/**
 * IntegrationsStore — persistence interface for installed integrations.
 *
 * Each integration is an agent that's been configured and connected.
 * The store tracks what's installed, its config, and status.
 */

export interface Integration {
  id: string;
  agentPath: string;
  tenantId?: string;
  status: 'active' | 'disabled' | 'error';
  config: Record<string, unknown>;
  installedBy?: string;
  installedAt: number;
  updatedAt: number;
}

export interface CreateIntegrationInput {
  agentPath: string;
  tenantId?: string;
  config: Record<string, unknown>;
  installedBy?: string;
}

export interface IntegrationsStore {
  create(input: CreateIntegrationInput): Promise<Integration>;
  get(id: string): Promise<Integration | null>;
  list(tenantId?: string): Promise<Integration[]>;
  listByAgent(agentPath: string, tenantId?: string): Promise<Integration[]>;
  update(id: string, updates: Partial<Pick<Integration, 'status' | 'config' | 'updatedAt'>>): Promise<Integration | null>;
  delete(id: string): Promise<boolean>;
}

/** In-memory implementation for testing / lightweight use */
export function createInMemoryIntegrationsStore(): IntegrationsStore {
  const integrations = new Map<string, Integration>();

  return {
    async create(input) {
      const id = `int_${Math.random().toString(36).slice(2, 14)}`;
      const now = Date.now();
      const integration: Integration = {
        id,
        agentPath: input.agentPath,
        tenantId: input.tenantId,
        status: 'active',
        config: input.config,
        installedBy: input.installedBy,
        installedAt: now,
        updatedAt: now,
      };
      integrations.set(id, integration);
      return integration;
    },

    async get(id) {
      return integrations.get(id) ?? null;
    },

    async list(tenantId?) {
      const all = Array.from(integrations.values());
      return tenantId ? all.filter(i => i.tenantId === tenantId) : all;
    },

    async listByAgent(agentPath, tenantId?) {
      return Array.from(integrations.values()).filter(
        i => i.agentPath === agentPath && (!tenantId || i.tenantId === tenantId)
      );
    },

    async update(id, updates) {
      const existing = integrations.get(id);
      if (!existing) return null;
      const updated = { ...existing, ...updates, updatedAt: Date.now() };
      integrations.set(id, updated);
      return updated;
    },

    async delete(id) {
      return integrations.delete(id);
    },
  };
}
