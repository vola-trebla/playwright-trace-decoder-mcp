import { ParsedTrace, TraceAction } from "./types.js";
import { snapshotToAriaYaml } from "./aria-translator.js";

// ---------------------------------------------------------------------------
// analyze_race_conditions
// ---------------------------------------------------------------------------

export interface RaceConditionResult {
  action_index: number;
  action_type: string;
  action_start: number;
  pending_requests: Array<{
    url: string;
    method: string;
    request_start: number;
    ms_before_action: number;
  }>;
}

const INTERACTION_ACTIONS = new Set([
  "page.click",
  "locator.click",
  "page.dblclick",
  "locator.dblclick",
  "page.fill",
  "locator.fill",
  "page.type",
  "locator.type",
  "page.press",
  "locator.press",
  "page.selectOption",
  "locator.selectOption",
  "page.check",
  "locator.check",
  "page.uncheck",
  "locator.uncheck",
  "page.hover",
  "locator.hover",
  "page.tap",
  "locator.tap",
  "page.goto",
  "page.reload",
  "page.goBack",
  "page.goForward",
]);

export function analyzeRaceConditions(trace: ParsedTrace): RaceConditionResult[] {
  const results: RaceConditionResult[] = [];

  trace.actions.forEach((action, index) => {
    const type = action.type.toLowerCase();
    const isInteraction =
      INTERACTION_ACTIONS.has(action.type) ||
      [...INTERACTION_ACTIONS].some((t) => type.includes(t.split(".")[1])) ||
      type.startsWith("expect") ||
      type.startsWith("locator.expect");
    if (!isInteraction) return;

    const pending = trace.network.filter((n) => {
      const networkEnd = n.startTime + n.duration;
      return n.startTime < action.startTime && networkEnd > action.startTime;
    });

    if (pending.length === 0) return;

    results.push({
      action_index: index,
      action_type: action.type,
      action_start: action.startTime,
      pending_requests: pending.map((n) => ({
        url: n.url,
        method: n.method,
        request_start: n.startTime,
        ms_before_action: Math.round(action.startTime - n.startTime),
      })),
    });
  });

  return results;
}

// ---------------------------------------------------------------------------
// get_dom_mutation_delta
// ---------------------------------------------------------------------------

export interface DomDeltaResult {
  action_index: number;
  action_type: string;
  before_snapshot: string | null;
  after_snapshot: string | null;
  added: string[];
  removed: string[];
  unchanged_count: number;
}

export function getDomMutationDelta(trace: ParsedTrace, actionIndex: number): DomDeltaResult {
  const action = trace.actions[actionIndex];
  const base: DomDeltaResult = {
    action_index: actionIndex,
    action_type: action?.type ?? "unknown",
    before_snapshot: null,
    after_snapshot: null,
    added: [],
    removed: [],
    unchanged_count: 0,
  };

  if (!action) return base;

  const callId = (action.metadata as Record<string, { callId?: string }>)?.before?.callId;
  if (!callId) return base;

  const beforeSnap = trace.snapshots.find(
    (s) => s.callId === callId && s.snapshotName.startsWith("before@")
  );
  const afterSnap = trace.snapshots.find(
    (s) => s.callId === callId && s.snapshotName.startsWith("after@")
  );

  if (!beforeSnap && !afterSnap) return base;

  const beforeLines = new Set(
    beforeSnap ? snapshotToAriaYaml(beforeSnap.html).split("\n").filter(Boolean) : []
  );
  const afterLines = new Set(
    afterSnap ? snapshotToAriaYaml(afterSnap.html).split("\n").filter(Boolean) : []
  );

  const added = [...afterLines].filter((l) => !beforeLines.has(l));
  const removed = [...beforeLines].filter((l) => !afterLines.has(l));
  const unchanged = [...afterLines].filter((l) => beforeLines.has(l)).length;

  return {
    ...base,
    before_snapshot: beforeSnap?.snapshotName ?? null,
    after_snapshot: afterSnap?.snapshotName ?? null,
    added,
    removed,
    unchanged_count: unchanged,
  };
}

