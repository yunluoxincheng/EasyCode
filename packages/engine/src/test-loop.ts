/**
 * 自主测试运行与排错自愈循环（TODOS #39）。
 *
 * 纯状态机：测试命令执行与「修一轮代码」的 Agent 回合均由调用方注入，
 * 因此本模块不依赖 Host / Provider，可在单测中直接驱动。
 */

import type { AgentEvent, TestRunSummary } from '@easycode/core';
import { extractFailureExcerpt, parseTestOutput } from '@easycode/core';

/** 单轮测试执行结果（由调用方通过 Host 执行后回传） */
export interface TestRunExecution {
  /** 进程退出码；null 表示被信号终止或退出码不可得 */
  exitCode: number | null;
  /** stdout 与 stderr 合流后的完整输出 */
  output: string;
  durationMs: number;
}

/** 修复回合的结果：显式区分成功 / 失败 / 中止，避免「修复没成功也继续重跑」 */
export interface RepairOutcome {
  ok: boolean;
  /** 是否因用户中止而结束 */
  aborted?: boolean;
  /** 失败原因说明（收敛时回传给 UI） */
  message?: string;
}

export interface RunTestLoopOptions {
  /** 实际执行的测试命令（已探知或用户指定） */
  command: string;
  /** 命令来源说明（展示用） */
  commandSource: string;
  /** 最大轮次（含首轮运行） */
  maxRounds: number;
  /** 可选的聚焦目标（/test-loop 参数） */
  focus?: string;
  signal: AbortSignal;
  emit(event: AgentEvent): void;
  /** 执行一次测试命令 */
  runTests(): Promise<TestRunExecution>;
  /**
   * 让 Agent 依据失败信息修一轮代码（内部通常驱动一次完整的 Agent 回合）。
   * 返回 `void` 视为成功；返回 `RepairOutcome` 时按其中状态收敛循环；
   * 抛出的异常同样会被捕获并收敛为 `error`（绝不静默退出、绝不重复发 done）。
   */
  repair(prompt: string): Promise<RepairOutcome | void>;
  /** 获取当前工作区未提交改动的 diff 摘要（可选，用于给模型提供改动上下文） */
  readDiff?(): Promise<string | undefined>;
}

export interface TestLoopResult {
  ok: boolean;
  rounds: number;
  reason: 'passed' | 'max_rounds' | 'aborted' | 'error';
  message?: string;
  /** 最后一轮的摘要（无则 undefined） */
  lastSummary?: TestRunSummary;
}

/** 输出尾部保留长度（卡片展开查看用，不进模型上下文） */
const OUTPUT_TAIL_CHARS = 4000;
/** 喂给模型的失败日志摘录上限 */
const PROMPT_EXCERPT_CHARS = 4000;
/** 喂给模型的 diff 上限 */
const PROMPT_DIFF_CHARS = 6000;

function tail(text: string, max: number): string {
  if (text.length <= max) return text;
  return `…（前 ${text.length - max} 字符已省略）\n${text.slice(text.length - max)}`;
}

/** 组装「依据测试失败修复代码」的结构化提示词 */
export function buildTestFixPrompt(args: {
  command: string;
  round: number;
  maxRounds: number;
  focus?: string;
  summary: TestRunSummary;
  excerpt: string;
  diff?: string;
}): string {
  const { command, round, maxRounds, focus, summary, excerpt, diff } = args;
  const lines: string[] = [];
  lines.push(`> **[测试自愈循环 · 第 ${round}/${maxRounds} 轮]** 测试未通过，请在当前工作区修复。`);
  lines.push('');
  lines.push(`- 测试命令：\`${command}\``);
  const counts: string[] = [];
  if (summary.passed !== undefined) counts.push(`通过 ${summary.passed}`);
  if (summary.failed !== undefined) counts.push(`失败 ${summary.failed}`);
  if (summary.total !== undefined) counts.push(`共 ${summary.total}`);
  if (counts.length > 0) lines.push(`- 结果统计：${counts.join(' / ')}`);
  if (focus?.trim()) lines.push(`- 聚焦范围：${focus.trim()}`);
  if (summary.failures.length > 0) {
    lines.push('- 失败用例：');
    for (const name of summary.failures) lines.push(`  - ${name}`);
  }
  if (excerpt.trim()) {
    lines.push('');
    lines.push('失败日志摘录：');
    lines.push('```');
    lines.push(excerpt.trim());
    lines.push('```');
  }
  if (diff?.trim()) {
    lines.push('');
    lines.push('当前工作区未提交改动（git diff）：');
    lines.push('```diff');
    lines.push(diff.trim());
    lines.push('```');
  }
  lines.push('');
  lines.push('修复要求：');
  lines.push('1. 先定位失败根因：阅读相关源码与测试，判断是实现缺陷还是测试预期本身写错。');
  lines.push('2. 做最小改动修复，不要顺手重构无关代码，也不要通过删除/跳过测试来让结果变绿。');
  lines.push('3. 不要重复执行整条测试命令：本轮循环会自动重跑测试，修完直接简短说明改动点。');
  return lines.join('\n');
}

