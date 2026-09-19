/**
 * 极简 JSON Schema 校验：只覆盖工具参数所需能力
 * （object / string / number / boolean / array / enum / required / 未知属性剔除）。
 * 换取零依赖，schema 由各工具手写声明。
 */
export interface JsonSchema {
  type: 'object' | 'string' | 'number' | 'boolean' | 'array';
  description?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema;
  enum?: string[];
}

export type ValidationResult<T> = { ok: true; value: T } | { ok: false; error: string };

export function validateToolInput<T = Record<string, unknown>>(
  input: unknown,
  schema: JsonSchema,
): ValidationResult<T> {
  if (typeof input === 'string') {
    try {
      input = JSON.parse(input);
    } catch {
      return { ok: false, error: '输入不是合法 JSON' };
    }
  }
  if (input === null || typeof input !== 'object') {
    return { ok: false, error: '输入必须是 JSON 对象' };
  }
  const raw = input as Record<string, unknown>;
  const out: Record<string, unknown> = {};

  for (const key of schema.required ?? []) {
    if (!(key in raw)) return { ok: false, error: `缺少必填参数: ${key}` };
  }
  for (const [key, sub] of Object.entries(schema.properties ?? {})) {
    if (!(key in raw) || raw[key] === undefined) continue;
    const check = checkValue(raw[key], sub, key);
    if (!check.ok) return check;
    out[key] = check.value;
  }
  return { ok: true, value: out as T };
}

function checkValue(
  value: unknown,
  schema: JsonSchema,
  key: string,
): ValidationResult<unknown> {
  switch (schema.type) {
    case 'string': {
      if (typeof value !== 'string') return { ok: false, error: `参数 ${key} 应为字符串` };
      if (schema.enum && !schema.enum.includes(value)) {
        return { ok: false, error: `参数 ${key} 应为 ${schema.enum.join(' | ')} 之一` };
      }
      return { ok: true, value };
    }
    case 'number': {
      const n = typeof value === 'string' ? Number(value) : value;
      if (typeof n !== 'number' || Number.isNaN(n)) {
        return { ok: false, error: `参数 ${key} 应为数字` };
      }
      return { ok: true, value: n };
    }
    case 'boolean': {
      if (typeof value !== 'boolean') return { ok: false, error: `参数 ${key} 应为布尔值` };
      return { ok: true, value };
    }
    case 'array': {
      if (!Array.isArray(value)) return { ok: false, error: `参数 ${key} 应为数组` };
      if (schema.items) {
        const checked: unknown[] = [];
        for (const [i, item] of value.entries()) {
          const check = checkValue(item, schema.items, `${key}[${i}]`);
          if (!check.ok) return check;
          checked.push(check.value);
        }
        return { ok: true, value: checked };
      }
      return { ok: true, value };
    }
    case 'object':
    default:
      return { ok: true, value };
  }
}
