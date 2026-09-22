import test from 'node:test';
import assert from 'node:assert/strict';
import { listFilesRecursively } from '../tools/search.js';
import { MemoryHost } from '../host.js';

test('listFilesRecursively 递归收集相对路径并忽略指定目录', async () => {
  const host = new MemoryHost({
    '/workspace/src/App.tsx': 'export const App = () => null;',
    '/workspace/src/components/Composer.tsx': 'export const Composer = () => null;',
    '/workspace/package.json': '{}',
    '/workspace/.git/HEAD': 'ref: refs/heads/master',
    '/workspace/node_modules/react/index.js': '',
    '/workspace/dist/bundle.js': '',
  });

  const files = await listFilesRecursively(host, '/workspace');

  assert.ok(files.includes('src/App.tsx'));
  assert.ok(files.includes('src/components/Composer.tsx'));
  assert.ok(files.includes('package.json'));
  // 校验忽略规则生效
  assert.ok(!files.some((f) => f.includes('.git')));
  assert.ok(!files.some((f) => f.includes('node_modules')));
  assert.ok(!files.some((f) => f.includes('dist')));
});

test('listFilesRecursively 支持上限截断', async () => {
  const host = new MemoryHost({
    '/workspace/a.ts': '',
    '/workspace/b.ts': '',
    '/workspace/c.ts': '',
    '/workspace/d.ts': '',
  });

  const files = await listFilesRecursively(host, '/workspace', { limit: 2 });
  assert.equal(files.length, 2);
});
