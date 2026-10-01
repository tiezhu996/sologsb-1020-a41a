import {
  $, component$, useComputed$, useSignal, useStore, useVisibleTask$
} from '@builder.io/qwik';
import { Checkbox, Modal, Tabs } from '@qwik-ui/headless';
import type {
  ArchiveRecord, ArchiveState, CompensationTask, FieldKey,
  MatchCandidate, RecordGroup, SealJob, SealItem
} from './types';
import { computeMatches, fieldValue } from './utils/matching';
import { digestCompensation, digestRecord, shortDigest } from './utils/digest';
import { seedState } from './data/seed';
import {
  SealingError, formatTime, getConfig, getSnapshot, phaseLabel, reconcile,
  resetVault, reserveBatch, sealBatch, setFault, setTtl, takeOverBatch,
  type FaultMode, type ReconcileRow, type VaultSnapshot
} from './services/sealing';

const STORAGE_KEY = 'sologsb-1020-archive-state-v1';
const SEAL_EXTRA_KEY = 'sologsb-1020-seal-extra-v1';
const OPERATOR_KEY = 'sologsb-1020-operator-v1';
const fieldLabels: Array<[FieldKey, string]> = [
  ['title', '标题'], ['date', '日期'], ['people', '人物'], ['places', '地点'], ['identifier', '编号'],
  ['medium', '载体'], ['extent', '数量'], ['rights', '权利'], ['notes', '备注']
];

const parseDate = (value: string) => {
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value.split('-').reverse().join('/');
  if (/^\d{4}$/.test(value)) return `${value}年`;
  return value || '未知';
};

const recordById = (state: ArchiveState, id: string) => state.records.find((record) => record.id === id);
const matchLabel = (state: ArchiveState, match: MatchCandidate) => {
  const left = recordById(state, match.leftId);
  const right = recordById(state, match.rightId);
  return `${left?.title ?? '未知记录'} ↔ ${right?.title ?? '未知记录'}`;
};