/**
 * 执行自愈循环：运行测试 → 失败则驱动 Agent 修复 → 重跑，直至全绿或轮次耗尽。
 * 每轮都会发出 `test_run_start` / `test_run_result`，收敛时发出 `test_loop_done`。
 */
export async function runTestLoop(options: RunTestLoopOptions): Promise<TestLoopResult> {
  const { command, commandSource, maxRounds, focus, signal, emit, runTests, repair, readDiff } =
    options;
  let rounds = 0;
  let lastSummary: TestRunSummary | undefined;

  while (rounds < maxRounds) {
    if (signal.aborted) {
      emit({ type: 'test_loop_done', ok: false, rounds, reason: 'aborted' });
      return { ok: false, rounds, reason: 'aborted', lastSummary };
    }
    rounds += 1;
    emit({
      type: 'test_run_start',
      round: rounds,
      maxRounds,
      command,
      source: commandSource,
      ...(focus?.trim() ? { focus: focus.trim() } : {}),
    });

    let execution: TestRunExecution;
    try {
      execution = await runTests();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const aborted = signal.aborted || /abort/i.test(message);
      if (!aborted) {
        emit({ type: 'test_run_result', round: rounds, command, ok: false, exitCode: null, durationMs: 0, summary: { failures: [] }, outputTail: message });
      }
      emit({
        type: 'test_loop_done',
        ok: false,
        rounds,
        reason: aborted ? 'aborted' : 'error',
        message,
      });
      return { ok: false, rounds, reason: aborted ? 'aborted' : 'error', message, lastSummary };
    }

    const output = execution.output ?? '';
    const summary = parseTestOutput(output);
    lastSummary = summary;
    const ok = execution.exitCode === 0;
    emit({
      type: 'test_run_result',
      round: rounds,
      command,
      ok,
      exitCode: execution.exitCode,
      durationMs: execution.durationMs,
      summary,
      outputTail: tail(output, OUTPUT_TAIL_CHARS),
    });

    if (ok) {
      emit({ type: 'test_loop_done', ok: true, rounds, reason: 'passed' });
      return { ok: true, rounds, reason: 'passed', lastSummary };
    }
    if (signal.aborted) {
      emit({ type: 'test_loop_done', ok: false, rounds, reason: 'aborted' });
      return { ok: false, rounds, reason: 'aborted', lastSummary };
    }
    if (rounds >= maxRounds) {
      emit({ type: 'test_loop_done', ok: false, rounds, reason: 'max_rounds' });
      return { ok: false, rounds, reason: 'max_rounds', lastSummary };
    }

    let diff: string | undefined;
    if (readDiff) {
      try {
        const raw = await readDiff();
        if (raw?.trim()) diff = tail(raw.trim(), PROMPT_DIFF_CHARS);
      } catch {
        // diff 读取失败不影响自愈循环主体
      }
    }
    const prompt = buildTestFixPrompt({
      command,
      round: rounds,
      maxRounds,
      focus,
      summary,
      excerpt: extractFailureExcerpt(output, PROMPT_EXCERPT_CHARS),
      diff,
    });
    // 修复回合可能因模型初始化、快照或持久化故障而抛错；
    // 必须就地收敛为 error 并发出唯一一次 done，否则循环会静默退出、UI 永远停在「运行中」
    let outcome: RepairOutcome | void;
    try {
      outcome = await repair(prompt);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const aborted = signal.aborted || /abort/i.test(message);
      emit({
        type: 'test_loop_done',
        ok: false,
        rounds,
        reason: aborted ? 'aborted' : 'error',
        message,
      });
      return {
        ok: false,
        rounds,
        reason: aborted ? 'aborted' : 'error',
        message,
        lastSummary,
      };
    }
    if (outcome?.aborted) {
      emit({ type: 'test_loop_done', ok: false, rounds, reason: 'aborted' });
      return { ok: false, rounds, reason: 'aborted', lastSummary };
    }
    if (outcome && outcome.ok === false) {
      const message = outcome.message ?? '修复回合执行失败';
      emit({ type: 'test_loop_done', ok: false, rounds, reason: 'error', message });
      return { ok: false, rounds, reason: 'error', message, lastSummary };
    }
  }

  emit({ type: 'test_loop_done', ok: false, rounds, reason: 'max_rounds' });
  return { ok: false, rounds, reason: 'max_rounds', lastSummary };
}
