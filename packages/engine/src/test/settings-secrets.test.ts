import test from 'node:test';
import assert from 'node:assert/strict';
import { MemoryHost, type SecretStore } from '@easycode/core';
import { AgentServer } from '../server.js';
import { DEFAULT_SETTINGS, type Settings } from '../settings.js';

const FILE = '/easycode-demo/settings.json';
const ALPHA = 'test-only-alpha-key';
const BETA = 'test-only-beta-key';
const TAVILY = 'test-only-tavily-key';
const REPLACEMENT = 'test-only-replacement-key';

/** 故障注入只验证事务边界，不代表真实系统凭据后端可用。 */
class ControlledSecrets implements SecretStore {
  readonly values = new Map<string, string>();
  available = true;
  fault?: 'readback';
  writes = 0;
  readonly failedDeletes = new Set<string>();

  async status() { return { available: this.available, backend: 'controlled-test-store' }; }
  private requireAvailable() {
    if (!this.available) throw new Error('injected unavailable store');
  }
  async get(id: string) {
    this.requireAvailable();
    if (this.fault === 'readback') return 'injected incorrect readback';
    return this.values.get(id) ?? null;
  }
  async set(id: string, value: string) {
    this.requireAvailable();
    this.writes++;
    this.values.set(id, value);
  }
  async delete(id: string) {
    this.requireAvailable();
    if (this.failedDeletes.has(id)) throw new Error('injected delete failure');
    this.values.delete(id);
  }
}

function legacySettings(): Settings {
  return {
    ...structuredClone(DEFAULT_SETTINGS),
    providers: {
      alpha: { kind: 'openai-compatible', baseURL: 'https://example.invalid', apiKey: ALPHA },
      beta: { kind: 'responses', baseURL: 'https://example.invalid', apiKey: BETA },
    },
    defaultProvider: 'alpha',
    webSearch: { enabled: true, backend: 'tavily', tavilyApiKey: TAVILY },
  };
}

class CredentialHost extends MemoryHost {
  readonly secrets = new ControlledSecrets();
  constructor() { super({ [FILE]: JSON.stringify(legacySettings()) }); }
}

function disk(host: MemoryHost): Settings {
  return JSON.parse(host.snapshot()[FILE]) as Settings;
}

function assertMasked(view: Settings) {
  assert.equal(view.credentialCleanupRefs, undefined);
  for (const p of Object.values(view.providers)) {
    assert.equal(p.apiKey, undefined);
    assert.equal(p.apiKeyRef, undefined);
  }
  assert.equal(view.webSearch?.tavilyApiKey, undefined);
  assert.equal(view.webSearch?.tavilyApiKeyRef, undefined);
}

function assertNoTemporaryFiles(host: MemoryHost) {
  assert.deepEqual(Object.keys(host.snapshot()), [FILE]);
}

test('凭据迁移：并发首次读取共享迁移，回读成功后提交引用，重启保留并脱敏', async () => {
  const host = new CredentialHost();
  const server = new AgentServer(host);
  const views = await Promise.all([server.getSettings(), server.getSettings(), server.getSettings()]);
  assert.equal(host.secrets.writes, 3);
  for (const view of views) {
    assertMasked(view);
    assert.equal(view.providers.alpha.hasApiKey, true);
    assert.equal(view.webSearch?.hasTavilyApiKey, true);
  }
  const saved = disk(host);
  assert.equal(saved.secretStorage, 'system');
  assert.equal(saved.providers.alpha.apiKey, undefined);
  assert.equal(saved.webSearch?.tavilyApiKey, undefined);
  assert.equal(await host.secrets.get(saved.providers.alpha.apiKeyRef!), ALPHA);
  assert.equal(await host.secrets.get(saved.providers.beta.apiKeyRef!), BETA);
  assert.equal(await host.secrets.get(saved.webSearch!.tavilyApiKeyRef!), TAVILY);
  assertNoTemporaryFiles(host);
  assertMasked(await new AgentServer(host).getSettings());
  assert.equal(host.secrets.writes, 3, '重启不得重复写入已迁移凭据');
});

