/**
 * Table-driven ref.call tests using anonymized production consumer-config
 * shapes from Twin (herald, oauth, houzz, apiKey header agents).
 *
 * Does not load live prod data — fixtures mirror VCS consumer-config.json +
 * registry-cache.json patterns only.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  createAdk,
  createAgentRegistry,
  createAgentServer,
  defineAgent,
  defineTool,
  type RegistryCache,
  type AgentServer,
} from "./index";

const REG_PORT = 19925;

function createMemoryFs(): {
  readFile(path: string): Promise<string | null>;
  writeFile(path: string, content: string): Promise<void>;
  seed(path: string, content: string): void;
} {
  const files = new Map<string, string>();
  return {
    async readFile(path: string) {
      return files.get(path) ?? null;
    },
    async writeFile(path: string, content: string) {
      files.set(path, content);
    },
    seed(path: string, content: string) {
      files.set(path, content);
    },
  };
}

type FixtureCase = {
  name: string;
  refName: string;
  agentPath: string;
  /** consumer-config ref entry (prod-shaped, secrets redacted) */
  refEntry: Record<string, unknown>;
  registryCache: RegistryCache;
  resolveCredentials?: (field: string) => string | null;
  expectToken?: string | null;
  expectHeader?: { name: string; value: string };
};

/** Production-shaped fixtures (no secrets). */
const FIXTURES: FixtureCase[] = [
  {
    name: "herald — empty config, platform-minted access_token",
    refName: "herald",
    agentPath: "herald",
    refEntry: {
      ref: "herald",
      name: "herald",
      scheme: "registry",
      sourceRegistry: {
        url: `http://localhost:${REG_PORT}`,
        agentPath: "herald",
      },
      config: {},
    },
    registryCache: {
      refs: {
        herald: {
          ref: "herald",
          fetchedAt: new Date().toISOString(),
          authFields: {
            access_token: { required: true, automated: true },
          },
        },
      },
    },
    resolveCredentials: (field) =>
      field === "access_token" ? "minted-twin-jwt" : null,
    expectToken: "minted-twin-jwt",
  },
  {
    name: "oauth ref — stored access_token in config (notion/github pattern)",
    refName: "notion",
    agentPath: "notion",
    refEntry: {
      ref: "notion",
      name: "notion",
      scheme: "registry",
      sourceRegistry: {
        url: `http://localhost:${REG_PORT}`,
        agentPath: "notion",
      },
      config: { access_token: "stored-oauth-token" },
    },
    registryCache: {
      refs: {
        notion: {
          ref: "notion",
          fetchedAt: new Date().toISOString(),
          authFields: {
            client_id: { required: true, automated: false },
            client_secret: { required: true, automated: false },
            access_token: { required: true, automated: false },
          },
        },
      },
    },
    resolveCredentials: () => "resolver-should-not-win",
    expectToken: "stored-oauth-token",
  },
  {
    name: "houzz — bearer token stored as config.token",
    refName: "houzz",
    agentPath: "houzz",
    refEntry: {
      ref: "houzz",
      name: "houzz",
      scheme: "registry",
      sourceRegistry: {
        url: `http://localhost:${REG_PORT}`,
        agentPath: "houzz",
      },
      config: { token: "stored-cookie-blob" },
    },
    registryCache: {
      refs: {
        houzz: {
          ref: "houzz",
          fetchedAt: new Date().toISOString(),
          authFields: {
            token: { required: true, automated: false },
          },
        },
      },
    },
    expectToken: "stored-cookie-blob",
  },
  {
    name: "apiKey agent — env-resolved header cred (datadog-style)",
    refName: "datadog",
    agentPath: "datadog",
    refEntry: {
      ref: "datadog",
      name: "datadog",
      scheme: "registry",
      sourceRegistry: {
        url: `http://localhost:${REG_PORT}`,
        agentPath: "datadog",
      },
      config: {},
    },
    registryCache: {
      refs: {
        datadog: {
          ref: "datadog",
          fetchedAt: new Date().toISOString(),
          authFields: {
            dd_api_key: { required: true, automated: false },
          },
        },
      },
    },
    resolveCredentials: (field) =>
      field === "dd_api_key" ? "dd-key-from-env" : null,
    expectHeader: { name: "DD-API-KEY", value: "dd-key-from-env" },
  },
  {
    name: "no-auth ref — web-search pattern (authFields empty)",
    refName: "web-search",
    agentPath: "web-search",
    refEntry: {
      ref: "web-search",
      name: "web-search",
      scheme: "registry",
      sourceRegistry: {
        url: `http://localhost:${REG_PORT}`,
        agentPath: "web-search",
      },
      config: {},
    },
    registryCache: {
      refs: {
        "web-search": {
          ref: "web-search",
          fetchedAt: new Date().toISOString(),
          authFields: {},
        },
      },
    },
    expectToken: null,
  },
];

describe("ref.call production-shaped consumer-config fixtures", () => {
  let registryServer: AgentServer;
  let receivedToken: string | undefined;
  let receivedHeaders: Record<string, string> | undefined;

  beforeAll(async () => {
    const echoTool = defineTool({
      name: "ping",
      description: "Echo outbound auth material",
      inputSchema: { type: "object" as const, properties: {} },
      execute: async (input: Record<string, unknown>) => {
        receivedToken = input.accessToken as string | undefined;
        receivedHeaders = input._headers as Record<string, string> | undefined;
        return { ok: true };
      },
    });

    const registry = createAgentRegistry();
    for (const path of new Set(FIXTURES.map((f) => f.agentPath))) {
      registry.register(
        defineAgent({
          path,
          entrypoint: `${path} fixture agent`,
          tools: [echoTool],
          visibility: "public",
          config: {
            security: {
              type: "oauth2",
              authFields: {
                access_token: { required: true, automated: true },
              },
            },
          },
        }),
      );
    }

    registryServer = createAgentServer(registry, { port: REG_PORT });
    await registryServer.start();
  });

  afterAll(async () => {
    await registryServer.stop();
  });

  for (const fixture of FIXTURES) {
    test(fixture.name, async () => {
      receivedToken = undefined;
      receivedHeaders = undefined;

      const fs = createMemoryFs();
      fs.seed(
        "consumer-config.json",
        JSON.stringify({
          registries: [
            { name: "prod-reg", url: `http://localhost:${REG_PORT}` },
          ],
          refs: [fixture.refEntry],
        }),
      );
      fs.seed("registry-cache.json", JSON.stringify(fixture.registryCache));

      const adk = createAdk(fs, {
        ...(fixture.resolveCredentials && {
          resolveCredentials: async ({ field }) =>
            fixture.resolveCredentials!(field),
        }),
      });

      const result = await adk.ref.call(fixture.refName, "ping");
      expect((result as { result?: { ok?: boolean } }).result?.ok).toBe(true);

      if (fixture.expectToken !== undefined) {
        expect(receivedToken ?? null).toBe(fixture.expectToken);
      }
      if (fixture.expectHeader) {
        expect(receivedHeaders?.[fixture.expectHeader.name]).toBe(
          fixture.expectHeader.value,
        );
      }
    });
  }
});
