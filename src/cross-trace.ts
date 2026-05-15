import { createHash } from "crypto";
import { ParsedTrace, TraceAction } from "./types.js";

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
// compare_traces — fuzzy alignment via LCS on type|locator key
// ---------------------------------------------------------------------------

export interface AlignedActionDiff {
  passing_index: number;
  failing_index: number;
  type: string;
  passing_duration_ms: number;
  failing_duration_ms: number;
  delta_ms: number;
  passing_error: string | null;
  failing_error: string | null;
  is_timing_anomaly: boolean;
}

export interface UnmatchedAction {
  index: number;
  type: string;
  locator: string | undefined;
  error: string | undefined;
}

export interface TraceDiff {
  passing_test: string | null;
  failing_test: string | null;
  total_actions_passing: number;
  total_actions_failing: number;
  aligned_count: number;
  first_structural_divergence: {
    passing_index: number;
    failing_index: number;
    description: string;
  } | null;
  timing_anomalies: AlignedActionDiff[];
  error_divergence: AlignedActionDiff | null;
  only_in_passing: UnmatchedAction[];
  only_in_failing: UnmatchedAction[];
  network_summary: {
    passing_requests: number;
    failing_requests: number;
    only_in_failing: string[];
    only_in_passing: string[];
  };
}

const TIMING_THRESHOLD_MS = 500;

function actionKey(action: TraceAction): string {
  return `${action.type}|${action.locator ?? ""}`;
}

function lcsIndices(passing: TraceAction[], failing: TraceAction[]): [number, number][] {
  const m = passing.length;
  const n = failing.length;

  // Build LCS DP table
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (actionKey(passing[i - 1]) === actionKey(failing[j - 1])) {
        dp[i][j] = dp[i - 1][j - 1] + 1;
      } else {
        dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
      }
    }
  }

  // Backtrack to extract matched index pairs
  const pairs: [number, number][] = [];
  let i = m;
  let j = n;
  while (i > 0 && j > 0) {
    if (actionKey(passing[i - 1]) === actionKey(failing[j - 1])) {
      pairs.unshift([i - 1, j - 1]);
      i--;
      j--;
    } else if (dp[i - 1][j] >= dp[i][j - 1]) {
      i--;
    } else {
      j--;
    }
  }

  return pairs;
}

export function compareTraces(passing: ParsedTrace, failing: ParsedTrace): TraceDiff {
  const passingActions = passing.actions;
  const failingActions = failing.actions;

  const pairs = lcsIndices(passingActions, failingActions);

  const matchedPassingIdx = new Set(pairs.map(([pi]) => pi));
  const matchedFailingIdx = new Set(pairs.map(([, fi]) => fi));

  // Unmatched actions
  const only_in_passing: UnmatchedAction[] = passingActions
    .map((a, i) => ({ a, i }))
    .filter(({ i }) => !matchedPassingIdx.has(i))
    .map(({ a, i }) => ({ index: i, type: a.type, locator: a.locator, error: a.error }));

  const only_in_failing: UnmatchedAction[] = failingActions
    .map((a, i) => ({ a, i }))
    .filter(({ i }) => !matchedFailingIdx.has(i))
    .map(({ a, i }) => ({ index: i, type: a.type, locator: a.locator, error: a.error }));

  // Compare matched pairs
  const timing_anomalies: AlignedActionDiff[] = [];
  let error_divergence: AlignedActionDiff | null = null;

  for (const [pi, fi] of pairs) {
    const p = passingActions[pi];
    const f = failingActions[fi];
    const pDur = p.endTime - p.startTime;
    const fDur = f.endTime - f.startTime;
    const delta = Math.round(fDur - pDur);

    const diff: AlignedActionDiff = {
      passing_index: pi,
      failing_index: fi,
      type: f.type,
      passing_duration_ms: Math.round(pDur),
      failing_duration_ms: Math.round(fDur),
      delta_ms: delta,
      passing_error: p.error ?? null,
      failing_error: f.error ?? null,
      is_timing_anomaly: Math.abs(delta) > TIMING_THRESHOLD_MS,
    };

    if (Math.abs(delta) > TIMING_THRESHOLD_MS) {
      timing_anomalies.push(diff);
    }

    if (!p.error && f.error && !error_divergence) {
      error_divergence = { ...diff, is_timing_anomaly: false };
    }
  }

  // First structural divergence: earliest position where sequences are no longer in sync
  let first_structural_divergence: TraceDiff["first_structural_divergence"] = null;
  for (let k = 0; k < pairs.length - 1; k++) {
    const [pi, fi] = pairs[k];
    const [nextPi, nextFi] = pairs[k + 1];
    // Gap in either sequence means skipped (unmatched) actions between these two points
    if (nextPi - pi > 1 || nextFi - fi > 1) {
      first_structural_divergence = {
        passing_index: pi,
        failing_index: fi,
        description:
          `after matched action "${passingActions[pi].type}" ` +
          `(passing[${pi}] / failing[${fi}]): ` +
          `${nextPi - pi - 1} unmatched in passing, ${nextFi - fi - 1} unmatched in failing`,
      };
      break;
    }
  }

  // Network delta
  const passingUrls = new Set(passing.network.map((n) => n.url));
  const failingUrls = new Set(failing.network.map((n) => n.url));

  return {
    passing_test: passing.metadata.testTitle ?? null,
    failing_test: failing.metadata.testTitle ?? null,
    total_actions_passing: passingActions.length,
    total_actions_failing: failingActions.length,
    aligned_count: pairs.length,
    first_structural_divergence,
    timing_anomalies,
    error_divergence,
    only_in_passing,
    only_in_failing,
    network_summary: {
      passing_requests: passing.network.length,
      failing_requests: failing.network.length,
      only_in_failing: [...failingUrls].filter((u) => !passingUrls.has(u)),
      only_in_passing: [...passingUrls].filter((u) => !failingUrls.has(u)),
    },
  };
}
