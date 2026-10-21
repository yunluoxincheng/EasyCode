import test from 'node:test';
import assert from 'node:assert/strict';
import { todoWriteTool } from '../tools/todo.js';
import { MemoryHost } from '../host.js';

const mockCtx = {
  host: new MemoryHost(),
  workspace: '/workspace',
  signal: new AbortController().signal,
};

test('todoWriteTool拦截多个in_progress', async () => {
  await assert.rejects(
    () =>
      todoWriteTool.execute(
        {
          todos: [
            { content: '任务1', status: 'in_progress' },
            { content: '任务2', status: 'in_progress' },
          ],
        },
        mockCtx,
      ),
    /至多只能有 1 个任务处于 in_progress/
  );
});
