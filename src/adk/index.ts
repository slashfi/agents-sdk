/**
 * ADK module — barrel export for local store, MCP client, and commands.
 */

export {
  initAdkDir,
  readConfig,
  writeConfig,
  readKey,
  setSecret,
  getSecret,
  listSecretKeys,
  removeSecrets,
  addRef,
  removeRef,
  listRefs,
  isInitialized,
  getAdkDir,
  getConfigPath,
  getSecretsPath,
  getKeyPath,
} from "./local-store.js";

export { McpRegistryClient } from "./mcp-client.js";
export type { RegistryAgent } from "./mcp-client.js";

// Keep REST client for web consumers
export { RegistryClient } from "./registry-client.js";

export {
  cmdInit,
  cmdSearch,
  cmdAdd,
  cmdRemove,
  cmdInfo,
  cmdCall,
  cmdListConsumer,
  cmdServe,
  cmdLogin,
} from "./commands.js";
