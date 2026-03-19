import postgres from "postgres";
import {
  createAgentRegistry,
  createAgentServer,
  createAuthAgent,
  createSecretsAgent,
} from "@slashfi/agents-sdk";
import { connectDb } from "./db/schema.js";
import { createPostgresAuthStore } from "./db/store.js";
import { createPostgresSecretStore } from "./db/secret-store.js";
import { dbConnectionsAgent } from "./agents/db-connections.js";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) { console.error("ERROR: DATABASE_URL is required"); process.exit(1); }
const ROOT_KEY = process.env.ROOT_KEY;
if (!ROOT_KEY) { console.error("ERROR: ROOT_KEY is required"); process.exit(1); }
if (!process.env.ENCRYPTION_KEY) { console.error("ERROR: ENCRYPTION_KEY is required"); process.exit(1); }
const PORT = Number.parseInt(process.env.PORT ?? "3000", 10);

console.log("[db] Connecting...");
const client = postgres(DATABASE_URL);
connectDb(client);
(globalThis as any).__pgClient = client;
console.log("[db] Connected.");

const secretStore = createPostgresSecretStore(client, process.env.ENCRYPTION_KEY!);

const registry = createAgentRegistry();
registry.register(createAuthAgent({ rootKey: ROOT_KEY, store: createPostgresAuthStore(client), secretStore, allowRegistration: true }));
registry.register(createSecretsAgent({ store: secretStore }));
registry.register(dbConnectionsAgent);

const server = createAgentServer(registry, { port: PORT, hostname: "0.0.0.0", secretStore });
await server.start();
console.log("[server] Agents:", registry.list().map((a) => a.path).join(", "));
