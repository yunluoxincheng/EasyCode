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

const HLJS_CACHE_CAP = 300;
const hljsCache = new Map<string, string>();

/** 代码高亮缓存：针对已闭合的代码块避免重复执行昂贵的 hljs 正则分词 */
function getHighlightedCode(lang: string, text: string): string {
  const cacheKey = `${lang}\n${text}`;
  const cached = hljsCache.get(cacheKey);
  if (cached !== undefined) {
    hljsCache.delete(cacheKey);
    hljsCache.set(cacheKey, cached);
    return cached;
  }

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

  if (hljsCache.size >= HLJS_CACHE_CAP) {
    const firstKey = hljsCache.keys().next().value;
    if (firstKey !== undefined) hljsCache.delete(firstKey);
  }
  hljsCache.set(cacheKey, highlighted);
  return highlighted;
}

// 禁止模型输出中的原始 HTML 直接注入（防 XSS），链接在新窗口打开
const renderer = new Renderer();
renderer.html = (token) => escapeHtml(typeof token === 'string' ? token : token.text ?? '');
renderer.link = (token) => {
  const { href, title, text } = token as { href?: string; title?: string | null; text?: string };
  const titleAttr = title ? ` title="${escapeHtml(title)}"` : '';
  return `<a href="${escapeHtml(href ?? '#')}"${titleAttr} target="_blank" rel="noopener noreferrer">${text ?? ''}</a>`;
};

// 代码块语法高亮 + 顶部语言条与复制按钮容器（内置高亮缓存）
renderer.code = (token: Tokens.Code | { text: string; lang?: string }) => {
  const text = token.text ?? '';
  const rawLang = (token.lang ?? '').trim();
  const lang = rawLang.split(/\s+/)[0] || '';
  const highlighted = getHighlightedCode(lang, text);

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

const MD_CACHE_CAP = 200;
const mdCache = new Map<string, string>();

/** 渲染 Markdown 为 HTML 字符串，内嵌 LRU 缓存彻底避免对已定型长文本的重复解析与 AST 遍历 */
export function renderMarkdown(text: string): string {
  if (!text) return '';
  const cached = mdCache.get(text);
  if (cached !== undefined) {
    mdCache.delete(text);
    mdCache.set(text, cached);
    return cached;
  }

  const result = marked.parse(text, { async: false }) as string;
  if (mdCache.size >= MD_CACHE_CAP) {
    const firstKey = mdCache.keys().next().value;
    if (firstKey !== undefined) mdCache.delete(firstKey);
  }
  mdCache.set(text, result);
  return result;
}