test('凭据回读不一致：不迁移旧明文，回滚新引用并允许重试', async () => {
  const host = new CredentialHost();
  const before = host.snapshot();
  host.secrets.fault = 'readback';
  const server = new AgentServer(host);
  const view = await server.getSettings();
  assertMasked(view);
  assert.equal(view.providers.alpha.hasApiKey, true);
  assert.match(view.credentialStorageStatus?.warning ?? '', /旧密钥尚未迁移/);
  assert.doesNotMatch(view.credentialStorageStatus?.warning ?? '', new RegExp(ALPHA));
  assert.deepEqual(host.snapshot(), before);
  assert.equal(host.secrets.values.size, 0);

  host.secrets.fault = undefined;
  const retried = await server.updateSettings({ maxSteps: 211 });
  assertMasked(retried);
  assert.equal(retried.credentialStorageStatus?.warning, undefined);
  assert.equal(retried.maxSteps, 211);
  assert.equal(await host.secrets.get(disk(host).providers.alpha.apiKeyRef!), ALPHA);
  assert.equal(await host.secrets.get(disk(host).webSearch!.tavilyApiKeyRef!), TAVILY);
  assertNoTemporaryFiles(host);
});

test('密钥替换提交失败：不覆盖旧引用或内存，重试成功后才删除旧凭据', async () => {
  const host = new CredentialHost();
  const server = new AgentServer(host);
  const view = await server.getSettings();
  const before = host.snapshot();
  const oldValues = new Map(host.secrets.values);
  const originalRename = host.fs.rename;
  host.fs.rename = async () => { throw new Error('injected rename failure'); };
  const patch = {
    maxSteps: 211,
    providers: { ...view.providers, alpha: { ...view.providers.alpha, apiKey: REPLACEMENT } },
  };
  await assert.rejects(server.updateSettings(patch), /原设置已保留/);
  assert.deepEqual(host.snapshot(), before);
  assert.deepEqual(host.secrets.values, oldValues);
  assert.equal((await server.getSettings()).maxSteps, view.maxSteps);

  host.fs.rename = originalRename;
  const saved = await server.updateSettings(patch);
  assertMasked(saved);
  assert.equal(saved.maxSteps, 211);
  const old = JSON.parse(before[FILE]) as Settings;
  const next = disk(host);
  assert.notEqual(next.providers.alpha.apiKeyRef, old.providers.alpha.apiKeyRef);
  assert.equal(await host.secrets.get(next.providers.alpha.apiKeyRef!), REPLACEMENT);
  assert.equal(await host.secrets.get(old.providers.alpha.apiKeyRef!), null);
  assert.equal(await host.secrets.get(next.providers.beta.apiKeyRef!), BETA);
  assertNoTemporaryFiles(host);
});

