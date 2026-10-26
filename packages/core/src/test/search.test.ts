import test from 'node:test';
import assert from 'node:assert/strict';
import { listFilesRecursively } from '../tools/search.js';
import { MemoryHost } from '../host.js';
import { Worker } from 'node:worker_threads';

test('搜索：目录忽略与子任务字面量扫描不回溯、可及时取消', async () => {
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

  // 在可强制结束的测试 Worker 中跑旧/新生产实现；旧正则不能挂死整个回归进程。
  const searchURL = process.env.EASYCODE_SEARCH_MODULE_URL ?? new URL('../tools/search.js', import.meta.url).href;
  const outcome = await new Promise<{ literal: string; cancelled: boolean; heartbeats: number }>((resolve, reject) => {
    const worker = new Worker(`
      const {parentPort,workerData}=require('node:worker_threads');
      (async()=>{
        const mod=await import(workerData);
        const {MemoryHost}=await import(new URL('../host.js',workerData).href);
        const tool=mod.literalSearchFilesTool??mod.searchFilesTool;
        const host=new MemoryHost({'/workspace/long.txt':'a'.repeat(200000)+'!'});
        let heartbeats=0;const beat=setInterval(()=>heartbeats++,1);
        let stop;
        try{
          const literal=await tool.execute({pattern:'(a+)+$'},{host,workspace:'/workspace',signal:new AbortController().signal});
          const controller=new AbortController();stop=setTimeout(()=>controller.abort(),1);
          let cancelled=false;
          try{await tool.execute({pattern:'not present'},{host,workspace:'/workspace',signal:controller.signal});}
          catch(error){cancelled=error.name==='AbortError';}
          parentPort.postMessage({literal,cancelled,heartbeats});
        }finally{clearInterval(beat);clearTimeout(stop);parentPort.close();}
      })().catch(error=>{parentPort.postMessage({error:String(error)});parentPort.close();});
    `, { eval: true, workerData: searchURL });
    const timer = setTimeout(() => { void worker.terminate().then(() => reject(new Error('搜索阻塞了截止/取消事件循环'))); }, 5000);
    worker.once('error', (error) => { clearTimeout(timer); reject(error); });
    worker.once('message', (value) => {
      clearTimeout(timer);
      void worker.terminate().then(() => value.error ? reject(new Error(value.error)) : resolve(value));
    });
  });
  assert.match(outcome.literal, /无匹配/);
  assert.equal(outcome.cancelled, true);
  assert.ok(outcome.heartbeats > 0, '扫描期间必须让定时器执行');
});
