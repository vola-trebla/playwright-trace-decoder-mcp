import AdmZip from "adm-zip";
import { writeFileSync, mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { extractTraceMetadataStrict } from "../src/trace-parser.js";

let testDir: string;

function makeContextEvent(): string {
  return JSON.stringify({ type: "context-options", browserName: "chromium", platform: "linux" });
}

function makeAction(callId: string, startTime: number, endTime: number, error?: string): string {
  const before = JSON.stringify({ type: "before", callId, apiName: "page.click", startTime });
  const after = JSON.stringify({
    type: "after",
    callId,
    endTime,
    ...(error ? { error: { message: error } } : {}),
  });
  return `${before}\n${after}`;
}

function makeNetworkEvent(withBody: boolean): string {
  return JSON.stringify({
    type: "resource-snapshot",
    snapshot: {
      request: { url: "https://api.example.com/data", method: "GET" },
      response: {
        status: 200,
        content: {
          mimeType: "application/json",
          ...(withBody ? { _base64: Buffer.from('{"ok":true}').toString("base64") } : {}),
        },
      },
      _monotonicTime: 1000,
      time: 50,
    },
  });
}

function buildTrace(events: string[]): Buffer {
  return Buffer.from(events.join("\n") + "\n", "utf8");
}

function buildZip(
  traceFiles: Record<string, Buffer>,
  networkBuf?: Buffer,
  resourceFiles?: Record<string, Buffer>
): string {
  const zip = new AdmZip();
  for (const [name, buf] of Object.entries(traceFiles)) {
    zip.addFile(name, buf);
  }
  if (networkBuf) {
    zip.addFile("trace.network", networkBuf);
  }
  if (resourceFiles) {
    for (const [name, buf] of Object.entries(resourceFiles)) {
      zip.addFile(name, buf);
    }
  }
  const dest = join(testDir, `${Object.keys(traceFiles).join("-")}-${Date.now()}.zip`);
  writeFileSync(dest, zip.toBuffer());
  return dest;
}

beforeAll(() => {
  testDir = mkdtempSync(join(tmpdir(), "pw-trace-strict-test-"));
});

afterAll(() => {
  // temp dir cleaned up by OS
});

describe("extractTraceMetadataStrict", () => {
  it("single session, no failure → retry_attempt_index -1", () => {
    const trace = buildTrace([
      makeContextEvent(),
      makeAction("c1", 1000, 1100),
      makeAction("c2", 1100, 1200),
    ]);
    const path = buildZip({ "trace.trace": trace });
    const result = extractTraceMetadataStrict(path);

    expect(result.session_count).toBe(1);
    expect(result.retry_attempt_index).toBe(-1);
    expect(result.test_sessions_array[0].status).toBe("passed");
    expect(result.test_sessions_array[0].retry_index).toBe(0);
    expect(result.test_sessions_array[0].action_count).toBe(2);
  });

  it("two sessions (retry): first failed, second passed → retry_attempt_index 0", () => {
    const failed = buildTrace([
      makeContextEvent(),
      makeAction("c1", 1000, 1100, "Element not found"),
    ]);
    const passed = buildTrace([makeContextEvent(), makeAction("c1", 2000, 2100)]);
    const path = buildZip({ "trace-1.trace": passed, "trace.trace": failed });
    const result = extractTraceMetadataStrict(path);

    expect(result.session_count).toBe(2);
    expect(result.retry_attempt_index).toBe(0);
    expect(result.test_sessions_array[0].status).toBe("failed");
    expect(result.test_sessions_array[1].status).toBe("passed");
  });

  it("all sessions failed → retry_attempt_index is last session index", () => {
    const fail = (id: string) =>
      buildTrace([makeContextEvent(), makeAction(id, 1000, 1100, "Timeout")]);
    const path = buildZip({
      "trace.trace": fail("c1"),
      "trace-1.trace": fail("c2"),
    });
    const result = extractTraceMetadataStrict(path);

    expect(result.retry_attempt_index).toBe(1);
    expect(result.test_sessions_array.every((s) => s.status === "failed")).toBe(true);
  });

  it("detects .pwtrace.zip extension", () => {
    const trace = buildTrace([makeContextEvent(), makeAction("c1", 1000, 1100)]);
    const zip = new AdmZip();
    zip.addFile("trace.trace", trace);
    const dest = join(testDir, "trace.pwtrace.zip");
    writeFileSync(dest, zip.toBuffer());

    const result = extractTraceMetadataStrict(dest);
    expect(result.file_extension).toBe(".pwtrace.zip");
  });

  it("regular .zip → file_extension is .zip", () => {
    const trace = buildTrace([makeContextEvent(), makeAction("c1", 1000, 1100)]);
    const path = buildZip({ "trace.trace": trace });
    const result = extractTraceMetadataStrict(path);
    expect(result.file_extension).toBe(".zip");
  });

  it("HAR embed mode — inline _base64 body detected", () => {
    const trace = buildTrace([makeContextEvent(), makeAction("c1", 1000, 1100)]);
    const network = Buffer.from(makeNetworkEvent(true) + "\n", "utf8");
    const path = buildZip({ "trace.trace": trace }, network);
    const result = extractTraceMetadataStrict(path);

    expect(result.har_resolution_status).toBe("embed");
    expect(result.embedded_payloads_flag).toBe(true);
  });

  it("HAR omit mode — no body content, no resource files", () => {
    const trace = buildTrace([makeContextEvent(), makeAction("c1", 1000, 1100)]);
    const network = Buffer.from(makeNetworkEvent(false) + "\n", "utf8");
    const path = buildZip({ "trace.trace": trace }, network);
    const result = extractTraceMetadataStrict(path);

    expect(result.har_resolution_status).toBe("omit");
    expect(result.embedded_payloads_flag).toBe(false);
  });

  it("HAR attach mode — separate resource files present", () => {
    const trace = buildTrace([makeContextEvent(), makeAction("c1", 1000, 1100)]);
    const network = Buffer.from(makeNetworkEvent(false) + "\n", "utf8");
    const path = buildZip({ "trace.trace": trace }, network, {
      "resources/response-abc123.bin": Buffer.from('{"data":1}'),
    });
    const result = extractTraceMetadataStrict(path);

    expect(result.har_resolution_status).toBe("attach");
  });

  it("throws on non-trace zip", () => {
    const zip = new AdmZip();
    zip.addFile("readme.txt", Buffer.from("not a trace"));
    const dest = join(testDir, "not-a-trace.zip");
    writeFileSync(dest, zip.toBuffer());

    expect(() => extractTraceMetadataStrict(dest)).toThrow("No .trace files found");
  });

  it("duration_ms is non-negative", () => {
    const trace = buildTrace([
      makeContextEvent(),
      makeAction("c1", 1000, 1200),
      makeAction("c2", 1200, 1500),
    ]);
    const path = buildZip({ "trace.trace": trace });
    const result = extractTraceMetadataStrict(path);
    expect(result.test_sessions_array[0].duration_ms).toBeGreaterThanOrEqual(0);
  });
});
