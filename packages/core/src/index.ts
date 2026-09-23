// 类型与协议
export * from './types.js';
export * from './events.js';
export * from './policy.js';
// 宿主
export * from './host.js';
// 审批
export * from './approval.js';
// 工具
export { ToolRegistry, executeTool, resolveWorkspacePath, createBuiltinTools, runWebSearch } from './tools/index.js';
export type { Tool, ToolSpec, ToolContext, ToolExecution } from './tools/index.js';
export { readFileTool, writeFileTool, editFileTool, listDirTool } from './tools/fs.js';
export { searchFilesTool, listFilesRecursively } from './tools/search.js';
export { runCommandTool } from './tools/shell.js';
export { todoWriteTool } from './tools/todo.js';
export {
  gitStatusTool,
  gitDiffTool,
  getGitStatus,
  getGitDiff,
  stageGitFiles,
  discardGitChanges,
  splitUnifiedDiff,
} from './tools/git.js';
export type { GitStatusSummary, GitFileChange, GitDiffResult, GitDiffOptions } from './tools/git.js';
// Provider
export * from './providers/index.js';
export { OpenAICompatibleProvider, toWireMessages as toOpenAIWireMessages } from './providers/openai.js';
export { AnthropicProvider, toWireMessages as toAnthropicWireMessages } from './providers/anthropic.js';
export { ResponsesProvider } from './providers/responses.js';
export { MockProvider } from './providers/mock.js';
// 循环与工具函数
export { runAgentLoop } from './loop.js';
export type { LoopOptions, LoopResult } from './loop.js';
export {
  pruneHistoricalToolResults,
  compactHistoryMessages,
  extractLatestTodos,
} from './compaction.js';
export type {
  PruneToolOptions,
  PruneResult,
  CompactOptions,
} from './compaction.js';
export { diffLines } from './diff.js';
export type { DiffLine } from './diff.js';
export { validateToolInput } from './jsonschema.js';
export type { JsonSchema } from './jsonschema.js';
