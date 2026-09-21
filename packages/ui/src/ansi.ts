import React from 'react';

export interface AnsiSpan {
  text: string;
  className: string;
}

/**
 * 清洗 \r 字符：针对带有动态进度条、旋转指示器的单行输出，取覆盖后的有效文本
 */
export function cleanCarriageReturns(text: string): string {
  const normalized = text.replace(/\r\n/g, '\n');
  const lines = normalized.split('\n');
  const cleanedLines = lines.map((line) => {
    if (!line.includes('\r')) return line;
    const parts = line.split('\r');
    return parts[parts.length - 1] ?? '';
  });
  return cleanedLines.join('\n');
}

/**
 * 解析 ANSI SGR 控制序列并转为结构化文本片段列表
 */
export function parseAnsi(rawText: string): AnsiSpan[] {
  const cleaned = cleanCarriageReturns(rawText);
  // 剥离非 SGR 的控制序列 (如光标、清屏等)
  const stripped = cleaned.replace(/\u001b\[[0-9;?]*[A-K|L-l|n-z]/g, '');

  const regex = /\u001b\[([0-9;]*)m/g;
  const spans: AnsiSpan[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  let currentFg = '';
  let currentBg = '';
  let isBold = false;
  let isDim = false;
  let isItalic = false;
  let isUnderline = false;

  const buildClass = (): string => {
    const cls: string[] = [];
    if (currentFg) cls.push(currentFg);
    if (currentBg) cls.push(currentBg);
    if (isBold) cls.push('ansi-bold');
    if (isDim) cls.push('ansi-dim');
    if (isItalic) cls.push('ansi-italic');
    if (isUnderline) cls.push('ansi-underline');
    return cls.join(' ');
  };

  while ((match = regex.exec(stripped)) !== null) {
    const textBefore = stripped.slice(lastIndex, match.index);
    if (textBefore) {
      spans.push({ text: textBefore, className: buildClass() });
    }

    const codeStr = match[1] || '0';
    const codes = codeStr.split(';').map((s) => (s ? parseInt(s, 10) : 0));

    for (let i = 0; i < codes.length; i++) {
      const code = codes[i];
      if (code === 0) {
        currentFg = '';
        currentBg = '';
        isBold = false;
        isDim = false;
        isItalic = false;
        isUnderline = false;
      } else if (code === 1) {
        isBold = true;
      } else if (code === 2) {
        isDim = true;
      } else if (code === 3) {
        isItalic = true;
      } else if (code === 4) {
        isUnderline = true;
      } else if (code === 22) {
        isBold = false;
        isDim = false;
      } else if (code === 23) {
        isItalic = false;
      } else if (code === 24) {
        isUnderline = false;
      } else if ((code >= 30 && code <= 37) || (code >= 90 && code <= 97)) {
        currentFg = `ansi-fg-${code}`;
      } else if (code === 39) {
        currentFg = '';
      } else if ((code >= 40 && code <= 47) || (code >= 100 && code <= 107)) {
        currentBg = `ansi-bg-${code}`;
      } else if (code === 49) {
        currentBg = '';
      }
    }

    lastIndex = regex.lastIndex;
  }

  const remaining = stripped.slice(lastIndex);
  if (remaining) {
    spans.push({ text: remaining, className: buildClass() });
  }

  return spans;
}

/**
 * 渲染包含 ANSI 转义序列的文本为 React 节点
 */
export function renderAnsi(text: string): React.ReactNode {
  const spans = parseAnsi(text);
  if (spans.length === 0) return null;
  return spans.map((span, idx) => {
    if (!span.className) return span.text;
    return React.createElement('span', { key: idx, className: span.className }, span.text);
  });
}
