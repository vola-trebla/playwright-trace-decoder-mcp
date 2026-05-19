import AdmZip from "adm-zip";
import { statSync, writeFileSync, mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createHash } from "crypto";
import { createInterface } from "readline";
import { Readable } from "stream";
import {
  ParsedTrace,
  StrictTraceMetadata,
  TraceAction,
  TraceMetadata,
  TraceSession,
  NetworkEntry,
  ConsoleMessage,
  TraceEvent,
  FrameSnapshot,
  TraceScreenshot,
} from "./types.js";

// If trace_path is a URL, download it to a stable temp path keyed by URL hash.
// The file persists for the process lifetime so the LRU cache still works.
const urlTempDir = mkdtempSync(join(tmpdir(), "pw-trace-mcp-"));

export async function resolveTracePath(tracePathOrUrl: string): Promise<string> {
  if (!tracePathOrUrl.startsWith("http://") && !tracePathOrUrl.startsWith("https://")) {
    return tracePathOrUrl;
  }
  const hash = createHash("sha1").update(tracePathOrUrl).digest("hex").slice(0, 16);
  const dest = join(urlTempDir, `${hash}.zip`);
  // Re-use the cached download within the same process run
  try {
    statSync(dest);
    return dest;
  } catch {
    // not yet downloaded
  }
  const res = await fetch(tracePathOrUrl);
  if (!res.ok) {
    throw new Error(`Failed to download trace from URL: ${res.status} ${res.statusText}`);
  }
  const buffer = Buffer.from(await res.arrayBuffer());
  writeFileSync(dest, buffer);
  return dest;
}

const CACHE_MAX = 50;
const cache = new Map<string, { mtime: number; parsed: ParsedTrace }>();

function cacheGet(key: string) {
  const entry = cache.get(key);
  if (!entry) return undefined;
  cache.delete(key);
  cache.set(key, entry);
  return entry;
}

function cacheSet(key: string, value: { mtime: number; parsed: ParsedTrace }) {
  if (cache.has(key)) cache.delete(key);
  cache.set(key, value);
  if (cache.size > CACHE_MAX) {
    cache.delete(cache.keys().next().value!);
  }
}

export async function parseTraceZip(zipPath: string): Promise<ParsedTrace> {
  const mtime = statSync(zipPath).mtimeMs;
  const cached = cacheGet(zipPath);
  if (cached && cached.mtime === mtime) return cached.parsed;

  const zip = new AdmZip(zipPath);
  const traceEvents: TraceEvent[] = [];
  const networkEvents: TraceEvent[] = [];

  for (const entry of zip.getEntries()) {
    if (entry.entryName.endsWith(".trace")) {
      await parseJsonlBuffer(entry.getData(), traceEvents);
    } else if (entry.entryName.endsWith(".network")) {
      await parseJsonlBuffer(entry.getData(), networkEvents);
    }
  }

  const parsed: ParsedTrace = {
    metadata: extractMetadata(traceEvents),
    events: traceEvents,
    actions: extractActions(traceEvents),
    network: extractNetwork(networkEvents),
    console: extractConsole(traceEvents),
    snapshots: extractSnapshots(traceEvents),
  };

  cacheSet(zipPath, { mtime, parsed });
  return parsed;
}

function parseJsonlSync(buffer: Buffer): TraceEvent[] {
  const events: TraceEvent[] = [];
  for (const line of buffer.toString("utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      events.push(JSON.parse(trimmed) as TraceEvent);
    } catch {
      // skip malformed lines
    }
  }
  return events;
}

