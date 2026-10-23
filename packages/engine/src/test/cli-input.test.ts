import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { CliInput } from '../cli-input.js';

test('CLI 输入队列：单块多行与 EOF 保真，取消/关闭清理等待并有界缓冲', async () => {
  const source = new PassThrough();
  const input = new CliInput(source, new PassThrough());
  try {
    const first = input.read('Question 1: ');
    source.end('1\r\nSecond\n');
    assert.equal(await first, '1');
    // 确保 EOF 已发生，仍能从同一个 Interface 的队列取到第二行。
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(await input.read('Question 2: '), 'Second');
    await assert.rejects(input.read('Question 3: '), /输入已结束/);
  } finally { input.close(); source.destroy(); }

  const activeSource = new PassThrough();
  const active = new CliInput(activeSource, new PassThrough());
  try {
    const controller = new AbortController();
    const waiting = active.read('Wait: ', controller.signal);
    controller.abort();
    await assert.rejects(waiting, { name: 'AbortError' });
    const closing = active.read('Close: ');
    active.close();
    await assert.rejects(closing, /输入已关闭/);
    await assert.rejects(active.read('Already closed: '), /输入已关闭/);
    assert.equal(activeSource.listenerCount('data'), 0);
  } finally { active.close(); activeSource.destroy(); }

  const ttySource = Object.assign(new PassThrough(), { isTTY: true, setRawMode() { return this; } });
  const ttyOutput = Object.assign(new PassThrough(), { isTTY: true, columns: 80 });
  const terminal = new CliInput(ttySource, ttyOutput);
  try {
    const interrupted = terminal.read('SIGINT: ');
    ttySource.write('\x03');
    await assert.rejects(interrupted, { name: 'AbortError' });
    assert.equal(terminal.signal.aborted, true);
    assert.equal(terminal.signal.reason.name, 'AbortError');
  } finally { terminal.close(); ttySource.destroy(); ttyOutput.destroy(); }

  const overflowingSource = new PassThrough();
  const bounded = new CliInput(overflowingSource, new PassThrough());
  try {
    const waiting = bounded.read('Bounded: ');
    overflowingSource.end(`${'x'.repeat(4001)}\n`);
    await assert.rejects(waiting, /超过限制/);
    assert.equal(bounded.signal.aborted, true);
    await assert.rejects(bounded.read('No reuse: '), /超过限制/);
  } finally { bounded.close(); overflowingSource.destroy(); }
});
