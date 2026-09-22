export { AgentServer } from './server.js';
export type { CreateSessionOptions, SessionEventPayload } from './server.js';
export { supportsNativeWebSearch, validWebSearchBackend } from './server.js';
export type { AgentClient } from './client.js';
export { DEFAULT_SETTINGS, PROVIDER_PRESETS, providerLabel } from './settings.js';
export type {
  Settings,
  ProviderEntry,
  ProviderModel,
  ProviderModelInfo,
  ModelTestResult,
  WebSearchConfig,
  ProjectEntry,
  ShellType,
  ShellInfo,
} from './settings.js';
export { lookupCatalog, resolveModelMeta } from './model-catalog.js';
export type { CatalogMeta } from './model-catalog.js';
export { buildSystemPrompt } from './prompts.js';
export { WorkspaceLockManager, Mutex } from './workspace-lock.js';
