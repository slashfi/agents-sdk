# Atlas Integration Agents - Architecture & Implementation Context

## What Exists Today

### 1. Tenant API Key Auth (just shipped)
- **PR #12577** on `slashfi/slash` repo, branch `atlas/wire-auth-require`
- `tenant_api_key` table in atlas DB (CockroachDB)
- Auth middleware in atlas-api: validates `Bearer atlas_<tenant>_<random>` on all non-public routes
- HMAC-SHA256 key hashing via `ATLAS_API_KEY_HASH_SECRET`
- backend-common already sends the key via `createProxyAtlasApiClient` using `ATLAS_TENANT_API_KEY` env var
- Key generated via `scripts/api-key.ts` in atlas-api

### 2. Agents SDK (`github.com/slashfi/agents-sdk`)
- Branch `add-runtime-hooks` (PR #1, not merged to main)
- Core SDK: `defineAgent()`, `defineTool()`, `createAgentRegistry()`, `createAgentServer()`
- `@auth` agent built-in: OAuth2 `client_credentials` flow, root key for admin, JWT access tokens with scopes
- `@databases` agent example: query, list_tables, describe_table, execute_mutation
- PostgresAuthStore implementation using Drizzle
- Server exposes: `GET /list`, `POST /call`, `POST /oauth/token`
- Dockerfile + railway.toml ready for Railway deployment (not deployed yet)
- `ToolContext` has `callerId`, `callerType` passed to each tool

### 3. Existing @integrations Agent (to be deprecated)
- Monolithic agent in atlas that handles all integrations (Notion, Figma, Intercom, Linear)
- Tools: `setup_integration`, `connect_integration`, `list_integrations`, `call_integration`
- Tokens stored per AtlasUser in VCS/KV (atlas-os-sdk SecretStore, encrypted, backed by CockroachDB)
- OAuth flow: connect_integration returns auth URL, callback on atlas-api stores token

### 4. Remote Agent Pattern (already exists)
- `@slash-company-server` in atlas is a remote agent
- Config at: `packages/atlas/atlas-environments/src/environments/slash/agents/@slash-company-server/agent.config.ts`
- Uses `upstream` config: `{ url, apiKey, transformRequest }`
- `transformRequest` can modify requests before proxying (e.g., resolve user identity)
- atlas-os-sdk handles the HTTP proxying transparently

## Architecture Decisions Made

### Each integration is its own agent
- Deprecate the monolithic `@integrations` agent
- Each integration becomes a separate agent: `@notion`, `@github`, `@datadog`, `@instacart`
- Each integration is a separate npm package: `@slashfi/notion-agent`, `@slashfi/github-agent`, etc.
- The SDK (`@slashfi/agents-sdk`) stays generic - provides the framework + `@auth`

### One remote server hosts all integration agents
- Single deployment (Railway) registers all integration agents
- Uses agents-sdk's `createAgentServer` with all agents registered
- `@auth` agent controls server-level access (which callers can hit the server)

```typescript
import { createAuthAgent, createAgentRegistry, createAgentServer } from '@slashfi/agents-sdk';
import { createNotionAgent } from '@slashfi/notion-agent';
import { createGithubAgent } from '@slashfi/github-agent';

const registry = createAgentRegistry();
registry.register(createAuthAgent({ rootKey: ROOT_KEY, store }));
registry.register(createNotionAgent());
registry.register(createGithubAgent());

const server = createAgentServer(registry, { port: 3000 });
```

### Tokens stored centrally in atlas DB
- Integration tokens (Notion OAuth tokens, Datadog API keys, etc.) stored in atlas CockroachDB
- Encrypted via atlas-os-sdk SecretStore (existing mechanism)
- Scoped to `atlas_user_id`, NOT tenant (user connects once, works across tenants)
- Remote agents are STATELESS - they don't store or look up tokens

### Credentials injected at proxy layer
- atlas-api proxies calls to remote agents using the existing `upstream` pattern
- `transformRequest` looks up the user's integration token from atlas DB
- Injects it into `credentials` field on the request
- Remote agent reads `ctx.credentials.accessToken` - never touches DB

```typescript
// atlas-api upstream config (generic for all integrations)
upstream: {
  url: REMOTE_AGENT_URL,
  transformRequest: async ({ request }) => {
    const provider = agentPath.replace('@', ''); // @notion → notion
    const token = await secretStore.get(request.userId, provider);
    return {
      request: {
        ...request,
        credentials: token ? { accessToken: token } : undefined,
      },
    };
  },
}
```

### ToolContext gets `credentials` field
- SDK adds `credentials?: Record<string, string>` to `ToolContext`
- Server passes credentials from request through to tool execution
- Agent code: `const token = ctx.credentials?.accessToken;`

### Integration agent packages are dead simple
- No DB connection, no config, no token lookup
- Just: read `ctx.credentials`, call the provider API, return results
- If `ctx.credentials` is undefined → return `{ error: 'NOT_CONNECTED' }`

```typescript
// @slashfi/notion-agent - entire package
export function createNotionAgent() {
  const call = defineTool({
    name: 'call',
    description: 'Make any Notion API call',
    inputSchema: {
      type: 'object',
      properties: {
        method: { type: 'string', enum: ['GET', 'POST', 'PATCH', 'DELETE'] },
        path: { type: 'string', description: 'e.g. /v1/search' },
        body: { type: 'object' },
      },
      required: ['method', 'path'],
    },
    execute: async (input, ctx) => {
      if (!ctx.credentials?.accessToken) {
        return { error: 'NOT_CONNECTED', message: 'User has not connected Notion.' };
      }
      const res = await fetch(`https://api.notion.com${input.path}`, {
        method: input.method,
        headers: {
          Authorization: `Bearer ${ctx.credentials.accessToken}`,
          'Notion-Version': '2022-06-28',
          'Content-Type': 'application/json',
        },
        ...(input.body && { body: JSON.stringify(input.body) }),
      });
      return res.json();
    },
  });

  return defineAgent({
    path: '@notion',
    description: 'Interact with Notion',
    tools: [call],
  });
}
```

### Connect flow - two patterns

**OAuth integrations (Notion, GitHub, Linear):**
1. Agent tries to call @notion, gets `NOT_CONNECTED`
2. Agent tells user to connect → surfaces OAuth URL as Slack button/link
3. OAuth state param encodes context: `{ userId, slackChannel, slackMessageTs, branchId, originalPrompt }`
4. User clicks → completes OAuth in browser
5. Callback goes to **atlas-api** (not the remote server), which:
   - Exchanges code for token with the provider
   - Stores token in atlas DB (SecretStore)
   - Updates Slack message to show ✅ Connected
   - Re-invokes the agent to continue the original task
6. Next call to @notion has credentials injected → works

**API key integrations (Datadog, OpenAI):**
1. Agent tries to call @datadog, gets `NOT_CONNECTED`
2. Agent asks user in Slack: "Paste your Datadog API key"
3. User replies with key
4. Agent stores it via atlas-api (SecretStore)
5. No callback needed - conversation IS the state
6. Agent continues the original task

### Auth flow - full chain
```
Slack message → backend-common
  → (tenant API key: Bearer atlas_slash_xxx)
  → atlas-api
    → auth middleware validates tenant key
    → resolves slack user → atlas_user_id
    → orchestrator runs agent
    → agent calls @notion.call()
    → atlas-api proxy:
        1. looks up atlas_user's Notion token from SecretStore
        2. injects as credentials
        3. gets @auth access token for remote server (client_credentials, cached)
        4. proxies to remote server
  → remote server validates @auth token
  → routes to @notion agent
  → @notion reads ctx.credentials.accessToken
  → calls Notion API
  → returns results
  → back to Slack
