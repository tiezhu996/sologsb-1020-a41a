import type { ConclusionPayload } from '../types';

/** 规范化 JSON，保证字段顺序不同也能得到同一摘要 */
export function canonicalize(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value && typeof value === 'object') {
    return Object.keys(value as Record<string, unknown>)
      .sort()
      .reduce<Record<string, unknown>>((acc, key) => {
        acc[key] = sortValue((value as Record<string, unknown>)[key]);
        return acc;
      }, {});
  }
  return value;
}

/** FNV-1a 64 位以内的稳定十六进制摘要，用作对象摘要，不依赖 crypto.subtle */
export function digestOf(payload: ConclusionPayload): string {
  const text = canonicalize(payload);
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  const hex = (hash >>> 0).toString(16).padStart(8, '0');
  // 混入长度，降低短文本碰撞概率
  let lenHash = 0x811c9dc5 ^ text.length;
  lenHash = Math.imul(lenHash, 0x01000193);
  return `sha1x-${hex}${(lenHash >>> 0).toString(16).padStart(8, '0')}`;
}
