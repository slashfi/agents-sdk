/**
 * Sample Server Registry
 *
 * Demonstrates how to build an agent server using Hono + @slashfi/agents-sdk.
 *
 * The SDK handles the MCP protocol (JSON-RPC, auth, tool routing).
 * Hono handles everything else (custom routes, middleware, HTML pages).
 *
 * Run: bun run dev
 */

import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import {
  createAgentRegistry,
  createAgentServer,
  createAuthAgent,
  createMemoryAuthStore,
} from "@slashfi/agents-sdk";

import { weatherAgent } from "./agents/weather.js";
import { notesAgent } from "./agents/notes.js";

// ============================================
// 1. Create registry and register agents
// ============================================

const ROOT_KEY = process.env.ROOT_KEY || "dev-root-key";

const registry = createAgentRegistry();

// Built-in auth agent (optional — remove for fully open registries)
registry.register(
  createAuthAgent({
    rootKey: ROOT_KEY,
    store: createMemoryAuthStore(),
  }),
);

// Your agents
registry.register(weatherAgent);
registry.register(notesAgent);

// ============================================
// 2. Create SDK server (MCP protocol handler)
// ============================================

const agentServer = createAgentServer(registry, {
  serverName: "sample-registry",
  serverVersion: "0.1.0",
});

// ============================================
// 3. Build Hono app
// ============================================

const app = new Hono();

// --- Middleware ---
app.use("*", logger());
app.use("*", cors());

// --- SDK routes (MCP protocol) ---
// Forward these to the SDK's fetch handler
app.post("/", (c) => agentServer.fetch(c.req.raw));
app.get("/health", (c) => agentServer.fetch(c.req.raw));
app.get("/list", (c) => agentServer.fetch(c.req.raw));
app.post("/oauth/token", (c) => agentServer.fetch(c.req.raw));

// --- Custom routes (your application code) ---

// Landing page
app.get("/", (c) => {
  const agents = registry.list();
  return c.html(`
    <!DOCTYPE html>
    <html>
    <head>
      <title>Sample Agent Registry</title>
      <style>
        body { font-family: system-ui, sans-serif; max-width: 640px; margin: 40px auto; padding: 0 20px; color: #1a1a1a; }
        h1 { font-size: 24px; }
        .agent { background: #f5f5f5; border-radius: 8px; padding: 16px; margin: 12px 0; }
        .agent h3 { margin: 0 0 4px; font-size: 16px; }
        .agent p { margin: 0; color: #666; font-size: 14px; }
        .tools { margin-top: 8px; display: flex; gap: 6px; flex-wrap: wrap; }
        .tool { background: #e0e0e0; padding: 2px 8px; border-radius: 4px; font-size: 12px; font-family: monospace; }
        code { background: #f0f0f0; padding: 2px 6px; border-radius: 3px; font-size: 13px; }
        pre { background: #1a1a1a; color: #e0e0e0; padding: 16px; border-radius: 8px; overflow-x: auto; font-size: 13px; }
      </style>
    </head>
    <body>
      <h1>\uD83E\uDD16 Sample Agent Registry</h1>
      <p>MCP-compatible agent server built with <code>@slashfi/agents-sdk</code> + <code>hono</code></p>

      <h2>Registered Agents</h2>
      ${agents
        .filter((a) => !a.path.startsWith("@auth"))
        .map(
          (a) => `
        <div class="agent">
          <h3>${a.config?.name || a.path}</h3>
          <p>${a.config?.description || "No description"}</p>
          <div class="tools">
            ${a.tools.map((t) => `<span class="tool">${t.name}</span>`).join("")}
          </div>
        </div>
      `,
        )
        .join("")}

      <h2>Try it</h2>
      <pre>curl http://localhost:3000/list

# Call a tool via MCP JSON-RPC
curl -X POST http://localhost:3000 \\
  -H "Content-Type: application/json" \\
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
  }'</pre>

      <h2>Auth</h2>
      <p>The <code>@weather</code> agent is <strong>public</strong> (no auth needed).</p>
      <p>The <code>@notes</code> agent is <strong>internal</strong> (requires a Bearer token).</p>
      <pre># Register a client
curl -X POST http://localhost:3000 \\
  -H "Content-Type: application/json" \\
  -H "Authorization: Bearer ${ROOT_KEY}" \\
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

# Exchange credentials for a token
curl -X POST http://localhost:3000/oauth/token \\
  -H "Content-Type: application/x-www-form-urlencoded" \\
  -d "grant_type=client_credentials&amp;client_id=CLIENT_ID&amp;client_secret=CLIENT_SECRET"</pre>
    </body>
    </html>
  `);
});

// Custom API endpoint (not MCP — just a regular REST route)
app.get("/api/cities", (c) => {
  return c.json({
    message: "This is a custom route, not part of MCP.",
    cities: ["san francisco", "new york", "miami", "seattle", "austin"],
  });
});

// ============================================
// 4. Start
// ============================================

const port = Number(process.env.PORT) || 3000;

console.log(`\n  Sample Agent Registry`);
console.log(`  http://localhost:${port}\n`);
console.log(`  MCP endpoint:  POST http://localhost:${port}/`);
console.log(`  Agent list:    GET  http://localhost:${port}/list`);
console.log(`  Health:        GET  http://localhost:${port}/health`);
console.log(`  Custom route:  GET  http://localhost:${port}/api/cities`);
console.log(`  Root key:      ${ROOT_KEY}\n`);

export default {
  port,
  fetch: app.fetch,
};
