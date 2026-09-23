import type { AgentClient } from '@easycode/engine';
import { downloadFile, sanitizeFilename } from './exportSession.js';

export function getDecisionExportFilename(scope: 'global' | 'project' | 'session', name?: string): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}`;
  const cleanName = sanitizeFilename(name || 'dataset');
  if (scope === 'global') {
    return `Reflex-AllProjects-Finetune-${stamp}.jsonl`;
  }
  if (scope === 'project') {
    return `Reflex-Project-${cleanName}-${stamp}.jsonl`;
  }
  return `Reflex-Session-${cleanName}-${stamp}.jsonl`;
}

/**
 * 从后端拉取微调数据集并在前端触发文件下载
 */
export async function downloadDecisionDataset(
  client: AgentClient,
  filter?: { workspaceRoot?: string; sessionId?: string },
  scopeTitle?: string,
): Promise<{ ok: boolean; count: number; error?: string }> {
  try {
    if (!client.exportDecisionDataset) {
      return { ok: false, count: 0, error: '当前宿主不支持导出决策数据集' };
    }
    const jsonl = await client.exportDecisionDataset(filter);
    if (!jsonl || !jsonl.trim()) {
      return { ok: false, count: 0, error: '当前范围暂无决策数据可导出' };
    }
    const lines = jsonl.trim().split('\n');
    const count = lines.length;

    let scope: 'global' | 'project' | 'session' = 'global';
    if (filter?.sessionId) scope = 'session';
    else if (filter?.workspaceRoot) scope = 'project';

    const filename = getDecisionExportFilename(scope, scopeTitle);
    downloadFile(filename, jsonl, 'application/x-jsonlines');
    return { ok: true, count };
  } catch (err) {
    return { ok: false, count: 0, error: err instanceof Error ? err.message : String(err) };
  }
}
