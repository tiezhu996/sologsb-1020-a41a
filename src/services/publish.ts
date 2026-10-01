import type {
  ArchiveState,
  CompensationTask,
  ConclusionPayload,
  MergeResult,
  PublishJob,
  SealedVersion
} from '../types';
import { digestOf } from '../utils/digest';
import type { SealingService } from './sealingService';
import { SealingConflictError, SealingOfflineError } from './sealingService';

const uid = (prefix: string) => `${prefix}-${crypto.randomUUID().slice(0, 8)}`;
const nowIso = () => new Date().toISOString();

export const audit = (
  state: ArchiveState,
  action: string,
  detail: string,
  recordIds: string[] = []
) => {
  state.revision += 1;
  state.audit.unshift({ id: uid('aud'), at: nowIso(), action, detail, recordIds });
  state.audit = state.audit.slice(0, 300);
};

const projectRecords = (state: ArchiveState, ids: string[]) =>
  state.records
    .filter((record) => ids.includes(record.id))
    .map(({ id, group, title, date, people, places, identifier }) => ({
      id, group, title, date, people, places, identifier
    }));

/* ---------------- 结论与发布任务 ---------------- */

export function buildMergePayload(state: ArchiveState, merge: MergeResult): ConclusionPayload {
  return {
    kind: 'merge',
    at: merge.mergedAt,
    merge: {
      id: merge.id,
      matchId: merge.matchId,
      leftId: merge.leftId,
      rightId: merge.rightId,
      chosen: merge.chosen,
      values: merge.values
    },
    records: projectRecords(state, [merge.leftId, merge.rightId, merge.id])
  };
}

const jobTitleFor = (state: ArchiveState, merge: MergeResult) => {
  const current = state.records.find((record) => record.id === merge.id);
  return current?.title ?? merge.values.title ?? `合并 ${merge.id.slice(0, 8)}`;
};

export function findMergeJob(state: ArchiveState, mergeId: string, workstationId?: string) {
  return state.jobs.find(
    (job) => job.conclusionKey === mergeId &&
      job.kind === 'merge' &&
      (!workstationId || job.workstationId === workstationId)
  );
}

export function createMergeJob(state: ArchiveState, mergeId: string, workstationId: string): PublishJob {
  const merge = state.merges.find((item) => item.id === mergeId);
  if (!merge) throw new Error('找不到合并结果');
  const existing = findMergeJob(state, mergeId, workstationId);
  if (existing) return existing;
  const payload = buildMergePayload(state, merge);
  const job: PublishJob = {
    id: uid('job'),
    idempotencyKey: uid('idem'),
    workstationId,
    kind: 'merge',
    conclusionKey: mergeId,
    title: jobTitleFor(state, merge),
    payload,
    digest: digestOf(payload),
    stage: 'queued',
    attempts: 0,
    failSealOnce: false,
    createdAt: nowIso(),
    updatedAt: nowIso()
  };
  state.jobs.unshift(job);
  audit(state, '创建发布任务', `核对结论「${job.title}」按对象摘要 ${job.digest.slice(0, 12)} 排队，等待发布批次`, [merge.leftId, merge.rightId]);
  return job;
}

/* ---------------- 发布流水线（对象复用 → 批次预留 → 封存） ---------------- */

type PublishOutcome = 'sealed' | 'reserved' | 'queued' | 'conflict' | 'failed';

