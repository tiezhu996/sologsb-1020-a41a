import type { BatchKind, SealJob } from '../types';

/**
 * 封存服务（远端）的本地模拟。
 *
 * 与本机工作区物理隔离：独立 localStorage 键、独立数据模型。
 * - 本机工作区管：核对结论、字段选择、撤回记录
 * - 封存服务管：封存对象（按内容摘要复用）、发布批次（预留定归属）、封存状态与版本链
 *
 * 每个异步调用都带延迟，并可注入“断网 / 预留响应丢失 / 封存响应丢失”故障，
 * 用来验证失败恢复、重复提交与发布对账。
 */

const VAULT_KEY = 'sologsb-1020-vault-v1';
const CONFIG_KEY = 'sologsb-1020-vault-config-v1';
const LATENCY_MS = 240;
export const DEFAULT_TTL_SECONDS = 15;

export type FaultMode = 'none' | 'offline' | 'drop-reserve' | 'drop-seal';

export interface VaultConfig {
  online: boolean;
  fault: FaultMode;
  ttlSeconds: number;
}

export interface BatchItemInput {
  refId: string;
  recordId: string;
  title: string;
  identifier: string;
  digest: string;
  compensationId?: string;
}

export interface SealedBatchItem extends BatchItemInput {
  objectId: string;
  versionId: string;
  /** true 表示引用的仍是同一版本（摘要未变），不重复建档 */
  reused: boolean;
}

export interface BatchHistoryEntry {
  at: string;
  event: string;
  detail: string;
}

export interface SealBatch {
  batchId: string;
  idempotencyKey: string;
  kind: BatchKind;
  operator: string;
  status: 'reserved' | 'sealed';
  items: BatchItemInput[];
  sealedItems?: SealedBatchItem[];
  reservedAt: string;
  reservedUntil: string;
  sealedAt?: string;
  history: BatchHistoryEntry[];
}

export interface VaultObject {
  objectId: string;
  digest: string;
  title: string;
  identifier: string;
  createdAt: string;
  reuseCount: number;
}

export interface VaultVersion {
  refId: string;
  versionId: string;
  objectId: string;
  digest: string;
  kind: BatchKind;
  batchId: string;
  operator: string;
  createdAt: string;
  supersededBy?: string;
  compensationFor?: string;
}

export interface VaultEvent {
  id: string;
  at: string;
  type: string;
  detail: string;
}

interface VaultData {
  objects: VaultObject[];
  versions: VaultVersion[];
  batches: SealBatch[];
  events: VaultEvent[];
  seq: number;
}

export interface ReserveInput {
  operator: string;
  kind: BatchKind;
  items: BatchItemInput[];
  idempotencyKey: string;
}

export interface VaultSnapshot {
  objects: VaultObject[];
  versions: VaultVersion[];
  batches: SealBatch[];
  events: VaultEvent[];
  now: string;
  online: boolean;
}

export type SealingErrorCode =
  | 'offline'
  | 'reserve-conflict'
  | 'batch-not-found'
  | 'not-owner'
  | 'reservation-active'
  | 'batch-sealed';

export class SealingError extends Error {
  code: SealingErrorCode;
  conflict?: { batchId: string; owner: string; reservedUntil: string };
  constructor(code: SealingErrorCode, message: string, conflict?: SealingError['conflict']) {
    super(message);
    this.name = 'SealingError';
    this.code = code;
    this.conflict = conflict;
  }
}

const defaultConfig = (): VaultConfig => ({ online: true, fault: 'none', ttlSeconds: DEFAULT_TTL_SECONDS });

const loadConfig = (): VaultConfig => {
  try {
    const raw = localStorage.getItem(CONFIG_KEY);
    return raw ? { ...defaultConfig(), ...JSON.parse(raw) } : defaultConfig();
  } catch {
    return defaultConfig();
  }
};

const saveConfig = (config: VaultConfig) => {
  localStorage.setItem(CONFIG_KEY, JSON.stringify(config));
};

const emptyVault = (): VaultData => ({ objects: [], versions: [], batches: [], events: [], seq: 0 });

const loadVault = (): VaultData => {
  try {
    const raw = localStorage.getItem(VAULT_KEY);
    return raw ? { ...emptyVault(), ...JSON.parse(raw) } : emptyVault();
  } catch {
    return emptyVault();
  }
};

const saveVault = (data: VaultData) => {
  localStorage.setItem(VAULT_KEY, JSON.stringify(data));
};

const delay = () => new Promise<void>((resolve) => { window.setTimeout(resolve, LATENCY_MS); });

const ensureOnline = () => {
  const config = loadConfig();
  if (!config.online) throw new SealingError('offline', '封存服务不可达：当前处于断网状态');
  return config;
};

