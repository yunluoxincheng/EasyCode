#!/usr/bin/env node
/**
 * EasyCode CLI —— 与桌面端共用同一引擎，验证 core 的可复用性。
 *
 * 用法:
 *   easycode "任务描述" [--workspace <dir>] [--provider <id>] [--model <name>]
 *            [--yolo] [--data-dir <dir>]
 *
 * API Key 通过环境变量 EASYCODE_API_KEY 或 --api-key 传入。
 */
import { homedir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import readline from 'node:readline';
import { NodeHost } from '@easycode/host-node';
import { AgentServer } from './index.js';
import type { AgentEvent } from '@easycode/core';

interface Args {
  task: string;
  workspace: string;
  provider: string;
  model?: string;
  yolo: boolean;
  apiKey?: string;
  dataDir?: string;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    task: '',
    workspace: process.cwd(),
    provider: 'demo',
    yolo: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case '--workspace':
      case '-w':
        args.workspace = path.resolve(argv[++i]);
        break;
      case '--provider':
      case '-p':
        args.provider = argv[++i];
        break;
      case '--model':
      case '-m':
        args.model = argv[++i];
        break;
      case '--yolo':
        args.yolo = true;
        break;
      case '--api-key':
        args.apiKey = argv[++i];
        break;
      case '--data-dir':
        args.dataDir = path.resolve(argv[++i]);
        break;
      default:
        if (!a.startsWith('-') && !args.task) args.task = a;
    }
  }
  return args;
}

const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const cyan = (s: string) => `\x1b[36m${s}\x1b[0m`;
const yellow = (s: string) => `\x1b[33m${s}\x1b[0m`;
const red = (s: string) => `\x1b[31m${s}\x1b[0m`;
const green = (s: string) => `\x1b[32m${s}\x1b[0m`;

async function confirm(question: string): Promise<boolean> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(`${yellow('?')} ${question} (y/N) `, (answer) => {
      rl.close();
      resolve(/^y(es)?$/i.test(answer.trim()));
    });
  });
}

function printEvent(event: AgentEvent, askConfirm: (q: string) => Promise<boolean>): void {
  switch (event.type) {
    case 'assistant_start':
      process.stdout.write('\n');
      break;
    case 'text_delta':
      process.stdout.write(event.delta);
      break;
    case 'reasoning_delta':
      process.stdout.write(dim(event.delta));
      break;
    case 'tool_call_start':
      process.stdout.write(`\n${cyan(`⚙ ${event.call.name}`)} ${JSON.stringify(event.call.input).slice(0, 200)}\n`);
      break;
    case 'tool_result':
      process.stdout.write(
        `${event.isError ? red('✗') : green('✓')} ${dim(`(${event.durationMs}ms)`)}\n${dim(event.content.slice(0, 2000))}\n`,
      );
      break;
    case 'approval_request':
      // CLI 交互式审批
      void (async () => {
        process.stdout.write(
          yellow(`\n⏸ 请求执行 ${event.toolName}: ${JSON.stringify(event.input).slice(0, 300)}\n`),
        );
        const approved = await askConfirm('允许执行？');
        process.stdout.write(approved ? green('已批准\n') : red('已拒绝\n'));
        onApproval?.(event.requestId, approved);
      })();
      break;
    case 'step_end':
      if (event.usage) {
        process.stdout.write(
          dim(`\n[tokens in/out: ${event.usage.inputTokens ?? '?'}/${event.usage.outputTokens ?? '?'}]`),
        );
      }
      break;
    case 'error':
      process.stdout.write(`\n${red(`错误: ${event.message}`)}\n`);
      break;
    default:
      break;
  }
}

let onApproval: ((requestId: string, approved: boolean) => void) | null = null;

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  if (!args.task) {
    console.log('用法: easycode "任务描述" [--workspace <dir>] [--provider <id>] [--model <name>] [--yolo]');
    console.log('\n可用 Provider 预设: demo, zhipu, deepseek, openai, moonshot, ollama, lm-studio, anthropic');
    return 1;
  }

  const dataDir = args.dataDir ?? path.join(homedir(), '.easycode');
  const host = new NodeHost({ dataDir });
  const server = new AgentServer(host);

  const apiKey = args.apiKey ?? process.env.EASYCODE_API_KEY;
  if (apiKey) {
    const settings = await server.getSettings();
    const entry = settings.providers[args.provider];
    if (entry) entry.apiKey = apiKey;
  }

  const session = await server.createSession({
    workspaceRoot: args.workspace,
    providerId: args.provider,
    model: args.model,
  });
  if (args.yolo) server.setApprovalMode(session.id, 'yolo');

  console.log(dim(`EasyCode CLI | 工作区: ${session.workspaceRoot} | Provider: ${args.provider}${args.model ? ` (${args.model})` : ''} | 模式: ${args.yolo ? 'YOLO' : 'ASK'}`));

  onApproval = (requestId, approved) => server.respondApproval(session.id, requestId, approved);
  const askConfirm = (q: string) => confirm(q);
  server.onEvent(({ event }) => printEvent(event, askConfirm));

  try {
    await server.sendMessage(session.id, args.task);
  } catch (err) {
    console.error(red(`失败: ${err instanceof Error ? err.message : String(err)}`));
    return 1;
  }
  process.stdout.write('\n');
  return 0;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