// ---------------------------------------------------------------------------
// correlate_dom_and_network
// ---------------------------------------------------------------------------

export interface NetworkDomCorrelation {
  action_id: string;
  triggering_request_url: string;
  response_status_code: number;
  response_body_snippet: string;
  time_to_dom_mutation_ms: number;
  resulting_dom_mutations: Array<{ type: "added" | "removed" | "changed"; selector: string }>;
}

const NOISE_PATTERNS = [
  /analytics/i,
  /tracking/i,
  /beacon/i,
  /telemetry/i,
  /metrics/i,
  /ping\b/i,
  /pixel/i,
  /\.gif(\?|$)/i,
];

export function correlateNetworkAndDom(trace: ParsedTrace): NetworkDomCorrelation[] {
  const results: NetworkDomCorrelation[] = [];

  trace.actions.forEach((action, index) => {
    const delta = getDomMutationDelta(trace, index);
    const mutations: Array<{ type: "added" | "removed" | "changed"; selector: string }> = [
      ...delta.added.map((s) => ({ type: "added" as const, selector: s })),
      ...delta.removed.map((s) => ({ type: "removed" as const, selector: s })),
    ];

    if (mutations.length === 0) return;

    // Network requests whose response completed during this action's window (±100ms)
    const windowStart = action.startTime - 100;
    const windowEnd = action.endTime + 100;

    const candidates = trace.network.filter((n) => {
      const responseComplete = n.startTime + n.duration;
      return (
        responseComplete >= windowStart &&
        responseComplete <= windowEnd &&
        !NOISE_PATTERNS.some((p) => p.test(n.url)) &&
        !(n.mimeType.startsWith("image/") && n.status === 204)
      );
    });

    if (candidates.length === 0) return;

    // Pick the request whose response completed closest to the action start
    const trigger = candidates.reduce((best, n) => {
      const dA = Math.abs(n.startTime + n.duration - action.startTime);
      const dB = Math.abs(best.startTime + best.duration - action.startTime);
      return dA < dB ? n : best;
    });

    const responseCompleteTime = trigger.startTime + trigger.duration;

    results.push({
      action_id: `${index}:${action.type}`,
      triggering_request_url: trigger.url,
      response_status_code: trigger.status,
      response_body_snippet: trigger.body_snippet ?? "",
      time_to_dom_mutation_ms: Math.round(action.endTime - responseCompleteTime),
      resulting_dom_mutations: mutations.slice(0, 10),
    });
  });

  return results;
}

// ---------------------------------------------------------------------------
// get_causal_chain_for_failure
// ---------------------------------------------------------------------------

export interface CausalChainEvent {
  time: number;
  kind: "action" | "network_error" | "console_error" | "failed_action";
  description: string;
  detail?: string;
}

export interface CausalChainResult {
  failed_action: string | null;
  failure_time: number | null;
  lookback_ms: number;
  chain: CausalChainEvent[];
}

