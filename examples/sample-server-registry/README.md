# Sample Server Registry

A minimal agent registry built with [`@slashfi/agents-sdk`](https://github.com/slashfi/agents-sdk) and [Hono](https://hono.dev).

Demonstrates the recommended pattern: **SDK handles MCP protocol, Hono handles everything else.**

## Quick Start

```bash
bun install
bun run dev
```

Open http://localhost:3000 for the landing page.

## Architecture

```
src/
  server.ts              # Hono app + SDK composition
  agents/
    weather.ts           # @weather agent (public, no auth)
    notes.ts             # @notes agent (internal, requires auth)
```

The key pattern:

```typescript
import { Hono } from "hono";
import { createAgentServer, createAgentRegistry } from "@slashfi/agents-sdk";

const app = new Hono();
const agentServer = createAgentServer(registry);

// SDK handles MCP protocol
app.post("/", (c) => agentServer.fetch(c.req.raw));
app.get("/health", (c) => agentServer.fetch(c.req.raw));
app.post("/oauth/token", (c) => agentServer.fetch(c.req.raw));

// Your routes
app.get("/", (c) => c.html("<h1>My Registry</h1>"));
app.get("/api/custom", (c) => c.json({ hello: "world" }));
```

## Agents

| Agent | Visibility | Tools |
|-------|-----------|-------|
| `@weather` | public | `get_weather`, `get_forecast` |
| `@notes` | internal | `create_note`, `list_notes`, `get_note`, `delete_note` |

**Public** agents can be called without auth. **Internal** agents require a Bearer token.

## Usage

### List agents

```bash
curl http://localhost:3000/list
```

### Call a public tool (no auth)

```bash
curl -X POST http://localhost:3000 \
  -H "Content-Type: application/json" \
  -d '{
    "jsonrpc": "2.0",
    "id": 1,
    "method": "tools/call",
    "params": {
      "name": "call_agent",
      "arguments": {
        "request": {
          "action": "execute_tool",
          "path": "@weather",
          "tool": "get_weather",
          "params": { "city": "san francisco" }
        }
      }
    }
  }'
```

### Auth flow (for internal agents)

```bash
# 1. Register a client (requires root key)
curl -X POST http://localhost:3000 \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer dev-root-key" \
  -d '{
    "jsonrpc": "2.0",
    "id": 1,
    "method": "tools/call",
    "params": {
      "name": "call_agent",
      "arguments": {
        "request": {
          "action": "execute_tool",
          "path": "@auth",
          "tool": "register",
          "params": { "name": "my-app" }
        }
      }
    }
  }'
# Returns: { clientId: "...", clientSecret: "..." }

# 2. Exchange for a token
curl -X POST http://localhost:3000/oauth/token \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "grant_type=client_credentials&client_id=CLIENT_ID&client_secret=CLIENT_SECRET"
# Returns: { access_token: "...", token_type: "Bearer", expires_in: 3600 }

# 3. Call internal agents
curl -X POST http://localhost:3000 \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer ACCESS_TOKEN" \
  -d '{
    "jsonrpc": "2.0",
    "id": 1,
    "method": "tools/call",
    "params": {
      "name": "call_agent",
      "arguments": {
        "request": {
          "action": "execute_tool",
          "path": "@notes",
          "tool": "create_note",
          "params": { "title": "Hello", "content": "World" }
        }
      }
    }
  }'
```

## MCP Compatibility

This server speaks the [Model Context Protocol](https://modelcontextprotocol.io/). Any MCP client can connect to it at `http://localhost:3000`. The server exposes two MCP tools:

- **`call_agent`** — Execute a tool on any registered agent
- **`list_agents`** — List agents and their tools
