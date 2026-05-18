import { describe, expect, it } from "vitest";
import { correlateNetworkAndDom } from "../src/diagnostics.js";
import type { ParsedTrace, NetworkEntry, TraceAction, FrameSnapshot } from "../src/types.js";

// Playwright's internal snapshot format: [tag, attrs, ...children]
type SnapNode = [string, Record<string, string>, ...(SnapNode | string)[]];

function snapDoc(...children: SnapNode[]): SnapNode {
  return ["HTML", {}, ["BODY", {}, ...children]];
}
const BTN: SnapNode = ["BUTTON", {}, "Submit"];
const SUCCESS: SnapNode = ["P", { role: "status" }, "Success!"];
// BUTTON produces unique named ARIA lines suitable for Set-based diffing
function buttons(n: number): SnapNode[] {
  return Array.from({ length: n }, (_, i) => ["BUTTON", {}, `action-${i}`] as SnapNode);
}

function makeTrace(
  actions: Partial<TraceAction>[],
  network: Partial<NetworkEntry>[],
  snapshots: Partial<FrameSnapshot>[] = []
): ParsedTrace {
  return {
    metadata: {},
    events: [],
    console: [],
    actions: actions.map((a) => ({
      type: a.type ?? "page.click",
      startTime: a.startTime ?? 1000,
      endTime: a.endTime ?? 1200,
      locator: a.locator,
      error: a.error,
      metadata: a.metadata ?? {},
    })),
    network: network.map((n) => ({
      url: n.url ?? "https://api.example.com/data",
      method: n.method ?? "GET",
      status: n.status ?? 200,
      startTime: n.startTime ?? 900,
      duration: n.duration ?? 150,
      mimeType: n.mimeType ?? "application/json",
      body_snippet: n.body_snippet,
    })),
    snapshots: snapshots.map((s) => ({
      callId: s.callId ?? "call-1",
      snapshotName: s.snapshotName ?? "before@call-1",
      frameUrl: s.frameUrl ?? "https://example.com",
      html: s.html ?? null,
      timestamp: s.timestamp ?? 1000,
    })),
  };
}

describe("correlateNetworkAndDom", () => {
  it("returns empty when no network requests in window", () => {
    const trace = makeTrace(
      [{ startTime: 1000, endTime: 1200, metadata: { before: { callId: "c1" } } }],
      [{ startTime: 500, duration: 100 }] // completes at 600, outside window
    );
    expect(correlateNetworkAndDom(trace)).toHaveLength(0);
  });

  it("returns empty when no DOM mutations", () => {
    // no snapshots → getDomMutationDelta returns no added/removed
    const trace = makeTrace(
      [{ startTime: 1000, endTime: 1200, metadata: { before: { callId: "c1" } } }],
      [{ startTime: 900, duration: 150 }] // completes at 1050, in window
    );
    expect(correlateNetworkAndDom(trace)).toHaveLength(0);
  });

  it("correlates request that completed in action window with DOM mutation", () => {
    // Action: 1000–1200. Network response completes at 1050 (in window).
    const trace = makeTrace(
      [{ startTime: 1000, endTime: 1200, metadata: { before: { callId: "c1" } } }],
      [
        {
          url: "https://api.example.com/submit",
          startTime: 900,
          duration: 150, // completes at 1050
          status: 201,
          body_snippet: '{"ok":true}',
        },
      ],
      [
        { callId: "c1", snapshotName: "before@call-1", html: snapDoc(BTN), timestamp: 1000 },
        {
          callId: "c1",
          snapshotName: "after@call-1",
          html: snapDoc(BTN, SUCCESS),
          timestamp: 1200,
        },
      ]
    );

    const result = correlateNetworkAndDom(trace);
    expect(result).toHaveLength(1);
    expect(result[0].triggering_request_url).toBe("https://api.example.com/submit");
    expect(result[0].response_status_code).toBe(201);
    expect(result[0].response_body_snippet).toBe('{"ok":true}');
    expect(result[0].time_to_dom_mutation_ms).toBe(150); // 1200 - 1050
    expect(result[0].resulting_dom_mutations.length).toBeGreaterThan(0);
    expect(result[0].resulting_dom_mutations.some((m) => m.type === "added")).toBe(true);
  });

  it("filters out analytics/tracking URLs", () => {
    const trace = makeTrace(
      [{ startTime: 1000, endTime: 1200, metadata: { before: { callId: "c1" } } }],
      [
        { url: "https://analytics.google.com/collect", startTime: 900, duration: 150 },
        { url: "https://tracker.example.com/pixel.gif", startTime: 900, duration: 150 },
      ],
      [
        { callId: "c1", snapshotName: "before@call-1", html: snapDoc(BTN) },
        { callId: "c1", snapshotName: "after@call-1", html: snapDoc(BTN, SUCCESS) },
      ]
    );

    // Both candidates filtered → no correlation despite DOM mutation
    expect(correlateNetworkAndDom(trace)).toHaveLength(0);
  });

  it("picks request closest to action start when multiple candidates", () => {
    const nodeA: SnapNode = ["H1", {}, "Title A"]; // heading [level=1]
    const nodeB: SnapNode = ["H2", {}, "Subtitle"]; // heading [level=2] — different ARIA line
    const trace = makeTrace(
      [{ startTime: 1000, endTime: 1200, metadata: { before: { callId: "c1" } } }],
      [
        { url: "https://api.example.com/far", startTime: 750, duration: 150 }, // completes 900, dist=100
        { url: "https://api.example.com/close", startTime: 950, duration: 100 }, // completes 1050, dist=50
      ],
      [
        { callId: "c1", snapshotName: "before@call-1", html: snapDoc(nodeA) },
        { callId: "c1", snapshotName: "after@call-1", html: snapDoc(nodeA, nodeB) },
      ]
    );

    const result = correlateNetworkAndDom(trace);
    expect(result).toHaveLength(1);
    expect(result[0].triggering_request_url).toContain("/close");
  });

  it("action_id format is index:type", () => {
    const nodeX: SnapNode = ["BUTTON", {}, "X"];
    const nodeY: SnapNode = ["BUTTON", {}, "Y"];
    const trace = makeTrace(
      [
        {
          type: "page.goto",
          startTime: 1000,
          endTime: 1200,
          metadata: { before: { callId: "c1" } },
        },
      ],
      [{ url: "https://api.example.com/page", startTime: 900, duration: 150 }],
      [
        { callId: "c1", snapshotName: "before@call-1", html: snapDoc(nodeX) },
        { callId: "c1", snapshotName: "after@call-1", html: snapDoc(nodeX, nodeY) },
      ]
    );

    const result = correlateNetworkAndDom(trace);
    expect(result[0].action_id).toBe("0:page.goto");
  });

  it("caps resulting_dom_mutations at 10", () => {
    const trace = makeTrace(
      [{ startTime: 1000, endTime: 1200, metadata: { before: { callId: "c1" } } }],
      [{ url: "https://api.example.com/list", startTime: 900, duration: 150 }],
      [
        { callId: "c1", snapshotName: "before@call-1", html: snapDoc(...buttons(5)) },
        { callId: "c1", snapshotName: "after@call-1", html: snapDoc(...buttons(20)) },
      ]
    );

    const result = correlateNetworkAndDom(trace);
    expect(result[0].resulting_dom_mutations.length).toBeLessThanOrEqual(10);
  });
});
