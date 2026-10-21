import { safeStorage } from 'electron';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { SecretStore } from '@easycode/core';

/** Electron 的 OS 加密存储；Linux basic_text 不是安全后端，必须拒绝。 */
export function createSecretStore(dataDir: string): SecretStore {
  const directory = path.join(dataDir, 'credentials');
  const file = (id: string): string => {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id)) {
      throw new Error('无效的凭据引用');
    }
    return path.join(directory, `${id}.enc`);
  };
  const status = async () => {
    const backend = process.platform === 'linux' ? safeStorage.getSelectedStorageBackend() : process.platform;
    return { available: safeStorage.isEncryptionAvailable() && backend !== 'basic_text', backend: `Electron safeStorage (${backend})` };
  };
  const requireAvailable = async () => {
    if (!(await status()).available) throw new Error('系统安全存储不可用');
  };
  return {
    status,
    get: async (id) => {
      await requireAvailable();
      const target = file(id);
      let data: Buffer;
      try { data = await fs.readFile(target); }
      catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw new Error('读取加密凭据失败');
      }
      try { return safeStorage.decryptString(data); }
      catch { throw new Error('解密凭据失败，请解锁系统安全存储'); }
    },
    set: async (id, value) => {
      await requireAvailable();
      const target = file(id);
      const temp = `${target}.${randomUUID()}.tmp`;
      try {
        const encrypted = safeStorage.encryptString(value);
        await fs.mkdir(directory, { recursive: true, mode: 0o700 });
        await fs.writeFile(temp, encrypted, { mode: 0o600, flag: 'wx' });
        await fs.rename(temp, target);
      } catch {
        await fs.unlink(temp).catch(() => {});
        throw new Error('保存加密凭据失败');
      }
    },
    delete: async (id) => {
      try { await fs.unlink(file(id)); }
      catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('清理加密凭据失败');
      }
    },
  };
}
