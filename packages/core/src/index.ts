// 类型与协议
export * from './types.js';
export * from './events.js';
export * from './policy.js';
// 宿主
export * from './host.js';
export * from './mcp.js';
// 后台任务与端口探测（TODOS #37）
export * from './tasks.js';
// 审批
export * from './approval.js';
export * from './questions.js';
// 权限规则引擎（TODOS #47）
export * from './permissions.js';
// 真实路径守卫：符号链接消解与工作区边界校验（TODOS #47 第三轮复审）
export * from './path-guard.js';
// 测试运行探知与失败解析（TODOS #39）
export * from './test-runner.js';
// 工具
export { ToolRegistry, executeTool, resolveWorkspacePath, createBuiltinTools, runWebSearch } from './tools/index.js';
export type { Tool, ToolSpec, ToolContext, ToolExecution, FileChangeEvent } from './tools/index.js';
export {
  readFileTool,
  writeFileTool,
  editFileTool,
  listDirTool,
  parseCodeRangeMentions,
  resolveCodeRangeMentions,
  formatFileMention,
} from './tools/fs.js';
export type { CodeRangeMention, CodeRangeSnippet } from './tools/fs.js';

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
