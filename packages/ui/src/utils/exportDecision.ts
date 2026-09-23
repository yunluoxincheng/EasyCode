import type { AgentClient } from '@easycode/engine';
import { downloadFile, sanitizeFilename } from './exportSession.js';

export function getDecisionExportFilename(
  kind: 'trajectory' | 'finetune',
  scope: 'global' | 'project' | 'session',
  name?: string,
): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}`;
  const cleanName = sanitizeFilename(name || (scope === 'global' ? 'AllProjects' : 'dataset'));
  const tag = kind === 'finetune' ? 'Finetune' : 'Trajectory';
  if (scope === 'global') {
    return `Reflex-${tag}-AllProjects-${stamp}.jsonl`;
  }
  if (scope === 'project') {
    return `Reflex-${tag}-Project-${cleanName}-${stamp}.jsonl`;
  }
  return `Reflex-${tag}-Session-${cleanName}-${stamp}.jsonl`;
}

/**
 * 从后端拉取决策数据集并在前端触发文件下载
 */
export async function downloadDecisionDataset(
  client: AgentClient,
  filter?: { workspaceRoot?: string; sessionId?: string; kind?: 'trajectory' | 'finetune'; includeUnreviewed?: boolean },
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

    const kind = filter?.kind ?? (filter?.includeUnreviewed ? 'trajectory' : 'finetune');
    const filename = getDecisionExportFilename(kind, scope, scopeTitle);
    downloadFile(filename, jsonl, 'application/x-jsonlines');
    return { ok: true, count };
  } catch (err) {
    return { ok: false, count: 0, error: err instanceof Error ? err.message : String(err) };
  }
}
