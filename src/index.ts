#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import * as z from "zod/v4";
import { parseTraceZip } from "./trace-parser.js";
import { snapshotToAriaYaml } from "./aria-translator.js";
import { analyzeRaceConditions, getDomMutationDelta, getCausalChain } from "./diagnostics.js";
import { generateErrorSignature, compareTraces } from "./cross-trace.js";

const server = new McpServer({
  name: "playwright-trace-decoder",
  version: "0.1.0",
});

const traceInputSchema = z.object({
  trace_path: z.string().describe("Absolute path to trace.zip"),
});

const paginatedTraceInputSchema = traceInputSchema.extend({
  limit: z.number().int().min(1).max(500).default(50).describe("Max items to return"),
  offset: z.number().int().min(0).default(0).describe("Number of items to skip"),
});

function errorResponse(err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
  return { content: [{ type: "text" as const, text: `Error: ${message}` }] };
}

server.registerTool(
  "get_test_metadata",
  {
    description: "Returns test metadata: title, browser, platform, viewport, and start time",
    inputSchema: traceInputSchema,
  },
  async ({ trace_path }) => {
    try {
      const trace = await parseTraceZip(trace_path);
      return {
        content: [{ type: "text", text: JSON.stringify(trace.metadata, null, 2) }],
      };
    } catch (err) {
      return errorResponse(err);
    }
  }
);

server.registerTool(
  "get_trace_summary",
  {
    description: "Returns the failing action and top-level error message from a Playwright trace",
    inputSchema: traceInputSchema,
  },
  async ({ trace_path }) => {
    try {
      const trace = await parseTraceZip(trace_path);
      const failedAction = trace.actions.find((a) => a.error);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                metadata: trace.metadata,
                failed_action: failedAction ?? null,
                total_actions: trace.actions.length,
                has_errors: !!failedAction,
              },
              null,
              2
            ),
          },
        ],
      };
    } catch (err) {
      return errorResponse(err);
    }
  }
);

server.registerTool(
  "get_action_timeline",
  {
    description:
      "Returns a paginated timeline of all actions with locators and timings. Use limit/offset to page through large traces.",
    inputSchema: paginatedTraceInputSchema,
  },
  async ({ trace_path, limit, offset }) => {
    try {
      const trace = await parseTraceZip(trace_path);
      const page = trace.actions.slice(offset, offset + limit);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                total: trace.actions.length,
                offset,
                limit,
                has_more: offset + limit < trace.actions.length,
                actions: page,
              },
              null,
              2
            ),
          },
        ],
      };
    } catch (err) {
      return errorResponse(err);
    }
  }
);

server.registerTool(
  "get_filtered_network_logs",
  {
    description:
      "Returns only 4xx/5xx network responses, stripping static assets. Use limit/offset to page through results.",
    inputSchema: paginatedTraceInputSchema,
  },
  async ({ trace_path, limit, offset }) => {
    try {
      const trace = await parseTraceZip(trace_path);
      const STATIC_MIME = ["text/css", "text/javascript", "font/", "image/", "video/", "audio/"];
      const errors = trace.network.filter(
        (n) => n.status >= 400 && !STATIC_MIME.some((m) => n.mimeType.startsWith(m))
      );
      const page = errors.slice(offset, offset + limit);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                total: errors.length,
                offset,
                limit,
                has_more: offset + limit < errors.length,
                error_requests: page,
              },
              null,
              2
            ),
          },
        ],
      };
    } catch (err) {
      return errorResponse(err);
    }
  }
);

server.registerTool(
  "get_console_errors",
  {
    description: "Returns JS exceptions and warnings. Use limit/offset to page through results.",
    inputSchema: paginatedTraceInputSchema,
  },
  async ({ trace_path, limit, offset }) => {
    try {
      const trace = await parseTraceZip(trace_path);
      const errors = trace.console.filter((c) => c.type === "error");
      const warnings = trace.console.filter((c) => c.type === "warning");
      const pagedErrors = errors.slice(offset, offset + limit);
      const pagedWarnings = warnings.slice(offset, offset + limit);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                total_errors: errors.length,
                total_warnings: warnings.length,
                total_messages: trace.console.length,
                offset,
                limit,
                has_more: offset + limit < Math.max(errors.length, warnings.length),
                errors: pagedErrors,
                warnings: pagedWarnings,
              },
              null,
              2
            ),
          },
        ],
      };
    } catch (err) {
      return errorResponse(err);
    }
  }
);

server.registerTool(
  "get_aria_accessibility_tree",
  {
    description:
      "Returns the ARIA accessibility tree (YAML) for a frame snapshot in the trace. " +
      "Reduces DOM token cost by ~90% vs raw HTML. Use action_index to target a specific action — " +
      "defaults to the failed action, or the last snapshot if no failure.",
    inputSchema: traceInputSchema.extend({
      action_index: z
        .number()
        .int()
        .min(0)
        .optional()
        .describe(
          "Index of the action whose snapshot to use (0-based). Defaults to failed action."
        ),
    }),
  },
  async ({ trace_path, action_index }) => {
    try {
      const trace = await parseTraceZip(trace_path);

      if (trace.snapshots.length === 0) {
        return {
          content: [{ type: "text", text: "No frame snapshots found in this trace." }],
        };
      }

      let snapshot = trace.snapshots[trace.snapshots.length - 1];

      if (action_index !== undefined) {
        const action = trace.actions[action_index];
        if (action) {
          const callId = (action.metadata as Record<string, { callId?: string }>)?.before?.callId;
          const match = trace.snapshots.find(
            (s) => s.callId === callId && s.snapshotName.startsWith("after@")
          );
          if (match) snapshot = match;
        }
      } else {
        const failed = trace.actions.find((a) => a.error);
        if (failed) {
          const callId = (failed.metadata as Record<string, { callId?: string }>)?.before?.callId;
          const match = trace.snapshots.find(
            (s) => s.callId === callId && s.snapshotName.startsWith("before@")
          );
          if (match) snapshot = match;
        }
      }

      const yaml = snapshotToAriaYaml(snapshot.html);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                snapshot_name: snapshot.snapshotName,
                frame_url: snapshot.frameUrl,
                timestamp: snapshot.timestamp,
                aria_tree: yaml,
              },
              null,
              2
            ),
          },
        ],
      };
    } catch (err) {
      return errorResponse(err);
    }
  }
);

