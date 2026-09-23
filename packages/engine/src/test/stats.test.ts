import test from 'node:test';
import assert from 'node:assert/strict';
import { MemoryHost } from '@easycode/core';
import type { DecisionRecord } from '@easycode/core';
import { DecisionStatsManager } from '../stats.js';
import { ShadowDecisionPolicy } from '../shadow.js';

test('DecisionStatsManager 仅比较真实动作，并仅导出人工审核标签', async () => {
  const host = new MemoryHost();
  const manager = new DecisionStatsManager(host);

  const r1: DecisionRecord = {
    id: 'dec_1',
    turnId: 'turn_1',
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
    turnId: 'turn_1',
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
    turnId: 'turn_2',
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
  assert.equal(globalStats.comparableDecisions, 1, '没有实际动作的记录不参与一致率');
  assert.equal(globalStats.unresolvedDecisions, 2);
  assert.equal(await manager.exportDataset(), '', '未审核记录不允许自标注导出');
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

  // 4. 独立人工审核后导出；模型 defer 与人工目标互不混淆。
  await manager.reviewDecision('session_1', 'dec_1', { selectedId: 'fast', defer: false });
  await manager.reviewDecision('session_1', 'dec_2', { defer: true });
  const jsonl = await manager.exportDataset({ sessionId: 'session_1' });
  const lines = jsonl.trim().split('\n');
  assert.equal(lines.length, 2);
  const row1 = JSON.parse(lines[0]);
  assert.equal(row1.schema_version, 1);
  assert.equal(row1.target.selected[0], 'fast', 'fast 对应选中项');
  assert.equal(row1.target.defer, false);
  assert.equal(row1.split_group, 'online:turn_1');
  assert.equal(row1.source.label_basis, 'human');
  assert.equal(row1.candidates[0].id, 'fast');
  assert.equal(row1.candidates.length, 2);
  const row2 = JSON.parse(lines[1]);
  assert.equal(row2.target.defer, true);
  assert.deepEqual(row2.target.selected, [], 'defer 训练目标不能包含选中候选项');

  // 5. 清理
  await manager.deleteSessionRecords('session_1');
  const afterClean = await manager.getStats();
  assert.equal(afterClean.totalDecisions, 1, '只剩 session_2');
});

test('同一会话并发追加事件不会覆盖先前记录', async () => {
  const manager = new DecisionStatsManager(new MemoryHost());
  const writes = Array.from({ length: 100 }, (_, i) => manager.appendEvent('session_parallel', {
    kind: 'requested',
    record: {
      id: `dec_${i}`,
      turnId: 'turn_parallel',
      timestamp: new Date().toISOString(),
      workspaceRoot: '/workspace',
      sessionId: 'session_parallel',
      sessionTitle: '并发',
      taskFamily: 'reasoning_effort',
      instruction: 'Choose effort',
      state: { summary: `Task ${i}` },
      candidates: [{ id: 'fast', text: 'Fast' }, { id: 'high', text: 'High' }],
    },
  }));
  await Promise.all(writes);
  const records = await manager.loadRecords({ sessionId: 'session_parallel' });
  assert.equal(records.length, 100);
  assert.equal(new Set(records.map((r) => r.id)).size, 100);
});

test('Shadow 预测与实际动作按 ID 关联，推理失败不伪造一致率', async () => {
  const manager = new DecisionStatsManager(new MemoryHost());
  let modelInput: import('@easycode/core').DecisionRequest | undefined;
  const context = {
    sessionId: 'session_shadow', sessionTitle: '影子', workspaceRoot: '/workspace', turnId: 'turn_shadow',
  };
  const shadow = new ShadowDecisionPolicy({
    async decide(req) {
      modelInput = req;
      return {
        selectedId: 'fast', selectedText: 'Fast', confidence: 0.8, defer: false,
        scores: { fast: 0.8, high: 0.2 }, latencyMs: 12,
      };
    },
  }, manager, context);
  const observation = shadow.observe({
    instruction: 'Choose effort',
    state: {
      summary: `${'a'.repeat(390)} sk-abcdefghijklmnopqrst needs complex reasoning`,
      goal: 'Bearer secret-token-value',
      history: ['h'.repeat(120)],
    },
    candidates: [{ id: 'fast', text: 'Fast' }, { id: 'high', text: 'High' }],
  });
  observation.actual({ selectedId: 'high', description: 'Provider effort: high' });
  observation.outcome({ status: 'unknown', evidence: 'No quality assessment' });
  await shadow.drain();
  const records = await manager.loadRecords({ sessionId: context.sessionId });
  assert.equal(records.length, 1);
  assert.equal(records[0].predictionStatus, 'ready');
  assert.equal(records[0].agreement, false);
  assert.equal(records[0].actualAction?.selectedId, 'high');
  assert.deepEqual(modelInput?.state, records[0].state, '归档状态必须与传给模型的状态相同');
  assert.match(records[0].state.summary, /\[REDACTED/);
  assert.doesNotMatch(records[0].state.summary, /sk-abcdefghijklmnopqrst/);
  assert.doesNotMatch(records[0].state.goal ?? '', /secret-token-value/);
  assert.equal(records[0].state.history?.[0].length, 100);
  assert.equal(await manager.exportDataset(), '', '真实行为仍需独立审核才可训练');

  const failed = new ShadowDecisionPolicy({
    async decide() { throw new Error('model unavailable'); },
  }, manager, { ...context, turnId: 'turn_failed' });
  failed.observe({
    instruction: 'Choose effort', state: { summary: 'Another task' },
    candidates: [{ id: 'fast', text: 'Fast' }, { id: 'high', text: 'High' }],
  });
  await failed.drain();
  const stats = await manager.getStats();
  assert.equal(stats.totalDecisions, 2);
  assert.equal(stats.validPredictions, 1);
  assert.equal(stats.comparableDecisions, 1);
  assert.equal(stats.agreementRate, 0);
});

test('审核拒绝越界会话 ID 和非法标签', async () => {
  const manager = new DecisionStatsManager(new MemoryHost());
  await assert.rejects(manager.loadRecords({ sessionId: '../outside' }), /Invalid session ID/);
  await assert.rejects(manager.reviewDecision('../outside', 'any', { defer: true }), /Invalid session ID/);
});

test('旧版单行日志只展示历史，不作为有效预测或训练样本', async () => {
  const legacy = {
    id: 'old_1', timestamp: '2026-09-23T10:00:00.000Z',
    workspaceRoot: '/workspace', sessionId: 'session_old', sessionTitle: '旧记录',
    taskFamily: 'reasoning_effort', instruction: 'Choose effort',
    state: { summary: 'Legacy task' },
    candidates: [{ id: 'fast', text: 'Fast' }, { id: 'high', text: 'High' }],
    prediction: {
      selectedId: 'fast', selectedText: 'Fast', confidence: 0.8, defer: false,
      scores: { fast: 0.8, high: 0.2 }, latencyMs: 12,
    },
    actualAction: { selectedId: 'fast', description: 'Unverified old action' },
    agreement: true,
  };
  const host = new MemoryHost({
    '/easycode-demo/reflex_decisions/session_old.jsonl': JSON.stringify(legacy) + '\n',
  });
  const manager = new DecisionStatsManager(host);
  const records = await manager.loadRecords();
  assert.equal(records.length, 1);
  assert.equal(records[0].predictionStatus, 'failed');
  assert.equal(records[0].agreement, undefined);
  assert.equal((await manager.getStats()).validPredictions, 0);
  assert.equal(await manager.exportDataset(), '');
});