export function getCausalChain(trace: ParsedTrace, lookbackMs = 5000): CausalChainResult {
  const failed = trace.actions.find((a) => a.error);

  if (!failed) {
    return { failed_action: null, failure_time: null, lookback_ms: lookbackMs, chain: [] };
  }

  const failureTime = failed.startTime;
  const windowStart = failureTime - lookbackMs;
  const chain: CausalChainEvent[] = [];

  // Preceding user-facing actions in the window
  trace.actions
    .filter((a) => a !== failed && a.startTime >= windowStart && a.startTime < failureTime)
    .filter((a) => INTERACTION_ACTIONS.has(a.type) || a.type.startsWith("expect"))
    .forEach((a) => {
      chain.push({
        time: a.startTime,
        kind: "action",
        description: a.type,
        detail: a.locator ?? undefined,
      });
    });

  // Network errors (4xx/5xx) in the window
  trace.network
    .filter((n) => n.status >= 400 && n.startTime >= windowStart && n.startTime < failureTime)
    .forEach((n) => {
      chain.push({
        time: n.startTime,
        kind: "network_error",
        description: `${n.method} ${n.status}`,
        detail: n.url,
      });
    });

  // Console errors before failure
  trace.console
    .filter((c) => c.type === "error" && c.time >= windowStart && c.time < failureTime)
    .forEach((c) => {
      chain.push({
        time: c.time,
        kind: "console_error",
        description: "console.error",
        detail: c.text,
      });
    });

  // The failure itself
  chain.push({
    time: failureTime,
    kind: "failed_action",
    description: failed.type,
    detail: failed.error ?? undefined,
  });

  chain.sort((a, b) => a.time - b.time);

  return {
    failed_action: failed.type,
    failure_time: failureTime,
    lookback_ms: lookbackMs,
    chain,
  };
}

// ---------------------------------------------------------------------------
// detect_performance_anomalies
// ---------------------------------------------------------------------------

export interface PerformanceAnomaly {
  kind: "slow_action" | "frame_drop";
  blocked_action_id: string;
  task_duration_ms: number;
  threshold_ms: number;
  concurrent_network_load: number;
  frame_drop_count: number;
  worst_frame_gap_ms: number;
  suspected_cause:
    | "main_thread_blocked"
    | "network_saturation"
    | "timeout_or_navigation"
    | "unknown";
}

export interface PerformanceReport {
  anomalies: PerformanceAnomaly[];
  suspected_memory_leak_flag: boolean;
  p50_action_duration_ms: number;
  p95_action_duration_ms: number;
  total_frame_drop_count: number;
}

function getActionType(action: TraceAction): string {
  const before = (action.metadata as Record<string, Record<string, unknown>> | undefined)?.before;
  if (before?.apiName) return String(before.apiName);
  if (before?.class && before?.method) return `${String(before.class)}.${String(before.method)}`;
  return action.type;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.floor((p / 100) * (sorted.length - 1));
  return sorted[idx];
}