server.registerTool(
  "get_element_state_at_failure",
  {
    description: "Returns DOM attributes of the failing element at the moment of failure",
    inputSchema: traceInputSchema,
  },
  async ({ trace_path }) => {
    try {
      const trace = await parseTraceZip(trace_path);
      const failedAction = trace.actions.find((a) => a.error);
      if (!failedAction) {
        return {
          content: [
            { type: "text", text: JSON.stringify({ message: "No failure found in trace" }) },
          ],
        };
      }
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                failed_action: failedAction.type,
                locator: failedAction.locator,
                error: failedAction.error,
                time: failedAction.startTime,
                raw: failedAction.metadata,
              },
              null,
              2
            ),
          },
        ],
      };
    } catch (err) {
      return errorResponse(err);
    }
  }
);

server.registerTool(
  "analyze_race_conditions",
  {
    description:
      "Detects potential race conditions by finding network requests that were still " +
      "in-flight when a user interaction action fired. Returns flagged actions with pending requests.",
    inputSchema: traceInputSchema,
  },
  async ({ trace_path }) => {
    try {
      const trace = await parseTraceZip(trace_path);
      const results = analyzeRaceConditions(trace);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              { total_flagged: results.length, race_conditions: results },
              null,
              2
            ),
          },
        ],
      };
    } catch (err) {
      return errorResponse(err);
    }
  }
);

server.registerTool(
  "get_dom_mutation_delta",
  {
    description:
      "Diffs the ARIA tree before and after a specific action. Returns added and removed " +
      "elements so the agent sees exactly what changed without comparing two full DOM dumps.",
    inputSchema: traceInputSchema.extend({
      action_index: z
        .number()
        .int()
        .min(0)
        .describe("Index of the action to diff (0-based, from get_action_timeline)"),
    }),
  },
  async ({ trace_path, action_index }) => {
    try {
      const trace = await parseTraceZip(trace_path);
      const delta = getDomMutationDelta(trace, action_index);
      return {
        content: [{ type: "text", text: JSON.stringify(delta, null, 2) }],
      };
    } catch (err) {
      return errorResponse(err);
    }
  }
);

server.registerTool(
  "get_causal_chain_for_failure",
  {
    description:
      "Walks backwards from the failed action and builds a chronological chain of " +
      "preceding actions, network errors, and console errors. Surfaces the most likely root cause.",
    inputSchema: traceInputSchema.extend({
      lookback_ms: z
        .number()
        .int()
        .min(100)
        .max(30000)
        .default(5000)
        .describe("How far back from the failure to look, in milliseconds (default 5000)"),
    }),
  },
  async ({ trace_path, lookback_ms }) => {
    try {
      const trace = await parseTraceZip(trace_path);
      const chain = getCausalChain(trace, lookback_ms);
      return {
        content: [{ type: "text", text: JSON.stringify(chain, null, 2) }],
      };
    } catch (err) {
      return errorResponse(err);
    }
  }
);

server.registerTool(
  "generate_error_signature",
  {
    description:
      "Generates a stable 12-char hash signature for a test failure by normalizing the " +
      "error message (stripping paths, numbers, UUIDs). Use to group duplicate failures " +
      "across parallel CI runs without reading each trace manually.",
    inputSchema: traceInputSchema,
  },
  async ({ trace_path }) => {
    try {
      const trace = await parseTraceZip(trace_path);
      const sig = generateErrorSignature(trace);
      return {
        content: [{ type: "text", text: JSON.stringify(sig, null, 2) }],
      };
    } catch (err) {
      return errorResponse(err);
    }
  }
);

server.registerTool(
  "compare_traces",
  {
    description:
      "Compares a passing and a failing trace of the same test. Aligns actions by sequence, " +
      "finds the first timing or structural divergence, and summarises network differences. " +
      "Use to diagnose flakiness — what was different in the run that failed.",
    inputSchema: z.object({
      passing_trace_path: z.string().describe("Absolute path to the passing trace.zip"),
      failing_trace_path: z.string().describe("Absolute path to the failing trace.zip"),
    }),
  },
  async ({ passing_trace_path, failing_trace_path }) => {
    try {
      const [passing, failing] = await Promise.all([
        parseTraceZip(passing_trace_path),
        parseTraceZip(failing_trace_path),
      ]);
      const diff = compareTraces(passing, failing);
      return {
        content: [{ type: "text", text: JSON.stringify(diff, null, 2) }],
      };
    } catch (err) {
      return errorResponse(err);
    }
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
