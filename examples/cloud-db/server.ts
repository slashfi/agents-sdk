import postgres from "postgres";
import {
  createAgentRegistry,
  createAgentServer,
  createAuthAgent,
  createSecretsAgent,
  createIntegrationsAgent,
  createUsersAgent,
} from "@slashfi/agents-sdk";
import { connectDb } from "./db/schema.js";
import { createPostgresAuthStore } from "./db/store.js";
import { createPostgresSecretStore } from "./db/secret-store.js";
import { createPostgresIntegrationStore } from "./db/integration-store.js";
import { createPostgresUserStore } from "./db/user-store.js";
import { dbConnectionsAgent } from "./agents/db-connections.js";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) { console.error("ERROR: DATABASE_URL is required"); process.exit(1); }
const ROOT_KEY = process.env.ROOT_KEY;
if (!ROOT_KEY) { console.error("ERROR: ROOT_KEY is required"); process.exit(1); }
if (!process.env.ENCRYPTION_KEY) { console.error("ERROR: ENCRYPTION_KEY is required"); process.exit(1); }
const PORT = Number.parseInt(process.env.PORT ?? "3000", 10);
const CALLBACK_BASE_URL = process.env.CALLBACK_BASE_URL ?? `http://localhost:${PORT}/integrations/callback`;

console.log("[db] Connecting...");
const client = postgres(DATABASE_URL);
connectDb(client);
(globalThis as any).__pgClient = client;
console.log("[db] Connected.");

// Stores
const secretStore = createPostgresSecretStore(client, process.env.ENCRYPTION_KEY!);
const integrationStore = createPostgresIntegrationStore(client, process.env.ENCRYPTION_KEY!);
const userStore = createPostgresUserStore(client, process.env.ENCRYPTION_KEY!);

// Registry
const registry = createAgentRegistry();

// @auth — OAuth2 client_credentials, tenants, JWT
registry.register(createAuthAgent({
  rootKey: ROOT_KEY,
  store: createPostgresAuthStore(client),
  secretStore,
  allowRegistration: true,
}));

// @secrets — encrypted secret storage
registry.register(createSecretsAgent({ store: secretStore }));

// @integrations — provider configs, OAuth flows, API calling
registry.register(createIntegrationsAgent({
  store: integrationStore,
  secretStore,
  callbackBaseUrl: CALLBACK_BASE_URL,
  resolveClientCredentials: async (providerId, config) => {
    // For now, use env vars: PROVIDER_ID_CLIENT_ID / PROVIDER_ID_CLIENT_SECRET
    const envPrefix = providerId.toUpperCase().replace(/-/g, "_");
    const clientId = process.env[`${envPrefix}_CLIENT_ID`];
    const clientSecret = process.env[`${envPrefix}_CLIENT_SECRET`];
    if (clientId && clientSecret) {
      return { clientId, clientSecret };
    }
    throw new Error(`No client credentials found for provider '${providerId}'. Set ${envPrefix}_CLIENT_ID and ${envPrefix}_CLIENT_SECRET env vars.`);
  },
}));

// @users — user accounts + identity linking
registry.register(createUsersAgent({ store: userStore }));

// @db-connections — database connection management
registry.register(dbConnectionsAgent);

// Server
const server = createAgentServer(registry, {
  port: PORT,
  hostname: "0.0.0.0",
  secretStore,
});
await server.start();

console.log(`[server] Agents: ${registry.list().map((a) => a.path).join(", ")}`);
console.log(`[server] OAuth callback URL: ${CALLBACK_BASE_URL}`);
