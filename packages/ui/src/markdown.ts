import { marked, Renderer } from 'marked';

function escapeHtml(text: string): string {
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

marked.use({ renderer, breaks: true, gfm: true });

export function renderMarkdown(text: string): string {
  return marked.parse(text, { async: false }) as string;
}
