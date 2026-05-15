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

export interface ParsedTrace {
  metadata: TraceMetadata;
  events: TraceEvent[];
  actions: TraceAction[];
  network: NetworkEntry[];
  console: ConsoleMessage[];
  snapshots: FrameSnapshot[];
}
