import type {
  ArchiveBatch,
  ArchiveObject,
  ConclusionPayload,
  LedgerEvent,
  ReserveResult,
  SealOutcome,
  SealingServiceState
} from '../types';

const SERVICE_KEY = 'sologsb-1020-sealing-service-v1';
const RESERVE_TTL_MS = 30_000;

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

const uid = (prefix: string) => `${prefix}-${crypto.randomUUID().slice(0, 8)}`;

const nowIso = () => new Date().toISOString();

export const initialServiceState = (): SealingServiceState => ({
  online: true,
  objects: [],
  batches: [],
  ledger: []
});

/** 封存服务独立持久化在 localStorage，模拟对端服务，断网时写入会失败 */
export function loadServiceState(): SealingServiceState {
  try {
    const raw = localStorage.getItem(SERVICE_KEY);
    if (raw) return { ...initialServiceState(), ...(JSON.parse(raw) as SealingServiceState) };
  } catch {
    localStorage.removeItem(SERVICE_KEY);
  }
  return initialServiceState();
}

export function saveServiceState(state: SealingServiceState) {
  localStorage.setItem(SERVICE_KEY, JSON.stringify(state));
}

export const reserveTtlMs = RESERVE_TTL_MS;

export class SealingOfflineError extends Error {
  constructor() {
    super('封存服务当前不可达（已断网）');
    this.name = 'SealingOfflineError';
  }
}

export class SealingConflictError extends Error {
  constructor(public batch: ArchiveBatch) {
    super('批次已被其他工位预留');
    this.name = 'SealingConflictError';
  }
}

/**
 * 封存服务：管对象摘要、发布批次、封存状态。
 * 全部方法走"读快照 → 修改 → 落盘"，并在离线时直接抛错，
 * 这样本机重试逻辑与真实断网行为一致。
 */
export class SealingService {
  state: SealingServiceState;

  constructor(state?: SealingServiceState) {
    this.state = state ?? loadServiceState();
  }

  get online() {
    return this.state.online;
  }

  setOnline(value: boolean) {
    this.state.online = value;
    this.persist();
  }

  private persist() {
    saveServiceState(this.state);
  }

  private requireOnline() {
    if (!this.state.online) throw new SealingOfflineError();
  }

  private log(type: LedgerEvent['type'], detail: string, workstationId: string, objectId?: string, batchId?: string) {
    this.state.ledger.unshift({ id: uid('evt'), at: nowIso(), type, detail, workstationId, objectId, batchId });
    this.state.ledger = this.state.ledger.slice(0, 400);
  }

  private isExpired(batch: ArchiveBatch, at = Date.now()) {
    return batch.status === 'reserved' && new Date(batch.reservedUntil).getTime() < at;
  }

  /**
   * 按对象摘要查找 / 登记对象。
   * 同一核对结论 + 同一内容摘要只复用已有对象，绝不重复建档。
   */
  resolveObject(
    digest: string,
    kind: ConclusionPayload['kind'],
    conclusionKey: string,
    workstationId: string
  ): { object: ArchiveObject; reused: boolean } {
    this.requireOnline();
    const existing = this.state.objects.find(
      (item) => item.conclusionKey === conclusionKey && item.digest === digest
    );
    if (existing) {
      this.log('对象复用', `按摘要 ${digest.slice(0, 12)} 复用对象 ${existing.id}`, workstationId, existing.id);
      this.persist();
      return { object: existing, reused: true };
    }
    // 结论相同但摘要变化（撤回后补偿内容）→ 仍挂同一对象，形成新版本
    const sameConclusion = this.state.objects.find((item) => item.conclusionKey === conclusionKey);
    if (sameConclusion) {
      sameConclusion.digest = digest;
      this.log('对象复用', `结论 ${conclusionKey} 内容已更新，沿用对象 ${sameConclusion.id} 并将另开版本`, workstationId, sameConclusion.id);
      this.persist();
      return { object: sameConclusion, reused: true };
    }
    const object: ArchiveObject = {
      id: uid('obj'),
      digest,
      kind,
      conclusionKey,
      createdAt: nowIso(),
      versions: []
    };
    this.state.objects.unshift(object);
    this.log('对象登记', `按摘要 ${digest.slice(0, 12)} 登记新对象 ${object.id}`, workstationId, object.id);
    this.persist();
    return { object, reused: false };
  }

