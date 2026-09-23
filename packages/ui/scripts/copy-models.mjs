import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const targetDir = path.resolve(__dirname, '../public/models/reflex');
const ortTargetDir = path.resolve(__dirname, '../public/ort');
const sourceDir =
  process.env.EASYCODE_REFLEX_MODEL_DIR ||
  path.resolve(__dirname, '../../../../Reflex/models_export/deberta-v3-xsmall');

const ortSourceDir = path.resolve(__dirname, '../node_modules/onnxruntime-web/dist');

const REQUIRED_FILES = [
  'model_int8.onnx',
  'tokenizer.json',
  'tokenizer_config.json',
  'runtime_config.json',
];

console.log('[copy-models] Source directory:', sourceDir);
console.log('[copy-models] Target directory:', targetDir);

if (!fs.existsSync(sourceDir)) {
  console.warn(`[copy-models] Warning: source directory not found: ${sourceDir}. Skipping model copy.`);
} else {
  fs.mkdirSync(targetDir, { recursive: true });

  for (const fn of REQUIRED_FILES) {
    const src = path.join(sourceDir, fn);
    const dst = path.join(targetDir, fn);
    if (fs.existsSync(src)) {
      const statSrc = fs.statSync(src);
      let shouldCopy = true;
      if (fs.existsSync(dst)) {
        const statDst = fs.statSync(dst);
        if (statSrc.size === statDst.size && statSrc.mtimeMs <= statDst.mtimeMs) {
          shouldCopy = false;
        }
      }
      if (shouldCopy) {
        console.log(`[copy-models] Copying ${fn} (${(statSrc.size / (1024 * 1024)).toFixed(2)} MB)...`);
        fs.copyFileSync(src, dst);
      } else {
        console.log(`[copy-models] ${fn} is up to date.`);
      }
    } else {
      console.warn(`[copy-models] Warning: expected model file not found: ${src}`);
    }
  }
}

// 拷贝 onnxruntime-web wasm 文件
if (fs.existsSync(ortSourceDir)) {
  fs.mkdirSync(ortTargetDir, { recursive: true });
  const files = fs.readdirSync(ortSourceDir).filter((f) => f.endsWith('.wasm') || f.endsWith('.mjs'));
  for (const fn of files) {
    const src = path.join(ortSourceDir, fn);
    const dst = path.join(ortTargetDir, fn);
    if (!fs.existsSync(dst) || fs.statSync(src).size !== fs.statSync(dst).size) {
      console.log(`[copy-models] Copying ORT asset: ${fn}...`);
      fs.copyFileSync(src, dst);
    }
  }
}

console.log('[copy-models] Reflex models and ORT assets sync completed successfully.');
