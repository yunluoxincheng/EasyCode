import test from 'node:test';
import assert from 'node:assert/strict';
import { MemoryHost } from '@easycode/core';
import type { DecisionRecord } from '@easycode/core';
import { DecisionStatsManager } from '../stats.js';

test('DecisionStatsManager 写入决策记录、聚合统计并导出 JSONL 微调数据集', async () => {
  const host = new MemoryHost();
  const manager = new DecisionStatsManager(host);

  const r1: DecisionRecord = {
    id: 'dec_1',
    timestamp: '2026-09-23T10:00:00.000Z',
    workspaceRoot: '/workspace/project-alpha',
    sessionId: 'session_1',
    sessionTitle: '修复 README',
    taskFamily: 'reasoning_effort',
    instruction: 'Choose reasoning effort',
    state: { summary: 'Simple edit' },
    candidates: [
      { id: 'fast', text: 'FAST' },
      { id: 'medium', text: 'MEDIUM' },
    ],
    prediction: {
      selectedId: 'fast',
      selectedText: 'FAST',
      confidence: 0.95,
      defer: false,
      scores: { fast: 0.95, medium: 0.05 },
      latencyMs: 25.4,
    },
    agreement: true,
  };

  const r2: DecisionRecord = {
    id: 'dec_2',
    timestamp: '2026-09-23T10:05:00.000Z',
    workspaceRoot: '/workspace/project-alpha',
    sessionId: 'session_1',
    sessionTitle: '修复 README',
    taskFamily: 'recovery',
    instruction: 'Recover from error',
    state: { summary: 'File not found' },
    candidates: [
      { id: 'retry', text: 'Retry' },
      { id: 'search', text: 'Search' },
    ],
    prediction: {
      selectedId: 'search',
      selectedText: 'Search',
      confidence: 0.35,
      defer: true,
      scores: { retry: 0.45, search: 0.55 },
      latencyMs: 28.2,
    },
    actualAction: { selectedId: 'search', description: 'Run search' },
    agreement: true,
  };

  const r3: DecisionRecord = {
    id: 'dec_3',
    timestamp: '2026-09-23T11:00:00.000Z',
    workspaceRoot: '/workspace/project-beta',
    sessionId: 'session_2',
    sessionTitle: '重构组件',
    taskFamily: 'safety',
    instruction: 'Check command safety',
    state: { summary: 'rm -rf' },
    candidates: [
      { id: 'allow', text: 'ALLOW' },
      { id: 'block', text: 'BLOCK' },
    ],
    prediction: {
      selectedId: 'block',
      selectedText: 'BLOCK',
      confidence: 0.88,
      defer: false,
      scores: { allow: 0.12, block: 0.88 },
      latencyMs: 22.1,
    },
    agreement: true,
  };

  // 1. 写入
  await manager.recordDecision(r1);
  await manager.recordDecision(r2);
  await manager.recordDecision(r3);

  // 2. 统计
  const globalStats = await manager.getStats();
  assert.equal(globalStats.totalDecisions, 3);
  assert.equal(globalStats.deferRate, 0.333);
  assert.equal(globalStats.agreementRate, 1.0);
  assert.equal(globalStats.taskFamilyDistribution.reasoning_effort, 1);
  assert.equal(globalStats.taskFamilyDistribution.recovery, 1);
  assert.equal(globalStats.taskFamilyDistribution.safety, 1);
  assert.equal(globalStats.confidenceBuckets.low, 1); // 0.35
  assert.equal(globalStats.confidenceBuckets.high, 1); // 0.88
  assert.equal(globalStats.confidenceBuckets.topTier, 1); // 0.95

  // 单项目过滤统计
  const projectStats = await manager.getStats({ workspaceRoot: '/workspace/project-alpha' });
  assert.equal(projectStats.totalDecisions, 2);

  // 3. 树形获取
  const tree = await manager.getDecisionTree();
  assert.equal(tree.length, 2, '两个项目');
  const alphaNode = tree.find((t) => t.workspaceRoot === '/workspace/project-alpha');
  assert.ok(alphaNode);
  assert.equal(alphaNode.totalDecisions, 2);
  assert.equal(alphaNode.sessions.length, 1);
  assert.equal(alphaNode.sessions[0].sessionId, 'session_1');
  assert.equal(alphaNode.sessions[0].records.length, 2);

  // 4. 导出
  const jsonl = await manager.exportDataset({ sessionId: 'session_1' });
  const lines = jsonl.trim().split('\n');
  assert.equal(lines.length, 2);
  const row1 = JSON.parse(lines[0]);
  assert.equal(row1.schema_version, 1);
  assert.equal(row1.target.selected[0], 'fast', 'fast 对应选中项');
  assert.equal(row1.candidates[0].id, 'fast');
  assert.equal(row1.candidates.length, 2);

  // 5. 清理
  await manager.deleteSessionRecords('session_1');
  const afterClean = await manager.getStats();
  assert.equal(afterClean.totalDecisions, 1, '只剩 session_2');
});