const addEvent = (data: VaultData, type: string, detail: string) => {
  data.events.unshift({ id: `evt-${++data.seq}`, at: new Date().toISOString(), type, detail });
  data.events = data.events.slice(0, 200);
};

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

const overlap = (a: BatchItemInput[], b: BatchItemInput[]) => {
  const refs = new Set(a.map((item) => item.refId));
  return b.some((item) => refs.has(item.refId));
};

/** 预留发布批次：以批次预留定归属；同幂等键重复提交直接返回原批次 */
export async function reserveBatch(input: ReserveInput): Promise<SealBatch> {
  await delay();
  const config = ensureOnline();
  if (!input.items.length) throw new SealingError('batch-sealed', '批次内容为空，无法预留');

  const data = loadVault();
  const now = Date.now();

  // 幂等：同键重试不重复建档
  const sameKey = data.batches.find((batch) => batch.idempotencyKey === input.idempotencyKey);
  if (sameKey) {
    sameKey.history.push({ at: new Date().toISOString(), event: 'reserve-replayed', detail: `${input.operator} 以同一幂等键重试，返回既有批次` });
    saveVault(data);
    if (config.fault === 'drop-reserve') {
      throw new SealingError('offline', '批次预留响应在网络中断中丢失：服务端已预留，本机未收到确认（故障注入）');
    }
    return clone(sameKey);
  }

  // 归属冲突：存在未过期、引用重叠的预留批次
  const blocking = data.batches.find((batch) =>
    batch.status === 'reserved'
    && new Date(batch.reservedUntil).getTime() > now
    && overlap(batch.items, input.items)
  );
  if (blocking) {
    throw new SealingError(
      'reserve-conflict',
      `引用记录已被 ${blocking.operator} 的预留批次 ${blocking.batchId} 占用`,
      { batchId: blocking.batchId, owner: blocking.operator, reservedUntil: blocking.reservedUntil }
    );
  }

  const isoNow = new Date().toISOString();
  const batch: SealBatch = {
    batchId: `BATCH-${String(++data.seq).padStart(5, '0')}`,
    idempotencyKey: input.idempotencyKey,
    kind: input.kind,
    operator: input.operator,
    status: 'reserved',
    items: clone(input.items),
    reservedAt: isoNow,
    reservedUntil: new Date(now + config.ttlSeconds * 1000).toISOString(),
    history: [{ at: isoNow, event: 'reserved', detail: `${input.operator} 预留 ${input.items.length} 条引用，TTL ${config.ttlSeconds}s` }]
  };
  data.batches.unshift(batch);
  addEvent(data, 'batch-reserved', `${batch.batchId} · ${input.operator} · ${input.kind === 'compensation' ? '补偿批次' : '发布批次'} · ${input.items.length} 条`);
  saveVault(data);
  if (config.fault === 'drop-reserve') {
    throw new SealingError('offline', '批次预留响应在网络中断中丢失：服务端已预留，本机未收到确认（故障注入）');
  }
  return clone(batch);
}

