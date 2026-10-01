import type { ArchiveRecord } from '../types';

/**
 * 简单确定性 32 位 FNV-1a 哈希（演示用）。
 * 封存对象摘要只依赖内容，不依赖本机记录 id，
 * 因此同内容重复发布可以复用同一封存对象。
 */
function fnv1a32(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

export function canonicalRecordPayload(record: ArchiveRecord): string {
  return JSON.stringify({
    title: record.title,
    date: record.date,
    people: [...record.people].sort(),
    places: [...record.places].sort(),
    identifier: record.identifier,
    medium: record.medium,
    extent: record.extent,
    rights: record.rights,
    notes: record.notes
  });
}

/** 记录内容摘要：两段 FNV 交叉，降低演示碰撞概率 */
export function digestRecord(record: ArchiveRecord): string {
  const payload = canonicalRecordPayload(record);
  const head = fnv1a32(payload);
  const tail = fnv1a32(payload.split('').reverse().join(''));
  return `sha256:${head}${tail}`;
}

/** 补偿清单摘要：撤回合并 + 恢复的来源记录共同决定新版本内容 */
export function digestCompensation(input: { mergeId: string; sources: Array<{ title: string; identifier: string }>; at: string }): string {
  const payload = JSON.stringify({
    kind: 'merge-withdraw-compensation',
    mergeId: input.mergeId,
    sources: input.sources.map((item) => `${item.identifier}::${item.title}`).sort(),
    at: input.at
  });
  return `sha256:${fnv1a32(payload)}${fnv1a32(payload.split('').reverse().join(''))}`;
}

export function shortDigest(digest: string): string {
  return digest.replace('sha256:', '').slice(0, 10);
}
