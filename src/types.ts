export interface TraceAction {
  type: string;
  startTime: number;
  endTime: number;
  locator?: string;
  error?: string;
  metadata?: Record<string, unknown>;
}

export interface NetworkEntry {
  url: string;
  method: string;
  status: number;
  startTime: number;
  duration: number;
  resourceType: string;
}

export interface ConsoleMessage {
  type: "error" | "warning" | "log" | "info";
  text: string;
  time: number;
}

export interface TraceEvent {
  type: string;
  time?: number;
  [key: string]: unknown;
}

export interface ParsedTrace {
  events: TraceEvent[];
  actions: TraceAction[];
  network: NetworkEntry[];
  console: ConsoleMessage[];
}