/** 完成封存：仅预留持有者可封存；按对象摘要复用对象；同摘要不新增版本 */
export async function sealBatch(batchId: string, operator: string): Promise<SealBatch> {
  await delay();
  ensureOnline();
  const data = loadVault();
  const config = loadConfig();

  const batch = data.batches.find((item) => item.batchId === batchId);
  if (!batch) throw new SealingError('batch-not-found', `批次 ${batchId} 在封存服务中不存在`);
  if (batch.status === 'sealed') {
    batch.history.push({ at: new Date().toISOString(), event: 'seal-replayed', detail: `${operator} 重复提交封存请求，返回既有封存结果` });
    saveVault(data);
    if (config.fault === 'drop-seal') {
      throw new SealingError('offline', `批次 ${batchId} 封存响应丢失，但服务端早已封存完成（故障注入）`);
    }
    return clone(batch);
  }

  const expired = new Date(batch.reservedUntil).getTime() <= Date.now();
  if (batch.operator !== operator) {
    if (expired) throw new SealingError('not-owner', `批次 ${batchId} 的预留归属 ${batch.operator} 且已过期，请先接管再封存`);
    throw new SealingError('not-owner', `批次 ${batchId} 归属 ${batch.operator}，当前操作员无权封存`);
  }

  const sealedItems: SealedBatchItem[] = [];
  const nowIso = new Date().toISOString();
  let newVersions = 0;
  let reusedObjects = 0;
  let reusedVersions = 0;

  batch.items.forEach((item) => {
    let object = data.objects.find((candidate) => candidate.digest === item.digest);
    if (object) {
      object.reuseCount += 1;
      reusedObjects += 1;
    } else {
      object = {
        objectId: `OBJ-${String(++data.seq).padStart(5, '0')}`,
        digest: item.digest,
        title: item.title,
        identifier: item.identifier,
        createdAt: nowIso,
        reuseCount: 0
      };
      data.objects.unshift(object);
    }

    const chain = data.versions
      .filter((version) => version.refId === item.refId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    const latest = chain[0];

    if (latest && latest.digest === item.digest) {
      reusedVersions += 1;
      sealedItems.push({ ...item, objectId: object.objectId, versionId: latest.versionId, reused: true });
      return;
    }

    const version: VaultVersion = {
      refId: item.refId,
      versionId: `VER-${String(++data.seq).padStart(5, '0')}`,
      objectId: object.objectId,
      digest: item.digest,
      kind: batch.kind,
      batchId: batch.batchId,
      operator,
      createdAt: nowIso,
      compensationFor: item.compensationId
    };
    if (latest) latest.supersededBy = version.versionId;
    data.versions.unshift(version);
    sealedItems.push({ ...item, objectId: object.objectId, versionId: version.versionId, reused: false });
    newVersions += 1;
  });

  batch.status = 'sealed';
  batch.sealedItems = sealedItems;
  batch.sealedAt = nowIso;
  batch.history.push({ at: nowIso, event: 'sealed', detail: `${operator} 完成封存：新版本 ${newVersions} 条，对象复用 ${reusedObjects} 次，版本复用 ${reusedVersions} 条` });
  addEvent(data, 'batch-sealed', `${batch.batchId} · ${operator} · 新版本 ${newVersions}，对象复用 ${reusedObjects} 次，版本复用 ${reusedVersions} 条`);
  saveVault(data);
  if (config.fault === 'drop-seal') {
    throw new SealingError('offline', `批次 ${batchId} 封存响应在网络中断中丢失：服务端已封存，本机未收到确认（故障注入）`);
  }
  return clone(batch);
}

/** 接管他人已过期的预留批次，并在批次履历中留记录 */
export async function takeOverBatch(batchId: string, operator: string): Promise<SealBatch> {
  await delay();
  ensureOnline();
  const data = loadVault();
  const batch = data.batches.find((item) => item.batchId === batchId);
  if (!batch) throw new SealingError('batch-not-found', `批次 ${batchId} 在封存服务中不存在`);
  if (batch.status === 'sealed') throw new SealingError('batch-sealed', `批次 ${batchId} 已封存，无需接管`);
  if (batch.operator === operator) return clone(batch);
  const expired = new Date(batch.reservedUntil).getTime() <= Date.now();
  if (!expired) {
    throw new SealingError('reservation-active', `批次 ${batchId} 仍在 ${batch.operator} 的预留有效期内，不可接管`, {
      batchId, owner: batch.operator, reservedUntil: batch.reservedUntil
    });
  }
  const previous = batch.operator;
  batch.operator = operator;
  batch.history.push({ at: new Date().toISOString(), event: 'taken-over', detail: `${operator} 接管了 ${previous} 的过期预留` });
  addEvent(data, 'reservation-taken-over', `${batch.batchId} · ${operator} 接管 ${previous} 的过期预留`);
  saveVault(data);
  return clone(batch);
}

export function getConfig(): VaultConfig {
  return loadConfig();
}

export function setOnline(online: boolean) {
  const config = loadConfig();
  config.online = online;
  saveConfig(config);
}

export function setFault(fault: FaultMode) {
  const config = loadConfig();
  config.fault = fault;
  if (fault !== 'offline' && fault !== 'none') config.online = true;
  if (fault === 'offline') config.online = false;
  if (fault === 'none') config.online = true;
  saveConfig(config);
}

export function setTtl(seconds: number) {
  const config = loadConfig();
  config.ttlSeconds = Math.max(3, seconds);
  saveConfig(config);
}

export function getSnapshot(): VaultSnapshot {
  const data = loadVault();
  const config = loadConfig();
  return { ...clone(data), now: new Date().toISOString(), online: config.online };
}

export function resetVault() {
  localStorage.removeItem(VAULT_KEY);
}

/* ---------------- 发布对账 ---------------- */

export type ReconcileStatus =
  | 'in-sync'               // 本机与封存服务一致
  | 'locally-ahead'         // 本机有未完成发布，可恢复同一批次
  | 'remote-ahead'          // 服务已封存，本机未收到确认
  | 'orphan-reserved-mine'  // 服务有我的预留，本机无作业记录
  | 'orphan-reserved-other' // 他人/他机的活跃或过期预留
  | 'orphan-sealed';        // 服务已封存，本机完全无记录

export interface ReconcileRow {
  key: string;
  jobId?: string;
  batchId?: string;
  kind?: BatchKind;
  operator?: string;
  status: ReconcileStatus;
  detail: string;
  /** 建议的对账动作 */
  action: 'retry' | 'takeover' | 'adopt' | 'none';
  reservedUntil?: string;
}

export function reconcile(jobs: SealJob[], vault: VaultSnapshot): ReconcileRow[] {
  const rows: ReconcileRow[] = [];
  const matchedBatches = new Set<string>();

  jobs.forEach((job) => {
    const batch = vault.batches.find((item) =>
      item.batchId === job.batchId || (!job.batchId && item.idempotencyKey === job.idempotencyKey)
    );
    if (batch) matchedBatches.add(batch.batchId);

    if (!batch) {
      if (job.phase === 'sealed') {
        rows.push({ key: job.id, jobId: job.id, status: 'remote-ahead', kind: job.kind, operator: job.operator, detail: '本机标记已封存，但封存服务查不到批次（可能已被清库）', action: 'none' });
      } else {
        rows.push({ key: job.id, jobId: job.id, status: 'locally-ahead', kind: job.kind, operator: job.operator, detail: `本机停在「${phaseLabel(job.phase)}」，服务无批次，按幂等键 ${job.idempotencyKey.slice(0, 10)} 重试不会重复建档`, action: 'retry' });
      }
      return;
    }

    if (batch.status === 'sealed') {
      const itemCount = batch.sealedItems?.length ?? 0;
      if (job.phase === 'sealed') {
        rows.push({ key: job.id, jobId: job.id, batchId: batch.batchId, status: 'in-sync', kind: batch.kind, operator: batch.operator, detail: `已封存 · ${itemCount} 条引用与本机作业一致`, action: 'none' });
      } else {
        rows.push({ key: job.id, jobId: job.id, batchId: batch.batchId, status: 'remote-ahead', kind: batch.kind, operator: batch.operator, detail: `封存响应可能在网络中断中丢失：服务端 ${batch.batchId} 已封存 ${itemCount} 条，本机仍为「${phaseLabel(job.phase)}」`, action: 'adopt' });
      }
      return;
    }

    // 服务端仍为预留
    const expired = new Date(batch.reservedUntil).getTime() <= Date.now();
    const mine = batch.operator === job.operator;
    if (mine) {
      rows.push({ key: job.id, jobId: job.id, batchId: batch.batchId, status: 'locally-ahead', kind: batch.kind, operator: batch.operator, reservedUntil: batch.reservedUntil, detail: `批次 ${batch.batchId} 已预留（${expired ? '预留已过期，持有者仍可恢复' : `有效期至 ${formatTime(batch.reservedUntil)}`}），继续封存即可`, action: 'retry' });
    } else {
      rows.push({
        key: job.id, jobId: job.id, batchId: batch.batchId, status: 'orphan-reserved-other', kind: batch.kind, operator: batch.operator, reservedUntil: batch.reservedUntil,
        detail: `批次归属 ${batch.operator}${expired ? '，预留已过期，可接管后继续' : '，仍在有效期内'}`,
        action: expired ? 'takeover' : 'none'
      });
    }
  });

  // 服务端存在、本机完全没有的批次（他机/他人提交，或清库重建）
  vault.batches.forEach((batch) => {
    if (matchedBatches.has(batch.batchId)) return;
    if (batch.status === 'sealed') {
      rows.push({ key: batch.batchId, batchId: batch.batchId, status: 'orphan-sealed', kind: batch.kind, operator: batch.operator, detail: `服务端存在已封存批次 ${batch.batchId}（${batch.sealedItems?.length ?? 0} 条），本机无对应作业`, action: 'adopt' });
      return;
    }
    const expired = new Date(batch.reservedUntil).getTime() <= Date.now();
    rows.push({
      key: batch.batchId, batchId: batch.batchId, status: 'orphan-reserved-mine', kind: batch.kind, operator: batch.operator, reservedUntil: batch.reservedUntil,
      detail: `服务端存在预留批次 ${batch.batchId}，归属 ${batch.operator}，${expired ? '预留已过期' : '仍在有效期'}，本机无作业记录`,
      action: expired ? 'takeover' : 'none'
    });
  });

  return rows;
}

export function phaseLabel(phase: SealJob['phase']): string {
  switch (phase) {
    case 'draft': return '待发布';
    case 'reserving': return '预留批次中';
    case 'reserved': return '批次已预留';
    case 'sealing': return '封存中';
    case 'sealed': return '已封存';
    case 'failed': return '发布失败';
  }
}

export function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}