export function extractTraceMetadataStrict(zipPath: string): StrictTraceMetadata {
  const zip = new AdmZip(zipPath);
  const entries = zip.getEntries();
  const filename = zipPath.split("/").pop() ?? zipPath;

  const fileExtension = filename.endsWith(".pwtrace.zip") ? ".pwtrace.zip" : ".zip";

  const traceEntries = entries
    .filter((e) => e.entryName.endsWith(".trace"))
    .sort((a, b) => {
      // trace.trace = attempt 0, trace-1.trace = attempt 1, etc.
      const numA = Number(/(\d+)\.trace$/.exec(a.entryName)?.[1] ?? 0);
      const numB = Number(/(\d+)\.trace$/.exec(b.entryName)?.[1] ?? 0);
      return numA - numB;
    });

  if (traceEntries.length === 0) {
    throw new Error("No .trace files found — archive is not a valid Playwright trace");
  }

  let formatVersion = "unknown";
  const sessions: TraceSession[] = traceEntries.map((entry, idx) => {
    const events = parseJsonlSync(entry.getData());

    if (idx === 0) {
      const versionEvent = events.find(
        (e) => e.type === "version" || typeof (e as Record<string, unknown>).version === "number"
      );
      if (versionEvent) {
        const v = (versionEvent as Record<string, unknown>).version;
        formatVersion = v !== undefined ? String(v) : "unknown";
      }
    }

    const actions = extractActions(events);
    const hasError = actions.some((a) => a.error);
    const startTimes = actions.map((a) => a.startTime).filter((t) => t > 0);
    const endTimes = actions.map((a) => a.endTime).filter((t) => t > 0);
    const duration =
      startTimes.length && endTimes.length ? Math.max(...endTimes) - Math.min(...startTimes) : 0;

    return {
      session_id: entry.entryName,
      retry_index: idx,
      status: hasError ? "failed" : "passed",
      duration_ms: Math.round(duration),
      action_count: actions.length,
    };
  });

  const retryAttemptIndex = sessions.reduce((acc, s, i) => (s.status === "failed" ? i : acc), -1);

  const networkEntries = entries.filter((e) => e.entryName.endsWith(".network"));
  let harResolutionStatus: "embed" | "attach" | "omit" = "omit";
  let embeddedPayloadsFlag = false;

  if (networkEntries.length > 0) {
    const networkEvents = parseJsonlSync(networkEntries[0].getData());
    for (const snap of networkEvents.filter((e) => e.type === "resource-snapshot").slice(0, 20)) {
      const snapshot = snap.snapshot as Record<string, unknown> | undefined;
      const resp = snapshot?.response as Record<string, unknown> | undefined;
      const content = resp?.content as Record<string, unknown> | undefined;
      if (content?._base64 || content?.text) {
        harResolutionStatus = "embed";
        embeddedPayloadsFlag = true;
        break;
      }
    }

    if (harResolutionStatus !== "embed") {
      const hasAttachedResources = entries.some(
        (e) =>
          e.entryName.startsWith("resources/") &&
          !SCREENSHOT_RE.test(e.entryName) &&
          !e.entryName.endsWith(".jpeg") &&
          !e.entryName.endsWith(".png")
      );
      if (hasAttachedResources) harResolutionStatus = "attach";
    }
  }

  return {
    trace_format_version: formatVersion,
    file_extension: fileExtension,
    session_count: sessions.length,
    retry_attempt_index: retryAttemptIndex,
    har_resolution_status: harResolutionStatus,
    embedded_payloads_flag: embeddedPayloadsFlag,
    test_sessions_array: sessions,
  };
}

async function parseJsonlBuffer(buffer: Buffer, target: TraceEvent[]): Promise<void> {
  const rl = createInterface({ input: Readable.from(buffer), crlfDelay: Infinity });
  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      target.push(JSON.parse(trimmed) as TraceEvent);
    } catch {
      // skip malformed lines
    }
  }
}

function extractMetadata(events: TraceEvent[]): TraceMetadata {
  const ctx = events.find((e) => e.type === "context-options");
  if (!ctx) return {};
  const options = ctx.options as Record<string, unknown> | undefined;
  return {
    browser: ctx.browserName ? String(ctx.browserName) : undefined,
    platform: ctx.platform ? String(ctx.platform) : undefined,
    viewport: options?.viewport as { width: number; height: number } | undefined,
    testTitle: ctx.title ? String(ctx.title) : undefined,
    wallTime: ctx.wallTime ? Number(ctx.wallTime) : undefined,
  };
}

