/** 按需加载既有分词器；o200k 为本地容量估算，非供应商计费值。 */
export async function estimateContextTokens(value: unknown): Promise<number> {
  const { encode } = await import('gpt-tokenizer/encoding/o200k_base');
  return encode(JSON.stringify(value), { disallowedSpecial: new Set() }).length;
}
