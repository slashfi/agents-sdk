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
app.get("/agents", (c) => agentServer.fetch(c.req.raw));
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
      <meta name="viewport" content="width=device-width, initial-scale=1">
      <style>
        * { box-sizing: border-box; margin: 0; padding: 0; }
        body {
          font-family: -apple-system, BlinkMacSystemFont, 'SF Pro Display', 'Segoe UI', sans-serif;
          background: #f9f8f7;
          color: #1a1917;
          -webkit-font-smoothing: antialiased;
          min-height: 100vh;
        }
        .page {
          max-width: 720px;
          margin: 0 auto;
          padding: 48px 24px;
        }
        .header {
          margin-bottom: 32px;
        }
        .header h1 {
          font-size: 22px;
          font-weight: 600;
          letter-spacing: -0.02em;
          margin-bottom: 6px;
        }
        .header p {
          font-size: 14px;
          color: #6b6560;
          line-height: 1.5;
        }
        .section {
          margin-bottom: 24px;
        }
        .section-title {
          font-size: 12px;
          font-weight: 600;
          text-transform: uppercase;
          letter-spacing: 0.05em;
          color: #9c958e;
          margin-bottom: 10px;
        }
        .card {
          background: #fff;
          border: 1px solid #d9d6ce;
          border-radius: 8px;
          box-shadow: 0 1px 1px rgba(21,20,15,.05);
          overflow: hidden;
        }
        .agent-row {
          padding: 14px 16px;
          display: flex;
          align-items: flex-start;
          justify-content: space-between;
          gap: 12px;
          transition: background 0.1s;
        }
        .agent-row:not(:last-child) {
          border-bottom: 1px solid #eae7e2;
        }
        .agent-row:hover {
          background: #faf9f7;
        }
        .agent-info h3 {
          font-size: 14px;
          font-weight: 600;
          margin-bottom: 2px;
        }
        .agent-info p {
          font-size: 13px;
          color: #6b6560;
        }
        .agent-meta {
          display: flex;
          align-items: center;
          gap: 6px;
          flex-shrink: 0;
        }
        .badge {
          font-size: 11px;
          font-weight: 500;
          padding: 2px 8px;
          border-radius: 10px;
          white-space: nowrap;
        }
        .badge-public {
          background: #e8f5e8;
          color: #2d6a2e;
        }
        .badge-internal {
          background: #fef3e2;
          color: #8a6318;
        }
        .tools {
          display: flex;
          gap: 4px;
          flex-wrap: wrap;
          margin-top: 6px;
        }
        .tool {
          font-size: 11px;
          font-family: 'SF Mono', Menlo, monospace;
          color: #6b6560;
          background: #f4f3f1;
          border: 1px solid #eae7e2;
          padding: 1px 7px;
          border-radius: 4px;
        }
        .code-card {
          background: #1a1917;
          border: 1px solid #2d2c28;
          border-radius: 8px;
          overflow: hidden;
        }
        .code-header {
          padding: 10px 14px;
          font-size: 12px;
          font-weight: 500;
          color: #9c958e;
          background: #222120;
          border-bottom: 1px solid #2d2c28;
          display: flex;
          align-items: center;
          justify-content: space-between;
        }
        .code-body {
          padding: 14px;
          font-family: 'SF Mono', Menlo, monospace;
          font-size: 12.5px;
          line-height: 1.6;
          color: #c9c5bf;
          overflow-x: auto;
          white-space: pre;
        }
        .code-body .comment { color: #6b6560; }
        .code-body .string { color: #c4982a; }
        .code-body .key { color: #a8c4a0; }
        code {
          font-family: 'SF Mono', Menlo, monospace;
          font-size: 12.5px;
          background: #f4f3f1;
          border: 1px solid #eae7e2;
          padding: 1px 5px;
          border-radius: 4px;
        }
        .endpoints {
          display: grid;
          gap: 1px;
          background: #eae7e2;
          border: 1px solid #d9d6ce;
          border-radius: 8px;
          overflow: hidden;
        }
        .endpoint {
          display: flex;
          align-items: center;
          gap: 10px;
          padding: 10px 14px;
          background: #fff;
          font-size: 13px;
        }
        .method {
          font-family: 'SF Mono', Menlo, monospace;
          font-size: 11px;
          font-weight: 600;
          padding: 2px 6px;
          border-radius: 4px;
          min-width: 40px;
          text-align: center;
        }
        .method-get { background: #e8f5e8; color: #2d6a2e; }
        .method-post { background: #e5edff; color: #2952a3; }
        .endpoint-path {
          font-family: 'SF Mono', Menlo, monospace;
          font-size: 13px;
          color: #1a1917;
        }
        .endpoint-desc {
          color: #9c958e;
          font-size: 12px;
          margin-left: auto;
        }
        .footer {
          text-align: center;
          padding: 24px 0;
          font-size: 12px;
          color: #9c958e;
        }
        .footer a { color: #c4982a; text-decoration: none; }
        .footer a:hover { text-decoration: underline; }
      </style>
    </head>
    <body>
      <div class="page">
        <div class="header">
          <h1>Agent Registry</h1>
          <p>MCP-compatible agent server built with <code>@slashfi/agents-sdk</code> + <code>hono</code></p>
        </div>

        <div class="section">
          <div class="section-title">Agents</div>
          <div class="card">
            ${agents
              .filter((a: any) => !a.path.startsWith("@auth"))
              .map(
                (a: any) => `
              <div class="agent-row">
                <div class="agent-info">
                  <h3>${a.config?.name || a.path}</h3>
                  <p>${a.config?.description || "No description"}</p>
                  <div class="tools">
                    ${a.tools.map((t: any) => `<span class="tool">${t.name}</span>`).join("")}
                  </div>
                </div>
                <div class="agent-meta">
                  <span class="badge ${a.visibility === "public" ? "badge-public" : "badge-internal"}">${a.visibility === "public" ? "public" : "internal"}</span>
                </div>
              </div>
            `,
              )
              .join("")}
          </div>
        </div>

        <div class="section">
          <div class="section-title">Endpoints</div>
          <div class="endpoints">
            <div class="endpoint">
              <span class="method method-post">POST</span>
              <span class="endpoint-path">/</span>
              <span class="endpoint-desc">MCP JSON-RPC</span>
            </div>
            <div class="endpoint">
              <span class="method method-get">GET</span>
              <span class="endpoint-path">/agents</span>
              <span class="endpoint-desc">List public agents (HTTP)</span>
            </div>
            <div class="endpoint">
              <span class="method method-get">GET</span>
              <span class="endpoint-path">/health</span>
              <span class="endpoint-desc">Health check</span>
            </div>
            <div class="endpoint">
              <span class="method method-post">POST</span>
              <span class="endpoint-path">/oauth/token</span>
              <span class="endpoint-desc">Token exchange</span>
            </div>
          </div>
        </div>

        <div class="section">
          <div class="section-title">Try it</div>
          <div class="code-card">
            <div class="code-header">curl</div>
            <div class="code-body"><span class="comment"># Call a public tool</span>
curl -X POST ${c.req.url.replace(/\/$/, '')} \\
  -H <span class="string">"Content-Type: application/json"</span> \\
  -d <span class="string">'{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"call_agent","arguments":{"request":{"action":"execute_tool","path":"@weather","tool":"get_weather","params":{"city":"san francisco"}}}}}'</span></div>
          </div>
        </div>

        <div class="footer">
          Powered by <a href="https://github.com/slashfi/agents-sdk">@slashfi/agents-sdk</a>
        </div>
      </div>
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
console.log(`  Agent list:    GET  http://localhost:${port}/agents`);
console.log(`  Health:        GET  http://localhost:${port}/health`);
console.log(`  Custom route:  GET  http://localhost:${port}/api/cities`);
console.log(`  Root key:      ${ROOT_KEY}\n`);

export default {
  port,
  fetch: app.fetch,
};
