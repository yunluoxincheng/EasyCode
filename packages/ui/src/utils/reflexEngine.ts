import type { DecisionPolicy, DecisionRequest, DecisionResult } from '@easycode/core';
import type { InferenceSession } from 'onnxruntime-web';

const INIT_RETRY_COOLDOWN_MS = 30_000;

export class ReflexWebPolicy implements DecisionPolicy {
  private session: InferenceSession | null = null;
  private tokenizer: any = null;
  private runtimeConfig: any = null;
  private isReady = false;
  private enabled = false;
  private generation = 0;
  private queue: Promise<void> = Promise.resolve();
  private loadController: AbortController | null = null;
  private pendingDecisions = 0;
  private initializationFailure: { generation: number; retryAt: number } | null = null;

  /** 只响应已保存的设置；构造实例本身不会加载运行时或模型。 */
  setEnabled(enabled: boolean): void {
    if (this.enabled === enabled) return;
    this.enabled = enabled;
    const generation = ++this.generation;
    this.initializationFailure = null;
    this.loadController?.abort();
    // 初始化、推理、释放共享队列：关闭时不得释放仍在 run() 的会话，
    // 快速开关产生的旧任务也不得把迟到模型发布到新一代生命周期。
    void this.enqueue(async () => {
      if (this.isCurrent(generation)) await this.init(generation);
      else if (this.generation === generation) await this.release();
    }).catch((err) => {
      console.warn('[Reflex] Model lifecycle error:', err);
    });
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const task = this.queue.then(operation);
    this.queue = task.then(() => {}, () => {});
    return task;
  }

  private isCurrent(generation: number): boolean {
    return this.enabled && this.generation === generation;
  }

  private inRetryCooldown(generation: number): boolean {
    return this.initializationFailure?.generation === generation &&
      performance.now() < this.initializationFailure.retryAt;
  }

  private async release(): Promise<void> {
    this.isReady = false;
    if (this.session) {
      // 释放失败时保留句柄，下一次切换或初始化可以重试。
      await this.session.release();
      this.session = null;
      console.log('[Reflex] On-device ONNX Web engine released.');
    }
    this.tokenizer = null;
    this.runtimeConfig = null;
  }

  private async init(generation: number): Promise<boolean> {
    if (!this.isCurrent(generation)) return false;
    if (this.isReady) return true;
    if (this.inRetryCooldown(generation)) return false;
    const controller = new AbortController();
    this.loadController = controller;
    try {
      await this.release();
      if (!this.isCurrent(generation)) return false;
      console.log('[Reflex] Initializing on-device ONNX Web engine...');
      // 1. 动态按需引入 onnxruntime-web
      const ort = await import('onnxruntime-web');
      if (!this.isCurrent(generation)) return false;
      // wasmPaths 必须是绝对 URL：ORT 内部用 new URL(filename, prefix) 解析 .mjs/.wasm，
      // 相对前缀 './ort/' 在 URL 构造器中非法，会回退为相对动态 import，
      // 被 Vite 解析到 .vite/deps 或产物 assets 下的错误路径，导致后端加载失败。
      ort.env.wasm.wasmPaths = new URL('./ort/', document.baseURI).href;
      ort.env.wasm.numThreads = 1;

      // 2. 动态按需引入分词器
      const { AutoTokenizer, env } = await import('@huggingface/transformers');
      if (!this.isCurrent(generation)) return false;
      env.allowLocalModels = true;
      env.allowRemoteModels = false;

      // 3. 读取伴生配置
      const configResp = await fetch('./models/reflex/runtime_config.json', { signal: controller.signal });
      if (!configResp.ok) throw new Error('runtime_config.json not found');
      const runtimeConfig = await configResp.json();
      if (!this.isCurrent(generation)) return false;

      // 4. 加载 Fast Tokenizer
      const tokenizer = await AutoTokenizer.from_pretrained('./models/reflex');
      if (!this.isCurrent(generation)) return false;

      // 5. 加载 80MB INT8 ONNX 模型
      const modelResp = await fetch('./models/reflex/model_int8.onnx', { signal: controller.signal });
      if (!modelResp.ok) throw new Error('model_int8.onnx not found');
      const modelBuffer = await modelResp.arrayBuffer();
      if (!this.isCurrent(generation)) return false;

      this.session = await ort.InferenceSession.create(modelBuffer, {
        executionProviders: ['wasm'],
        graphOptimizationLevel: 'all',
      });
      if (!this.isCurrent(generation)) return false;

      this.tokenizer = tokenizer;
      this.runtimeConfig = runtimeConfig;
      this.isReady = true;
      this.initializationFailure = null;
      console.log('[Reflex] On-device ONNX Web engine ready.');
      return true;
    } catch (err) {
      if (this.isCurrent(generation)) {
        this.initializationFailure = { generation, retryAt: performance.now() + INIT_RETRY_COOLDOWN_MS };
        console.warn('[Reflex] Failed to initialize on-device Reflex model, fallback to Noop:', err);
      }
      this.isReady = false;
      return false;
    } finally {
      if (this.loadController === controller) this.loadController = null;
      if (!this.isCurrent(generation)) await this.release();
    }
  }

