import readline from 'node:readline';
import type { Readable, Writable } from 'node:stream';

/** CLI 共用一条输入流，保留同一数据块中的后续行，不随单个问题关闭 readline。 */
export class CliInput {
  private readonly fatal = new AbortController();
  readonly signal = this.fatal.signal;
  private readonly rl: readline.Interface;
  private lines: string[] = [];
  private bufferedChars = 0;
  private ended = false;
  private disposed = false;
  private failure?: Error;
  private waiting?: { resolve(value: string): void; reject(error: Error): void };

  constructor(input: Readable, private readonly output: Writable) {
    this.rl = readline.createInterface({ input, output, crlfDelay: Infinity });
    this.rl.on('line', (line) => {
      if (this.disposed) return;
      if (line.length > 4000 || this.lines.length >= 256 || this.bufferedChars + line.length > 64_000) {
        this.fail(new Error('CLI 输入超过限制：单行 4000 字符，缓冲 256 行或 64000 字符'));
        return;
      }
      if (this.waiting) this.waiting.resolve(line);
      else { this.lines.push(line); this.bufferedChars += line.length; }
    });
    this.rl.once('close', () => {
      this.ended = true;
      // EOF 保留已读的行；没有缓冲的等待立即结束，不能永久挂起。
      this.waiting?.reject(this.failure ?? new Error('CLI 输入已结束'));
    });
    this.rl.once('SIGINT', () => this.fail(new DOMException('CLI input interrupted', 'AbortError')));
    this.rl.once('error', (error) => this.fail(error));
  }

  async read(prompt: string, signal?: AbortSignal): Promise<string> {
    signal?.throwIfAborted();
    if (this.failure) throw this.failure;
    if (this.disposed) throw new Error('CLI 输入已关闭');
    if (this.waiting) throw new Error('CLI 已有等待中的输入');
    if (this.ended) this.output.write(prompt);
    else { this.rl.setPrompt(prompt); this.rl.prompt(); }
    const line = this.lines.shift();
    if (line !== undefined) { this.bufferedChars -= line.length; return line; }
    if (this.ended) throw new Error('CLI 输入已结束');
    return new Promise((resolve, reject) => {
      const onAbort = () => settle(undefined, new DOMException('CLI question cancelled', 'AbortError'));
      const settle = (value?: string, error?: Error) => {
        signal?.removeEventListener('abort', onAbort);
        this.waiting = undefined;
        if (error) reject(error); else resolve(value!);
      };
      this.waiting = { resolve: (line) => settle(line), reject: (error) => settle(undefined, error) };
      signal?.addEventListener('abort', onAbort, { once: true });
      if (signal?.aborted) onAbort();
    });
  }

  close(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.lines = [];
    this.bufferedChars = 0;
    this.waiting?.reject(this.failure ?? new Error('CLI 输入已关闭'));
    this.rl.close();
  }

  private fail(error: Error): void {
    this.failure = error;
    this.fatal.abort(error);
    this.close();
  }
}