export function runPublish(
  state: ArchiveState,
  service: SealingService,
  jobId: string
): { job: PublishJob; outcome: PublishOutcome } {
  const job = state.jobs.find((item) => item.id === jobId);
  if (!job) throw new Error('找不到发布任务');
  if (job.stage === 'sealed') return { job, outcome: 'sealed' };

  job.attempts += 1;
  job.updatedAt = nowIso();
  let step: 'object' | 'reserve' | 'seal' = 'object';

  try {
    // 1. 按对象摘要复用 / 登记对象 —— 重复提交命中同一对象，不重复建档
    const resolved = service.resolveObject(job.digest, job.payload.kind, job.conclusionKey, job.workstationId);
    job.objectId = resolved.object.id;
    if (job.stage === 'queued' || job.stage === 'failed') {
      job.stage = 'object-reused';
    }
    step = 'reserve';

    // 2. 预留批次；同一幂等键 / 同批次恢复，归属以先预留者为准
    const reserve = service.reserveBatch(resolved.object, job.digest, job.workstationId, job.idempotencyKey);
    job.batchId = reserve.batch.id;
    job.reservedBy = reserve.batch.workstationId;
    job.reservedUntil = reserve.batch.reservedUntil;
    if (reserve.outcome === 'conflict') {
      job.stage = 'conflict';
      job.lastError = `批次已被 ${reserve.batch.workstationId} 预留`;
      audit(state, '发布冲突', `「${job.title}」的发布批次归属 ${reserve.batch.workstationId}，需对账或等其预留过期后接管`, job.payload.records?.map((r) => r.id) ?? []);
      return { job, outcome: 'conflict' };
    }
    job.stage = 'reserved';
    step = 'seal';

    // 3. 演示用：首次封存写失败，批次保留，恢复后重试同一批次即可
    if (job.failSealOnce) {
      service.recordFailure(job.batchId, job.objectId, job.workstationId, `「${job.title}」封存写入失败，批次 ${job.batchId} 保留待恢复`);
      job.failSealOnce = false;
      job.stage = 'failed';
      job.lastError = '封存写入失败，批次已保留，可恢复后重试';
      audit(state, '发布失败', `「${job.title}」封存失败，批次 ${job.batchId} 仍处于预留，重试将恢复同一批次、不会重复建档`);
      return { job, outcome: 'failed' };
    }

    // 4. 正式封存，生成新版本
    const result = service.sealBatch(
      job.batchId,
      job.workstationId,
      job.digest,
      job.payload.kind,
      job.conclusionKey,
      job.payload.at
    );
    finishSealed(state, job, result.version, result.batch.sealedAt!);
    return { job, outcome: 'sealed' };
  } catch (error) {
    job.updatedAt = nowIso();
    if (error instanceof SealingOfflineError) {
      // 断网：走到哪一步就停在哪一步，恢复网络后按同一批次重试
      job.lastError = '封存服务不可达';
      if (step === 'object') job.stage = 'queued';
      audit(state, '断网暂存', `「${job.title}」在${step === 'object' ? '联系封存服务前' : step === 'reserve' ? '预留批次时' : '封存写入时'}断网，结论保留在本机工作区，联网后重试`);
      return { job, outcome: 'queued' };
    }
    if (error instanceof SealingConflictError) {
      job.stage = 'conflict';
      job.reservedBy = error.batch.workstationId;
      job.reservedUntil = error.batch.reservedUntil;
      job.lastError = `批次归属 ${error.batch.workstationId}`;
      return { job, outcome: 'conflict' };
    }
    job.stage = 'failed';
    job.lastError = error instanceof Error ? error.message : String(error);
    audit(state, '发布失败', `「${job.title}」${job.lastError}`);
    return { job, outcome: 'failed' };
  }
}

function finishSealed(state: ArchiveState, job: PublishJob, version: number, sealedAt: string) {
  const firstSeal = job.version === undefined;
  job.stage = 'sealed';
  job.version = version;
  job.sealedAt = sealedAt;
  job.lastError = undefined;
  if (job.compensationTaskId) {
    const task = state.compensations.find((item) => item.id === job.compensationTaskId);
    if (task) {
      task.status = 'sealed';
      task.newVersion = version;
      task.confirmedAt = sealedAt;
    }
  }
  audit(
    state,
    firstSeal ? '封存完成' : '补偿版本封存完成',
    `「${job.title}」已封存为对象 ${job.objectId} 的 v${version}，旧版本全部保留`,
    job.payload.records?.map((record) => record.id) ?? []
  );
}

/* ---------------- 撤回合并 → 补偿任务 → 新版本 ---------------- */

