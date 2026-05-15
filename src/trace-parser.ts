import AdmZip from "adm-zip";
import { ParsedTrace, TraceAction, NetworkEntry, ConsoleMessage, TraceEvent } from "./types.js";

export function parseTraceZip(zipPath: string): ParsedTrace {
  const zip = new AdmZip(zipPath);
  const events: TraceEvent[] = [];

  for (const entry of zip.getEntries()) {
    if (!entry.entryName.endsWith(".trace")) continue;
    const content = entry.getData().toString("utf8");
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        events.push(JSON.parse(trimmed) as TraceEvent);
      } catch {
        // skip malformed lines
      }
    }
  }

  return {
    events,
    actions: extractActions(events),
    network: extractNetwork(events),
    console: extractConsole(events),
  };
}

function extractActions(events: TraceEvent[]): TraceAction[] {
  const befores = events.filter((e) => e.type === "before");
  const afterMap = new Map<string, TraceEvent>();
  for (const e of events) {
    if (e.type === "after" && e.callId) {
      afterMap.set(String(e.callId), e);
    }
  }

  return befores.map((before) => {
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

function extractNetwork(events: TraceEvent[]): NetworkEntry[] {
  const browserEvents = events.filter((e) => e.type === "event");

  // Build request map: guid -> initializer data
  const requestMap = new Map<string, Record<string, unknown>>();
  for (const e of browserEvents) {
    if (e.class === "Request" && e.method === "__create__") {
      const params = e.params as Record<string, unknown>;
      const init = params.initializer as Record<string, unknown>;
      const guid = String(params.guid);
      requestMap.set(guid, init);
    }
  }

  // Collect responses and join with requests
  const entries: NetworkEntry[] = [];
  for (const e of browserEvents) {
    if (e.class !== "Response" || e.method !== "__create__") continue;
    const params = e.params as Record<string, unknown>;
    const init = params.initializer as Record<string, unknown>;
    const requestRef = init.request as Record<string, unknown>;
    const req = requestMap.get(String(requestRef?.guid));

    entries.push({
      url: String(init.url ?? ""),
      method: req ? String(req.method ?? "GET") : "GET",
      status: Number(init.status ?? 0),
      startTime: Number(e.time ?? 0),
      duration: Number((init.timing as Record<string, unknown>)?.responseStart ?? 0),
      resourceType: req ? String(req.resourceType ?? "other") : "other",
    });
  }

  return entries;
}

function extractConsole(events: TraceEvent[]): ConsoleMessage[] {
  return events
    .filter((e) => e.type === "event" && e.method === "console")
    .map((e) => {
      const params = e.params as Record<string, unknown>;
      const msg = params.message as Record<string, unknown> | undefined;
      return {
        type: (msg?.type as ConsoleMessage["type"]) ?? "log",
        text: msg?.text ? String(msg.text) : String(params.text ?? ""),
        time: Number(e.time ?? 0),
      };
    });
}
