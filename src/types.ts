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
  status: 'unreviewed' | 'confirmed' | 'rejected' | 'merged' | 'restored';
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
  mergedRecordId: string;
  chosen: Partial<Record<FieldKey, RecordGroup | 'combine'>>;
  values: Partial<Record<FieldKey, string>>;
  mergedAt: string;
  withdrawn?: boolean;
  withdrawnAt?: string;
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

/** 发布到封存服务的单条内容（以业务记录为引用单位） */
export interface SealItem {
  refId: string;
  recordId: string;
  title: string;
  identifier: string;
  digest: string;
}

export type SealJobPhase =
  | 'draft'        // 已建本机作业，尚未发布
  | 'reserving'    // 正在预留批次
  | 'reserved'     // 批次已预留，尚未封存（响应丢失/可恢复）
  | 'sealing'      // 正在封存
  | 'sealed'       // 封存完成
  | 'failed';      // 发布失败，等待恢复同一批次

export type BatchKind = 'publish' | 'compensation';

export interface SealJob {
  id: string;
  idempotencyKey: string;
  operator: string;
  kind: BatchKind;
  items: SealItem[];
  phase: SealJobPhase;
  batchId?: string;
  reservedUntil?: string;
  lastError?: string;
  attempts: number;
  createdAt: string;
  updatedAt: string;
  /** 补偿任务发布后回写 */
  compensationId?: string;
}

export interface CompensationAffected {
  recordId: string;
  title: string;
  identifier: string;
  role: 'merged' | 'restored-source';
  refId: string;
  sealedVersion?: string;
  objectId?: string;
}

export type CompensationStatus = 'pending' | 'submitting' | 'done' | 'dismissed';

export interface CompensationTask {
  id: string;
  reason: string;
  mergeId: string;
  mergeTitle: string;
  createdAt: string;
  affected: CompensationAffected[];
  /** 受影响引用对象及其封存版本 */
  refId: string;
  previousVersion?: string;
  previousObjectId?: string;
  newVersion?: string;
  newObjectId?: string;
  batchId?: string;
  status: CompensationStatus;
  confirmedAt?: string;
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
  /** 封存相关数据由独立持久化通道管理，不进入撤销快照 */
  sealJobs: SealJob[];
  compensations: CompensationTask[];
}
