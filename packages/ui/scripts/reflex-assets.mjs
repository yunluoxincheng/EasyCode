// 与 ReflexWebPolicy 的本地模型和 ORT 默认 WASM/JSEP 后端保持一致。
export const MODEL_FILES = [
  'model_int8.onnx',
  'tokenizer.json',
  'tokenizer_config.json',
  'runtime_config.json',
];
export const ORT_FILES = [
  'ort-wasm-simd-threaded.jsep.mjs',
  'ort-wasm-simd-threaded.jsep.wasm',
];
