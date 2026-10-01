export type RecordGroup = 'A' | 'B';
export type MatchStatus = 'suggested' | 'confirmed' | 'rejected' | 'merged';
export type FieldKey = 'title' | 'date' | 'people' | 'places' | 'identifier' | 'medium' | 'extent' | 'rights' | 'notes';

export interface ArchiveRecord {
  id: string;
  group: RecordGroup;
  title: string;
  date: string;
  people: string[];
  places: string[];
  identifier: string;
  medium: string;
  extent: string;
  rights: string;
  notes: string;
  updatedAt: string;
  status: 'unreviewed' | 'confirmed' | 'rejected' | 'merged';
}

export interface MatchCandidate {
  id: string;
  leftId: string;
  rightId: string;
  score: number;
  fieldScores: Record<FieldKey, number>;
  status: MatchStatus;
  reasons: string[];
  reviewedAt?: string;
}

export interface MergeResult {
  id: string;
  matchId: string;
  leftId: string;
  rightId: string;
  chosen: Partial<Record<FieldKey, RecordGroup | 'combine'>>;
  values: Partial<Record<FieldKey, string>>;
  mergedAt: string;
  withdrawnAt?: string;
  sourceRecords?: [ArchiveRecord, ArchiveRecord];
}

export interface AuditEntry {
  id: string;
  at: string;
  action: string;
  detail: string;
  recordIds: string[];
  before?: string;
  after?: string;
}

/* ===================== 封存归档领域类型 ===================== */

export type PublishStage =
  | 'queued'          // 仅本机记录，尚未联系封存服务（断网提交）
  | 'object-reused'   // 已按摘要定位/登记对象
  | 'reserved'        // 批次已预留，等待封存
  | 'sealed'          // 封存完成
  | 'failed'          // 发布失败（可按同一批次恢复重试）
  | 'conflict';       // 批次被他人预留，待对账或接管

export type ConclusionKind = 'merge' | 'confirm' | 'merge-withdraw';

/** 可发布的核对结论载荷（规范化后算对象摘要） */
export interface ConclusionPayload {
  kind: ConclusionKind;
  at: string;
  merge?: {
    id: string;
    matchId: string;
    leftId: string;
    rightId: string;
    chosen: Partial<Record<FieldKey, RecordGroup | 'combine'>>;
    values: Partial<Record<FieldKey, string>>;
  };
  withdraw?: {
    mergeId: string;
    objectId?: string;
    reason: string;
    affectedRecordIds: string[];
  };
  records?: Array<{
    id: string;
    group: RecordGroup;
    title: string;
    date: string;
    people: string[];
    places: string[];
    identifier: string;
  }>;
}

export interface PublishJob {
  id: string;
  /** 幂等键：同一发布动作重试始终复用，不会重复建档 */
  idempotencyKey: string;
  workstationId: string;
  kind: ConclusionKind;
  /** 结论锚点：合并 id 或匹配 id，用于判断"同一结论" */
  conclusionKey: string;
  title: string;
  payload: ConclusionPayload;
  digest: string;
  stage: PublishStage;
  attempts: number;
  failSealOnce: boolean;
  objectId?: string;
  batchId?: string;
  version?: number;
  reservedBy?: string;
  reservedUntil?: string;
  lastError?: string;
  sealedAt?: string;
  createdAt: string;
  updatedAt: string;
  compensationTaskId?: string;
}

export interface CompensationTask {
  id: string;
  workstationId: string;
  mergeId: string;
  objectId: string;
  sealedVersion: number;
  affectedRecordIds: string[];
  referencedObjectIds: string[];
  createdAt: string;
  status: 'pending' | 'submitted' | 'sealed' | 'discarded';
  jobId?: string;
  newVersion?: number;
  confirmedAt?: string;
}

/* ---------------- 封存服务侧模型 ---------------- */

export interface SealedVersion {
  version: number;
  digest: string;
  kind: ConclusionKind;
  conclusionKey: string;
  workstationId: string;
  at: string;
}

export interface ArchiveObject {
  id: string;
  digest: string;
  kind: ConclusionKind;
  /** 同一核对结论在服务侧只对应一个对象，版本链挂在对象上 */
  conclusionKey: string;
  createdAt: string;
  versions: SealedVersion[];
}

export type BatchStatus = 'reserved' | 'sealed' | 'released';

export interface ArchiveBatch {
  id: string;
  objectId: string;
  digest: string;
  workstationId: string;
  status: BatchStatus;
  reservedAt: string;
  reservedUntil: string;
  sealedAt?: string;
  version?: number;
  /** 批次预留交接历史（接管必须留记录） */
  transfers: Array<{ at: string; from: string; to: string; reason: string }>;
  idempotencyKey: string;
}

export type LedgerEventType =
  | '对象登记'
  | '对象复用'
  | '批次预留'
  | '发布失败'
  | '批次封存'
  | '预留冲突'
  | '过期接管'
  | '发布对账'
  | '重复提交拦截';

export interface LedgerEvent {
  id: string;
  at: string;
  type: LedgerEventType;
  detail: string;
  workstationId: string;
  objectId?: string;
  batchId?: string;
}

export interface SealingServiceState {
  online: boolean;
  objects: ArchiveObject[];
  batches: ArchiveBatch[];
  ledger: LedgerEvent[];
}

export interface ReserveResult {
  outcome: 'reserved' | 'conflict';
  object: ArchiveObject;
  batch: ArchiveBatch;
}

export interface SealOutcome {
  object: ArchiveObject;
  batch: ArchiveBatch;
  version: number;
  reused: boolean;
}

export interface ArchiveState {
  revision: number;
  records: ArchiveRecord[];
  matches: MatchCandidate[];
  merges: MergeResult[];
  audit: AuditEntry[];
  activeMatchId: string;
  selectedRecordIds: string[];
  hydrated: boolean;
  workstationId: string;
  jobs: PublishJob[];
  compensations: CompensationTask[];
}
