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
  return events
    .filter((e) => e.type === "action" || e.type === "before" || e.type === "after")
    .map((e) => ({
      type: String(e["apiName"] ?? e.type),
      startTime: Number(e["startTime"] ?? e.time ?? 0),
      endTime: Number(e["endTime"] ?? 0),
      locator: e["params"] ? String((e["params"] as Record<string, unknown>)["selector"] ?? "") : undefined,
      error: e["error"] ? String((e["error"] as Record<string, unknown>)["message"] ?? "") : undefined,
      metadata: e as Record<string, unknown>,
    }))
    .filter((a) => a.type !== "before" && a.type !== "after");
}

function extractNetwork(events: TraceEvent[]): NetworkEntry[] {
  return events
    .filter((e) => e.type === "resource-snapshot" || e.type === "network-request")
    .map((e) => {
      const url = String(e["url"] ?? "");
      const method = String(e["method"] ?? "GET");
      const status = Number(e["status"] ?? 0);
      return {
        url,
        method,
        status,
        startTime: Number(e["time"] ?? 0),
        duration: Number(e["duration"] ?? 0),
        resourceType: String(e["resourceType"] ?? "other"),
      };
    });
}

function extractConsole(events: TraceEvent[]): ConsoleMessage[] {
  return events
    .filter((e) => e.type === "console")
    .map((e) => ({
      type: (e["messageType"] as ConsoleMessage["type"]) ?? "log",
      text: String(e["text"] ?? ""),
      time: Number(e["time"] ?? 0),
    }));
}
