import AdmZip from "adm-zip";
import { statSync } from "fs";
import { createInterface } from "readline";
import { Readable } from "stream";
import {
  ParsedTrace,
  TraceAction,
  TraceMetadata,
  NetworkEntry,
  ConsoleMessage,
  TraceEvent,
  FrameSnapshot,
} from "./types.js";

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
        type: String(before.apiName ?? before.callId ?? "unknown"),
        startTime: Number(before.startTime ?? 0),
        endTime: Number(after?.endTime ?? 0),
        locator: params.selector
          ? String(params.selector)
          : params.locator
            ? String(params.locator)
            : undefined,
        error: error?.message ? String(error.message) : undefined,
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
      return {
        url: String(req?.url ?? ""),
        method: String(req?.method ?? "GET"),
        status: Number(resp?.status ?? 0),
        startTime: Number(snap._monotonicTime ?? 0),
        duration: Number(snap.time ?? 0),
        mimeType: String(content?.mimeType ?? "other"),
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