```

## What Needs to Be Built

### In agents-sdk:
- [ ] Add `credentials?: Record<string, string>` to `ToolContext`
- [ ] Pass credentials from request through to tool in server
- [ ] Merge PR #1 (`add-runtime-hooks`) to main
- [ ] `IntegrationTokenStore` interface (or confirm existing patterns are sufficient)

### New package: @slashfi/notion-agent
- [ ] `createNotionAgent()` function
- [ ] `call` tool (generic Notion API wrapper using ctx.credentials)
- [ ] Publish as npm package (or keep in a monorepo)

### In atlas-api:
- [ ] Generic integration upstream factory (not hardcoded per integration)
- [ ] Register remote integration agents using upstream pattern
- [ ] OAuth callback endpoint for integration connections
- [ ] Store/retrieve integration tokens via SecretStore
- [ ] Re-invoke agent after successful OAuth connection

### Remote agent server:
- [ ] Deploy on Railway with @auth + @notion
- [ ] Set env vars: ROOT_KEY, DATABASE_URL
- [ ] Create client credentials for atlas-api via root key

### In atlas-slack agent:
- [ ] Handle NOT_CONNECTED responses → surface connect UI
- [ ] Render OAuth as Slack button, API key as prompt
- [ ] Handle post-connect continuation

## Key Files & Repos

| What | Where |
|------|-------|
| Agents SDK | `github.com/slashfi/agents-sdk` (branch: `add-runtime-hooks`) |
| @auth agent | `agents-sdk/src/auth.ts` |
| @databases example | `agents-sdk/examples/databases/server.ts` |
| @notion PR | `agents-sdk` PR #2 (branch: `feat/notion-agent`) - needs updating per new architecture |
| Tenant auth middleware | `slash` repo, `packages/atlas/atlas-api/src/hono-routes/middleware/auth.ts` |
| Remote agent pattern | `slash` repo, `packages/atlas/atlas-environments/src/environments/slash/agents/@slash-company-server/agent.config.ts` |
| Existing integrations | `slash` repo, `packages/atlas/atlas-agent/src/agents/@integrations/` |
| Existing SecretStore | `slash` repo, `packages/atlas/atlas-os-sdk/src/` |
