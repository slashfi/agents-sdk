/**
 * Seed demo data into the agent registry.
 * Idempotent - safe to run multiple times.
 */
import type postgres from "postgres";

export async function seed(client: postgres.Sql) {
  // Check if already seeded
  const existing = await client.unsafe(
    "SELECT id FROM tenants LIMIT 1"
  );
  if (existing.length > 0) {
    console.log("[seed] Data already exists, skipping.");
    return;
  }

  console.log("[seed] Seeding registry data...");

  // Tenants
  await client.unsafe(`
    INSERT INTO tenants (id, name, plan, created_at) VALUES
      ('ten_acme', 'Acme Corp', 'pro', NOW()),
      ('ten_initech', 'Initech', 'free', NOW()),
      ('ten_globex', 'Globex Corporation', 'enterprise', NOW())
  `);

  // Agents
  await client.unsafe(`
    INSERT INTO agents (id, tenant_id, name, description, version, status, endpoint_url, created_at, updated_at) VALUES
      ('agt_search',    'ten_acme',    '@search',    'Semantic search across documents and knowledge bases',          '1.2.0', 'active',   'https://search.acme.io/rpc',    NOW(), NOW()),
      ('agt_summarize', 'ten_acme',    '@summarize', 'Summarize long-form content into key takeaways',               '0.9.1', 'active',   'https://summarize.acme.io/rpc',  NOW(), NOW()),
      ('agt_translate', 'ten_acme',    '@translate', 'Translate text between languages with context awareness',      '2.0.0', 'active',   NULL,                             NOW(), NOW()),
      ('agt_classify',  'ten_initech', '@classify',  'Classify support tickets by category and priority',            '1.0.0', 'active',   'https://classify.initech.io/rpc', NOW(), NOW()),
      ('agt_triage',    'ten_initech', '@triage',    'Route incoming requests to the right team',                    '0.5.0', 'inactive', NULL,                             NOW(), NOW()),
      ('agt_monitor',   'ten_globex',  '@monitor',   'Monitor infrastructure and alert on anomalies',                '3.1.0', 'active',   'https://monitor.globex.io/rpc',  NOW(), NOW()),
      ('agt_deploy',    'ten_globex',  '@deploy',    'Manage deployments across environments',                       '1.4.2', 'active',   'https://deploy.globex.io/rpc',   NOW(), NOW())
  `);

  // Agent Tools
  await client.unsafe(`
    INSERT INTO agent_tools (id, agent_id, name, description, input_schema) VALUES
      ('tool_1',  'agt_search',    'search',           'Search documents by query',                  '{"type":"object","properties":{"query":{"type":"string"},"limit":{"type":"number"}},"required":["query"]}'),
      ('tool_2',  'agt_search',    'index_document',   'Add a document to the search index',         '{"type":"object","properties":{"content":{"type":"string"},"metadata":{"type":"object"}},"required":["content"]}'),
      ('tool_3',  'agt_summarize', 'summarize',        'Summarize text content',                     '{"type":"object","properties":{"text":{"type":"string"},"max_length":{"type":"number"}},"required":["text"]}'),
      ('tool_4',  'agt_translate', 'translate',        'Translate text to target language',           '{"type":"object","properties":{"text":{"type":"string"},"target_lang":{"type":"string"}},"required":["text","target_lang"]}'),
      ('tool_5',  'agt_classify',  'classify_ticket',  'Classify a support ticket',                  '{"type":"object","properties":{"subject":{"type":"string"},"body":{"type":"string"}},"required":["subject","body"]}'),
      ('tool_6',  'agt_triage',    'route',            'Route a request to the right handler',       '{"type":"object","properties":{"request_type":{"type":"string"},"urgency":{"type":"string"}},"required":["request_type"]}'),
      ('tool_7',  'agt_monitor',   'get_metrics',      'Get current infrastructure metrics',         '{"type":"object","properties":{"service":{"type":"string"},"window":{"type":"string"}},"required":["service"]}'),
      ('tool_8',  'agt_monitor',   'create_alert',     'Create an alert rule',                       '{"type":"object","properties":{"metric":{"type":"string"},"threshold":{"type":"number"},"operator":{"type":"string"}},"required":["metric","threshold","operator"]}'),
      ('tool_9',  'agt_deploy',    'deploy',           'Deploy a service to an environment',         '{"type":"object","properties":{"service":{"type":"string"},"env":{"type":"string"},"version":{"type":"string"}},"required":["service","env"]}'),
      ('tool_10', 'agt_deploy',    'rollback',         'Rollback a deployment',                      '{"type":"object","properties":{"service":{"type":"string"},"env":{"type":"string"}},"required":["service","env"]}')
  `);

  console.log("[seed] Done. Seeded 3 tenants, 7 agents, 10 tools.");
}
