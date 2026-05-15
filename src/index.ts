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
    description: "Returns a structured timeline of all actions with locators and timings",
    inputSchema: traceInputSchema,
  },
  async ({ trace_path }) => {
    const trace = await parseTraceZip(trace_path);
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(trace.actions, null, 2),
        },
      ],
    };
  }
);

server.registerTool(
  "get_filtered_network_logs",
  {
    description: "Returns only 4xx/5xx network responses, stripping static assets",
    inputSchema: traceInputSchema,
  },
  async ({ trace_path }) => {
    const trace = await parseTraceZip(trace_path);
    const STATIC_MIME = ["text/css", "text/javascript", "font/", "image/", "video/", "audio/"];
    const errors = trace.network.filter(
      (n) => n.status >= 400 && !STATIC_MIME.some((m) => n.mimeType.startsWith(m))
    );
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({ error_requests: errors, count: errors.length }, null, 2),
        },
      ],
    };
  }
);

server.registerTool(
  "get_console_errors",
  {
    description: "Returns JS exceptions and errors separated from assertion errors",
    inputSchema: traceInputSchema,
  },
  async ({ trace_path }) => {
    const trace = await parseTraceZip(trace_path);
    const errors = trace.console.filter((c) => c.type === "error");
    const warnings = trace.console.filter((c) => c.type === "warning");
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({ errors, warnings, total_messages: trace.console.length }, null, 2),
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