  /** 按结论键查找对象（本机尚未保留 objectId 时用于对账/接管） */
  findObjectByConclusion(conclusionKey: string, workstationId: string): ArchiveObject | undefined {
    this.requireOnline();
    const object = this.state.objects.find((item) => item.conclusionKey === conclusionKey);
    if (object) {
      this.log('对象复用', `按结论 ${conclusionKey.slice(-8)} 定位到对象 ${object.id}`, workstationId, object.id);
      this.persist();
    }
    return object ? clone(object) : undefined;
  }

  /**
   * 预留发布批次。
   * - 同一幂等键重复请求 → 直接返回已有批次（断网后重复提交不重复建档）
   * - 他人持有且未过期 → conflict，归属以先预留者为准
   * - 他人预留已过期 → 当前工位可接管，并在 transfers 留记录
   */
  reserveBatch(
    object: ArchiveObject,
    digest: string,
    workstationId: string,
    idempotencyKey: string
  ): ReserveResult {
    this.requireOnline();

    const byIdempotency = this.state.batches.find((batch) => batch.idempotencyKey === idempotencyKey);
    if (byIdempotency && !(byIdempotency.workstationId !== workstationId && this.isExpired(byIdempotency))) {
      this.log('重复提交拦截', `幂等键 ${idempotencyKey.slice(0, 8)} 命中批次 ${byIdempotency.id}，恢复同一批次`, workstationId, object.id, byIdempotency.id);
      this.persist();
      return {
        outcome: byIdempotency.workstationId === workstationId || byIdempotency.status !== 'reserved' ? 'reserved' : 'conflict',
        object,
        batch: byIdempotency
      };
    }

    // 同一对象上他人的活跃预留：冲突或接管
    const active = this.state.batches
      .filter((batch) => batch.objectId === object.id && batch.status === 'reserved')
      .sort((a, b) => b.reservedAt.localeCompare(a.reservedAt))[0];

    if (active && active.workstationId !== workstationId) {
      if (this.isExpired(active)) {
        active.status = 'released';
        const takeover = this.createBatch(object, digest, workstationId, idempotencyKey);
        takeover.transfers.push({
          at: nowIso(),
          from: active.workstationId,
          to: workstationId,
          reason: `原预留已于 ${active.reservedUntil} 过期，自动接管`
        });
        this.log('过期接管', `${workstationId} 接管 ${active.workstationId} 过期预留的对象 ${object.id}`, workstationId, object.id, takeover.id);
        this.persist();
        return { outcome: 'reserved', object, batch: takeover };
      }
      this.log('预留冲突', `对象 ${object.id} 已由 ${active.workstationId} 预留至 ${active.reservedUntil}`, workstationId, object.id, active.id);
      this.persist();
      return { outcome: 'conflict', object, batch: active };
    }

    const batch = this.createBatch(object, digest, workstationId, idempotencyKey);
    this.log('批次预留', `${workstationId} 预留批次 ${batch.id}，对象 ${object.id}`, workstationId, object.id, batch.id);
    this.persist();
    return { outcome: 'reserved', object, batch };
  }

  private createBatch(object: ArchiveObject, digest: string, workstationId: string, idempotencyKey: string): ArchiveBatch {
    const at = new Date();
    const batch: ArchiveBatch = {
      id: uid('batch'),
      objectId: object.id,
      digest,
      workstationId,
      status: 'reserved',
      reservedAt: at.toISOString(),
      reservedUntil: new Date(at.getTime() + RESERVE_TTL_MS).toISOString(),
      transfers: [],
      idempotencyKey
    };
    this.state.batches.unshift(batch);
    return batch;
  }

