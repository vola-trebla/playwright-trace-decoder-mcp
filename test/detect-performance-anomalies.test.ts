import { describe, expect, it } from "vitest";
import { detectPerformanceAnomalies } from "../src/diagnostics.js";
import type { ParsedTrace, TraceEvent } from "../src/types.js";

function frame(timestamp: number): TraceEvent {
  return { type: "screencast-frame", timestamp };
}

function makeTrace(
  actions: Array<{ startTime: number; endTime: number; type?: string }>,
  network: Array<{ startTime: number; duration: number }> = [],
  events: TraceEvent[] = []
): ParsedTrace {
  return {
    metadata: {},
    console: [],
    snapshots: [],
    events,
    actions: actions.map((a) => ({
      type: a.type ?? "Locator.click",
      startTime: a.startTime,
      endTime: a.endTime,
      metadata: {},
    })),
    network: network.map((n) => ({
      url: "https://example.com/api",
      method: "GET",
      status: 200,
      startTime: n.startTime,
      duration: n.duration,
      mimeType: "application/json",
    })),
  };
}

describe("detectPerformanceAnomalies", () => {
  it("returns no anomalies for a fast trace", () => {
    const trace = makeTrace([{ startTime: 0, endTime: 100 }], [], [frame(0), frame(16), frame(32)]);
    const result = detectPerformanceAnomalies(trace);
    expect(result.anomalies).toHaveLength(0);
    expect(result.total_frame_drop_count).toBe(0);
  });

  it("flags slow action above default threshold", () => {
    const trace = makeTrace([{ type: "Frame.goto", startTime: 0, endTime: 600 }]);
    const result = detectPerformanceAnomalies(trace);
    expect(result.anomalies).toHaveLength(1);
    expect(result.anomalies[0].kind).toBe("slow_action");
    expect(result.anomalies[0].task_duration_ms).toBe(600);
    expect(result.anomalies[0].blocked_action_id).toBe("0:Frame.goto");
  });

  it("does not flag action below threshold", () => {
    const trace = makeTrace([{ startTime: 0, endTime: 499 }]);
    const result = detectPerformanceAnomalies(trace);
    expect(result.anomalies).toHaveLength(0);
  });

  it("counts total frame drops correctly", () => {
    const trace = makeTrace(
      [],
      [],
      [frame(0), frame(16), frame(316), frame(332)] // gap of 300ms at t=16
    );
    const result = detectPerformanceAnomalies(trace);
    expect(result.total_frame_drop_count).toBe(1);
  });

  it("associates frame drop with overlapping slow action", () => {
    // Action 0–2000ms; frame drop of 300ms at t=16 (inside action window)
    const trace = makeTrace(
      [{ type: "Frame.goto", startTime: 0, endTime: 2000 }],
      [],
      [frame(0), frame(16), frame(316), frame(332)]
    );
    const result = detectPerformanceAnomalies(trace);
    const anomaly = result.anomalies.find((a) => a.kind === "slow_action");
    expect(anomaly?.frame_drop_count).toBeGreaterThan(0);
    expect(anomaly?.worst_frame_gap_ms).toBe(300);
    expect(anomaly?.suspected_cause).toBe("main_thread_blocked");
  });

  it("reports network_saturation when >= 5 requests are in-flight and no frame drops", () => {
    const concurrent = Array.from({ length: 6 }, () => ({ startTime: 100, duration: 1000 }));
    const trace = makeTrace([{ type: "Frame.goto", startTime: 200, endTime: 800 }], concurrent);
    const result = detectPerformanceAnomalies(trace);
    const anomaly = result.anomalies.find((a) => a.kind === "slow_action");
    expect(anomaly?.concurrent_network_load).toBe(6);
    expect(anomaly?.suspected_cause).toBe("network_saturation");
  });

  it("reports timeout_or_navigation for very long action with no other signals", () => {
    const trace = makeTrace([{ type: "Frame.goto", startTime: 0, endTime: 5000 }]);
    const result = detectPerformanceAnomalies(trace);
    const anomaly = result.anomalies[0];
    expect(anomaly?.suspected_cause).toBe("timeout_or_navigation");
  });

  it("computes p50 and p95 from action durations", () => {
    const durations = [100, 200, 300, 400, 500];
    const trace = makeTrace(
      durations.map((dur, i) => ({ startTime: i * 1000, endTime: i * 1000 + dur }))
    );
    const result = detectPerformanceAnomalies(trace);
    expect(result.p50_action_duration_ms).toBe(300);
    // floor(0.95 * 4) = 3 → sorted[3] = 400
    expect(result.p95_action_duration_ms).toBe(400);
  });

  it("sets suspected_memory_leak_flag for monotonically increasing durations", () => {
    const trace = makeTrace([
      { type: "Locator.fill", startTime: 0, endTime: 100 },
      { type: "Locator.fill", startTime: 200, endTime: 400 },
      { type: "Locator.fill", startTime: 500, endTime: 900 },
    ]);
    const result = detectPerformanceAnomalies(trace);
    expect(result.suspected_memory_leak_flag).toBe(true);
  });

  it("does not flag memory leak when durations are non-monotonic", () => {
    const trace = makeTrace([
      { type: "Locator.fill", startTime: 0, endTime: 200 },
      { type: "Locator.fill", startTime: 300, endTime: 550 },
      { type: "Locator.fill", startTime: 600, endTime: 750 }, // 150ms < 250ms * 0.9 = 225ms → decreasing
    ]);
    const result = detectPerformanceAnomalies(trace);
    expect(result.suspected_memory_leak_flag).toBe(false);
  });

  it("emits standalone frame_drop anomaly for prominent gap outside action windows", () => {
    // No actions overlap the 300ms gap at t=500
    const trace = makeTrace(
      [{ startTime: 0, endTime: 100 }],
      [],
      [frame(500), frame(800), frame(816)] // 300ms gap at t=500
    );
    const result = detectPerformanceAnomalies(trace);
    expect(result.total_frame_drop_count).toBe(1);
    const dropAnomaly = result.anomalies.find((a) => a.kind === "frame_drop");
    expect(dropAnomaly).toBeDefined();
    expect(dropAnomaly?.worst_frame_gap_ms).toBe(300);
  });
});