test('后端恢复：列全阻塞项，旧凭据清理队列跨重启保留、部分重试并确认', async () => {
  const host = new CredentialHost();
  const server = new AgentServer(host);
  const view = await server.getSettings();
  host.secrets.available = false;
  const before = host.snapshot();
  const beforeValues = new Map(host.secrets.values);
  const providers: Settings['providers'] = {
    ...view.providers, alpha: { ...view.providers.alpha, apiKey: REPLACEMENT },
  };
  await assert.rejects(server.updateSettings({ secretStorage: 'plaintext', providers }), (err: Error) => {
    assert.equal(err.name, 'CredentialRecoveryError');
    assert.match(err.message, /模型服务 "beta"/);
    assert.match(err.message, /Tavily 搜索/);
    assert.match(err.message, /重新填写或显式清除/);
    assert.doesNotMatch(err.message, /模型服务 "alpha"/);
    for (const value of [ALPHA, BETA, TAVILY, REPLACEMENT, ...beforeValues.keys()]) {
      assert.equal(err.message.includes(value), false, '恢复诊断不能泄露值或引用');
    }
    return true;
  });
  assert.deepEqual(host.snapshot(), before);
  assert.deepEqual(host.secrets.values, beforeValues);
  assert.equal((await server.getSettings()).secretStorage, 'system');

  // 当前 Provider 补填，其余显式清除；禁用或未使用的服务也不能静默丢弃。
  const saved = await server.updateSettings({
    secretStorage: 'plaintext',
    providers: { ...providers, beta: { ...providers.beta, apiKey: '' } },
    webSearch: { ...view.webSearch!, tavilyApiKey: '' },
  });
  assertMasked(saved);
  assert.equal(saved.secretStorage, 'plaintext');
  assert.equal(saved.providers.alpha.hasApiKey, true);
  assert.equal(saved.providers.beta.hasApiKey, false);
  assert.equal(saved.webSearch?.hasTavilyApiKey, false);
  assert.match(saved.credentialStorageStatus?.warning ?? '', /旧凭据清理失败/);
  assert.equal(disk(host).providers.alpha.apiKey, REPLACEMENT);
  assert.equal(disk(host).providers.beta.apiKeyRef, undefined);
  assert.equal(disk(host).webSearch?.tavilyApiKeyRef, undefined);
  const refs = [...beforeValues.keys()];
  assert.deepEqual(disk(host).credentialCleanupRefs?.sort(), refs.sort());
  const unavailable = await new AgentServer(host).getSettings();
  assertMasked(unavailable);
  assert.match(unavailable.credentialStorageStatus?.warning ?? '', /旧凭据清理失败/);
  assert.deepEqual(disk(host).credentialCleanupRefs?.sort(), refs);

  // 删除成功但确认写回失败：保留原队列，不能撤销已保存的新配置。
  host.secrets.available = true;
  const betaRef = JSON.parse(before[FILE]).providers.beta.apiKeyRef as string;
  host.secrets.failedDeletes.add(betaRef);
  const rename = host.fs.rename;
  host.fs.rename = async () => { throw new Error('injected cleanup acknowledgement failure'); };
  const unacknowledged = await new AgentServer(host).getSettings();
  assert.match(unacknowledged.credentialStorageStatus?.warning ?? '', /清理记录更新失败/);
  assert.equal(disk(host).providers.alpha.apiKey, REPLACEMENT);
  assert.deepEqual(disk(host).credentialCleanupRefs?.sort(), refs);
  assert.deepEqual([...host.secrets.values.keys()], [betaRef]);
  host.fs.rename = rename;

  const restarted = new AgentServer(host);
  assertMasked(await restarted.getSettings());
  assert.deepEqual(disk(host).credentialCleanupRefs, [betaRef], '已删除引用幂等重试，失败项单独保留');
  host.secrets.failedDeletes.clear();
  const unrelatedRef = crypto.randomUUID();
  host.secrets.values.set(unrelatedRef, 'test-only-unrelated');
  const retried = await restarted.updateSettings({ maxSteps: 211, credentialCleanupRefs: [unrelatedRef] });
  assertMasked(retried);
  assert.equal(retried.credentialStorageStatus?.warning, undefined);
  assert.equal(disk(host).credentialCleanupRefs, undefined);
  assert.equal(host.secrets.values.has(betaRef), false);
  assert.equal(host.secrets.values.has(unrelatedRef), true, '公开更新不能注入清理目标');
  assertNoTemporaryFiles(host);
});

test('并发设置更新：后续提交继承最新值，不覆盖首个更新', async () => {
  const host = new CredentialHost();
  const server = new AgentServer(host);
  await server.getSettings();
  const oldValues = new Map(host.secrets.values);
  const rename = host.fs.rename;
  let enter!: () => void;
  let release!: () => void;
  const entered = new Promise<void>((resolve) => { enter = resolve; });
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let first = true;
  host.fs.rename = async (from, to) => {
    if (first) {
      first = false;
      enter();
      await gate;
    }
    await rename(from, to);
  };
  const updateA = server.updateSettings({ maxSteps: 211 }).then(
    () => 'saved', () => 'rejected',
  );
  await entered;
  const updateB = server.updateSettings({ defaultApprovalMode: 'yolo' });
  try {
    await new Promise<void>((resolve) => setImmediate(resolve));
  } finally { release(); }
  assert.equal(await updateA, 'saved');
  const final = await updateB;
  assert.equal(final.maxSteps, 211);
  assert.equal(final.defaultApprovalMode, 'yolo');
  assert.equal(disk(host).maxSteps, final.maxSteps);
  assert.equal(disk(host).defaultApprovalMode, 'yolo');
  assert.deepEqual(host.secrets.values, oldValues);
  assertNoTemporaryFiles(host);
});

test('搜索连通性：Tavily 凭据缺失返回零耗时错误，不发请求', async (t) => {
  const host = new CredentialHost();
  const server = new AgentServer(host);
  await server.getSettings();
  host.secrets.values.delete(disk(host).webSearch!.tavilyApiKeyRef!);
  const fetch = t.mock.method(globalThis, 'fetch', async () => { throw new Error('unexpected network call'); });
  const result = await server.testWebSearch();
  assert.equal(result.ok, false);
  assert.equal(result.latencyMs, 0);
  assert.match(result.error ?? '', /无法读取已保存的密钥/);
  assert.equal(result.resultCount, undefined);
  assert.equal(fetch.mock.callCount(), 0);
});
