import AdmZip from "adm-zip";
import { writeFileSync, mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { beforeAll, describe, expect, it } from "vitest";
import { parseTraceZip } from "../src/trace-parser.js";
import { mapLocatorToSource } from "../src/diagnostics.js";

let testDir: string;

beforeAll(() => {
  testDir = mkdtempSync(join(tmpdir(), "pw-trace-modern-format-test-"));
});

function buildZip(events: Record<string, unknown>[]): string {
  const zip = new AdmZip();
  const body = events.map((e) => JSON.stringify(e)).join("\n") + "\n";
  zip.addFile("0-trace.trace", Buffer.from(body, "utf8"));
  const dest = join(testDir, `trace-${Date.now()}-${Math.random()}.zip`);
  writeFileSync(dest, zip.toBuffer());
  return dest;
}

describe("Playwright >= 1.49 trace format", () => {
  it("reads first-class console entries (type: console)", async () => {
    const path = buildZip([
      { type: "context-options", browserName: "chromium" },
      {
        type: "console",
        messageType: "error",
        text: "TypeError: boom\n    at g (http://localhost/app.js:1:188)",
        time: 1500,
      },
      { type: "console", messageType: "warning", text: "deprecated", time: 1600 },
      { type: "console", messageType: "log", text: "hello", time: 1700 },
    ]);

    const parsed = await parseTraceZip(path);

    expect(parsed.console).toHaveLength(3);
    expect(parsed.console[0]).toMatchObject({ type: "error", time: 1500 });
    expect(parsed.console[0].text).toContain("http://localhost/app.js:1:188");
    expect(parsed.console[1].type).toBe("warning");
    expect(parsed.console[2].type).toBe("log");
  });

  it("surfaces uncaught page errors (pageError events) as console errors with their stack", async () => {
    const path = buildZip([
      { type: "context-options", browserName: "chromium" },
      {
        type: "event",
        time: 1390.287,
        class: "BrowserContext",
        method: "pageError",
        params: {
          error: {
            error: {
              message: 'Missing element: [data-testid="greetings"]',
              stack:
                'Error: Missing element: [data-testid="greetings"]\n    at s (http://localhost:4173/dist/app.js:1:557)',
              name: "Error",
            },
          },
          location: { url: "http://localhost:4173/dist/app.js", line: 0, column: 556 },
        },
        pageId: "page@1",
      },
    ]);

    const parsed = await parseTraceZip(path);

    expect(parsed.console).toHaveLength(1);
    expect(parsed.console[0].type).toBe("error");
    expect(parsed.console[0].time).toBe(1390.287);
    expect(parsed.console[0].text).toBe(
      'Uncaught Error: Missing element: [data-testid="greetings"]\n    at s (http://localhost:4173/dist/app.js:1:557)'
    );
  });

  it("still reads legacy console events referenced by guid", async () => {
    const path = buildZip([
      { type: "context-options", browserName: "chromium" },
      {
        type: "object",
        guid: "console@1",
        initializer: { type: "error", text: "legacy error" },
      },
      { type: "event", method: "console", params: { message: { guid: "console@1" } }, time: 10 },
    ]);

    const parsed = await parseTraceZip(path);

    expect(parsed.console).toEqual([{ type: "error", text: "legacy error", time: 10 }]);
  });

  it("maps a failing expect step to the test file via the inline stack", async () => {
    const path = buildZip([
      { type: "context-options", browserName: "chromium" },
      {
        type: "before",
        callId: "expect@1",
        class: "Test",
        method: "expect",
        title: 'Expect "toHaveText"',
        params: { locator: "getByTestId('greeting')", expected: "Hello" },
        startTime: 2800,
        stack: [{ file: "/repo/tests/greeting.spec.ts", line: 6, column: 46 }],
      },
      {
        type: "after",
        callId: "expect@1",
        endTime: 7800,
        error: { message: "Expect failed", name: "ExpectError" },
      },
    ]);

    const parsed = await parseTraceZip(path);
    const result = mapLocatorToSource(parsed);

    expect(result.error).toContain("Expect failed");
    expect(result.step_title).toBe('Expect "toHaveText"');
    expect(result.source_location).toEqual({
      file: "/repo/tests/greeting.spec.ts",
      line: 6,
      column: 46,
      function: undefined,
    });
  });
});