const ANSI_RE = /\x1b\[[0-9;]*[mGKHF]/g;

function stripAnsi(s: string): string {
  return s.replace(ANSI_RE, "");
}

function normalizeActionType(before: TraceEvent): string {
  if (before.apiName) return String(before.apiName);

  // If apiName is missing, try to reconstruct from class/method or title
  const { class: className, method, title } = before as Record<string, any>;

  if (className && method) {
    return `${className}.${method}`;
  }

  if (title) {
    return String(title);
  }

  // Fallback to callId but keep it recognizable
  return String(before.callId ? `pw:api@${before.callId}` : "unknown");
}

function extractActions(events: TraceEvent[]): TraceAction[] {
  const afterMap = new Map<string, TraceEvent>();
  for (const e of events) {
    if (e.type === "after" && e.callId) {
      afterMap.set(String(e.callId), e);
    }
  }

  return events
    .filter((e) => e.type === "before")
    .map((before) => {
      const after = afterMap.get(String(before.callId));
      const params = (before.params ?? {}) as Record<string, unknown>;
      const error = after?.error as Record<string, unknown> | undefined;
      return {
        type: normalizeActionType(before),
        startTime: Number(before.startTime ?? 0),
        endTime: Number(after?.endTime ?? 0),
        locator: params.selector
          ? String(params.selector)
          : params.locator
            ? String(params.locator)
            : undefined,
        error: error?.message ? stripAnsi(String(error.message)) : undefined,
        metadata: { before, after },
      };
    });
}

function extractNetwork(networkEvents: TraceEvent[]): NetworkEntry[] {
  return networkEvents
    .filter((e) => e.type === "resource-snapshot")
    .map((e) => {
      const snap = e.snapshot as Record<string, unknown>;
      const req = snap.request as Record<string, unknown>;
      const resp = snap.response as Record<string, unknown>;
      const content = resp?.content as Record<string, unknown> | undefined;
      let body_snippet: string | undefined;
      if (content?._base64) {
        body_snippet = Buffer.from(String(content._base64), "base64")
          .toString("utf8")
          .slice(0, 200);
      } else if (content?.text) {
        body_snippet = String(content.text).slice(0, 200);
      }
      return {
        url: String(req?.url ?? ""),
        method: String(req?.method ?? "GET"),
        status: Number(resp?.status ?? 0),
        startTime: Number(snap._monotonicTime ?? 0),
        duration: Number(snap.time ?? 0),
        mimeType: String(content?.mimeType ?? "other"),
        ...(body_snippet !== undefined ? { body_snippet } : {}),
      };
    });
}

function extractSnapshots(events: TraceEvent[]): FrameSnapshot[] {
  return events
    .filter((e) => e.type === "frame-snapshot")
    .map((e) => {
      const snap = e.snapshot as Record<string, unknown>;
      return {
        callId: String(snap.callId ?? ""),
        snapshotName: String(snap.snapshotName ?? ""),
        frameUrl: String(snap.frameUrl ?? ""),
        html: snap.html,
        timestamp: Number(snap.timestamp ?? 0),
      };
    });
}

// Filename pattern: resources/page@<id>-<timestamp>.jpeg
const SCREENSHOT_RE = /^resources\/page@[^-]+-(\d+)\.jpeg$/;

export function extractScreenshots(zipPath: string): TraceScreenshot[] {
  const zip = new AdmZip(zipPath);
  const results: TraceScreenshot[] = [];

  for (const entry of zip.getEntries()) {
    const match = SCREENSHOT_RE.exec(entry.entryName);
    if (!match) continue;
    const timestamp = Number(match[1]);
    results.push({ entryName: entry.entryName, timestamp, data: entry.getData() });
  }

  results.sort((a, b) => a.timestamp - b.timestamp);
  return results;
}

function extractConsole(events: TraceEvent[]): ConsoleMessage[] {
  const objectMap = new Map<string, TraceEvent>();
  for (const e of events) {
    if (e.type === "object" && e.guid) {
      objectMap.set(String(e.guid), e);
    }
  }

  return events
    .filter((e) => e.type === "event" && e.method === "console")
    .map((e) => {
      const params = e.params as Record<string, unknown>;
      const msgRef = params.message as Record<string, unknown> | undefined;
      const msgObj = objectMap.get(String(msgRef?.guid ?? ""));
      const init = msgObj?.initializer as Record<string, unknown> | undefined;
      return {
        type: (init?.type as ConsoleMessage["type"]) ?? "log",
        text: init?.text ? String(init.text) : "",
        time: Number(e.time ?? 0),
      };
    });
}