export default component$(() => {
  const state = useStore<ArchiveState>(seedState());
  const history = useSignal<string[]>([]);
  const future = useSignal<string[]>([]);
  const query = useSignal('');
  const groupFilter = useSignal<'all' | RecordGroup>('all');
  const statusFilter = useSignal<'all' | 'suggested' | 'confirmed' | 'rejected'>('all');
  const visibleCount = useSignal(80);
  const selectedMatchIds = useSignal<string[]>([]);
  const importOpen = useSignal(false);
  const mergeOpen = useSignal(false);
  const reconcileOpen = useSignal(false);
  const importGroup = useSignal<RecordGroup>('A');
  const importRaw = useSignal('');
  const importText = useSignal('');
  const toast = useSignal('');
  const panelTab = useSignal(0);

  // —— 封存归档工作台状态 ——
  const operator = useSignal('');
  const vault = useSignal<VaultSnapshot | null>(null);
  const tick = useSignal(0);
  const sealFault = useSignal<FaultMode>('none');
  const sealTtl = useSignal(15);
  const reconcileRows = useSignal<ReconcileRow[]>([]);
  const compensationsTab = useSignal(0);

  const refreshVault = $(() => {
    vault.value = getSnapshot();
    const config = getConfig();
    sealFault.value = config.fault;
    sealTtl.value = config.ttlSeconds;
  });

  const snapshot = () => JSON.stringify({
    revision: state.revision,
    records: state.records,
    matches: state.matches,
    merges: state.merges,
    audit: state.audit
  });

  const capture = () => {
    history.value = [...history.value.slice(-49), snapshot()];
    future.value = [];
  };

  const restore = (raw: string) => {
    const next = JSON.parse(raw) as Partial<ArchiveState>;
    state.revision = next.revision ?? state.revision;
    state.records = next.records ?? state.records;
    state.matches = next.matches ?? state.matches;
    state.merges = next.merges ?? state.merges;
    state.audit = next.audit ?? state.audit;
  };

  const notify = (message: string) => {
    toast.value = message;
    window.setTimeout(() => { if (toast.value === message) toast.value = ''; }, 3200);
  };

  const commit = (action: string, detail: string, recordIds: string[] = []) => {
    state.revision += 1;
    state.audit.unshift({ id: crypto.randomUUID(), at: new Date().toISOString(), action, detail, recordIds });
    state.audit = state.audit.slice(0, 300);
  };

  const undo = $(() => {
    const raw = history.value.at(-1);
    if (!raw) return;
    future.value = [...future.value, snapshot()];
    history.value = history.value.slice(0, -1);
    restore(raw);
  });

  const redo = $(() => {
    const raw = future.value.at(-1);
    if (!raw) return;
    history.value = [...history.value, snapshot()];
    future.value = future.value.slice(0, -1);
    restore(raw);
  });

  const filteredRecords = useComputed$(() => {
    const term = query.value.trim().toLowerCase();
    return state.records
      .filter((record) => groupFilter.value === 'all' || record.group === groupFilter.value)
      .filter((record) => !term || [record.title, record.date, record.identifier, ...record.people, ...record.places].join(' ').toLowerCase().includes(term))
      .sort((a, b) => a.group.localeCompare(b.group) || a.title.localeCompare(b.title, 'zh-CN'))
      .slice(0, visibleCount.value);
  });

  const filteredMatches = useComputed$(() => state.matches
    .filter((match) => statusFilter.value === 'all' || match.status === statusFilter.value)
    .sort((a, b) => b.score - a.score));

  const visibleMatches = useComputed$(() => filteredMatches.value.slice(0, 120));
  const activeMatch = useComputed$(() => state.matches.find((match) => match.id === state.activeMatchId) ?? filteredMatches.value[0]);
  const conflictCount = useComputed$(() => state.matches.filter((match) => match.status === 'suggested' && match.score < .68).length);

  // —— 封存相关派生 ——
  const sealedRefs = useComputed$(() => new Set(
    state.sealJobs.filter((job) => job.phase === 'sealed').flatMap((job) => job.items.map((item) => item.refId))
  ));
  const pendingRefs = useComputed$(() => new Set(
    state.sealJobs.filter((job) => job.phase !== 'sealed').flatMap((job) => job.items.map((item) => item.refId))
  ));

  /** 可发布：已核对确认的记录（含合并结果与确认匹配所涉及的记录） */
  const publishableRecords = useComputed$(() => state.records
    .filter((record) => record.status === 'merged' || record.status === 'confirmed')
    .filter((record) => !sealedRefs.value.has(record.id))
    .filter((record) => !pendingRefs.value.has(record.id))
    .sort((a, b) => a.title.localeCompare(b.title, 'zh-CN')));

  const sealedVersionFor = (refId: string): { versionId?: string; objectId?: string; digest?: string } => {
    const version = vault.value?.versions
      .filter((item) => item.refId === refId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
    return { versionId: version?.versionId, objectId: version?.objectId, digest: version?.digest };
  };

  const staleCount = useComputed$(() => {
    tick.value;
    if (!vault.value) return 0;
    return vault.value.batches.filter((batch) =>
      batch.status === 'reserved' && new Date(batch.reservedUntil).getTime() <= Date.now()).length;
  });

  const countdown = (iso?: string) => {
    tick.value;
    if (!iso) return '';
    const remain = Math.max(0, Math.round((new Date(iso).getTime() - Date.now()) / 1000));
    return remain > 0 ? `${remain}s` : '已过期';
  };

  const updateMatch = $((id: string, status: MatchCandidate['status']) => {
    capture();
    const match = state.matches.find((item) => item.id === id);
    if (!match) return;
    match.status = status;
    match.reviewedAt = new Date().toISOString();
    state.records.forEach((record) => {
      if ((record.id === match.leftId || record.id === match.rightId) && status === 'confirmed') record.status = 'confirmed';
    });
    commit(status === 'confirmed' ? '确认匹配' : '忽略可疑匹配', matchLabel(state, match), [match.leftId, match.rightId]);
    notify(status === 'confirmed' ? '已确认此项匹配' : '已忽略此项匹配');
  });

  const bulkMatch = $((status: MatchCandidate['status']) => {
    const ids = selectedMatchIds.value;
    if (!ids.length) return;
    capture();
    ids.forEach((id) => {
      const match = state.matches.find((item) => item.id === id);
      if (!match) return;
      match.status = status;
      match.reviewedAt = new Date().toISOString();
    });
    commit('批量复核', `${ids.length} 条匹配被标记为${status === 'confirmed' ? '确认' : '忽略'}`, ids.flatMap((id) => {
      const match = state.matches.find((item) => item.id === id);
      return match ? [match.leftId, match.rightId] : [];
    }));
    selectedMatchIds.value = [];
    notify(`已批量处理 ${ids.length} 条匹配`);
  });

  const openMerge = $(() => {
    const match = activeMatch.value;
    if (!match || !recordById(state, match.leftId) || !recordById(state, match.rightId)) return;
    state.activeMatchId = match.id;
    fieldLabels.forEach(([field]) => {
      const left = recordById(state, match.leftId);
      const right = recordById(state, match.rightId);
      if (left && right && fieldValue(left, field) === fieldValue(right, field)) choices[field] = 'A';
      else choices[field] = 'A';
    });
    mergeOpen.value = true;
  });

  const choices = useStore<Record<FieldKey, RecordGroup | 'combine'>>({
    title: 'A', date: 'A', people: 'A', places: 'A', identifier: 'A', medium: 'A', extent: 'A', rights: 'A', notes: 'A'
  });

  const mergeCurrent = $(() => {
    const match = activeMatch.value;
    if (!match) return;
    const left = recordById(state, match.leftId);
    const right = recordById(state, match.rightId);
    if (!left || !right) return;
    capture();
    const values: Partial<Record<FieldKey, string>> = {};
    fieldLabels.forEach(([field]) => {
      const source = choices[field];
      const pick = source === 'combine' ? `${fieldValue(left, field)}；${fieldValue(right, field)}` : fieldValue(source === 'A' ? left : right, field);
      values[field] = pick;
    });
    const mergedId = crypto.randomUUID();
    const merged: ArchiveRecord = {
      ...left,
      id: mergedId,
      ...values,
      people: values.people?.split(/[；、,，]/).map((item) => item.trim()).filter(Boolean) ?? left.people,
      places: values.places?.split(/[；、,，]/).map((item) => item.trim()).filter(Boolean) ?? left.places,
      status: 'merged',
      updatedAt: new Date().toISOString()
    };
    state.records = [...state.records.filter((record) => record.id !== left.id && record.id !== right.id), merged];
    state.matches.forEach((item) => {
      if (item.id === match.id) item.status = 'merged';
      else if (item.leftId === left.id || item.rightId === right.id || item.leftId === right.id || item.rightId === left.id) item.status = 'rejected';
    });
    state.merges.unshift({
      id: crypto.randomUUID(),
      matchId: match.id,
      leftId: left.id,
      rightId: right.id,
      mergedRecordId: mergedId,
      chosen: { ...choices },
      values,
      mergedAt: new Date().toISOString()
    });
    commit('合并两条记录', `保留 ${Object.values(choices).filter((choice) => choice === 'A').length} 个 A 来源字段、${Object.values(choices).filter((choice) => choice === 'B').length} 个 B 来源字段`, [left.id, right.id, merged.id]);
    mergeOpen.value = false;
    notify('记录已合并，来源与字段选择已写入审计记录');
  });

  /** 撤回合并：恢复两条来源记录；若合并结果已封存，则生成补偿任务（新版本保留旧版本） */
  const withdrawMerge = $((mergeId: string) => {
    const merge = state.merges.find((item) => item.id === mergeId);
    if (!merge || merge.withdrawn) return;
    capture();
    const merged = recordById(state, merge.mergedRecordId);
    const restoreAt = new Date().toISOString();
    const makeRestored = (sourceId: string, group: RecordGroup, suffix: string): ArchiveRecord => ({
      id: crypto.randomUUID(),
      group,
      title: (merged?.title ?? '撤回恢复记录') + suffix,
      date: merged?.date ?? '',
      people: merged ? [...merged.people] : [],
      places: merged ? [...merged.places] : [],
      identifier: `${merged?.identifier ?? sourceId}-R`,
      medium: merged?.medium ?? '',
      extent: merged?.extent ?? '',
      rights: merged?.rights ?? '',
      notes: `撤回合并 ${mergeId} 后恢复的来源记录（原 ${sourceId}）`,
      updatedAt: restoreAt,
      status: 'restored'
    });
    const restoredLeft = makeRestored(merge.leftId, 'A', '（恢复A源）');
    const restoredRight = makeRestored(merge.rightId, 'B', '（恢复B源）');
    state.records = [
      ...state.records.filter((record) => record.id !== merge.mergedRecordId),
      restoredLeft, restoredRight
    ];
    state.matches.forEach((item) => {
      if (item.id === merge.matchId) item.status = 'rejected';
      else if (item.leftId === merge.leftId || item.rightId === merge.rightId) item.status = 'rejected';
    });
    // 恢复的来源记录是新 id：为这对 A/B 记录重新计算匹配，旧匹配（指向已删除 id）标记为已忽略
    const repaired = computeMatches([restoredLeft, restoredRight]).map((candidate) => ({ ...candidate, reasons: [`撤回合并 ${mergeId} 后重新核对`, ...candidate.reasons] }));
    state.matches = [...state.matches, ...repaired];
    state.activeMatchId = repaired[0]?.id ?? '';
    merge.withdrawn = true;
    merge.withdrawnAt = restoreAt;

    if (sealedRefs.value.has(merge.mergedRecordId)) {
      const previous = sealedVersionFor(merge.mergedRecordId);
      const compensation: CompensationTask = {
        id: crypto.randomUUID(),
        reason: `撤回合并《${merged?.title ?? mergeId}》，封存引用需要生成补偿版本`,
        mergeId,
        mergeTitle: merged?.title ?? mergeId,
        createdAt: restoreAt,
        refId: merge.mergedRecordId,
        previousVersion: previous.versionId,
        previousObjectId: previous.objectId,
        affected: [
          { recordId: merge.mergedRecordId, title: merged?.title ?? mergeId, identifier: merged?.identifier ?? '—', role: 'merged', refId: merge.mergedRecordId, sealedVersion: previous.versionId, objectId: previous.objectId },
          ...[restoredLeft, restoredRight].map((record) => ({ recordId: record.id, title: record.title, identifier: record.identifier, role: 'restored-source' as const, refId: merge.mergedRecordId }))
        ],
        status: 'pending'
      };
      state.compensations.unshift(compensation);
      commit('撤回合并（已封存）', `合并结果已封存，生成补偿任务，待确认后发布新版本并保留 ${previous.versionId ?? '旧版本'}`, [merge.mergedRecordId, restoredLeft.id, restoredRight.id]);
      notify('合并已撤回，补偿任务已生成：确认后将在封存服务发布新版本（保留旧版本）');
    } else {
      commit('撤回合并', '恢复两条来源记录，合并结果未封存，无需补偿', [restoredLeft.id, restoredRight.id]);
      notify('合并已撤回，两条来源记录已恢复');
    }
  });

  const parseImport = $(() => {
    const raw = importRaw.value.trim();
    if (!raw) return;
    let rows: Array<Partial<ArchiveRecord>> = [];
    try {
      if (raw.startsWith('[')) rows = JSON.parse(raw) as Array<Partial<ArchiveRecord>>;
      else {
        const lines = raw.split(/\r?\n/).filter(Boolean);
        rows = lines.map((line, index) => {
          const cells = line.split(/\t|\|/).map((cell) => cell.trim());
          return {
            title: cells[0] || `未命名记录 ${index + 1}`,
            date: cells[1] || '',
            people: (cells[2] || '').split(/[，,、]/).filter(Boolean),
            places: (cells[3] || '').split(/[，,、]/).filter(Boolean),
            identifier: cells[4] || '',
            medium: cells[5] || '',
            extent: cells[6] || '',
            rights: cells[7] || '',
            notes: cells[8] || ''
          };
        });
      }
    } catch {
      notify('导入内容格式不正确，请使用 JSON 数组或制表符分隔文本');
      return;
    }
    if (!rows.length) return;
    capture();
    rows.forEach((row) => {
      const record: ArchiveRecord = {
        id: crypto.randomUUID(),
        group: importGroup.value,
        title: row.title || '未命名记录',
        date: row.date || '',
        people: Array.isArray(row.people) ? row.people : String(row.people || '').split(/[，,、]/).filter(Boolean),
        places: Array.isArray(row.places) ? row.places : String(row.places || '').split(/[，,、]/).filter(Boolean),
        identifier: row.identifier || '',
        medium: row.medium || '',
        extent: row.extent || '',
        rights: row.rights || '',
        notes: row.notes || '',
        updatedAt: new Date().toISOString(),
        status: 'unreviewed'
      };
      state.records.push(record);
    });
    state.matches = computeMatches(state.records);
    commit('导入档案记录', `从 ${importGroup.value} 组导入 ${rows.length} 条记录`, []);
    importRaw.value = '';
    importText.value = '';
    importOpen.value = false;
    notify(`已导入 ${rows.length} 条记录并重新匹配`);
  });

  const importFile = $(async (_event: Event, element: HTMLInputElement) => {
    const file = element.files?.[0];
    if (!file) return;
    importRaw.value = await file.text();
    importText.value = file.name;
  });

  const exportAudit = $(() => {
    const blob = new Blob([JSON.stringify({ exportedAt: new Date().toISOString(), records: state.records, matches: state.matches, merges: state.merges, sealJobs: state.sealJobs, compensations: state.compensations, audit: state.audit }, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `档案元数据核对结果-${new Date().toISOString().slice(0, 10)}.json`;
    anchor.click();
    URL.revokeObjectURL(url);
  });

  const moveReview = $((delta: number) => {
    const list = filteredMatches.value;
    const index = list.findIndex((match) => match.id === activeMatch.value?.id);
    const next = list[Math.max(0, Math.min(list.length - 1, index + delta))];
    if (next) {
      state.activeMatchId = next.id;
      document.querySelector(`[data-match-id="${next.id}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  });

  /* ============ 封存发布：先按对象摘要复用对象，再预留批次；失败恢复同一批次 ============ */

  const buildItems = (records: ArchiveRecord[]): SealItem[] => records.map((record) => ({
    refId: record.id,
    recordId: record.id,
    title: record.title,
    identifier: record.identifier,
    digest: digestRecord(record)
  }));

  const publishSelected = $(async () => {
    const records = publishableRecords.value;
    if (!records.length) { notify('没有可发布的已核对记录'); return; }
    const items = buildItems(records);
    const idempotencyKey = `pub:${operator.value}:${[...items.map((item) => item.digest)].sort().join('+').slice(0, 48)}`;
    const existing = state.sealJobs.find((job) => job.idempotencyKey === idempotencyKey && job.phase !== 'sealed');
    if (existing) {
      notify('相同内容已有进行中的发布作业，已直接复用，不会重复建档');
      await runPublish(existing.id);
      return;
    }
    const now = new Date().toISOString();
    const job: SealJob = {
      id: crypto.randomUUID(),
      idempotencyKey,
      operator: operator.value,
      kind: 'publish',
      items,
      phase: 'reserving',
      attempts: 0,
      createdAt: now,
      updatedAt: now
    };
    state.sealJobs.unshift(job);
    await runPublish(job.id);
  });

  const runPublish = $(async (jobId: string) => {
    const job = state.sealJobs.find((item) => item.id === jobId);
    if (!job) return;
    job.attempts += 1;
    job.updatedAt = new Date().toISOString();
    const compensation = job.compensationId
      ? state.compensations.find((task) => task.id === job.compensationId)
      : undefined;
    try {
      if (!job.batchId) {
        job.phase = 'reserving';
        const batch = await reserveBatch({ operator: job.operator, kind: job.kind, items: job.items, idempotencyKey: job.idempotencyKey });
        job.batchId = batch.batchId;
        job.reservedUntil = batch.reservedUntil;
        job.lastError = undefined;
        commit(job.kind === 'compensation' ? '预留补偿批次' : '预留发布批次', `${job.operator} 预留批次 ${batch.batchId}，含 ${job.items.length} 条引用（TTL ${Math.round((new Date(batch.reservedUntil).getTime() - new Date(batch.reservedAt).getTime()) / 1000)}s）`);
      }
      job.phase = 'sealing';
      const sealed = await sealBatch(job.batchId, job.operator);
      job.phase = 'sealed';
      job.reservedUntil = sealed.reservedUntil;
      job.lastError = undefined;
      const newOnes = sealed.sealedItems?.filter((item) => !item.reused).length ?? 0;

      if (compensation) {
        const mine = sealed.sealedItems?.[0];
        compensation.status = 'done';
        compensation.confirmedAt = new Date().toISOString();
        compensation.batchId = sealed.batchId;
        compensation.newVersion = mine?.versionId;
        compensation.newObjectId = mine?.objectId;
        commit('确认补偿任务', `补偿批次 ${sealed.batchId} 已封存：引用 ${compensation.refId.slice(0, 8)} 由 ${compensation.previousVersion ?? '—'} 升级为 ${mine?.versionId ?? '新版本'}，旧版本保留`);
        notify(`补偿版本 ${mine?.versionId ?? ''} 已封存，旧版本 ${compensation.previousVersion ?? ''} 保留可查`);
      } else {
        commit('封存完成', `批次 ${sealed.batchId} 封存成功：${job.items.length} 条引用，其中 ${newOnes} 条新版本，其余按对象摘要/版本复用`);
        notify(`批次 ${sealed.batchId} 封存成功：${newOnes} 条新版本，其余复用，重试未重复建档`);
      }
    } catch (error) {
      job.phase = 'failed';
      const sealingError = error as SealingError;
      job.lastError = sealingError.message;
      if (compensation && compensation.status === 'submitting') compensation.status = 'pending';
      if (sealingError.code === 'reserve-conflict' && sealingError.conflict) {
        job.batchId = sealingError.conflict.batchId;
        job.reservedUntil = sealingError.conflict.reservedUntil;
        notify(`预留冲突：批次 ${sealingError.conflict.batchId} 归属 ${sealingError.conflict.owner}，请在发布对账中处理`);
      } else {
        notify(`发布中断：${sealingError.message}。批次已保留，可直接恢复，不会重复建档`);
      }
      commit(job.kind === 'compensation' ? '补偿发布中断' : '发布中断', `作业 ${jobId.slice(0, 8)}：${sealingError.message}`);
    } finally {
      await refreshVault();
    }
  });

  /* ============ 撤回合并后的补偿任务：确认后生成新版本，保留旧版本 ============ */

  const confirmCompensation = $((compensationId: string) => {
    const task = state.compensations.find((item) => item.id === compensationId);
    if (!task || task.status !== 'pending') return;
    const at = new Date().toISOString();
    const digest = digestCompensation({ mergeId: task.mergeId, sources: task.affected.filter((item) => item.role === 'restored-source').map((item) => ({ title: item.title, identifier: item.identifier })), at });
    const items: SealItem[] = [{
      refId: task.refId,
      recordId: task.refId,
      title: `补偿版本 · ${task.mergeTitle}`,
      identifier: task.affected[0]?.identifier ?? task.refId,
      digest
    }];
    // 失败后重试复用同一作业与批次：摘要固定，不会重复建档
    const existing = state.sealJobs.find((job) => job.compensationId === compensationId);
    task.status = 'submitting';
    if (existing) {
      runPublish(existing.id);
      return;
    }
    const job: SealJob = {
      id: crypto.randomUUID(),
      idempotencyKey: `comp:${compensationId}`,
      operator: operator.value,
      kind: 'compensation',
      items,
      phase: 'reserving',
      attempts: 0,
      compensationId,
      createdAt: at,
      updatedAt: at
    };
    state.sealJobs.unshift(job);
    runPublish(job.id);
  });

  const dismissCompensation = $((compensationId: string) => {
    const task = state.compensations.find((item) => item.id === compensationId);
    if (!task) return;
    task.status = 'dismissed';
    commit('暂缓补偿任务', `补偿任务 ${compensationId.slice(0, 8)} 标记为暂缓，仍保留在轨迹中`);
  });

  /* ============ 发布对账与过期预留接管 ============ */

  const openReconcile = $(async () => {
    await refreshVault();
    reconcileRows.value = reconcile(state.sealJobs, vault.value!);
    reconcileOpen.value = true;
  });

  const adoptBatch = $(async (batchId: string) => {
    const remote = vault.value?.batches.find((batch) => batch.batchId === batchId);
    if (!remote) return;
    if (remote.status === 'reserved') {
      notify('该批次仍为预留状态，请先接管再封存');
      return;
    }
    const items: SealItem[] = (remote.sealedItems ?? remote.items).map((item) => ({
      refId: item.refId, recordId: item.recordId, title: item.title, identifier: item.identifier, digest: item.digest
    }));
    const now = new Date().toISOString();
    const job: SealJob = {
      id: crypto.randomUUID(),
      idempotencyKey: remote.idempotencyKey,
      operator: operator.value,
      kind: remote.kind,
      items,
      phase: 'sealed',
      batchId: remote.batchId,
      reservedUntil: remote.reservedUntil,
      attempts: 1,
      createdAt: now,
      updatedAt: now,
      compensationId: remote.items.find((item) => item.compensationId)?.compensationId
    };
    state.sealJobs.unshift(job);
    const compId = remote.items.find((item) => item.compensationId)?.compensationId;
    if (compId) {
      const task = state.compensations.find((item) => item.id === compId);
      const mine = remote.sealedItems?.find((item) => item.compensationId === compId) ?? remote.sealedItems?.[0];
      if (task && task.status !== 'done') {
        task.status = 'done';
        task.confirmedAt = remote.sealedAt;
        task.batchId = remote.batchId;
        task.newVersion = mine?.versionId;
        task.newObjectId = mine?.objectId;
      }
    }
    commit('对账补登', `封存响应丢失核对：批次 ${batchId} 服务端已封存，本机补登作业记录`);
    notify(`已补登批次 ${batchId} 的本机作业，两侧状态对齐`);
    await refreshVault();
    reconcileRows.value = reconcile(state.sealJobs, vault.value!);
  });

  const takeover = $(async (batchId: string) => {
    try {
      const batch = await takeOverBatch(batchId, operator.value);
      commit('接管过期预留', `${operator.value} 接管批次 ${batchId}，履历已在封存服务留记录`);
      const job = state.sealJobs.find((item) => item.batchId === batchId);
      if (job) {
        job.batchId = batch.batchId;
        job.reservedUntil = batch.reservedUntil;
        job.phase = 'failed';
        job.lastError = `已由 ${operator.value} 接管，可继续封存`;
      }
      notify(`已接管过期预留 ${batchId}，可继续封存`);
      await refreshVault();
      reconcileRows.value = reconcile(state.sealJobs, vault.value!);
    } catch (error) {
      notify(`接管失败：${(error as SealingError).message}`);
    }
  });

  const resetService = $(() => {
    resetVault();
    commit('清空封存服务演示数据', '封存服务对象、批次与版本链已清空，本机作业保留——可用于观察两侧对不上的状态');
    notify('封存服务已清空，本机作业保留，可立即执行发布对账');
    refreshVault();
  });

  const changeFault = $(async (mode: FaultMode) => {
    setFault(mode);
    await refreshVault();
    if (mode === 'none') notify('网络与故障注入已恢复正常，可恢复失败的作业');
    if (mode === 'offline') notify('已模拟断网：发布将失败，批次预留与作业状态保留在本机');
    if (mode === 'drop-reserve') notify('已注入「预留响应丢失」：批次可能已在服务端预留，恢复后用对账核对');
    if (mode === 'drop-seal') notify('已注入「封存响应丢失」：服务端可能已封存，恢复后对账会提示补登');
  });

  const changeTtl = $((seconds: number) => {
    setTtl(seconds);
    sealTtl.value = seconds;
    notify(`新批次预留有效期调整为 ${seconds} 秒（已存在的批次不变）`);
  });

  useVisibleTask$(async () => {
    operator.value = localStorage.getItem(OPERATOR_KEY) || '研究员甲';
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const saved = JSON.parse(raw) as Partial<ArchiveState>;
        restore(JSON.stringify(saved));
      }
      const extra = localStorage.getItem(SEAL_EXTRA_KEY);
      if (extra) {
        const parsed = JSON.parse(extra) as { sealJobs?: SealJob[]; compensations?: CompensationTask[] };
        if (parsed.sealJobs) state.sealJobs = parsed.sealJobs;
        if (parsed.compensations) state.compensations = parsed.compensations;
      }
    } catch {
      localStorage.removeItem(STORAGE_KEY);
    }
    state.hydrated = true;
    refreshVault();
    const timer = window.setInterval(() => { tick.value += 1; refreshVault(); }, 1000);
    // eslint-disable-next-line qwik/no-use-visible-task
    return () => window.clearInterval(timer);
  });

  useVisibleTask$(({ track }) => {
    const payload = track(() => JSON.stringify({ revision: state.revision, records: state.records, matches: state.matches, merges: state.merges, audit: state.audit }));
    if (state.hydrated) localStorage.setItem(STORAGE_KEY, payload);
  });

  useVisibleTask$(({ track }) => {
    const payload = track(() => JSON.stringify({ sealJobs: state.sealJobs, compensations: state.compensations }));
    if (state.hydrated) localStorage.setItem(SEAL_EXTRA_KEY, payload);
  });

  useVisibleTask$(({ track }) => {
    const value = track(() => operator.value);
    if (value) localStorage.setItem(OPERATOR_KEY, value);
  });

  useVisibleTask$(({ cleanup }) => {
    const handler = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement;
      const editing = /INPUT|TEXTAREA|SELECT/.test(target.tagName) || target.isContentEditable;
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'z') {
        event.preventDefault();
        event.shiftKey ? redo() : undo();
        return;
      }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'y') { event.preventDefault(); redo(); return; }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'i') { event.preventDefault(); importOpen.value = true; return; }
      if (editing) return;
      const key = event.key.toLowerCase();
      if (key === 'j') { event.preventDefault(); moveReview(1); }
      if (key === 'k') { event.preventDefault(); moveReview(-1); }
      if (event.key === 'Enter' && activeMatch.value) { event.preventDefault(); openMerge(); }
      if (key === 'c' && activeMatch.value) { event.preventDefault(); updateMatch(activeMatch.value.id, 'confirmed'); }
      if (key === 'r' && activeMatch.value) { event.preventDefault(); updateMatch(activeMatch.value.id, 'rejected'); }
      if (key === '?' || (event.shiftKey && event.key === '/')) { event.preventDefault(); panelTab.value = 2; }
    };
    window.addEventListener('keydown', handler);
    cleanup(() => window.removeEventListener('keydown', handler));
  });

  const reconcileStatusLabel: Record<ReconcileRow['status'], string> = {
    'in-sync': '一致',
    'locally-ahead': '本机超前',
    'remote-ahead': '服务超前',
    'orphan-reserved-mine': '孤儿预留',
    'orphan-reserved-other': '他人预留',
    'orphan-sealed': '孤儿已封存'
  };

  return (
    <div class="app-shell">
      <header class="topbar">
        <div class="brand">
          <div class="brand-seal">档</div>
          <div><h1>档案元数据核对台</h1><p>ARCHIVE RECONCILIATION DESK</p></div>
        </div>
        <div class="top-stat"><span class={`online-dot ${vault.value && !vault.value.online ? 'offline' : ''}`} />{state.hydrated ? `离线保存 · r${state.revision}` : '正在恢复本地工作区'}</div>
        <div class="top-actions">
          <button class="icon-button" disabled={!history.value.length} onClick$={undo}>撤销</button>
          <button class="icon-button" disabled={!future.value.length} onClick$={redo}>重做</button>
          <button class="button ghost" onClick$={() => importOpen.value = true}>导入两组记录</button>
          <button class="button light" onClick$={exportAudit}>导出核对包</button>
        </div>
      </header>

      <div class="overview">
        <div><span class="eyebrow">RECONCILIATION PROJECT</span><h2>口述史与手稿元数据比对</h2><p>逐条确认可疑匹配，保留每个字段的来源选择，并留下可追溯的处理记录；核对完成后发布到封存服务归档。</p></div>
        <div class="metrics">
          <div><strong>{state.records.filter((record) => record.group === 'A').length}</strong><span>A 组记录</span></div>
          <div><strong>{state.records.filter((record) => record.group === 'B').length}</strong><span>B 组记录</span></div>
          <div><strong>{state.matches.filter((match) => match.status === 'suggested').length}</strong><span>待复核匹配</span></div>
          <div class="danger"><strong>{conflictCount.value}</strong><span>低分可疑项</span></div>
        </div>
      </div>

      <main class="desk-grid">
        <section class="panel match-panel">
          <div class="panel-heading">
            <div><span class="eyebrow">01 / MATCH QUEUE</span><h3>匹配核对队列</h3></div>
            <span class="shortcut-hint">J / K 移动 · Enter 合并</span>
          </div>
          <div class="toolbar-row">
            <select class="input" value={statusFilter.value} onChange$={(event) => { statusFilter.value = (event.target as HTMLSelectElement).value as typeof statusFilter.value; }}>
              <option value="all">全部匹配</option><option value="suggested">待复核</option><option value="confirmed">已确认</option><option value="rejected">已忽略</option>
            </select>
            <button class="button small" disabled={!selectedMatchIds.value.length} onClick$={() => bulkMatch('confirmed')}>批量确认</button>
            <button class="button small ghost" disabled={!selectedMatchIds.value.length} onClick$={() => bulkMatch('rejected')}>批量忽略</button>
          </div>
          <div class="match-list">
            {visibleMatches.value.map((match) => {
              const left = recordById(state, match.leftId);
              const right = recordById(state, match.rightId);
              const isActive = () => state.activeMatchId === match.id;
              return (
                <article
                  data-match-id={match.id}
                  class={`match-card ${isActive() ? 'active' : ''}`}
                  onClick$={() => { state.activeMatchId = match.id; }}
                  tabIndex={0}
                >
                  <div class="match-topline">
                    <Checkbox.Root
                      class="qwik-check"
                      aria-label={`选择匹配 ${match.id}`}
                      initialValue={selectedMatchIds.value.includes(match.id)}
                      onClick$={(event: Event) => {
                        event.stopPropagation();
                        selectedMatchIds.value = selectedMatchIds.value.includes(match.id)
                          ? selectedMatchIds.value.filter((id) => id !== match.id)
                          : [...selectedMatchIds.value, match.id];
                      }}
                    ><Checkbox.Indicator>✓</Checkbox.Indicator></Checkbox.Root>
                    <span class={`score ${match.score < .68 ? 'low' : ''}`}>{Math.round(match.score * 100)}%</span>
                    <span class={`status ${match.status}`}>{match.status === 'suggested' ? '待复核' : match.status === 'confirmed' ? '已确认' : match.status === 'rejected' ? '已忽略' : '已合并'}</span>
                    <span class="record-id">{left?.identifier}</span>
                  </div>
                  <div class="pair-preview">
                    <div><small>A · {left?.group}</small><strong>{left?.title}</strong><span>{parseDate(left?.date ?? '')} · {left?.people.join('、')}</span></div>
                    <i>↔</i>
                    <div><small>B · {right?.group}</small><strong>{right?.title}</strong><span>{parseDate(right?.date ?? '')} · {right?.people.join('、')}</span></div>
                  </div>
                  <div class="reason-line">{match.reasons.join(' · ')}</div>
                </article>
              );
            })}
            {!visibleMatches.value.length && <div class="empty-state">没有符合当前筛选条件的匹配。</div>}
          </div>
        </section>

        <section class="panel records-panel">
          <div class="panel-heading">
            <div><span class="eyebrow">02 / RECORD INDEX</span><h3>档案记录索引</h3></div>
            <span class="shortcut-hint">分页渲染 · 当前 {filteredRecords.value.length} 条</span>
          </div>
          <div class="toolbar-row">
            <input class="input search" placeholder="搜索标题、日期、人物、地点或编号" value={query.value} onInput$={(event) => { query.value = (event.target as HTMLInputElement).value; visibleCount.value = 80; }} />
            <select class="input compact" value={groupFilter.value} onChange$={(event) => { groupFilter.value = (event.target as HTMLSelectElement).value as typeof groupFilter.value; visibleCount.value = 80; }}>
              <option value="all">A + B</option><option value="A">A 组</option><option value="B">B 组</option>
            </select>
          </div>
          <div class="record-table">
            <div class="table-head"><span>来源</span><span>标题</span><span>日期 / 人物 / 地点</span><span>编号</span><span>状态</span></div>
            {filteredRecords.value.map((record) => (
              <div class="table-row" key={record.id}>
                <span class={`group-badge ${record.group.toLowerCase()}`}>{record.group}</span>
                <strong>{record.title}{sealedRefs.value.has(record.id) && <em class="sealed-tag" title="已在封存服务归档">封</em>}</strong>
                <span>{parseDate(record.date)}<small>{record.people.join('、')} · {record.places.join('、')}</small></span>
                <code>{record.identifier}</code>
                <span class={`record-status ${record.status}`}>{record.status === 'unreviewed' ? '未核对' : record.status === 'confirmed' ? '已确认' : record.status === 'rejected' ? '已忽略' : record.status === 'restored' ? '已恢复' : '已合并'}</span>
              </div>
            ))}
          </div>
          {filteredRecords.value.length >= visibleCount.value && <button class="load-more" onClick$={() => visibleCount.value += 80}>加载下 80 条记录</button>}
        </section>

        <section class="panel review-panel">
          <Tabs.Root bind:selectedIndex={panelTab} class="review-tabs">
            <Tabs.List class="tab-list"><Tabs.Tab>复核详情</Tabs.Tab><Tabs.Tab>合并追溯</Tabs.Tab><Tabs.Tab>键盘帮助</Tabs.Tab></Tabs.List>
            <Tabs.Panel class="tab-panel">
              {activeMatch.value && recordById(state, activeMatch.value.leftId) && recordById(state, activeMatch.value.rightId) ? (() => {
                const left = recordById(state, activeMatch.value!.leftId)!;
                const right = recordById(state, activeMatch.value!.rightId)!;
                return <>
                  <div class="active-score"><span>{Math.round(activeMatch.value!.score * 100)}</span><div><strong>综合匹配分</strong><small>{activeMatch.value!.reasons.join(' · ')}</small></div></div>
                  <div class="field-compare compact"><div class="field-label">字段</div><div>A 来源</div><div>B 来源</div>
                    {fieldLabels.map(([field, label]) => <><div class="field-label">{label}</div><div class={fieldValue(left, field) !== fieldValue(right, field) ? 'different' : ''}>{fieldValue(left, field) || '—'}</div><div class={fieldValue(left, field) !== fieldValue(right, field) ? 'different' : ''}>{fieldValue(right, field) || '—'}</div></>)}
                  </div>
                  <div class="action-stack"><button class="button primary wide" onClick$={openMerge}>逐字段合并</button><div class="split-actions"><button class="button confirm" onClick$={() => updateMatch(activeMatch.value!.id, 'confirmed')}>确认匹配</button><button class="button ghost" onClick$={() => updateMatch(activeMatch.value!.id, 'rejected')}>忽略</button></div></div>
                </>;
              })() : <div class="empty-state">从左侧选择一条匹配查看字段来源。</div>}
            </Tabs.Panel>
            <Tabs.Panel class="tab-panel">
              {state.merges.length ? state.merges.map((merge) => {
                const left = recordById(state, merge.leftId);
                const right = recordById(state, merge.rightId);
                const sealed = sealedRefs.value.has(merge.mergedRecordId);
                return <details class="merge-log" key={merge.id}><summary>
                  <span class={merge.withdrawn ? 'withdrawn-title' : ''}>{left?.title ?? merge.leftId} ↔ {right?.title ?? merge.rightId}</span>
                  {merge.withdrawn && <span class="withdraw-badge">已撤回</span>}
                  {sealed && !merge.withdrawn && <span class="sealed-badge">已封存</span>}
                </summary><p>{new Date(merge.mergedAt).toLocaleString('zh-CN')}</p><ul>{Object.entries(merge.chosen).map(([field, choice]) => <li key={field}><strong>{fieldLabels.find(([key]) => key === field)?.[1]}</strong><span>保留 {choice === 'A' ? 'A 来源' : choice === 'B' ? 'B 来源' : '双来源拼接'}：{merge.values[field as FieldKey]}</span></li>)}</ul>
                  {!merge.withdrawn && <button class="button small danger" onClick$={() => withdrawMerge(merge.id)}>{sealed ? '撤回合并（将生成补偿任务）' : '撤回合并'}</button>}
                  {merge.withdrawn && <p class="withdraw-note">已于 {merge.withdrawnAt ? new Date(merge.withdrawnAt).toLocaleString('zh-CN') : ''} 撤回；{sealed ? '补偿任务在下方封存面板确认' : '该合并不在封存服务中，无补偿'}</p>}
                </details>;
              }) : <div class="empty-state">还没有合并记录。完成一次字段合并后，来源选择会出现在这里。</div>}
            </Tabs.Panel>
            <Tabs.Panel class="tab-panel shortcut-panel">
              <div><kbd>J / K</kbd><span>下一条 / 上一条可疑匹配</span></div><div><kbd>Enter</kbd><span>打开逐字段合并窗口</span></div><div><kbd>C / R</kbd><span>确认 / 忽略当前匹配</span></div><div><kbd>Ctrl + Z / Y</kbd><span>撤销 / 重做</span></div><div><kbd>Ctrl + I</kbd><span>打开导入窗口</span></div>
            </Tabs.Panel>
          </Tabs.Root>
        </section>
      </main>

      {/* ============ 04 / 封存归档工作台 ============ */}
      <section class="seal-wrap">
        <div class="seal-title">
          <div><span class="eyebrow">04 / SEALING ARCHIVE</span><h3>核对结论封存归档</h3></div>
          <p>本机工作区管核对结论、字段选择与撤回记录；封存服务管对象摘要、发布批次与封存状态。发布先按摘要复用对象再预留批次，失败后恢复同一批次，重试不重复建档。</p>
        </div>
        <div class="seal-grid">
          {/* 发布作业 */}
          <article class="panel seal-panel">
            <div class="panel-heading"><div><span class="eyebrow">PUBLISH JOBS</span><h3>发布作业</h3></div>
              <div class="operator-box">操作员
                <select class="input compact" value={operator.value} onChange$={(event) => { operator.value = (event.target as HTMLSelectElement).value; }}>
                  <option value="研究员甲">研究员甲</option><option value="研究员乙">研究员乙</option>
                </select>
              </div>
            </div>
            <div class="toolbar-row wrap">
              <button class="button primary small" disabled={!publishableRecords.value.length || !vault.value?.online} onClick$={publishSelected}>发布 {publishableRecords.value.length} 条已核对记录</button>
              <button class="button small ghost" onClick$={openReconcile}>发布对账{staleCount.value ? <strong class="alert-dot">·{staleCount.value}</strong> : null}</button>
            </div>
            <div class="seal-list">
              {state.sealJobs.length ? state.sealJobs.map((job) => (
                <div class={`job-row phase-${job.phase}`} key={job.id}>
                  <div class="job-head">
                    <span class={`job-phase ${job.phase}`}>{phaseLabel(job.phase)}</span>
                    <span class="job-kind">{job.kind === 'compensation' ? '补偿批次' : '发布批次'}</span>
                    <code class="job-batch">{job.batchId ?? '批次未确认'}</code>
                    {job.phase !== 'sealed' && job.reservedUntil && countdown(job.reservedUntil) && <span class={`ttl ${countdown(job.reservedUntil) === '已过期' ? 'expired' : ''}`}>{countdown(job.reservedUntil)}</span>}
                  </div>
                  <div class="job-meta">{job.items.length} 条引用 · {job.operator} · 尝试 {job.attempts} 次</div>
                  <div class="job-items">{job.items.slice(0, 3).map((item) => <span key={item.refId}>{item.title}<code>{shortDigest(item.digest)}</code></span>)}{job.items.length > 3 && <span class="more-items">+{job.items.length - 3}</span>}</div>
                  {job.lastError && <div class="job-error">{job.lastError}</div>}
                  {job.phase !== 'sealed' && <div class="job-actions">
                    <button class="button small confirm" disabled={!vault.value?.online} onClick$={() => runPublish(job.id)}>恢复同一批次并重试</button>
                    <button class="button small ghost" onClick$={openReconcile}>对账</button>
                  </div>}
                </div>
              )) : <div class="empty-state">还没有发布作业。完成核对（确认匹配或合并）后在此发布。</div>}
            </div>
          </article>

          {/* 撤回与补偿 */}
          <article class="panel seal-panel">
            <div class="panel-heading"><div><span class="eyebrow">WITHDRAW &amp; COMPENSATION</span><h3>撤回合并与补偿</h3></div><span>{state.compensations.filter((task) => task.status === 'pending').length} 项待确认</span></div>
            <div class="seal-list">
              {state.compensations.length ? state.compensations.map((task) => (
                <div class={`comp-row status-${task.status}`} key={task.id}>
                  <div class="job-head"><span class={`comp-status ${task.status}`}>{task.status === 'pending' ? '待确认' : task.status === 'submitting' ? '提交中' : task.status === 'done' ? '已补偿' : '已暂缓'}</span><code>{task.batchId ?? '补偿批次待预留'}</code></div>
                  <p class="comp-reason">{task.reason}</p>
                  <details class="comp-detail"><summary>受影响记录 · 引用对象 · 封存版本（{task.affected.length}）</summary>
                    <ul>{task.affected.map((row) => <li key={row.recordId}><span class={`role-tag ${row.role}`}>{row.role === 'merged' ? '合并结果' : '恢复来源'}</span>{row.title}<code>{row.sealedVersion ?? '—'}</code>{row.objectId && <code>{row.objectId}</code>}</li>)}</ul>
                    <div class="version-flow"><span>旧版本 <code>{task.previousVersion ?? '—'}</code></span><i>→</i><span>新版本 <code>{task.newVersion ?? '待生成'}</code>{!task.newVersion && <small>确认后生成，旧版本保留</small>}</span></div>
                  </details>
                  {task.status === 'pending' && <div class="job-actions"><button class="button small primary" disabled={!vault.value?.online} onClick$={() => confirmCompensation(task.id)}>确认并发布新版本</button><button class="button small ghost" onClick$={() => dismissCompensation(task.id)}>暂缓</button></div>}
                </div>
              )) : <div class="empty-state">撤回一个<b>已封存</b>的合并后，这里会列出受影响记录、引用对象和封存版本；确认后生成新版本并保留旧版本。</div>}
            </div>
          </article>

          {/* 封存服务 */}
          <article class="panel seal-panel vault-panel">
            <div class="panel-heading"><div><span class="eyebrow">SEALING SERVICE</span><h3>封存服务</h3></div>
              <span class={`service-state ${vault.value?.online ? 'up' : 'down'}`}>{vault.value?.online ? '在线' : '断网'}</span>
            </div>
            <div class="vault-controls">
              <label>故障注入
                <select class="input" value={sealFault.value} onChange$={(event) => changeFault((event.target as HTMLSelectElement).value as FaultMode)}>
                  <option value="none">网络正常</option>
                  <option value="offline">断网</option>
                  <option value="drop-reserve">预留响应丢失</option>
                  <option value="drop-seal">封存响应丢失</option>
                </select>
              </label>
              <label>预留 TTL
                <select class="input" value={String(sealTtl.value)} onChange$={(event) => changeTtl(Number((event.target as HTMLSelectElement).value))}>
                  <option value="10">10 秒</option><option value="15">15 秒</option><option value="30">30 秒</option><option value="60">60 秒</option>
                </select>
              </label>
              <button class="button small ghost danger-ghost" onClick$={resetService}>清空服务数据</button>
            </div>
            <div class="vault-stats">
              <div><strong>{vault.value?.objects.length ?? 0}</strong><span>封存对象</span></div>
              <div><strong>{vault.value?.versions.length ?? 0}</strong><span>版本</span></div>
              <div><strong>{vault.value?.batches.filter((batch) => batch.status === 'sealed').length ?? 0}</strong><span>已封存批次</span></div>
              <div><strong>{vault.value?.batches.filter((batch) => batch.status === 'reserved').length ?? 0}</strong><span>预留中</span></div>
            </div>
            <Tabs.Root bind:selectedIndex={compensationsTab} class="vault-tabs">
              <Tabs.List class="tab-list"><Tabs.Tab>批次</Tabs.Tab><Tabs.Tab>版本链</Tabs.Tab><Tabs.Tab>服务履历</Tabs.Tab></Tabs.List>
              <Tabs.Panel class="tab-panel vault-list">
                {(vault.value?.batches ?? []).map((batch) => {
                  const remaining = countdown(batch.status === 'reserved' ? batch.reservedUntil : undefined);
                  return <details class="vault-batch" key={batch.batchId}>
                    <summary><span class={`job-phase ${batch.status === 'sealed' ? 'sealed' : 'reserved'}`}>{batch.status === 'sealed' ? '已封存' : '预留'}</span><code>{batch.batchId}</code><span class="vault-operator">{batch.operator}{batch.kind === 'compensation' && <em class="kind-comp">补偿</em>}</span>{remaining && <span class={`ttl ${remaining === '已过期' ? 'expired' : ''}`}>{remaining}</span>}</summary>
                    <ul>{(batch.sealedItems ?? batch.items).map((item) => <li key={`${batch.batchId}-${item.refId}`}>{item.title}<code>{(item as { versionId?: string }).versionId ?? shortDigest(item.digest)}</code>{'reused' in item && (item as { reused: boolean }).reused && <em class="reuse-tag">复用</em>}</li>)}</ul>
                    <div class="batch-history">{batch.history.map((entry, index) => <small key={index}>[{formatTime(entry.at)}] {entry.event} · {entry.detail}</small>)}</div>
                    {batch.status === 'reserved' && remaining === '已过期' && batch.operator !== operator.value && <button class="button small" onClick$={() => takeover(batch.batchId)}>接管该过期预留</button>}
                  </details>;
                })}
                {!(vault.value?.batches.length) && <div class="empty-state">封存服务中还没有批次。</div>}
              </Tabs.Panel>
              <Tabs.Panel class="tab-panel vault-list">
                {(vault.value?.versions ?? []).map((version) => <div class="version-row" key={version.versionId}>
                  <code>{version.versionId}</code>
                  <span class="version-ref">{version.refId.slice(0, 8)}…</span>
                  <code class="version-obj">{version.objectId}</code>
                  {version.supersededBy && <em class="superseded">已被 {version.supersededBy} 取代（保留）</em>}
                  {version.compensationFor && <em class="kind-comp">补偿</em>}
                </div>)}
                {!(vault.value?.versions.length) && <div class="empty-state">封存服务中还没有版本。</div>}
              </Tabs.Panel>
              <Tabs.Panel class="tab-panel vault-list">
                {(vault.value?.events ?? []).map((event) => <div class="ledger-row" key={event.id}><time>{formatTime(event.at)}</time><strong>{event.type}</strong><span>{event.detail}</span></div>)}
                {!(vault.value?.events.length) && <div class="empty-state">服务履历为空。</div>}
              </Tabs.Panel>
            </Tabs.Root>
          </article>
        </div>
      </section>

      <section class="bottom-grid">
        <article class="panel audit-panel">
          <div class="panel-heading"><div><span class="eyebrow">03 / TRACE</span><h3>最新处理记录</h3></div><span>{state.audit.length} 条</span></div>
          <div class="audit-list">
            {state.audit.slice(0, 8).map((entry) => <div class="audit-entry" key={entry.id}><time>{new Date(entry.at).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}</time><div><strong>{entry.action}</strong><p>{entry.detail}</p></div><span>{entry.recordIds.length ? `${entry.recordIds.length} 条记录` : '系统'}</span></div>)}
          </div>
        </article>
        <article class="panel explanation-panel">
          <div class="panel-heading"><div><span class="eyebrow">METHOD</span><h3>核对与封存保护规则</h3></div></div>
          <p>核对阶段按标题、日期、人物、地点和编号加权评分；封存阶段以对象摘要和批次预留保证断网、重复提交、双人并发下两侧仍可对齐。</p>
          <div class="rule-row"><span>1</span><p>发布先按对象摘要复用对象、再预留批次；发布失败恢复同一批次，重试不重复建档。</p></div>
          <div class="rule-row"><span>2</span><p>撤回已封存的合并生成补偿任务，列明受影响记录、引用对象与封存版本；确认后发布新版本并保留旧版本。</p></div>
          <div class="rule-row"><span>3</span><p>两人同时发布以批次预留定归属；过期预留可接管并留履历；发布对账发现响应丢失可补登对齐。</p></div>
        </article>
      </section>

      {toast.value && <div class="toast">{toast.value}</div>}

      <Modal.Root bind:show={reconcileOpen} closeOnBackdropClick>
        <Modal.Panel class="modal-panel reconcile-modal">
          <Modal.Header class="modal-header"><div><span class="eyebrow">RECONCILE</span><Modal.Title>发布对账</Modal.Title></div><Modal.Close class="modal-close">×</Modal.Close></Modal.Header>
          <Modal.Description class="modal-description">逐行比対本机作业与封存服务批次：本机超前可恢复同一批次；服务超前（封存响应丢失）可补登；他人过期预留可接管。</Modal.Description>
          <div class="reconcile-list">
            {reconcileRows.value.length ? reconcileRows.value.map((row) => (
              <div class={`reconcile-row rec-${row.status}`} key={row.key}>
                <div class="rec-main"><span class={`rec-badge ${row.status}`}>{reconcileStatusLabel[row.status]}</span><div><strong>{row.batchId ?? row.jobId?.slice(0, 8)}</strong><p>{row.detail}</p><small>{row.kind === 'compensation' ? '补偿批次' : '发布批次'}{row.operator ? ` · ${row.operator}` : ''}</small></div></div>
                <div class="rec-actions">
                  {row.action === 'retry' && row.jobId && <button class="button small confirm" onClick$={() => { reconcileOpen.value = false; const job = state.sealJobs.find((item) => item.id === row.jobId); if (job) runPublish(job.id); }}>恢复并重试</button>}
                  {row.action === 'takeover' && row.batchId && <button class="button small primary" onClick$={() => takeover(row.batchId!)}>接管预留</button>}
                  {row.action === 'adopt' && row.batchId && <button class="button small light" onClick$={() => adoptBatch(row.batchId!)}>补登对齐</button>}
                  {row.action === 'none' && <span class="rec-ok">无需处理</span>}
                </div>
              </div>
            )) : <div class="empty-state">两侧完全一致，没有差异。</div>}
          </div>
          <Modal.Footer class="modal-footer"><button class="button ghost" onClick$={openReconcile}>重新比对</button><Modal.Close class="button primary">完成</Modal.Close></Modal.Footer>
        </Modal.Panel>
      </Modal.Root>

      <Modal.Root bind:show={importOpen} closeOnBackdropClick>
        <Modal.Panel class="modal-panel import-modal">
          <Modal.Header class="modal-header"><div><span class="eyebrow">IMPORT</span><Modal.Title>导入一组档案记录</Modal.Title></div><Modal.Close class="modal-close">×</Modal.Close></Modal.Header>
          <Modal.Description class="modal-description">支持 JSON 数组或制表符 / 竖线分隔文本。字段顺序：标题、日期、人物、地点、编号、载体、数量、权利、备注。</Modal.Description>
          <div class="import-controls">
            <label class="radio-card"><input type="radio" checked={importGroup.value === 'A'} onChange$={() => importGroup.value = 'A'} /><span><strong>A 组</strong><small>口述史 / 主要记录</small></span></label>
            <label class="radio-card"><input type="radio" checked={importGroup.value === 'B'} onChange$={() => importGroup.value = 'B'} /><span><strong>B 组</strong><small>手稿 / 待合并记录</small></span></label>
            <label class="file-button">选择文件<input type="file" accept=".json,.txt,.csv,.tsv" onChange$={(event, element) => importFile(event, element)} /></label>
          </div>
          <textarea class="modal-textarea" value={importRaw.value} onInput$={(event) => importRaw.value = (event.target as HTMLTextAreaElement).value} placeholder="李秀珍口述史访谈 | 2019-04-12 | 李秀珍、周明远 | 临河县 | OH-LXZ-2019-01 | 数字录音 | 02:14:38 | 研究者授权 | ..." />
          {importText.value && <div class="file-name">已读取：{importText.value}</div>}
          <Modal.Footer class="modal-footer"><Modal.Close class="button ghost">取消</Modal.Close><button class="button primary" disabled={!importRaw.value.trim()} onClick$={parseImport}>导入并重新匹配</button></Modal.Footer>
        </Modal.Panel>
      </Modal.Root>

      <Modal.Root bind:show={mergeOpen} closeOnBackdropClick>
        <Modal.Panel class="modal-panel merge-modal">
          <Modal.Header class="modal-header"><div><span class="eyebrow">FIELD MERGE</span><Modal.Title>逐字段选择保留来源</Modal.Title></div><Modal.Close class="modal-close">×</Modal.Close></Modal.Header>
          {activeMatch.value && recordById(state, activeMatch.value.leftId) && recordById(state, activeMatch.value.rightId) && (() => {
            const left = recordById(state, activeMatch.value!.leftId)!;
            const right = recordById(state, activeMatch.value!.rightId)!;
            return <>
              <Modal.Description class="modal-description">每个字段都显示两条记录的原始来源。选择后，生成一条新合并记录，原记录编号与选择依据仍保留在审计轨迹中。</Modal.Description>
              <div class="field-picker-head"><span>字段</span><span>A 组来源</span><span>B 组来源</span></div>
              <div class="field-picker">
                {fieldLabels.map(([field, label]) => {
                  const leftValue = fieldValue(left, field) || '—';
                  const rightValue = fieldValue(right, field) || '—';
                  const same = leftValue === rightValue;
                  return <div class={`field-picker-row ${same ? 'same' : 'conflict'}`} key={field}><div class="picker-label"><strong>{label}</strong>{same ? <small>一致</small> : <small>冲突</small>}</div><label class={`source-option ${choices[field] === 'A' ? 'selected' : ''}`}><input type="radio" name={`field-${field}`} checked={choices[field] === 'A'} onChange$={() => choices[field] = 'A'} /><span><b>A</b>{leftValue}</span></label><label class={`source-option ${choices[field] === 'B' ? 'selected' : ''}`}><input type="radio" name={`field-${field}`} checked={choices[field] === 'B'} onChange$={() => choices[field] = 'B'} /><span><b>B</b>{rightValue}</span></label><button class={`combine-button ${choices[field] === 'combine' ? 'selected' : ''}`} onClick$={() => choices[field] = 'combine'} title="拼接两侧内容">拼接</button></div>;
                })}
              </div>
              <Modal.Footer class="modal-footer"><Modal.Close class="button ghost">取消</Modal.Close><button class="button primary" onClick$={mergeCurrent}>生成合并记录</button></Modal.Footer>
            </>;
          })()}
        </Modal.Panel>
      </Modal.Root>
    </div>
  );
});
