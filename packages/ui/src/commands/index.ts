/**
 * Composer 斜杠快捷指令定义（TODOS #32）
 */

export type CommandKind = 'action' | 'prompt';
export type CommandCategory = 'git' | 'code' | 'session' | 'custom';

export interface SlashCommand {
  id: string;
  name: string; // 例如 '/commit'
  description: string; // 简要功能说明
  kind: CommandKind; // 'action' | 'prompt'
  category: CommandCategory;
  badge: string; // 界面展示的极客标签，例如 '[Git]'
  template?: string; // prompt 模板
}

/** 内置快捷指令集合 */
export const BUILTIN_SLASH_COMMANDS: SlashCommand[] = [
  // Prompt 模板类
  {
    id: 'commit',
    name: '/commit',
    description: '分析 Git 改动并生成规范提交信息',
    kind: 'prompt',
    category: 'git',
    badge: '[Git]',
    template:
      '请分析当前工作区的 Git 改动（执行 git status 与 git diff），提取关键变更，按照 Conventional Commits 规范生成标准提交信息（包含 feat/fix/refactor 等前缀与改动要点总结）。',
  },
  {
    id: 'review',
    name: '/review',
    description: '对工作区改动或指定文件进行代码审查',
    kind: 'prompt',
    category: 'code',
    badge: '[审查]',
    template:
      '请对当前工作区改动或指定代码进行全面审查，重点关注：1. 逻辑与架构合理性；2. 边界条件与异常处理；3. 安全漏洞与性能隐患；4. 代码风格与规范一致性。并给出明确的修改建议。',
  },
  {
    id: 'test',
    name: '/test',
    description: '为当前代码或模块设计并执行单元测试',
    kind: 'prompt',
    category: 'code',
    badge: '[测试]',
    template:
      '请为当前改动或相关功能模块设计并补充单元测试，覆盖正常路径与异常边界，并执行测试脚本验证。',
  },
  {
    id: 'fix',
    name: '/fix',
    description: '排查报错或异常并生成修复方案',
    kind: 'prompt',
    category: 'code',
    badge: '[修复]',
    template: '请排查并修复以下报错或异常，分析根本原因并给出最小改动修复方案：',
  },

  // 动作执行类（前端直接触发，零 Token 消耗）
  {
    id: 'compact',
    name: '/compact',
    description: '立即压缩上下文并归档早期历史',
    kind: 'action',
    category: 'session',
    badge: '[会话]',
  },
  {
    id: 'fork',
    name: '/fork',
    description: '从当前节点分叉出新会话分支',
    kind: 'action',
    category: 'session',
    badge: '[会话]',
  },
  {
    id: 'export',
    name: '/export',
    description: '导出会话为 Markdown 离线文档',
    kind: 'action',
    category: 'session',
    badge: '[导出]',
  },
  {
    id: 'clear',
    name: '/clear',
    description: '清空当前输入内容与草稿',
    kind: 'action',
    category: 'session',
    badge: '[操作]',
  },
];
