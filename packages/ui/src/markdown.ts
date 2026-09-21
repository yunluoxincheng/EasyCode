import { marked, Renderer, type Tokens } from 'marked';
import hljs from 'highlight.js/lib/common';

export function escapeHtml(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

// 禁止模型输出中的原始 HTML 直接注入（防 XSS），链接在新窗口打开
const renderer = new Renderer();
renderer.html = (token) => escapeHtml(typeof token === 'string' ? token : token.text ?? '');
renderer.link = (token) => {
  const { href, title, text } = token as { href?: string; title?: string | null; text?: string };
  const titleAttr = title ? ` title="${escapeHtml(title)}"` : '';
  return `<a href="${escapeHtml(href ?? '#')}"${titleAttr} target="_blank" rel="noopener noreferrer">${text ?? ''}</a>`;
};

// 代码块语法高亮 + 顶部语言条与复制按钮容器
renderer.code = (token: Tokens.Code | { text: string; lang?: string }) => {
  const text = token.text ?? '';
  const rawLang = (token.lang ?? '').trim();
  const lang = rawLang.split(/\s+/)[0] || '';
  let highlighted = '';

  if (lang && hljs.getLanguage(lang)) {
    try {
      highlighted = hljs.highlight(text, { language: lang, ignoreIllegals: true }).value;
    } catch {
      highlighted = escapeHtml(text);
    }
  } else {
    highlighted = escapeHtml(text);
  }

  const displayLang = lang ? `// ${lang}` : '// text';
  const langClass = lang ? ` language-${escapeHtml(lang)}` : '';

  return `<div class="code-block">
  <div class="code-head">
    <span class="code-lang">${escapeHtml(displayLang)}</span>
    <button type="button" class="code-copy-btn" title="复制代码">⧉ 复制</button>
  </div>
  <pre><code class="hljs${langClass}">${highlighted}</code></pre>
</div>\n`;
};

marked.use({ renderer, breaks: true, gfm: true });

export function renderMarkdown(text: string): string {
  return marked.parse(text, { async: false }) as string;
}

