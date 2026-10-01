// 用 node 内存 localStorage 跑一遍发布协调逻辑（非正式测试框架）
import assert from 'node:assert';
import { SealingService } from '../src/services/sealingService.ts';
import {
  audit,
  confirmCompensation,
  createMergeJob,
  reconcileJob,
  runPublish,
  takeoverReservation,
  withdrawMerge
} from '../src/services/publish.ts';
import type { ArchiveState, MergeResult, SealingServiceState } from '../src/types.ts';

const mem = new Map<string, string>();
(globalThis as { localStorage: Storage }).localStorage = {
  getItem: (key: string) => (mem.has(key) ? mem.get(key)! : null),
  setItem: (key: string, value: string) => mem.set(key, value),
  removeItem: (key: string) => mem.delete(key),
  clear: () => mem.clear(),
  key: () => null,
  length: 0
} as unknown as Storage;


const merge: MergeResult = {
  id: 'm-1', matchId: 'match-1', leftId: 'a1', rightId: 'b1',
  chosen: { title: 'A' }, values: { title: '合并标题' }, mergedAt: '2026-10-01T08:00:00.000Z',
  sourceRecords: []
};

const baseState = (): ArchiveState => ({
  revision: 0,
  records: [
    { id: 'a1', group: 'A', title: '甲', date: '2026', people: [], places: [], identifier: 'A1', medium: '', extent: '', rights: '', notes: '', updatedAt: '', status: 'merged' },
    { id: 'b1', group: 'B', title: '乙', date: '2026', people: [], places: [], identifier: 'B1', medium: '', extent: '', rights: '', notes: '', updatedAt: '', status: 'merged' },
    { id: 'm-1', group: 'A', title: '合并标题', date: '2026', people: [], places: [], identifier: 'A1', medium: '', extent: '', rights: '', notes: '', updatedAt: '', status: 'merged' }
  ],
  matches: [], merges: [{ ...merge }], audit: [],
  activeMatchId: '', selectedRecordIds: [], hydrated: true,
  workstationId: '工位-甲', jobs: [], compensations: []
});

// 1. 发布成功：对象 + 批次 + v1
let service = new SealingService();
let state = baseState();
const job = createMergeJob(state, 'm-1', '工位-甲');
assert.equal(runPublish(state, service, job.id).outcome, 'sealed');
assert.equal(state.jobs[0].stage, 'sealed');
assert.equal(state.jobs[0].version, 1);
assert.equal(service.state.objects.length, 1);
assert.equal(service.state.batches.length, 1);

// 2. 重复提交（重放同一 job）：不重复建档，直接回放 sealed
const again = runPublish(state, service, job.id);
assert.equal(again.outcome, 'sealed');
assert.equal(service.state.objects.length, 1);
assert.equal(service.state.batches.length, 1);

// 3. 断网排队 + 联网恢复同一批次：仍只有一个对象/批次，封存成功
service.setOnline(false);
let state2 = baseState();
const job2 = createMergeJob(state2, 'm-1', '工位-甲');
assert.equal(runPublish(state2, new SealingService(), job2.id).outcome, 'queued');
assert.equal(state2.jobs[0].stage, 'queued');
service.setOnline(true);
const recovered = runPublish(state2, new SealingService(), job2.id);
assert.equal(recovered.outcome, 'sealed');
// state2 的 job 与场景1共用同一个 service 存储，但 conclusionKey 相同 → 对象复用
assert.equal(new SealingService().state.objects.filter((o) => o.conclusionKey === 'm-1').length, 1);

// 4. 封存失败 → 批次保留 → 重试同一批次成功，不产生第二批
let svc: SealingServiceState;
mem.clear();
service = new SealingService();
state = baseState();
const job3 = createMergeJob(state, 'm-1', '工位-甲');
job3.failSealOnce = true;
assert.equal(runPublish(state, service, job3.id).outcome, 'failed');
const batchAfterFail = state.jobs[0].batchId;
assert.equal(runPublish(state, service, job3.id).outcome, 'sealed');
assert.equal(state.jobs[0].batchId, batchAfterFail);
assert.equal(service.state.batches.length, 1);
assert.equal(state.jobs[0].version, 1);