  private deferred(req: DecisionRequest): DecisionResult {
    return {
      selectedId: req.candidates[0]?.id ?? 'none',
      selectedText: req.candidates[0]?.text ?? 'None',
      confidence: 0,
      defer: true,
      scores: {},
      latencyMs: 0,
    };
  }

  decide(req: DecisionRequest): Promise<DecisionResult> {
    const generation = this.generation;
    // 旁路观察允许放弃过载预测，不能无界积压请求及其上下文。
    if (!this.enabled || this.inRetryCooldown(generation) || this.pendingDecisions >= 32) {
      return Promise.resolve(this.deferred(req));
    }
    this.pendingDecisions++;
    return this.enqueue(async () => {
      if (!this.isCurrent(generation)) return this.deferred(req);
      const result = await this.decideCurrent(req, generation);
      // 关闭前已开始的推理允许安全结束，但不得记录成有效预测。
      return this.isCurrent(generation) ? result : this.deferred(req);
    }).catch((err) => {
      console.warn('[Reflex] Decision lifecycle error, fallback to Noop:', err);
      return this.deferred(req);
    }).finally(() => { this.pendingDecisions--; });
  }

  private async decideCurrent(req: DecisionRequest, generation: number): Promise<DecisionResult> {
    const started = performance.now();
    const ready = await this.init(generation);

    if (!ready || !this.isCurrent(generation) || !this.session || !this.tokenizer) {
      // 未就绪时不记录假数据，返回 defer
      return this.deferred(req);
    }

    try {
      // 1. 组装输入文本结构（对前文状态与历史进行长度保护，确保末尾的 [CAND] 候选标记绝不会被截断）
      const safeSummary = (req.state.summary || '').slice(0, 400);
      const safeGoal = req.state.goal ? req.state.goal.slice(0, 200) : '';
      const safeHistory = (req.state.history || []).slice(-5);

      const parts = ['[TASK]', req.instruction];
      if (safeGoal) parts.push('', '[GOAL]', safeGoal);
      parts.push('', '[STATE]', safeSummary);
      if (safeHistory.length > 0) {
        parts.push('', '[HISTORY]');
        for (const h of safeHistory) parts.push(`- ${h.slice(0, 100)}`);
      }
      for (const c of req.candidates) {
        parts.push('', '[CAND]', c.text);
      }
      const text = parts.join('\n');

      // 2. Tokenize（使用 DeBERTa-v3 原生 512 上限）
      const encoded = await this.tokenizer(text, {
        max_length: 512,
        truncation: true,
      });
      if (!this.isCurrent(generation)) return this.deferred(req);

      const inputIdsArray = Array.from(encoded.input_ids.data as Iterable<number | bigint>, Number);
      const seqLen = inputIdsArray.length;
      const candTokenId = this.runtimeConfig?.special_tokens?.cand_token_id ?? 128005;

      // 3. 提取候选 Marker 位置与 Span Mask
      const candPositions: number[] = [];
      for (let i = 0; i < seqLen; i++) {
        if (inputIdsArray[i] === candTokenId) {
          candPositions.push(i);
        }
      }

      const numCands = req.candidates.length;
      if (candPositions.length < numCands) {
        throw new Error(`Truncation dropped candidate markers (${candPositions.length} < ${numCands})`);
      }

      const candidateMaskData = new Uint8Array(numCands).fill(1);
      const candidateTokenMaskData = new Uint8Array(numCands * seqLen).fill(0);

      for (let i = 0; i < numCands; i++) {
        const start = candPositions[i] + 1;
        let end = i + 1 < numCands ? candPositions[i + 1] : seqLen - 1;
        if (end <= start) {
          end = Math.min(seqLen, start + 1);
        }
        for (let j = start; j < end; j++) {
          if (j < seqLen) {
            candidateTokenMaskData[i * seqLen + j] = 1;
          }
        }
      }

      const ort = await import('onnxruntime-web');
      if (!this.isCurrent(generation)) return this.deferred(req);
      const inputIdsTensor = new ort.Tensor('int64', BigInt64Array.from(inputIdsArray.map(BigInt)), [1, seqLen]);
      const attentionMaskTensor = new ort.Tensor('int64', new BigInt64Array(seqLen).fill(1n), [1, seqLen]);
      const candPositionsTensor = new ort.Tensor('int64', BigInt64Array.from(candPositions.slice(0, numCands).map(BigInt)), [1, numCands]);
      const candMaskTensor = new ort.Tensor('bool', candidateMaskData, [1, numCands]);
      const candTokenMaskTensor = new ort.Tensor('bool', candidateTokenMaskData, [1, numCands, seqLen]);

      // 4. 前向推理
      const feeds = {
        input_ids: inputIdsTensor,
        attention_mask: attentionMaskTensor,
        candidate_positions: candPositionsTensor,
        candidate_mask: candMaskTensor,
        candidate_token_mask: candTokenMaskTensor,
      };

      const results = await this.session.run(feeds);
      const rawLogits = Array.from(results.candidate_logits.data as Float32Array);
      const deferLogits = results.defer_logits ? Number(results.defer_logits.data[0]) : 0;

      // 5. 温度缩放与 Softmax
      const temperature = this.runtimeConfig?.temperature ?? 78.2;
      const scaled = rawLogits.map((l) => l / temperature);
      const maxVal = Math.max(...scaled);
      const expVals = scaled.map((l) => Math.exp(l - maxVal));
      const sumExp = expVals.reduce((a, b) => a + b, 0) || 1;
      const probs = expVals.map((e) => e / sumExp);

      let bestIdx = 0;
      let maxProb = -1;
      const scoreMap: Record<string, number> = {};

      for (let i = 0; i < numCands; i++) {
        const p = probs[i];
        const cid = req.candidates[i].id;
        scoreMap[cid] = Math.round(p * 1000) / 1000;
        if (p > maxProb) {
          maxProb = p;
          bestIdx = i;
        }
      }

      const deferProb = 1.0 / (1.0 + Math.exp(-deferLogits));
      const shouldDefer = maxProb < 0.268 || deferProb > 0.65;
      const latencyMs = Math.round((performance.now() - started) * 10) / 10;

      return {
        selectedId: req.candidates[bestIdx]?.id ?? 'none',
        selectedText: req.candidates[bestIdx]?.text ?? 'None',
        confidence: Math.round(maxProb * 1000) / 1000,
        defer: shouldDefer,
        scores: scoreMap,
        latencyMs,
        modelVersion: `${this.runtimeConfig?.backbone ?? 'deberta-v3-xsmall'}:int8`,
      };
    } catch (err) {
      console.warn('[Reflex] Inference error:', err);
      // 推理失败不是有效模型输出：latencyMs 置 0，让影子门禁拒绝落盘。
      return this.deferred(req);
    }
  }
}
