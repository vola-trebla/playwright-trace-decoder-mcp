import { createHash } from "crypto";
import { ParsedTrace } from "./types.js";

// ---------------------------------------------------------------------------
// generate_error_signature
// ---------------------------------------------------------------------------

export interface ErrorSignature {
  signature: string;
  test_title: string;
  normalized_error: string;
  raw_error: string | null;
  components: { test_title: string; error_message: string };
}

function normalizeError(message: string): string {
  return message
    .replace(/https?:\/\/[^\s"')]+/g, "URL") // strip URLs
    .replace(/(\/[\w./\-]+:\d+:\d+)/g, "PATH") // strip file paths with line:col
    .replace(/\b[0-9a-f]{8,}\b/gi, "HASH") // strip hex hashes / UUIDs
    .replace(/\d{4,}/g, "N") // strip long numbers (timestamps, ids)
    .replace(/'[^']{0,80}'/g, "'STR'") // strip string literals
    .replace(/"[^"]{0,80}"/g, '"STR"')
    .replace(/\s+/g, " ")
    .trim();
}

export function generateErrorSignature(trace: ParsedTrace): ErrorSignature {
  const testTitle = trace.metadata.testTitle ?? "unknown";
  const failedAction = trace.actions.find((a) => a.error);
  const rawError = failedAction?.error ?? null;

  const normalizedError = rawError ? normalizeError(rawError) : "no_error";
  const input = `${testTitle}::${normalizedError}`;
  const signature = createHash("sha1").update(input).digest("hex").slice(0, 12);

  return {
    signature,
    test_title: testTitle,
    normalized_error: normalizedError,
    raw_error: rawError,
    components: { test_title: testTitle, error_message: normalizedError },
  };
}

// ---------------------------------------------------------------------------
// compare_traces
// ---------------------------------------------------------------------------

export interface ActionDiff {
  index: number;
  type: string;
  passing_duration_ms: number;
  failing_duration_ms: number;
  delta_ms: number;
  passing_error: string | null;
  failing_error: string | null;
  is_divergence: boolean;
}

export interface TraceDiff {
  passing_test: string | null;
  failing_test: string | null;
  total_actions_passing: number;
  total_actions_failing: number;
  first_divergence_index: number | null;
  first_divergence_type: string | null;
  timing_anomalies: ActionDiff[];
  error_divergence: ActionDiff | null;
  network_summary: {
    passing_requests: number;
    failing_requests: number;
    only_in_failing: string[];
    only_in_passing: string[];
  };
}

const TIMING_THRESHOLD_MS = 500;

export function compareTraces(passing: ParsedTrace, failing: ParsedTrace): TraceDiff {
  const passingActions = passing.actions;
  const failingActions = failing.actions;
  const len = Math.min(passingActions.length, failingActions.length);

  const timing_anomalies: ActionDiff[] = [];
  let error_divergence: ActionDiff | null = null;
  let first_divergence_index: number | null = null;
  let first_divergence_type: string | null = null;

  for (let i = 0; i < len; i++) {
    const p = passingActions[i];
    const f = failingActions[i];

    // Structural divergence: different action types at same index
    if (p.type !== f.type && first_divergence_index === null) {
      first_divergence_index = i;
      first_divergence_type = `passing="${p.type}" vs failing="${f.type}"`;
    }

    const pDur = p.endTime - p.startTime;
    const fDur = f.endTime - f.startTime;
    const delta = Math.round(fDur - pDur);

    const diff: ActionDiff = {
      index: i,
      type: f.type,
      passing_duration_ms: Math.round(pDur),
      failing_duration_ms: Math.round(fDur),
      delta_ms: delta,
      passing_error: p.error ?? null,
      failing_error: f.error ?? null,
      is_divergence: Math.abs(delta) > TIMING_THRESHOLD_MS,
    };

    if (Math.abs(delta) > TIMING_THRESHOLD_MS) {
      timing_anomalies.push(diff);
    }

    // First action where failing has error but passing doesn't
    if (!p.error && f.error && !error_divergence) {
      error_divergence = { ...diff, is_divergence: true };
    }
  }

  // Network delta
  const passingUrls = new Set(passing.network.map((n) => n.url));
  const failingUrls = new Set(failing.network.map((n) => n.url));
  const only_in_failing = [...failingUrls].filter((u) => !passingUrls.has(u));
  const only_in_passing = [...passingUrls].filter((u) => !failingUrls.has(u));

  return {
    passing_test: passing.metadata.testTitle ?? null,
    failing_test: failing.metadata.testTitle ?? null,
    total_actions_passing: passingActions.length,
    total_actions_failing: failingActions.length,
    first_divergence_index,
    first_divergence_type,
    timing_anomalies,
    error_divergence,
    network_summary: {
      passing_requests: passing.network.length,
      failing_requests: failing.network.length,
      only_in_failing,
      only_in_passing,
    },
  };
}
