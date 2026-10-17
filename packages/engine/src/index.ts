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
  RevertTurnOptions,
  WorkspaceFilePreview,
  RunTestLoopRequest,
  TestLoopResult,
  // end-server-type-exports
} from './server.js';
export { splitUnifiedDiff, parsePermissionRules, normalizePermissionRule } from './server.js';
export { runTestLoop, buildTestFixPrompt } from './test-loop.js';
export type { RunTestLoopOptions, TestRunExecution } from './test-loop.js';
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
  PermissionSettings,
  TestLoopSettings,
} from './settings.js';
export { lookupCatalog, resolveModelMeta } from './model-catalog.js';
export type { CatalogMeta } from './model-catalog.js';
export {
  buildSystemPrompt,
  parseCodeRangeMentions,
  resolveCodeRangeMentions,
  formatFileMention,
  type CodeRangeMention,
  type CodeRangeSnippet,
} from './prompts.js';
export { WorkspaceLockManager, Mutex } from './workspace-lock.js';
export { DecisionStatsManager } from './stats.js';
export { ShadowDecisionPolicy } from './shadow.js';
export type { ShadowContextInfo } from './shadow.js';
