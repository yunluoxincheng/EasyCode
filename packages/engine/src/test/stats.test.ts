import test from 'node:test';
import assert from 'node:assert/strict';
import { MemoryHost } from '@easycode/core';
import { DecisionStatsManager } from '../stats.js';
import { ShadowDecisionPolicy } from '../shadow.js';

test('自动标注筛选规则：工具成功执行自动入选，非零退出码失败排除，直接回复正常完成入选', async () => {
  const manager = new DecisionStatsManager(new MemoryHost());

  // 样本 A: tool_routing，命令执行失败（退出码 1）
  await manager.recordDecision({
    id: 'dec_fail_cmd',
    turnId: 'turn_fail',
    timestamp: '2026-09-24T10:00:00.000Z',
    workspaceRoot: '/workspace',
    sessionId: 's_auto',
    sessionTitle: '失败命令',
    taskFamily: 'tool_routing',
    instruction: 'Predict tool',
    state: { summary: 'Running test command' },
    candidates: [
      { id: 'run_command', text: 'RUN' },
      { id: 'stop_respond', text: 'STOP' },
    ],
    actualAction: { selectedId: 'run_command', description: 'Agent chose run_command' },
    outcome: { status: 'failure', evidence: 'Command exit code: 1' },
  });

  // 样本 B: tool_routing，工具执行成功（退出码 0）
  await manager.recordDecision({
    id: 'dec_success_cmd',
    turnId: 'turn_succ',
    timestamp: '2026-09-24T10:01:00.000Z',
    workspaceRoot: '/workspace',
    sessionId: 's_auto',
    sessionTitle: '成功命令',
    taskFamily: 'tool_routing',
    instruction: 'Predict tool',
    state: { summary: 'Running build command' },
    candidates: [
      { id: 'run_command', text: 'RUN' },
      { id: 'stop_respond', text: 'STOP' },
    ],
    actualAction: { selectedId: 'run_command', description: 'Agent chose run_command' },
    outcome: { status: 'success', evidence: 'Command exit code: 0' },
  });

  // 样本 C: tool_routing，无需工具直接回复用户且正常完成
  await manager.recordDecision({
    id: 'dec_stop_succ',
    turnId: 'turn_stop',
    timestamp: '2026-09-24T10:02:00.000Z',
    workspaceRoot: '/workspace',
    sessionId: 's_auto',
    sessionTitle: '直接回复',
    taskFamily: 'tool_routing',
    instruction: 'Predict tool',
    state: { summary: 'User said thanks' },
    candidates: [
      { id: 'run_command', text: 'RUN' },
      { id: 'stop_respond', text: 'STOP' },
    ],
    actualAction: { selectedId: 'stop_respond', description: 'Responded directly' },
    outcome: { status: 'success', evidence: 'Turn completed without tools' },
  });

  // 样本 D: recovery，自愈动作成功执行
  await manager.recordDecision({
    id: 'dec_rec_succ',
    turnId: 'turn_rec',
    timestamp: '2026-09-24T10:03:00.000Z',
    workspaceRoot: '/workspace',
    sessionId: 's_auto',
    sessionTitle: '自愈成功',
    taskFamily: 'recovery',
    instruction: 'Recover from error',
    state: { summary: 'Tool failed with file not found' },
    candidates: [
      { id: 'search_dir', text: 'SEARCH' },
      { id: 'stop', text: 'STOP' },
    ],
    actualAction: { selectedId: 'search_dir', description: 'Searched directory' },
    outcome: { status: 'success', evidence: 'Tool executed successfully' },
  });

  // 样本 E: safety，缺乏沙箱证据，必须被排除
  await manager.recordDecision({
    id: 'dec_safety_unverified',
    turnId: 'turn_safe',
    timestamp: '2026-09-24T10:04:00.000Z',
    workspaceRoot: '/workspace',
    sessionId: 's_auto',
    sessionTitle: '安全操作',
    taskFamily: 'safety',
    instruction: 'Check safety',
    state: { summary: 'rm some file' },
    candidates: [
      { id: 'allow', text: 'ALLOW' },
      { id: 'block', text: 'BLOCK' },
    ],
    actualAction: { description: 'YOLO mode allowed' },
  });

  const stats = await manager.getStats();
  assert.equal(stats.totalDecisions, 5);
  // 合格的应该只有 B(成功命令), C(直接回复), D(自愈成功) = 3 条
  // A(命令失败) 和 E(safety未验证) 被严格排除
  assert.equal(stats.qualifiedSamples, 3);

  const exported = await manager.exportDataset({ sessionId: 's_auto' });
  const lines = exported.trim().split('\n');
  assert.equal(lines.length, 3, '只有 3 条证据充足的样本被导出');

  for (const line of lines) {
    const item = JSON.parse(line);
    assert.ok(item.target, '导出的每一行必须带有合法 target');
    assert.equal(typeof item.target.defer, 'boolean');
    assert.ok(Array.isArray(item.target.selected));
    if (!item.target.defer) {
      assert.equal(item.target.selected.length, 1);
      assert.ok(item.candidates.some((c: { id: string }) => c.id === item.target.selected[0]));
    }
    assert.ok(item.split_group.startsWith('online:'));
  }
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
    metadata: {
      password: 'mypassword123',
      apiKey: 'sk-1234567890abcdef',
      rawText: 'Authorization: Bearer secret-auth-token-xyz',
    },
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

  // 验证 metadata 严格白名单过滤：非白名单凭证字段直接丢弃，绝不落盘
  assert.equal(records[0].metadata?.password, undefined);
  assert.equal(records[0].metadata?.apiKey, undefined);
  assert.equal(records[0].metadata?.rawText, undefined);

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

test('统一脱敏关口：私钥、URL密码、API凭证及非白名单metadata均无法穿透落盘', async () => {
  const host = new MemoryHost();
  const manager = new DecisionStatsManager(host);

  const leakPayload = {
    urlWithPass: 'postgres://superuser:p@ssw0rd123@db.example.com:5432/prod',
    privateKey: '-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAA\n-----END OPENSSH PRIVATE KEY-----',
    ghToken: 'ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ123456',
    secretPair: 'api_key="super-confidential-secret-999"',
    authBearer: 'Authorization: Bearer my-custom-bearer-jwt-token-val',
    titleSecret: 'Check Authorization: Bearer secret-title-jwt-token and sk-ant-1234567890abcdef',
  };

  await manager.appendEvent('session_pen_test', {
    kind: 'requested',
    record: {
      id: 'dec_pen_1',
      turnId: 'turn_pen',
      timestamp: new Date().toISOString(),
      workspaceRoot: '/workspace',
      sessionId: 'session_pen_test',
      sessionTitle: leakPayload.titleSecret,
      taskFamily: 'tool_routing',
      instruction: `Run ${leakPayload.urlWithPass} and check ${leakPayload.ghToken}`,
      state: {
        summary: `Executing with ${leakPayload.secretPair} and ${leakPayload.authBearer}`,
        goal: leakPayload.privateKey,
        history: [`curl ${leakPayload.urlWithPass}`],
      },
      candidates: [
        { id: 'run_command', text: `Execute with ${leakPayload.ghToken}` },
        { id: 'stop_respond', text: 'Stop' },
      ],
      // 故意传入非白名单的脏对象以及用白名单键名承载非法嵌套对象/数组
      metadata: {
        toolName: { dangerous_nested_obj: 'bypass_attempt' } as any, // 白名单键名，但承载了非法嵌套对象
        ratio: [0.1, 0.2] as any, // 白名单键名，但承载了非法数组
        step: 1, // 合法安全标量
        arbitrary_untrusted_command: 'rm -rf / --token=secret-token-inside-untrusted-key',
        nested_credentials: {
          client_secret: 'top-secret-val',
        },
      },
    },
  });

  await manager.flush('session_pen_test');

  // 直接读取底层磁盘落盘的原始 JSONL 文本
  const rawDiskText = await host.fs.readFile(host.paths.join(host.env.dataDir(), 'reflex_decisions/session_pen_test.jsonl'));

  // 1. 验证所有真实敏感凭证（包含 sessionTitle 中的凭证）完全不存在于磁盘文件中
  assert.doesNotMatch(rawDiskText, /secret-title-jwt-token/);
  assert.doesNotMatch(rawDiskText, /sk-ant-1234567890abcdef/);
  assert.doesNotMatch(rawDiskText, /p@ssw0rd123/);
  assert.doesNotMatch(rawDiskText, /ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ123456/);
  assert.doesNotMatch(rawDiskText, /super-confidential-secret-999/);
  assert.doesNotMatch(rawDiskText, /my-custom-bearer-jwt-token-val/);
  assert.doesNotMatch(rawDiskText, /b3BlbnNzaC1rZXktdjEAAAA/);

  // 2. 验证非白名单 metadata 属性以及承载嵌套对象的伪装键被彻底阻断，根本没有写入文件
  assert.doesNotMatch(rawDiskText, /arbitrary_untrusted_command/);
  assert.doesNotMatch(rawDiskText, /secret-token-inside-untrusted-key/);
  assert.doesNotMatch(rawDiskText, /nested_credentials/);
  assert.doesNotMatch(rawDiskText, /top-secret-val/);
  assert.doesNotMatch(rawDiskText, /dangerous_nested_obj/);

  // 3. 验证真正合法的安全标量字段正常保留
  assert.match(rawDiskText, /"step":1/);

  // 4. 读取解析后的对象，确认结构合规
  const records = await manager.loadRecords({ sessionId: 'session_pen_test' });
  assert.equal(records.length, 1);
  assert.match(records[0].sessionTitle, /Bearer \[REDACTED\]/);
  assert.doesNotMatch(records[0].sessionTitle, /secret-title-jwt-token/);
  assert.equal(records[0].metadata?.step, 1);
  assert.equal(records[0].metadata?.toolName, undefined, '白名单键承载非标量对象必须被安全丢弃');
  assert.equal(records[0].metadata?.ratio, undefined, '白名单键承载数组必须被安全丢弃');
  assert.equal('arbitrary_untrusted_command' in (records[0].metadata || {}), false);
});
