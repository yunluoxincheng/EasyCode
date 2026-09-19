export type DiffLine = { type: 'same' | 'add' | 'del'; text: string };

/**
 * 行级 LCS diff（用于 UI 呈现文件修改），限制规模防止 O(n²) 爆内存。
 */
export function diffLines(oldText: string, newText: string, maxLines = 1500): DiffLine[] {
  const a = oldText.split('\n').slice(0, maxLines);
  const b = newText.split('\n').slice(0, maxLines);
  const n = a.length;
  const m = b.length;

  // DP 表用扁平数组；超过规模时退化为逐行对照
  if (n * m > 4_000_000) {
    return [
      ...a.map((text): DiffLine => ({ type: 'del', text })),
      ...b.map((text): DiffLine => ({ type: 'add', text })),
    ];
  }

  const dp = new Uint32Array((n + 1) * (m + 1));
  const at = (i: number, j: number) => i * (m + 1) + j;
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[at(i, j)] =
        a[i] === b[j] ? dp[at(i + 1, j + 1)] + 1 : Math.max(dp[at(i + 1, j)], dp[at(i, j + 1)]);
    }
  }

  const result: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      result.push({ type: 'same', text: a[i] });
      i++;
      j++;
    } else if (dp[at(i + 1, j)] >= dp[at(i, j + 1)]) {
      result.push({ type: 'del', text: a[i] });
      i++;
    } else {
      result.push({ type: 'add', text: b[j] });
      j++;
    }
  }
  while (i < n) result.push({ type: 'del', text: a[i++] });
  while (j < m) result.push({ type: 'add', text: b[j++] });
  return result;
}
