/**
 * Cloud DB Server
 *
 * MCP server hosting:
 * - @auth: OAuth2 authentication (JWT tokens)
 * - @db-connections: manage database connections (Postgres, CockroachDB, Snowflake)
 *
 * Environment variables:
 *   DATABASE_URL     - Postgres connection string (required)
 *   ROOT_KEY         - Root key for admin operations (required)
 *   ENCRYPTION_KEY   - Key for encrypting secrets + connection configs (required)
 *   PORT             - Server port (default: 3000)
 */

import postgres from "postgres";

import {
  createAgentRegistry,
  createAgentServer,
  createAuthAgent,
} from "@slashfi/agents-sdk";

import { connectDb } from "./db/schema.js";
import { createPostgresAuthStore } from "./db/store.js";
import { createPostgresSecretStore } from "./db/secret-store.js";
import { dbConnectionsAgent } from "./agents/db-connections.js";

// ============================================
// Config
// ============================================

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) { console.error("ERROR: DATABASE_URL is required"); process.exit(1); }

const ROOT_KEY = process.env.ROOT_KEY;
if (!ROOT_KEY) { console.error("ERROR: ROOT_KEY is required"); process.exit(1); }

if (!process.env.ENCRYPTION_KEY) { console.error("ERROR: ENCRYPTION_KEY is required"); process.exit(1); }

const PORT = Number.parseInt(process.env.PORT ?? "3000", 10);

// ============================================
// Database
// ============================================

console.log("[db] Connecting...");
const client = postgres(DATABASE_URL);
connectDb(client);

// Make client available for raw SQL in agents
(globalThis as any).__pgClient = client;

console.log("[db] Connected.");

// ============================================
// Server
// ============================================

const registry = createAgentRegistry();

registry.register(
  createAuthAgent({
    rootKey: ROOT_KEY,
    store: createPostgresAuthStore(client),
    allowRegistration: true,
  })
);

registry.register(dbConnectionsAgent);

const server = createAgentServer(registry, {
  port: PORT,
  hostname: "0.0.0.0",
  secretStore: createPostgresSecretStore(client),
});
await server.start();
console.log(`[server] Agents: ${registry.list().map((a) => a.path).join(", ")}`);
