#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import * as z from "zod/v4";
import { parseTraceZip } from "./trace-parser.js";

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

server.registerTool(
  "get_test_metadata",
  {
    description: "Returns test metadata: title, browser, platform, viewport, and start time",
    inputSchema: traceInputSchema,
  },
  async ({ trace_path }) => {
    const trace = await parseTraceZip(trace_path);
    return {
      content: [{ type: "text", text: JSON.stringify(trace.metadata, null, 2) }],
    };
  }
);

server.registerTool(
  "get_trace_summary",
  {
    description: "Returns the failing action and top-level error message from a Playwright trace",
    inputSchema: traceInputSchema,
  },
  async ({ trace_path }) => {
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
  }
);

server.registerTool(
  "get_console_errors",
  {
    description: "Returns JS exceptions and warnings. Use limit/offset to page through results.",
    inputSchema: paginatedTraceInputSchema,
  },
  async ({ trace_path, limit, offset }) => {
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
  }
);

server.registerTool(
  "get_element_state_at_failure",
  {
    description: "Returns DOM attributes of the failing element at the moment of failure",
    inputSchema: traceInputSchema,
  },
  async ({ trace_path }) => {
    const trace = await parseTraceZip(trace_path);
    const failedAction = trace.actions.find((a) => a.error);
    if (!failedAction) {
      return {
        content: [{ type: "text", text: JSON.stringify({ message: "No failure found in trace" }) }],
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
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
