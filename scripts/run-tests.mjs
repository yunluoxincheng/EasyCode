import { readdir, readFile, access } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { run } from 'node:test';
import { spawnSync } from 'node:child_process';

const root = fileURLToPath(new URL('../', import.meta.url));
const limit = 80;
const generated = new Set(['.git', 'node_modules', 'dist', 'target', 'public', 'output']);
const files = [];
let nativeTests = 0;
let testFiles = 0;

// 从源码发现；不枚举 dist，避免旧构建产物复活已移除的测试。
async function discover(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (!generated.has(entry.name)) await discover(file);
    } else if (entry.isFile() && /\.(test|spec)\.[cm]?[jt]sx?$/.test(entry.name)) {
      const compiled = /\.tsx?$/.test(file)
        ? file.replace(`${path.sep}src${path.sep}`, `${path.sep}dist${path.sep}`).replace(/\.tsx?$/, '.js')
        : file;
      if (compiled === file && /\.tsx?$/.test(file)) throw new Error(`测试源码缺少 src/dist 构建约定：${file}`);
      await access(compiled);
      files.push(compiled);
      testFiles++;
    } else if (entry.isFile() && entry.name.endsWith('.rs')) {
      const source = (await readFile(file, 'utf8')).replace(/\/\/[^\n]*|\/\*[\s\S]*?\*\//g, '');
      const count = [...source.matchAll(/#\[\s*(?:\w+::)*test(?:\([^\]]*\))?\s*\]/g)].length;
      nativeTests += count;
      if (count) testFiles++;
    }
  }
}

try {
  const args = process.argv.slice(2).filter((arg) => arg !== '--');
  if (args.length && (args.length !== 1 || args[0] !== '--native')) {
    throw new Error('完整测试入口只接受 --native，不支持过滤用例');
  }
  await discover(root);
  if (!files.length || testFiles > limit || nativeTests > limit) {
    throw new Error(`测试文件 ${testFiles}、Rust 用例 ${nativeTests} 不符合 1–${limit} 的预算`);
  }
  const cargoArgs = ['test', '--locked', '--manifest-path', 'packages/desktop-tauri/src-tauri/Cargo.toml'];
  const cargo = (args) => {
    const result = spawnSync('cargo', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });
    if (result.status !== 0) {
      process.stdout.write(result.stdout ?? '');
      throw new Error(result.error?.message ?? 'Rust 测试或清单获取失败');
    }
    return result.stdout;
  };
  if (args.includes('--native')) {
    const registered = cargo([...cargoArgs, '--', '--list']);
    nativeTests = Math.max(nativeTests, [...registered.matchAll(/: test\r?$/gm)].length);
  }
  console.log(`[ INFO ] 测试文件 ${testFiles}/${limit}；Rust ${nativeTests} 个计入总预算${args.includes('--native') ? '（已核对实际清单）' : '（声明统计；--native 执行并核对实际清单）'}。`);
  let summary;
  const exercised = new Set();
  // 不接受过滤参数，CI 与本地使用同一完整清单；动态注册和子测试按实际结果计数。
  for await (const event of run({ files: files.sort(), timeout: 60_000, forceExit: true })) {
    if (event.type === 'test:pass') console.log(`[ OK ] ${event.data.name}`);
    if (event.type === 'test:fail') console.error(`[ ERR ] ${event.data.name}`, event.data.details.error);
    if (event.type === 'test:stdout') process.stdout.write(event.data.message);
    if (event.type === 'test:stderr') process.stderr.write(event.data.message);
    if (event.type === 'test:summary') summary = event.data;
    if (['test:pass', 'test:fail'].includes(event.type) && event.data.details.type === 'test' &&
        files.includes(event.data.file) && path.resolve(root, event.data.name) !== event.data.file) {
      exercised.add(event.data.file);
    }
  }
  if (!summary) throw new Error('测试进程未返回完整统计');
  const { tests, passed, failed, skipped, cancelled, todo } = summary.counts;
  const total = tests + nativeTests;
  console.log(`[ INFO ] Node ${tests}（通过 ${passed} / 失败 ${failed} / 跳过 ${skipped} / 取消 ${cancelled} / 待办 ${todo}）；加 Rust ${nativeTests}，项目共 ${total}/${limit}。`);
  if (!summary.success || skipped || cancelled || todo || total > limit || exercised.size !== files.length) {
    throw new Error('测试失败、存在未执行用例或超过 80 个上限；请精简/替换现有测试');
  }
  if (args.includes('--native')) {
    const output = cargo(cargoArgs);
    process.stdout.write(output);
    if ([...output.matchAll(/(\d+) ignored;/g)].some((match) => Number(match[1]) > 0)) {
      throw new Error('Rust 存在跳过的测试，不允许用 ignore 规避预算或验证');
    }
  }
} catch (error) {
  console.error(`[ ERR ] ${error.message}`);
  process.exitCode = 1;
}