// 5. 两人同时发布：乙先预留 → 甲冲突；乙封存后甲对账
mem.clear();
service = new SealingService();
state = baseState();
const jobA = createMergeJob(state, 'm-1', '工位-甲');
// 乙直接走服务
const obj = service.resolveObject(jobA.digest, 'merge', 'm-1', '工位-乙').object;
const r = service.reserveBatch(obj, jobA.digest, '工位-乙', 'idem-yi');
assert.equal(r.outcome, 'reserved');
assert.equal(runPublish(state, service, jobA.id).outcome, 'conflict');
assert.equal(state.jobs[0].stage, 'conflict');
// 乙封存
service.sealBatch(r.batch.id, '工位-乙', jobA.digest, 'merge', 'm-1', merge.mergedAt);
const recon = reconcileJob(state, service, jobA.id);
assert.equal(recon.sealed, true);
assert.equal(recon.owner, '工位-乙');
assert.equal(state.jobs[0].stage, 'sealed');
assert.equal(state.jobs[0].version, 1);
assert.equal(state.jobs[0].reservedBy, '工位-乙');

// 6. 过期预留接管：乙预留过期 → 甲接管并封存，批次留 transfers
mem.clear();
service = new SealingService();
state = baseState();
const jobB = createMergeJob(state, 'm-1', '工位-甲');
const obj2 = service.resolveObject(jobB.digest, 'merge', 'm-1', '工位-乙').object;
const old = service.reserveBatch(obj2, jobB.digest, '工位-乙', 'idem-yi-old').batch;
// 甲先尝试发布拿到冲突（预留未过期）
assert.equal(runPublish(state, service, jobB.id).outcome, 'conflict');
// 预留过期后，甲接管
old.reservedUntil = '2000-01-01T00:00:00.000Z';
localStorage.setItem('sologsb-1020-sealing-service-v1', JSON.stringify(service.state));
const takeover = takeoverReservation(state, new SealingService(), jobB.id);
assert.equal(takeover.outcome, 'reserved');
const finalOutcome = runPublish(state, new SealingService(), jobB.id);
assert.equal(finalOutcome.outcome, 'sealed');
const newBatch = new SealingService().state.batches.find((b) => b.id === state.jobs[0].batchId)!;
assert.equal(newBatch.workstationId, '工位-甲');
assert.equal(newBatch.transfers.length, 1);
assert.equal(newBatch.transfers[0].from, '工位-乙');

// 7. 撤回已封存合并 → 补偿任务列出三要素 → 确认后新版本 v2 且保留 v1
mem.clear();
service = new SealingService();
state = baseState();
const jobC = createMergeJob(state, 'm-1', '工位-甲');
runPublish(state, service, jobC.id);
const objectId = state.jobs[0].objectId!;
const task = withdrawMerge(state, 'm-1', '不应合并');
assert.equal(task.status, 'pending');
assert.equal(task.objectId, objectId);
assert.equal(task.sealedVersion, 1);
assert.deepEqual(task.affectedRecordIds, ['a1', 'b1', 'm-1']);
assert.ok(task.referencedObjectIds.includes(objectId));
assert.ok(state.merges[0].withdrawnAt);
const comp = confirmCompensation(state, service, task.id, '重新核对');
assert.equal(comp.outcome, 'sealed');
const sealedObject = service.state.objects.find((o) => o.id === objectId)!;
assert.equal(sealedObject.versions.length, 2);
assert.deepEqual(sealedObject.versions.map((v) => v.version).sort(), [1, 2]);
assert.equal(state.compensations[0].status, 'sealed');

// 8. 撤回未封存合并：无补偿版本
mem.clear();
state = baseState();
audit(state, 'x', 'y');
const task2 = withdrawMerge(state, 'm-1', '改主意');
assert.equal(task2.status, 'discarded');
assert.equal(task2.sealedVersion, 0);

console.log('全部封存流程断言通过 ✓');
