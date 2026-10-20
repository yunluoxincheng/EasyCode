import type { Host } from '@easycode/core';
import type { ProviderEntry, Settings, WebSearchConfig } from './settings.js';

type Credential = { apiKey?: string; apiKeyRef?: string; hasApiKey?: boolean };

/** 只在引擎处理密钥。设置提交使用新引用，避免失败时覆盖旧凭据。 */
export class SettingsSecrets {
  warning: string | undefined;

  constructor(private readonly host: Host) {}

  async status(): Promise<NonNullable<Settings['credentialStorageStatus']>> {
    try {
      const status = await this.host.secrets?.status();
      return { ...(status ?? { available: false, backend: '无系统安全存储（CLI / 浏览器演示）' }), warning: this.warning };
    } catch {
      return { available: false, backend: '系统安全存储不可用', warning: this.warning };
    }
  }

  async publicView(settings: Settings): Promise<Settings> {
    const view = structuredClone(settings);
    view.secretStorage ??= this.host.secrets ? 'system' : 'plaintext';
    for (const p of Object.values(view.providers)) {
      p.hasApiKey = !!(p.apiKey || p.apiKeyRef);
      delete p.apiKey;
      delete p.apiKeyRef;
    }
    if (view.webSearch) {
      view.webSearch.hasTavilyApiKey = !!(view.webSearch.tavilyApiKey || view.webSearch.tavilyApiKeyRef);
      delete view.webSearch.tavilyApiKey;
      delete view.webSearch.tavilyApiKeyRef;
    }
    view.credentialStorageStatus = await this.status();
    return view;
  }

  async resolve(p: Credential): Promise<string | undefined> {
    if (p.apiKey !== undefined) return p.apiKey || undefined;
    if (!p.apiKeyRef) return undefined;
    try {
      const value = await this.host.secrets?.get(p.apiKeyRef);
      if (value) return value;
    } catch { /* 下方统一错误，禁止底层错误泄露凭据 */ }
    throw new Error('无法读取已保存的密钥，请解锁系统凭据存储或在设置中重新填写密钥');
  }

  async provider(entry: ProviderEntry): Promise<ProviderEntry> {
    if (entry.kind === 'mock') return { ...entry, apiKey: undefined };
    return { ...entry, apiKey: await this.resolve(entry) };
  }

  async webSearch(ws: WebSearchConfig | undefined): Promise<WebSearchConfig | undefined> {
    if (!ws) return undefined;
    if (!ws.enabled || ws.backend !== 'tavily') return { ...ws, tavilyApiKey: undefined };
    return { ...ws, tavilyApiKey: await this.resolve({ apiKey: ws.tavilyApiKey, apiKeyRef: ws.tavilyApiKeyRef }) };
  }

  /** UI 缺省密钥表示保留；空字符串是显式清除。引用只能来自引擎旧配置。 */
  merge(current: Settings, patch: Partial<Settings>): Settings {
    const next = structuredClone({ ...current, ...patch });
    delete next.credentialStorageStatus;
    for (const [id, p] of Object.entries(next.providers)) {
      const previous = current.providers[id];
      const submitted = patch.providers?.[id];
      p.apiKey = submitted?.apiKey !== undefined ? submitted.apiKey : previous?.apiKey;
      p.apiKeyRef = submitted?.apiKey !== undefined ? undefined : previous?.apiKeyRef;
      delete p.hasApiKey;
    }
    if (next.webSearch) {
      next.webSearch.tavilyApiKey = patch.webSearch?.tavilyApiKey !== undefined
        ? patch.webSearch.tavilyApiKey : current.webSearch?.tavilyApiKey;
      next.webSearch.tavilyApiKeyRef = patch.webSearch?.tavilyApiKey !== undefined
        ? undefined : current.webSearch?.tavilyApiKeyRef;
      delete next.webSearch.hasTavilyApiKey;
    }
    return next;
  }

  needsMigration(settings: Settings): boolean {
    return !!this.host.secrets && settings.secretStorage !== 'plaintext' &&
      (Object.values(settings.providers).some((p) => !!p.apiKey) || !!settings.webSearch?.tavilyApiKey);
  }

  private refs(settings: Settings): Set<string> {
    return new Set([
      ...Object.values(settings.providers).map((p) => p.apiKeyRef),
      settings.webSearch?.tavilyApiKeyRef,
    ].filter((ref): ref is string => !!ref));
  }

  /** 凭据先写后读验证，配置同目录原子替换后才清理旧引用。 */
  async save(settings: Settings, previous: Settings, file: string): Promise<Settings> {
    const next = structuredClone(settings);
    delete next.credentialStorageStatus;
    next.secretStorage ??= this.host.secrets ? 'system' : 'plaintext';
    const created: string[] = [];
    const temp = `${file}.${crypto.randomUUID()}.tmp`;
    let tempWritten = false;
    const transform = async (p: Credential): Promise<void> => {
      delete p.hasApiKey;
      if (next.secretStorage === 'plaintext') {
        p.apiKey = await this.resolve(p);
        delete p.apiKeyRef;
      } else if (p.apiKey !== undefined) {
        if (p.apiKey) {
          const ref = crypto.randomUUID();
          created.push(ref);
          await this.host.secrets!.set(ref, p.apiKey);
          if (await this.host.secrets!.get(ref) !== p.apiKey) throw new Error('readback');
          p.apiKeyRef = ref;
        } else {
          delete p.apiKeyRef;
        }
        delete p.apiKey;
      }
    };
    try {
      if (next.secretStorage !== 'system' && next.secretStorage !== 'plaintext') throw new Error('mode');
      if (next.secretStorage === 'system' && !(await this.status()).available) {
        throw new Error('unavailable');
      }
      for (const p of Object.values(next.providers)) await transform(p);
      if (next.webSearch) {
        const p: Credential = { apiKey: next.webSearch.tavilyApiKey, apiKeyRef: next.webSearch.tavilyApiKeyRef };
        await transform(p);
        next.webSearch.tavilyApiKey = p.apiKey;
        next.webSearch.tavilyApiKeyRef = p.apiKeyRef;
        delete next.webSearch.hasTavilyApiKey;
      }
      if (!this.host.fs.rename) throw new Error('atomic rename unavailable');
      await this.host.fs.mkdir(this.host.env.dataDir(), { recursive: true });
      tempWritten = true;
      await this.host.fs.writeFile(temp, JSON.stringify(next, null, 2));
      await this.host.fs.rename(temp, file);
    } catch {
      if (tempWritten) await this.host.fs.unlink?.(temp).catch(() => {});
      for (const ref of created) await this.host.secrets?.delete(ref).catch(() => {});
      throw new Error('密钥或设置保存失败，原设置已保留。请检查系统凭据存储；如需明文存储，请在常规设置中明确选择');
    }
    this.warning = undefined;
    const keep = this.refs(next);
    for (const ref of this.refs(previous)) {
      if (!keep.has(ref)) {
        try { await this.host.secrets?.delete(ref); }
        catch { this.warning = '设置已保存，但旧凭据清理失败；旧凭据不再被当前设置引用'; }
      }
    }
    return next;
  }
}