export function withdrawMerge(state: ArchiveState, mergeId: string, reason: string): CompensationTask {
  const merge = state.merges.find((item) => item.id === mergeId);
  if (!merge) throw new Error('找不到合并结果');
  if (merge.withdrawnAt) throw new Error('该合并已撤回');

  // 本机工作区：恢复两条原记录，保留字段选择与撤销记录
  if (merge.sourceRecords) {
    state.records = state.records.filter((record) => record.id !== merge.id);
    merge.sourceRecords.forEach((source) => {
      if (!state.records.some((record) => record.id === source.id)) {
        state.records.push({ ...source, updatedAt: nowIso() });
      }
    });
  }
  const match = state.matches.find((item) => item.id === merge.matchId);
  if (match) {
    match.status = 'rejected';
    match.reviewedAt = nowIso();
  }
  merge.withdrawnAt = nowIso();

  const affectedRecordIds = [merge.leftId, merge.rightId, merge.id];
  const sealedJob = state.jobs.find(
    (job) => job.conclusionKey === mergeId && job.stage === 'sealed'
  );

  // 列出受影响记录、引用对象、封存版本
  const referencedObjectIds = Array.from(new Set(
    state.jobs
      .filter((job) => job.stage === 'sealed' && job.objectId)
      .filter((job) => job.payload.records?.some((record) => affectedRecordIds.includes(record.id)))
      .map((job) => job.objectId!)
  ));

  if (sealedJob?.objectId && sealedJob.version) {
    const task: CompensationTask = {
      id: uid('comp'),
      workstationId: sealedJob.workstationId,
      mergeId,
      objectId: sealedJob.objectId,
      sealedVersion: sealedJob.version,
      affectedRecordIds,
      referencedObjectIds,
      createdAt: nowIso(),
      status: 'pending'
    };
    state.compensations.unshift(task);
    audit(
      state,
      '撤回合并 · 生成补偿任务',
      `「${jobTitleFor(state, merge)}」已撤回：受影响记录 ${affectedRecordIds.length} 条、引用对象 ${referencedObjectIds.length} 个、现封存版本 v${task.sealedVersion}；确认后将生成新版本并保留旧版本`,
      affectedRecordIds
    );
    return task;
  }

  audit(state, '撤回合并', `「${jobTitleFor(state, merge)}」已在本机撤回，尚未发布过封存版本，无需补偿`, affectedRecordIds);
  // 没有已封存版本也建一条任务占位，UI 可提示无需补偿
  const task: CompensationTask = {
    id: uid('comp'),
    workstationId: state.workstationId,
    mergeId,
    objectId: '',
    sealedVersion: 0,
    affectedRecordIds,
    referencedObjectIds,
    createdAt: nowIso(),
    status: 'discarded'
  };
  return task;
}

export function confirmCompensation(
  state: ArchiveState,
  service: SealingService,
  taskId: string,
  reason: string
) {
  const task = state.compensations.find((item) => item.id === taskId);
  if (!task || task.status !== 'pending') throw new Error('补偿任务不可确认');
  const merge = state.merges.find((item) => item.id === task.mergeId);
  if (!merge) throw new Error('找不到合并结果');

  const payload: ConclusionPayload = {
    kind: 'merge-withdraw',
    at: nowIso(),
    withdraw: {
      mergeId: merge.id,
      objectId: task.objectId,
      reason,
      affectedRecordIds: task.affectedRecordIds
    },
    records: projectRecords(state, task.affectedRecordIds)
  };
  const job: PublishJob = {
    id: uid('job'),
    idempotencyKey: uid('idem'),
    workstationId: task.workstationId,
    kind: 'merge-withdraw',
    conclusionKey: merge.id,
    title: `补偿 · 撤回「${jobTitleFor(state, merge)}」`,
    payload,
    digest: digestOf(payload),
    stage: 'queued',
    attempts: 0,
    failSealOnce: false,
    createdAt: nowIso(),
    updatedAt: nowIso(),
    compensationTaskId: task.id
  };
  state.jobs.unshift(job);
  task.jobId = job.id;
  task.status = 'submitted';
  audit(state, '确认补偿任务', `撤回合并「${jobTitleFor(state, merge)}」生成补偿发布，沿用对象 ${task.objectId}，将在 v${task.sealedVersion} 之后追加新版本`, task.affectedRecordIds);
  return runPublish(state, service, job.id);
}