  /**
   * 封存批次：只有当前归属者且批次仍处于预留期才能封存。
   * 成功后对象追加一个新版本，旧版本全部保留。
   */
  sealBatch(
    batchId: string,
    workstationId: string,
    digest: string,
    kind: ConclusionPayload['kind'],
    conclusionKey: string,
    payloadAt: string
  ): SealOutcome {
    this.requireOnline();
    const batch = this.state.batches.find((item) => item.id === batchId);
    if (!batch) throw new Error('批次不存在，无法封存');
    if (batch.status === 'sealed') {
      const object = this.state.objects.find((item) => item.id === batch.objectId)!;
      this.log('重复提交拦截', `批次 ${batchId} 已封存，直接回放结果，不重复建档`, workstationId, batch.objectId, batchId);
      this.persist();
      return { object, batch: clone(batch), version: batch.version!, reused: true };
    }
    if (batch.workstationId !== workstationId) throw new SealingConflictError(batch);
    if (this.isExpired(batch)) throw new Error('批次预留已过期，请重新预留');
    if (batch.digest !== digest) throw new Error('批次摘要与待封存内容不一致');

    const object = this.state.objects.find((item) => item.id === batch.objectId);
    if (!object) throw new Error('对象缺失');

    const version = (object.versions[0]?.version ?? 0) + 1;
    object.versions.unshift({ version, digest, kind, conclusionKey, workstationId, at: payloadAt });
    object.digest = digest;
    batch.status = 'sealed';
    batch.sealedAt = nowIso();
    batch.version = version;
    this.log('批次封存', `批次 ${batch.id} 封存为对象 ${object.id} 的 v${version}（旧版本保留）`, workstationId, object.id, batch.id);
    this.persist();
    return { object: clone(object), batch: clone(batch), version, reused: false };
  }

  /** 预留过期判定，供 UI 显示"可接管" */
  batchState(batchId: string): { batch?: ArchiveBatch; expired: boolean } {
    const batch = this.state.batches.find((item) => item.id === batchId);
    return { batch: clone(batch), expired: batch ? this.isExpired(batch) : false };
  }

  /**
   * 发布对账：按对象摘要比对本机结论与服务端对象/批次状态，
   * 用于两人并发发布后确认归属与最终封存版本。
   */
  reconcile(objectId: string, digest: string, workstationId: string) {
    this.requireOnline();
    const object = this.state.objects.find((item) => item.id === objectId);
    const batches = this.state.batches
      .filter((batch) => batch.objectId === objectId)
      .sort((a, b) => b.reservedAt.localeCompare(a.reservedAt));
    const digestMatches = object?.digest === digest;
    const ownerBatch = batches.find((batch) => batch.status === 'reserved' || batch.status === 'sealed');
    const owner = ownerBatch?.workstationId ?? '—';
    const result = {
      object: object ? clone(object) : undefined,
      batches: clone(batches),
      digestMatches: !!digestMatches,
      owner,
      sealed: ownerBatch?.status === 'sealed',
      version: ownerBatch?.version
    };
    this.log(
      '发布对账',
      `对象 ${objectId} 摘要${digestMatches ? '一致' : '不一致'}，当前归属 ${owner}${ownerBatch?.status === 'sealed' ? `，已封存 v${ownerBatch.version}` : '，尚未封存'}`,
      workstationId,
      objectId,
      ownerBatch?.id
    );
    this.persist();
    return result;
  }

  recordFailure(batchId: string, objectId: string, workstationId: string, detail: string) {
    this.requireOnline();
    this.log('发布失败', detail, workstationId, objectId, batchId);
    this.persist();
  }

  reset() {
    this.state = initialServiceState();
    this.persist();
  }
}
