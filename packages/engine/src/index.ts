export { AgentServer } from './server.js';
export type {
  CreateSessionOptions,
  SessionEventPayload,
  ProjectRuleInfo,
  CustomPromptInfo,
  GitStatusSummary,
  GitFileChange,
  GitDiffResult,
  GitDiffOptions,
  TurnCheckpointSummary,
  TurnUndoPreview,
  TurnUndoFilePreview,
  TurnUndoResult,
  WorkspaceFilePreview,
  // end-server-type-exports
} from './server.js';
export { splitUnifiedDiff } from './server.js';
export { CheckpointManager } from './checkpoints.js';
export type { TurnCheckpointRecord, TurnFileSnapshot } from './checkpoints.js';
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
export {
  buildSystemPrompt,
  parseCodeRangeMentions,
  resolveCodeRangeMentions,
  type CodeRangeMention,
  type CodeRangeSnippet,
} from './prompts.js';
export { WorkspaceLockManager, Mutex } from './workspace-lock.js';
export { DecisionStatsManager } from './stats.js';
export { ShadowDecisionPolicy } from './shadow.js';
export type { ShadowContextInfo } from './shadow.js';
