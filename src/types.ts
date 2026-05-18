export interface TraceMetadata {
  browser?: string;
  platform?: string;
  viewport?: { width: number; height: number };
  testTitle?: string;
  wallTime?: number;
}

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
  mimeType: string;
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

export interface FrameSnapshot {
  callId: string;
  snapshotName: string;
  frameUrl: string;
  html: unknown;
  timestamp: number;
}

export interface TraceScreenshot {
  entryName: string;
  timestamp: number;
  data: Buffer;
}

export interface TraceSession {
  session_id: string;
  retry_index: number;
  status: "passed" | "failed";
  duration_ms: number;
  action_count: number;
}

export interface StrictTraceMetadata {
  trace_format_version: string;
  file_extension: string;
  session_count: number;
  retry_attempt_index: number;
  har_resolution_status: "embed" | "attach" | "omit";
  embedded_payloads_flag: boolean;
  test_sessions_array: TraceSession[];
}

export interface ParsedTrace {
  metadata: TraceMetadata;
  events: TraceEvent[];
  actions: TraceAction[];
  network: NetworkEntry[];
  console: ConsoleMessage[];
  snapshots: FrameSnapshot[];
}