export function detectPerformanceAnomalies(
  trace: ParsedTrace,
  slowActionThresholdMs = 500,
  frameDropThresholdMs = 50
): PerformanceReport {
  // Frame gaps from screencast-frame events
  const frameTimestamps = trace.events
    .filter((e) => e.type === "screencast-frame")
    .map((e) => Number(e.timestamp ?? 0))
    .filter((t) => t > 0)
    .sort((a, b) => a - b);

  const frameGaps: Array<{ gapMs: number; windowStart: number; windowEnd: number }> = [];
  for (let i = 1; i < frameTimestamps.length; i++) {
    const gap = frameTimestamps[i] - frameTimestamps[i - 1];
    if (gap > frameDropThresholdMs) {
      frameGaps.push({
        gapMs: gap,
        windowStart: frameTimestamps[i - 1],
        windowEnd: frameTimestamps[i],
      });
    }
  }

  const totalFrameDropCount = frameGaps.length;

  // Action durations for stats
  const actionDurations = trace.actions.map((a) =>
    a.endTime > a.startTime ? a.endTime - a.startTime : 0
  );
  const nonTrivial = actionDurations.filter((d) => d > 10).sort((a, b) => a - b);
  const p50 = percentile(nonTrivial, 50);
  const p95 = percentile(nonTrivial, 95);

  function concurrentNetworkLoad(windowStart: number, windowEnd: number): number {
    return trace.network.filter((n) => {
      const end = n.startTime + n.duration;
      return n.startTime < windowEnd && end > windowStart;
    }).length;
  }

  function frameDropsInWindow(windowStart: number, windowEnd: number) {
    const drops = frameGaps.filter(
      (g) => g.windowStart >= windowStart && g.windowStart <= windowEnd
    );
    return {
      count: drops.length,
      worstGap: drops.length > 0 ? Math.max(...drops.map((g) => g.gapMs)) : 0,
    };
  }

  const anomalies: PerformanceAnomaly[] = [];
  const coveredGapIndices = new Set<number>();

  trace.actions.forEach((action, index) => {
    const dur = actionDurations[index];
    if (dur < slowActionThresholdMs) return;

    const type = getActionType(action);
    const netLoad = concurrentNetworkLoad(action.startTime, action.endTime);
    const { count: dropCount, worstGap } = frameDropsInWindow(action.startTime, action.endTime);

    let suspectedCause: PerformanceAnomaly["suspected_cause"] = "unknown";
    if (dropCount > 0) {
      suspectedCause = "main_thread_blocked";
    } else if (netLoad >= 5) {
      suspectedCause = "network_saturation";
    } else if (dur > 3000) {
      suspectedCause = "timeout_or_navigation";
    }

    // Mark overlapping frame drops as covered
    frameGaps.forEach((g, i) => {
      if (g.windowStart >= action.startTime && g.windowStart <= action.endTime) {
        coveredGapIndices.add(i);
      }
    });

    anomalies.push({
      kind: "slow_action",
      blocked_action_id: `${index}:${type}`,
      task_duration_ms: Math.round(dur),
      threshold_ms: slowActionThresholdMs,
      concurrent_network_load: netLoad,
      frame_drop_count: dropCount,
      worst_frame_gap_ms: Math.round(worstGap),
      suspected_cause: suspectedCause,
    });
  });

  // Prominent standalone frame drops (>= 200ms) not covered by a slow action
  const PROMINENT_DROP_MS = 200;
  frameGaps.forEach((gap, i) => {
    if (coveredGapIndices.has(i) || gap.gapMs < PROMINENT_DROP_MS) return;

    const overlappingIdx = trace.actions.findIndex(
      (a) => a.startTime <= gap.windowStart && a.endTime >= gap.windowEnd
    );
    const overlapping = overlappingIdx >= 0 ? trace.actions[overlappingIdx] : null;
    const netLoad = concurrentNetworkLoad(gap.windowStart, gap.windowEnd);

    anomalies.push({
      kind: "frame_drop",
      blocked_action_id: overlapping ? `${overlappingIdx}:${getActionType(overlapping)}` : "none",
      task_duration_ms: Math.round(gap.gapMs),
      threshold_ms: PROMINENT_DROP_MS,
      concurrent_network_load: netLoad,
      frame_drop_count: 1,
      worst_frame_gap_ms: Math.round(gap.gapMs),
      suspected_cause: netLoad >= 3 ? "network_saturation" : "main_thread_blocked",
    });
  });

  // Memory leak: same action type (class.method), >= 3 occurrences with strictly
  // increasing durations (allowing 10% variance)
  const durationsByType = new Map<string, number[]>();
  trace.actions.forEach((action, i) => {
    const dur = actionDurations[i];
    if (dur < 10) return;
    const type = getActionType(action);
    const list = durationsByType.get(type);
    if (list) list.push(dur);
    else durationsByType.set(type, [dur]);
  });

  let suspectedMemoryLeakFlag = false;
  for (const durs of durationsByType.values()) {
    if (durs.length < 3) continue;
    let increasing = true;
    for (let i = 1; i < durs.length; i++) {
      if (durs[i] < durs[i - 1] * 0.9) {
        increasing = false;
        break;
      }
    }
    if (increasing) {
      suspectedMemoryLeakFlag = true;
      break;
    }
  }

  anomalies.sort((a, b) => b.task_duration_ms - a.task_duration_ms);

  return {
    anomalies,
    suspected_memory_leak_flag: suspectedMemoryLeakFlag,
    p50_action_duration_ms: Math.round(p50),
    p95_action_duration_ms: Math.round(p95),
    total_frame_drop_count: totalFrameDropCount,
  };
}
