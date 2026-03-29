/**
 * ADK module — barrel export for local store, registry client, and commands.
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

export { RegistryClient } from "./registry-client.js";
export type { AgentDetail, SearchResult } from "./registry-client.js";

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