export function discardCompensation(state: ArchiveState, taskId: string) {
  const task = state.compensations.find((item) => item.id === taskId);
  if (!task || task.status !== 'pending') return;
  task.status = 'discarded';
  audit(state, '放弃补偿任务', `合并 ${task.mergeId} 的补偿任务已放弃，封存服务仍保留 v${task.sealedVersion}`, task.affectedRecordIds);
}

/* ---------------- 并发：对账与过期接管 ---------------- */

export function reconcileJob(state: ArchiveState, service: SealingService, jobId: string) {
  const job = state.jobs.find((item) => item.id === jobId);
  if (!job || !job.objectId) throw new Error('任务尚未在封存服务登记对象');
  const result = service.reconcile(job.objectId, job.digest, job.workstationId);
  const ownerBatch = result.batches.find((batch) => batch.status === 'sealed') ?? result.batches[0];
  if (result.sealed && ownerBatch) {
    job.batchId = ownerBatch.id;
    job.version = ownerBatch.version;
    job.sealedAt = ownerBatch.sealedAt;
    job.stage = 'sealed';
    job.reservedBy = ownerBatch.workstationId;
    job.lastError = undefined;
    audit(state, '发布对账', `「${job.title}」对账完成：归属 ${result.owner}，对象 ${job.objectId} 已封存 v${result.version}，本机状态已对齐`);
  } else {
    job.reservedBy = result.owner;
    job.stage = result.owner === job.workstationId ? 'reserved' : 'conflict';
    audit(state, '发布对账', `「${job.title}」对账完成：当前预留归属 ${result.owner}，尚未封存`);
  }
  return result;
}

/** 接管他人过期预留：换新幂等键预留新批次，旧批次的交接由服务留记录 */
export function takeoverReservation(state: ArchiveState, service: SealingService, jobId: string) {
  const job = state.jobs.find((item) => item.id === jobId);
  if (!job || !job.objectId) throw new Error('任务尚未登记对象');
  job.attempts += 1;
  job.idempotencyKey = uid('takeover');
  const known = job.objectId
    ? service.resolveObject(job.digest, job.payload.kind, job.conclusionKey, job.workstationId).object
    : service.findObjectByConclusion(job.conclusionKey, job.workstationId)
      ?? service.resolveObject(job.digest, job.payload.kind, job.conclusionKey, job.workstationId).object;
  job.objectId = known.id;
  const result = service.reserveBatch(known, job.digest, job.workstationId, job.idempotencyKey);
  if (result.outcome === 'conflict') {
    job.stage = 'conflict';
    job.reservedBy = result.batch.workstationId;
    job.reservedUntil = result.batch.reservedUntil;
    audit(state, '接管失败', `「${job.title}」原预留尚未过期，仍归属 ${result.batch.workstationId}（至 ${result.batch.reservedUntil}）`);
    return { job, outcome: 'conflict' as const };
  }
  const transfer = result.batch.transfers[0];
  job.batchId = result.batch.id;
  job.stage = 'reserved';
  job.reservedBy = job.workstationId;
  job.reservedUntil = result.batch.reservedUntil;
  audit(
    state,
    '接管过期预留',
    `「${job.title}」已接管 ${transfer?.from ?? '原预留方'} 的过期预留，新批次 ${result.batch.id}，交接记录已留在封存服务`
  );
  return { job, outcome: 'reserved' as const };
}

export function versionLabel(version?: SealedVersion | number) {
  if (typeof version === 'number') return `v${version}`;
  return version ? `v${version.version}` : '—';
}
