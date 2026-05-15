# 🎭 playwright-trace-decoder-mcp

An MCP server that unpacks and structures Playwright `trace.zip` archives so AI agents can perform root-cause analysis on CI failures — without drowning in raw JSON or blowing up the context window.

## 🤔 The Problem

When a Playwright test fails in CI, you get a `trace.zip`. It's a binary blob. LLMs can't read it natively, and dumping the raw contents exceeds the context window. Engineers end up copying log snippets into ChatGPT manually like it's 2022.

This MCP server solves that.

## 🛠️ Tools

| Tool | What it returns |
|------|----------------|
| `get_trace_summary` | The failing action + top-level error message |
| `get_action_timeline` | All actions with API names, locators, and timings |
| `get_filtered_network_logs` | Only 4xx/5xx responses, static assets stripped |
| `get_console_errors` | JS exceptions and warnings from the browser console |
| `get_element_state_at_failure` | The failing locator, error message, and raw metadata at the exact moment of failure |

Every tool takes a single argument: `trace_path` — the absolute path to your `trace.zip`.

## 🚀 Setup

### 1. Install

```bash
npm install -g playwright-trace-decoder-mcp
# or run directly with npx
npx playwright-trace-decoder-mcp
```

### 2. Build from source

```bash
git clone https://github.com/vola-trebla/playwright-trace-decoder-mcp.git
cd playwright-trace-decoder-mcp
npm install
npm run build
```

### 3. Add to your MCP client

#### Claude Desktop (`~/Library/Application Support/Claude/claude_desktop_config.json`)

```json
{
  "mcpServers": {
    "playwright-trace-decoder": {
      "command": "npx",
      "args": ["playwright-trace-decoder-mcp"]
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

## 💬 Example Usage

Once connected, ask your AI agent:

> *"The CI run failed. Here's the trace: `/tmp/trace.zip`. What went wrong?"*

The agent will call `get_trace_summary` first, then drill into `get_element_state_at_failure` or `get_filtered_network_logs` as needed — without you copy-pasting anything.

## 🏗️ Stack

- [`@modelcontextprotocol/sdk`](https://github.com/modelcontextprotocol/typescript-sdk) — MCP server runtime
- [`adm-zip`](https://github.com/cthackers/adm-zip) — zip extraction
- [`zod`](https://zod.dev) v4 — input schema validation
- TypeScript, ESLint, Prettier, Husky

## 📋 Scripts

```bash
npm run build        # compile TypeScript → dist/
npm run lint         # ESLint
npm run format       # Prettier --write
npm run format:check # Prettier check (used in CI)
```

## 🗺️ Roadmap

- [ ] Support for remote traces (URL input)
- [ ] `get_screenshot_at_failure` — base64 screenshot from the trace
- [ ] Integration with [Flakiness Knowledge Graph MCP](../flakiness-knowledge-graph-mcp) for historical context

## 📄 License

MIT
