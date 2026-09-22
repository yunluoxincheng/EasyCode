import type { ChatMessage, SessionData, ToolCallBlock, TodoItem } from '@easycode/core';
import { diffLines } from '@easycode/core';
import { renderMarkdown, escapeHtml } from '../markdown.js';

function formatTimestamp(ts?: string | number): string {
  if (!ts) return '';
  const d = new Date(ts);
  if (isNaN(d.getTime())) return String(ts);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

export function sanitizeFilename(name: string): string {
  return name.replace(/[\\/:*?"<>|]/g, '_').trim() || 'session';
}

export function getExportFilename(title: string, ext: 'md' | 'html'): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}`;
  const cleanTitle = sanitizeFilename(title || '会话');
  return `EasyCode-${cleanTitle}-${stamp}.${ext}`;
}

/** 触发浏览器/WebView 文件直接下载保存 */
export function downloadFile(filename: string, content: string, mimeType: string): void {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

/** 将会话转为结构化 Markdown 文档 */
export function sessionToMarkdown(data: SessionData): string {
  const meta = data.meta;
  const lines: string[] = [];

  // 1. 头部信息
  lines.push(`# 会话记录：${meta.title || '未命名会话'}\n`);
  lines.push(`> **导出时间**：${formatTimestamp(new Date().toISOString())}  `);
  lines.push(`> **工作区**：\`${meta.workspaceRoot || '未绑定工作区'}\`  `);
  lines.push(`> **模型服务**：\`${meta.providerId}\` · \`${meta.model || '默认'}\`  `);
  if (data.usage) {
    lines.push(
      `> **Token 用量**：输入 ${data.usage.input.toLocaleString()} · 输出 ${data.usage.output.toLocaleString()} · 步数 ${data.usage.steps ?? 0}`,
    );
  }
  lines.push('\n---\n');

  // 2. 任务清单
  const todos: TodoItem[] = data.todos ?? [];
  if (todos.length > 0) {
    lines.push('## 📋 任务清单\n');
    for (let i = 0; i < todos.length; i++) {
      const t = todos[i];
      const check = t.status === 'completed' ? '[x]' : '[ ]';
      const statusLabel =
        t.status === 'in_progress' ? ' ◍ *(进行中)*' : t.status === 'completed' ? ' ✓' : '';
      const priorityLabel = t.priority ? ` \`[${t.priority}]\`` : '';
      lines.push(`${check} ${i + 1}. ${t.content}${statusLabel}${priorityLabel}`);
    }
    lines.push('\n---\n');
  }

  // 3. 工具结果映射表（toolCallId -> { content, isError }）
  const toolResults = new Map<string, { content: string; isError?: boolean }>();
  for (const msg of data.messages) {
    if (msg.role === 'tool_result') {
      toolResults.set(msg.toolCallId, { content: msg.content, isError: msg.isError });
    }
  }

  // 4. 消息正文
  lines.push('## 💬 会话流\n');
  for (const msg of data.messages) {
    if (msg.role === 'user') {
      const timeStr = msg.createdAt ? ` (${formatTimestamp(msg.createdAt)})` : '';
      lines.push(`### 👤 用户${timeStr}\n`);
      lines.push(`${msg.content}\n`);
    } else if (msg.role === 'assistant') {
      lines.push(`### 🤖 助手\n`);
      for (const b of msg.blocks) {
        if (b.type === 'thinking') {
          lines.push(`<details>\n<summary>💭 思考过程 (${b.text.length} 字符)</summary>\n`);
          lines.push(`\n${b.text}\n`);
          lines.push(`\n</details>\n`);
        } else if (b.type === 'tool_call') {
          const call = b as ToolCallBlock;
          const res = toolResults.get(call.id);
          const inp = (call.input ?? {}) as Record<string, unknown>;

          if (call.name === 'edit_file') {
            const path = String(inp.path || '');
            const oldStr = String(inp.old_string || '');
            const newStr = String(inp.new_string || '');
            const diffs = diffLines(oldStr, newStr);
            lines.push(`**🛠️ 编辑文件**：\`${path}\`\n`);
            lines.push('```diff');
            for (const d of diffs) {
              const prefix = d.type === 'add' ? '+' : d.type === 'del' ? '-' : ' ';
              lines.push(`${prefix} ${d.text}`);
            }
            lines.push('```\n');
          } else if (call.name === 'write_file') {
            const path = String(inp.path || '');
            const content = String(inp.content || '');
            lines.push(`**🛠️ 写入文件**：\`${path}\`\n`);
            lines.push('```');
            lines.push(content);
            lines.push('```\n');
          } else if (call.name === 'run_command') {
            const cmd = String(inp.command || '');
            lines.push(`**💻 执行终端命令**：\n\`\`\`bash\n$ ${cmd}\n\`\`\`\n`);
            if (res) {
              lines.push(`**执行输出** ${res.isError ? '(失败)' : '(完成)'}：\n\`\`\`\n${res.content}\n\`\`\`\n`);
            }
          } else if (call.name === 'todo_write') {
            lines.push(`**📋 更新任务清单**\n`);
          } else {
            lines.push(`**🔧 工具调用**：\`${call.name}\`\n`);
            lines.push('```json');
            lines.push(JSON.stringify(inp, null, 2));
            lines.push('```\n');
            if (res) {
              const shortRes = res.content.length > 2000 ? `${res.content.slice(0, 2000)}\n...(内容过长已截断)` : res.content;
              lines.push(`*执行结果*：\n\`\`\`\n${shortRes}\n\`\`\`\n`);
            }
          }
        } else if (b.type === 'text') {
          lines.push(`${b.text}\n`);
        }
      }
    }
  }

  return lines.join('\n');
}

/** 将会话转为带暗黑终端样式与折叠卡片的自包含离线 HTML */
export function sessionToHtml(data: SessionData): string {
  const meta = data.meta;
  const toolResults = new Map<string, { content: string; isError?: boolean }>();
  for (const msg of data.messages) {
    if (msg.role === 'tool_result') {
      toolResults.set(msg.toolCallId, { content: msg.content, isError: msg.isError });
    }
  }

  // 任务清单 HTML
  let todosHtml = '';
  const todos: TodoItem[] = data.todos ?? [];
  if (todos.length > 0) {
    const todoRows = todos
      .map((t, idx) => {
        const icon = t.status === 'completed' ? '✓' : t.status === 'in_progress' ? '◍' : '○';
        const cls = t.status === 'completed' ? 'done' : t.status === 'in_progress' ? 'prog' : 'pend';
        const priorityTag = t.priority ? `<span class="tag tag-${escapeHtml(t.priority)}">${escapeHtml(t.priority)}</span>` : '';
        return `
        <div class="todo-item ${cls}">
          <span class="todo-icon">${icon}</span>
          <span class="todo-idx">${idx + 1}.</span>
          <span class="todo-text">${escapeHtml(t.content)}</span>
          ${priorityTag}
        </div>`;
      })
      .join('');
    todosHtml = `
      <section class="card todos-card">
        <div class="card-head">📋 任务清单 (${todos.filter((t) => t.status === 'completed').length}/${todos.length})</div>
        <div class="card-body todo-list">${todoRows}</div>
      </section>`;
  }

  // 消息流 HTML
  const messageItemsHtml: string[] = [];
  for (const msg of data.messages) {
    if (msg.role === 'user') {
      const timeStr = msg.createdAt ? formatTimestamp(msg.createdAt) : '';
      messageItemsHtml.push(`
        <article class="msg-user">
          <div class="msg-meta">
            <span class="role-badge">👤 用户</span>
            ${timeStr ? `<span class="time">${escapeHtml(timeStr)}</span>` : ''}
          </div>
          <div class="user-content">${renderMarkdown(msg.content)}</div>
        </article>
      `);
    } else if (msg.role === 'assistant') {
      const blockHtmls: string[] = [];
      for (const b of msg.blocks) {
        if (b.type === 'thinking') {
          blockHtmls.push(`
            <details class="block-thinking">
              <summary class="thinking-head">💭 思考过程 (${b.text.length} 字符)</summary>
              <div class="thinking-body">${renderMarkdown(b.text)}</div>
            </details>
          `);
        } else if (b.type === 'tool_call') {
          const call = b as ToolCallBlock;
          const res = toolResults.get(call.id);
          const inp = (call.input ?? {}) as Record<string, unknown>;

          if (call.name === 'edit_file') {
            const path = String(inp.path || '');
            const oldStr = String(inp.old_string || '');
            const newStr = String(inp.new_string || '');
            const diffs = diffLines(oldStr, newStr);
            const diffRows = diffs
              .map((d) => {
                const prefix = d.type === 'add' ? '+' : d.type === 'del' ? '-' : ' ';
                const lineCls = d.type === 'add' ? 'line-add' : d.type === 'del' ? 'line-del' : 'line-same';
                return `<div class="diff-line ${lineCls}"><span class="sign">${prefix}</span><span class="txt">${escapeHtml(d.text)}</span></div>`;
              })
              .join('');

            blockHtmls.push(`
              <details class="card tool-card" open>
                <summary class="card-head tool-head">
                  <span class="tool-badge">🛠️ edit_file</span>
                  <span class="tool-path">${escapeHtml(path)}</span>
                  ${res?.isError ? '<span class="status-err">✕ 失败</span>' : '<span class="status-ok">✓ 完成</span>'}
                </summary>
                <div class="card-body diff-window">
                  <pre class="diff-code"><code>${diffRows}</code></pre>
                </div>
              </details>
            `);
          } else if (call.name === 'write_file') {
            const path = String(inp.path || '');
            const content = String(inp.content || '');
            blockHtmls.push(`
              <details class="card tool-card">
                <summary class="card-head tool-head">
                  <span class="tool-badge">🛠️ write_file</span>
                  <span class="tool-path">${escapeHtml(path)}</span>
                  ${res?.isError ? '<span class="status-err">✕ 失败</span>' : '<span class="status-ok">✓ 完成</span>'}
                </summary>
                <div class="card-body">
                  <pre class="code-pre"><code>${escapeHtml(content)}</code></pre>
                </div>
              </details>
            `);
          } else if (call.name === 'run_command') {
            const cmd = String(inp.command || '');
            blockHtmls.push(`
              <details class="card term-card" open>
                <summary class="card-head term-head">
                  <span class="term-badge">$</span>
                  <span class="term-cmd">${escapeHtml(cmd)}</span>
                  ${res?.isError ? '<span class="status-err">✕ 失败</span>' : '<span class="status-ok">✓ 退出码 0</span>'}
                </summary>
                <div class="card-body term-body">
                  <pre class="term-out"><code>${escapeHtml(res?.content || '(无控制台输出)')}</code></pre>
                </div>
              </details>
            `);
          } else if (call.name === 'todo_write') {
            blockHtmls.push(`
              <div class="tool-pill">
                <span class="tool-icon">📋</span>
                <span>更新任务清单</span>
              </div>
            `);
          } else {
            blockHtmls.push(`
              <details class="card tool-card">
                <summary class="card-head tool-head">
                  <span class="tool-badge">🔧 ${escapeHtml(call.name)}</span>
                  ${res?.isError ? '<span class="status-err">✕ 失败</span>' : '<span class="status-ok">✓ 完成</span>'}
                </summary>
                <div class="card-body">
                  <div class="sub-label">输入参数：</div>
                  <pre class="code-pre"><code>${escapeHtml(JSON.stringify(inp, null, 2))}</code></pre>
                  ${res ? `<div class="sub-label">执行输出：</div><pre class="code-pre"><code>${escapeHtml(res.content)}</code></pre>` : ''}
                </div>
              </details>
            `);
          }
        } else if (b.type === 'text') {
          blockHtmls.push(`<div class="assistant-text">${renderMarkdown(b.text)}</div>`);
        }
      }

      messageItemsHtml.push(`
        <article class="msg-assistant">
          <div class="msg-meta">
            <span class="role-badge assistant-badge">🤖 助手</span>
          </div>
          <div class="assistant-blocks">${blockHtmls.join('\n')}</div>
        </article>
      `);
    }
  }

  // 极客终端暗黑主题样式内联（自包含单文件，无需任何外链）
  const styles = `
    :root {
      --bg: #0a0e0b;
      --fg: #e5e7eb;
      --dim: #9ca3af;
      --border: #1e2922;
      --panel: #111813;
      --panel2: #162019;
      --green: #4ade80;
      --green-dim: rgba(74, 222, 128, 0.15);
      --amber: #fbbf24;
      --amber-dim: rgba(251, 191, 36, 0.15);
      --red: #f87171;
      --red-dim: rgba(248, 113, 113, 0.15);
      --cyan: #22d3ee;
      --purple: #c084fc;
      --font: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      background-color: var(--bg);
      color: var(--fg);
      font-family: var(--font);
      font-size: 14px;
      line-height: 1.6;
      padding: 32px 24px;
      max-width: 1040px;
      margin: 0 auto;
    }
    header.report-header {
      border-bottom: 1px solid var(--border);
      padding-bottom: 24px;
      margin-bottom: 28px;
    }
    .brand-row { display: flex; align-items: center; gap: 8px; margin-bottom: 12px; }
    .brand-mark { color: var(--green); font-size: 18px; }
    .brand-name { font-weight: 700; letter-spacing: 1.5px; font-size: 14px; color: var(--green); }
    h1.title { font-size: 24px; font-weight: 700; margin-bottom: 16px; color: #fff; }
    .meta-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
      gap: 12px;
      background: var(--panel);
      border: 1px solid var(--border);
      border-radius: 4px;
      padding: 14px 16px;
      font-size: 13px;
    }
    .meta-item .k { color: var(--dim); margin-right: 6px; }
    .meta-item .v { color: var(--fg); }
    .card {
      background: var(--panel);
      border: 1px solid var(--border);
      border-radius: 4px;
      margin-bottom: 16px;
      overflow: hidden;
    }
    .card-head {
      background: var(--panel2);
      padding: 10px 14px;
      font-size: 13px;
      font-weight: 600;
      border-bottom: 1px solid var(--border);
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .card-body { padding: 14px; }
    .todo-list { display: flex; flex-direction: column; gap: 8px; }
    .todo-item { display: flex; align-items: center; gap: 8px; font-size: 13px; }
    .todo-item.done .todo-icon { color: var(--green); }
    .todo-item.done .todo-text { color: var(--dim); text-decoration: line-through; }
    .todo-item.prog .todo-icon { color: var(--amber); }
    .todo-item.prog .todo-text { color: #fff; font-weight: 600; }
    .todo-item.pend .todo-icon { color: var(--dim); }
    .tag { font-size: 10px; padding: 1px 5px; border-radius: 2px; text-transform: uppercase; }
    .tag-high { background: var(--red-dim); color: var(--red); }
    .tag-medium { background: var(--amber-dim); color: var(--amber); }
    .tag-low { background: rgba(156, 163, 175, 0.2); color: var(--dim); }
    .chat-flow { display: flex; flex-direction: column; gap: 24px; margin-top: 24px; }
    .msg-user {
      background: rgba(74, 222, 128, 0.04);
      border: 1px solid rgba(74, 222, 128, 0.2);
      border-radius: 4px;
      padding: 16px;
    }
    .msg-assistant {
      background: var(--panel);
      border: 1px solid var(--border);
      border-radius: 4px;
      padding: 16px;
    }
    .msg-meta { display: flex; align-items: center; gap: 10px; margin-bottom: 12px; }
    .role-badge { font-size: 12px; font-weight: 600; color: var(--green); }
    .role-badge.assistant-badge { color: var(--cyan); }
    .time { font-size: 11px; color: var(--dim); }
    .user-content { font-size: 14px; }
    .block-thinking {
      background: var(--panel2);
      border: 1px dashed rgba(251, 191, 36, 0.3);
      border-radius: 4px;
      margin-bottom: 14px;
      padding: 10px 14px;
    }
    .thinking-head { cursor: pointer; color: var(--amber); font-size: 12px; font-weight: 600; }
    .thinking-body { margin-top: 10px; font-size: 13px; color: #d1d5db; border-top: 1px dashed rgba(251, 191, 36, 0.15); padding-top: 8px; }
    .tool-card summary { cursor: pointer; }
    .tool-badge { color: var(--green); font-weight: 600; }
    .tool-path { color: var(--cyan); font-size: 12px; }
    .status-ok { color: var(--green); margin-left: auto; font-size: 12px; }
    .status-err { color: var(--red); margin-left: auto; font-size: 12px; }
    .diff-window { background: #070a08; padding: 8px; overflow-x: auto; }
    .diff-code { font-family: var(--font); font-size: 12px; line-height: 1.45; }
    .diff-line { display: flex; gap: 6px; padding: 1px 4px; }
    .diff-line.line-add { background: var(--green-dim); color: #86efac; }
    .diff-line.line-del { background: var(--red-dim); color: #fca5a5; }
    .diff-line.line-same { color: #9ca3af; }
    .term-card { border-color: #27372d; }
    .term-head { background: #132218; }
    .term-badge { color: var(--green); font-weight: bold; }
    .term-cmd { color: #f3f4f6; font-family: var(--font); font-size: 12px; }
    .term-body { background: #080d09; padding: 10px; overflow-x: auto; }
    .term-out { font-family: var(--font); font-size: 12px; color: #d1d5db; white-space: pre-wrap; }
    .code-pre { background: #080d09; padding: 10px; border-radius: 3px; overflow-x: auto; font-size: 12px; color: #e5e7eb; }
    .sub-label { font-size: 11px; color: var(--dim); margin-top: 8px; margin-bottom: 4px; }
    .assistant-text { font-size: 14px; margin-top: 12px; line-height: 1.7; }
    .assistant-text p { margin-bottom: 12px; }
    .assistant-text pre { background: #080d09; padding: 12px; border-radius: 4px; border: 1px solid var(--border); overflow-x: auto; margin: 12px 0; font-size: 13px; }
    .assistant-text code { background: rgba(255,255,255,0.06); padding: 2px 5px; border-radius: 3px; font-family: var(--font); font-size: 12px; }
    .assistant-text pre code { background: transparent; padding: 0; font-size: 13px; }
    .assistant-text ul, .assistant-text ol { margin-left: 24px; margin-bottom: 12px; }
    .assistant-text blockquote { border-left: 3px solid var(--green); padding-left: 12px; color: var(--dim); margin: 12px 0; }
    .assistant-text h1, .assistant-text h2, .assistant-text h3 { margin: 18px 0 8px 0; color: #fff; }
    /* highlight.js 代码高亮暗黑终端主题 */
    .hljs { color: #abb2bf; }
    .hljs-keyword, .hljs-operator { color: #f472b6; }
    .hljs-string { color: #4ade80; }
    .hljs-number { color: #fbbf24; }
    .hljs-comment { color: #6b7280; font-style: italic; }
    .hljs-function, .hljs-attr { color: #22d3ee; }
    .hljs-type, .hljs-class { color: #c084fc; }
  `;

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>EasyCode 会话报告 — ${escapeHtml(meta.title || '未命名')}</title>
  <style>${styles}</style>
</head>
<body>
  <header class="report-header">
    <div class="brand-row">
      <span class="brand-mark">▚</span>
      <span class="brand-name">EASYCODE 离线会话报告</span>
    </div>
    <h1 class="title">${escapeHtml(meta.title || '未命名会话')}</h1>
    <div class="meta-grid">
      <div class="meta-item"><span class="k">导出时间:</span><span class="v">${formatTimestamp(new Date().toISOString())}</span></div>
      <div class="meta-item"><span class="k">工作区目录:</span><span class="v">${escapeHtml(meta.workspaceRoot || '未绑定工作区')}</span></div>
      <div class="meta-item"><span class="k">模型与服务:</span><span class="v">${escapeHtml(meta.providerId)} · ${escapeHtml(meta.model || '默认')}</span></div>
      ${
        data.usage
          ? `<div class="meta-item"><span class="k">Token 用量:</span><span class="v">输入 ${data.usage.input.toLocaleString()} / 输出 ${data.usage.output.toLocaleString()} (步数 ${data.usage.steps ?? 0})</span></div>`
          : ''
      }
    </div>
  </header>

  ${todosHtml}

  <section class="chat-flow">
    ${messageItemsHtml.join('\n')}
  </section>
</body>
</html>`;
}
