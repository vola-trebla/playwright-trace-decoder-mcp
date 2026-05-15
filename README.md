# 🎭 playwright-trace-decoder-mcp

An MCP server that unpacks and structures Playwright `trace.zip` archives so AI agents can perform root-cause analysis on CI failures — without drowning in raw JSON or blowing up the context window.

## 🤔 The Problem

When a Playwright test fails in CI, you get a `trace.zip`. It's a binary blob. LLMs can't read it natively, and dumping the raw contents exceeds the context window. Engineers end up copying log snippets into ChatGPT manually like it's 2022.

This MCP server solves that: 12 focused tools that expose exactly the signal an agent needs to diagnose a failure, with pagination and ARIA compression to keep token costs low.

## 🛠️ Tools

Tools are grouped by how an agent should sequence them when diagnosing a failure.

### Inspection — read trace data

| Tool | Arguments | What it returns |
|------|-----------|----------------|
| `get_test_metadata` | `trace_path` | Browser, platform, viewport, test title, wall-clock start time |
| `get_trace_summary` | `trace_path` | Failing action + top-level error + total action count |
| `get_action_timeline` | `trace_path`, `limit`, `offset` | Paginated list of all actions with API names, locators, and timings |
| `get_filtered_network_logs` | `trace_path`, `limit`, `offset` | Only 4xx/5xx responses — static assets (CSS, JS, fonts, images) stripped |
| `get_console_errors` | `trace_path`, `limit`, `offset` | JS exceptions and warnings from the browser console |
| `get_element_state_at_failure` | `trace_path` | Failing locator, error message, and raw before/after metadata |

All list-returning tools support `limit` (1–500, default 50) and `offset` pagination with a `has_more` flag.

### DOM / UI analysis

| Tool | Arguments | What it returns |
|------|-----------|----------------|
| `get_aria_accessibility_tree` | `trace_path`, `action_index?` | ARIA accessibility tree as compact YAML (~90% fewer tokens than raw HTML). Defaults to the snapshot at the failed action. |
| `get_dom_mutation_delta` | `trace_path`, `action_index` | Set-diff of ARIA lines before vs after a specific action — added/removed elements only, not two full DOM dumps |
| `analyze_race_conditions` | `trace_path` | Network requests that were in-flight when an interaction or assertion fired |

### Root-cause analysis

| Tool | Arguments | What it returns |
|------|-----------|----------------|
| `get_causal_chain_for_failure` | `trace_path`, `lookback_ms?` | Chronological chain of preceding actions, network errors, and console errors leading to the failure (default window: 5 s) |
| `generate_error_signature` | `trace_path` | Stable 12-char SHA-1 hash of the normalized error — use to group duplicate failures across parallel CI runs |
| `compare_traces` | `passing_trace_path`, `failing_trace_path` | Action-sequence alignment between a passing and failing run: first structural divergence, timing anomalies (>500 ms), network delta |

## 💬 Suggested agent workflow

```
get_trace_summary          ← what failed?
get_causal_chain_for_failure ← what led up to it?
get_aria_accessibility_tree  ← what did the page look like?
get_dom_mutation_delta       ← what changed right before the failure?
analyze_race_conditions      ← was a network request still pending?
compare_traces               ← flaky? compare to a passing run
```

## 🚀 Setup

### Build from source

```bash
git clone https://github.com/vola-trebla/playwright-trace-decoder-mcp.git
cd playwright-trace-decoder-mcp
npm install
npm run build
```

### Add to your MCP client

#### Claude Desktop (`~/Library/Application Support/Claude/claude_desktop_config.json`)

```json
{
  "mcpServers": {
    "playwright-trace-decoder": {
      "command": "node",
      "args": ["/absolute/path/to/playwright-trace-decoder-mcp/dist/index.js"]
    }
  }
}
```

#### Cursor (`.cursor/mcp.json`)

```json
{
  "mcpServers": {
    "playwright-trace-decoder": {
      "command": "node",
      "args": ["/absolute/path/to/playwright-trace-decoder-mcp/dist/index.js"]
    }
  }
}
```

#### Claude Code

```bash
claude mcp add playwright-trace-decoder \
  node /absolute/path/to/playwright-trace-decoder-mcp/dist/index.js
```

## 💬 Example usage

Once connected, ask your agent:

> *"The CI run failed. Here's the trace: `/tmp/trace.zip`. What went wrong and why?"*

The agent will call `get_trace_summary` first, then drill into `get_causal_chain_for_failure`, `get_aria_accessibility_tree`, and `analyze_race_conditions` as needed — without you copy-pasting anything.

To diagnose flakiness:

> *"This test passes locally but fails in CI. Compare these two traces and tell me what was different."*

The agent uses `compare_traces` to align both runs and surfaces the first timing or structural divergence.

## 🏗️ Architecture

```
trace.zip
  ├── *.trace     → JSONL: before/after action pairs, console events, frame snapshots
  └── *.network   → JSONL: HAR resource-snapshot entries
```

The parser streams each file line-by-line (no full-buffer split) and caches results in-process, keyed by path + mtime. Re-reading the same unmodified trace costs zero I/O.

Frame snapshots store the DOM as nested arrays (`["TAG", {attrs}, ...children]`). The ARIA translator walks this tree and outputs compact YAML, reducing token cost by ~90% vs raw HTML.

## 🏗️ Stack

- [`@modelcontextprotocol/sdk`](https://github.com/modelcontextprotocol/typescript-sdk) — MCP server runtime
- [`adm-zip`](https://github.com/cthackers/adm-zip) — zip extraction
- [`zod`](https://zod.dev) v4 — input schema validation
- TypeScript, ESLint, Prettier, Husky, GitHub Actions CI

## 📋 Scripts

```bash
npm run build        # compile TypeScript → dist/
npm run lint         # ESLint
npm run format       # Prettier --write
npm run format:check # Prettier check (used in CI)
```

## 📄 License

MIT
