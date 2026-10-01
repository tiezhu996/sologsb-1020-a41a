import {
  $, component$, useComputed$, useSignal, useStore, useVisibleTask$
} from '@builder.io/qwik';
import { Checkbox, Modal, Tabs } from '@qwik-ui/headless';
import type { ArchiveRecord, ArchiveState, FieldKey, MatchCandidate, RecordGroup, PublishJob } from './types';
import { computeMatches, fieldValue, scorePair } from './utils/matching';
import { seedState } from './data/seed';
import { SealingService } from './services/sealingService';
import {
  audit,
  confirmCompensation,
  createMergeJob,
  discardCompensation,
  findMergeJob,
  reconcileJob,
  runPublish,
  takeoverReservation,
  withdrawMerge
} from './services/publish';

const STORAGE_KEY = 'sologsb-1020-archive-state-v1';
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

const stageMeta: Record<PublishJob['stage'], { label: string; hint: string }> = {
  queued: { label: '本机待发', hint: '结论保存在本机工作区，尚未联系封存服务' },
  'object-reused': { label: '对象已定位', hint: '已按对象摘要复用或登记对象，等待预留批次' },
  reserved: { label: '批次已预留', hint: '批次归属本机，恢复后可直接封存' },
  sealed: { label: '已封存', hint: '封存服务已写入新版本' },
  failed: { label: '发布失败', hint: '同一批次已保留，重试不会重复建档' },
  conflict: { label: '预留冲突', hint: '批次被他人预留，可对账或等过期后接管' }
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
  const importGroup = useSignal<RecordGroup>('A');
  const importRaw = useSignal('');
  const importText = useSignal('');
  const toast = useSignal('');
  const panelTab = useSignal(0);
  const sealingOnline = useSignal(true);
  const serviceTick = useSignal(0);
  const archiveTab = useSignal(0);
  const withdrawOpen = useSignal(false);
  const withdrawMergeId = useSignal('');
  const withdrawReason = useSignal('');
  const compensateTaskId = useSignal('');
  const compensateReason = useSignal('');

  const getService = () => new SealingService();
  const refreshService = $(() => {
    const service = getService();
    sealingOnline.value = service.online;
    serviceTick.value += 1;
  });

  const snapshot = () => JSON.stringify({
    revision: state.revision,
    records: state.records,
    matches: state.matches,
    merges: state.merges,
    audit: state.audit
  });

  const capture = () => {
    // 撤销栈只覆盖核对结论与字段选择；发布任务/补偿任务以封存服务为准，不随撤销回滚
    history.value = [...history.value.slice(-49), JSON.stringify({
      revision: state.revision,
      records: state.records,
      matches: state.matches,
      merges: state.merges,
      audit: state.audit
    })];
    future.value = [];
  };

  const restore = (raw: string) => {
    const next = JSON.parse(raw) as Partial<ArchiveState>;
    state.revision = next.revision ?? state.revision;
    state.records = next.records ?? state.records;
    state.matches = next.matches ?? state.matches;
    state.merges = next.merges ?? state.merges;
    state.audit = next.audit ?? state.audit;
    if (next.jobs) state.jobs = next.jobs;
    if (next.compensations) state.compensations = next.compensations;
    if (next.workstationId) state.workstationId = next.workstationId;
  };

  const notify = (message: string) => {
    toast.value = message;
    window.setTimeout(() => { if (toast.value === message) toast.value = ''; }, 2800);
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
    if (!match) return;
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
    const merged: ArchiveRecord = {
      ...left,
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
      chosen: { ...choices },
      values,
      mergedAt: new Date().toISOString(),
      sourceRecords: [structuredClone(left), structuredClone(right)]
    });
    commit('合并两条记录', `保留 ${Object.values(choices).filter((choice) => choice === 'A').length} 个 A 来源字段、${Object.values(choices).filter((choice) => choice === 'B').length} 个 B 来源字段`, [left.id, right.id, merged.id]);
    mergeOpen.value = false;
    notify('记录已合并，来源与字段选择已写入审计记录');
  });

  /* ===================== 封存归档动作 ===================== */

  const serviceObjects = useComputed$(() => {
    serviceTick.value;
    return getService().state.objects;
  });
  const serviceBatches = useComputed$(() => {
    serviceTick.value;
    return getService().state.batches;
  });
  const serviceLedger = useComputed$(() => {
    serviceTick.value;
    return getService().state.ledger;
  });
  const pendingCompensations = useComputed$(() => state.compensations.filter((task) => task.status === 'pending'));

  const publishMerge = $((mergeId: string) => {
    try {
      const job = createMergeJob(state, mergeId, state.workstationId);
      const outcome = runPublish(state, getService(), job.id).outcome;
      refreshService();
      notify(outcome === 'sealed' ? '已按对象摘要复用对象并封存'
        : outcome === 'queued' ? '断网：结论暂存本机，联网后可重试'
        : outcome === 'conflict' ? '批次已被他人预留，请发布对账'
        : '发布未完成，可恢复同一批次重试');
    } catch (error) {
      notify(error instanceof Error ? error.message : '发布失败');
    }
  });

  const retryJob = $((jobId: string) => {
    const outcome = runPublish(state, getService(), jobId).outcome;
    refreshService();
    notify(outcome === 'sealed' ? '已恢复同一批次并封存，未重复建档'
      : outcome === 'queued' ? '仍不可达，结论继续保留在本机'
      : outcome === 'conflict' ? '批次仍被他人预留'
      : '批次已恢复，请继续重试');
  });

  const toggleSealingOnline = $(() => {
    const service = getService();
    service.setOnline(!service.online);
    sealingOnline.value = service.online;
    notify(service.online ? '封存服务已恢复连通' : '已模拟断网：发布将停在本机或失败步骤');
  });

  /** 模拟另一工位抢先预留同一对象（两人同时发布） */
  const simulateRival = $((jobId: string) => {
    const job = state.jobs.find((item) => item.id === jobId);
    if (!job) return;
    const service = getService();
    if (!service.online) { notify('封存服务离线，无法模拟并发预留'); return; }
    const resolved = service.resolveObject(job.digest, job.payload.kind, job.conclusionKey, '工位-乙');
    service.reserveBatch(resolved.object, job.digest, '工位-乙', crypto.randomUUID());
    refreshService();
    notify('工位-乙 已抢先预留同一对象的批次，再试发布即触发冲突');
  });

  const doReconcile = $((jobId: string) => {
    try {
      reconcileJob(state, getService(), jobId);
      refreshService();
      notify('发布对账完成，本机状态已与封存服务对齐');
    } catch (error) {
      notify(error instanceof Error ? error.message : '对账失败');
    }
  });

  const doTakeover = $((jobId: string) => {
    const result = takeoverReservation(state, getService(), jobId);
    refreshService();
    if (result.outcome === 'reserved') {
      runPublish(state, getService(), jobId);
      refreshService();
      notify('已接管过期预留并完成封存，交接记录留在封存服务');
    } else {
      notify('原预留尚未过期，暂不能接管');
    }
  });

  const openWithdraw = $((mergeId: string) => {
    withdrawMergeId.value = mergeId;
    withdrawReason.value = '';
    withdrawOpen.value = true;
  });

  const confirmWithdraw = $(() => {
    try {
      withdrawMerge(state, withdrawMergeId.value, withdrawReason.value || '核对后撤回');
      withdrawOpen.value = false;
      notify(pendingCompensations.value.length ? '已生成补偿任务：列出受影响记录、引用对象与封存版本' : '已在本机撤回（该合并尚未封存，无需补偿）');
    } catch (error) {
      notify(error instanceof Error ? error.message : '撤回失败');
    }
  });

  const openCompensate = $((taskId: string) => {
    compensateTaskId.value = taskId;
    compensateReason.value = '';
  });

  const confirmCompensateNow = $(() => {
    try {
      confirmCompensation(state, getService(), compensateTaskId.value, compensateReason.value || '撤回合并后重新核对');
      compensateTaskId.value = '';
      refreshService();
      notify('补偿已发布：同一对象生成新版本，旧版本保留');
    } catch (error) {
      notify(error instanceof Error ? error.message : '补偿失败');
    }
  });

  const discardCompensate = $((taskId: string) => {
    discardCompensation(state, taskId);
    notify('补偿任务已放弃，封存版本维持不变');
  });

  const toggleFailSeal = $((jobId: string) => {
    const job = state.jobs.find((item) => item.id === jobId);
    if (!job) return;
    job.failSealOnce = !job.failSealOnce;
    notify(job.failSealOnce ? '下一次封存在服务端写入失败（批次仍保留）' : '已取消封存失败模拟');
  });

  const resetSealing = $(() => {
    getService().reset();
    refreshService();
    notify('封存服务已重置（本机工作区结论保留，可重新发布）');
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
    const blob = new Blob([JSON.stringify({ exportedAt: new Date().toISOString(), records: state.records, matches: state.matches, merges: state.merges, audit: state.audit }, null, 2)], { type: 'application/json' });
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

  useVisibleTask$(() => {
    sealingOnline.value = getService().online;
    const timer = window.setInterval(() => refreshService(), 4000);
    return () => window.clearInterval(timer);
  });

  useVisibleTask$(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const saved = JSON.parse(raw) as Partial<ArchiveState>;
        restore(JSON.stringify(saved));
      }
    } catch {
      localStorage.removeItem(STORAGE_KEY);
    }
    state.hydrated = true;
  });

  useVisibleTask$(({ track }) => {
    const payload = track(() => JSON.stringify({
      revision: state.revision,
      records: state.records,
      matches: state.matches,
      merges: state.merges,
      audit: state.audit,
      jobs: state.jobs,
      compensations: state.compensations,
      workstationId: state.workstationId
    }));
    if (state.hydrated) localStorage.setItem(STORAGE_KEY, payload);
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

  return (
    <div class="app-shell">
      <header class="topbar">
        <div class="brand">
          <div class="brand-seal">档</div>
          <div><h1>档案元数据核对台</h1><p>ARCHIVE RECONCILIATION DESK</p></div>
        </div>
        <div class="top-stat"><span class={`online-dot ${sealingOnline.value ? '' : 'offline'}`} />{state.hydrated ? `${sealingOnline.value ? '封存服务在线' : '封存服务离线'} · 本机 r${state.revision}` : '正在恢复本地工作区'}</div>
        <div class="top-actions">
          <button class="icon-button" disabled={!history.value.length} onClick$={undo}>撤销</button>
          <button class="icon-button" disabled={!future.value.length} onClick$={redo}>重做</button>
          <button class="button ghost" onClick$={() => importOpen.value = true}>导入两组记录</button>
          <button class="button light" onClick$={exportAudit}>导出核对包</button>
        </div>
      </header>

      <div class="overview">
        <div><span class="eyebrow">RECONCILIATION PROJECT</span><h2>口述史与手稿元数据比对</h2><p>逐条确认可疑匹配，保留每个字段的来源选择，并留下可追溯的处理记录。</p></div>
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
                <strong>{record.title}</strong>
                <span>{parseDate(record.date)}<small>{record.people.join('、')} · {record.places.join('、')}</small></span>
                <code>{record.identifier}</code>
                <span class={`record-status ${record.status}`}>{record.status === 'unreviewed' ? '未核对' : record.status === 'confirmed' ? '已确认' : record.status === 'rejected' ? '已忽略' : '已合并'}</span>
              </div>
            ))}
          </div>
          {filteredRecords.value.length >= visibleCount.value && <button class="load-more" onClick$={() => visibleCount.value += 80}>加载下 80 条记录</button>}
        </section>

        <section class="panel review-panel">
          <Tabs.Root bind:selectedIndex={panelTab} class="review-tabs">
            <Tabs.List class="tab-list"><Tabs.Tab>复核详情</Tabs.Tab><Tabs.Tab>合并追溯</Tabs.Tab><Tabs.Tab>键盘帮助</Tabs.Tab></Tabs.List>
            <Tabs.Panel class="tab-panel">
              {activeMatch.value ? (() => {
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
                const job = findMergeJob(state, merge.id);
                return <details class="merge-log" key={merge.id} open={!!merge.withdrawnAt}><summary>{left?.title ?? merge.leftId} ↔ {right?.title ?? merge.rightId}{merge.withdrawnAt && <span class="withdrawn-tag">已撤回</span>}</summary><p>{new Date(merge.mergedAt).toLocaleString('zh-CN')}</p><ul>{Object.entries(merge.chosen).map(([field, choice]) => <li key={field}><strong>{fieldLabels.find(([key]) => key === field)?.[1]}</strong><span>保留 {choice === 'A' ? 'A 来源' : choice === 'B' ? 'B 来源' : '双来源拼接'}：{merge.values[field as FieldKey]}</span></li>)}</ul>
                  {merge.withdrawnAt
                    ? <p class="withdrawn-note">已于 {new Date(merge.withdrawnAt).toLocaleString('zh-CN')} 撤回，原两条记录已恢复，字段选择与撤销记录保留。</p>
                    : <div class="merge-actions"><button class="button primary small" onClick$={() => publishMerge(merge.id)}>{job ? '重新发布此结论' : '发布到封存服务'}</button><button class="button ghost small" onClick$={() => openWithdraw(merge.id)}>撤回合并</button>{job && <span class={`job-chip ${job.stage}`}>{stageMeta[job.stage].label}{job.version ? ` · v${job.version}` : ''}</span>}</div>}
                </details>;
              }) : <div class="empty-state">还没有合并记录。完成一次字段合并后，来源选择会出现在这里。</div>}
            </Tabs.Panel>
            <Tabs.Panel class="tab-panel shortcut-panel">
              <div><kbd>J / K</kbd><span>下一条 / 上一条可疑匹配</span></div><div><kbd>Enter</kbd><span>打开逐字段合并窗口</span></div><div><kbd>C / R</kbd><span>确认 / 忽略当前匹配</span></div><div><kbd>Ctrl + Z / Y</kbd><span>撤销 / 重做</span></div><div><kbd>Ctrl + I</kbd><span>打开导入窗口</span></div><div><kbd>Ctrl/⌘ + Enter</kbd><span>在导入框中提交记录</span></div>
            </Tabs.Panel>
          </Tabs.Root>
        </section>
      </main>

      <section class="bottom-grid">
        <article class="panel audit-panel">
          <div class="panel-heading"><div><span class="eyebrow">03 / TRACE</span><h3>最新处理记录</h3></div><span>{state.audit.length} 条</span></div>
          <div class="audit-list">
            {state.audit.slice(0, 8).map((entry) => <div class="audit-entry" key={entry.id}><time>{new Date(entry.at).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}</time><div><strong>{entry.action}</strong><p>{entry.detail}</p></div><span>{entry.recordIds.length ? `${entry.recordIds.length} 条记录` : '系统'}</span></div>)}
          </div>
        </article>
        <article class="panel explanation-panel">
          <div class="panel-heading"><div><span class="eyebrow">METHOD</span><h3>匹配与保护规则</h3></div></div>
          <p>标题、日期、人物、地点和编号按权重综合评分。低于 68% 的候选会以红色标记，但系统不会替研究者自动决定。</p>
          <div class="rule-row"><span>1</span><p>每个字段保留 A / B 来源，可在合并窗口中单独选择或拼接。</p></div>
          <div class="rule-row"><span>2</span><p>原始记录、合并结果和忽略理由都进入本地审计轨迹。</p></div>
          <div class="rule-row"><span>3</span><p>记录列表使用分批窗口渲染，导入大量数据时仍只挂载当前窗口。</p></div>
        </article>
      </section>

      <section class="archive-section">
        <div class="archive-head">
          <div><span class="eyebrow">04 / SEALING ARCHIVE</span><h2>封存归档</h2><p>本机工作区管核对结论、字段选择和撤销记录；封存服务管对象摘要、发布批次和封存状态。</p></div>
          <div class="archive-controls">
            <span class="workstation-badge">{state.workstationId}</span>
            <button class={`button small ${sealingOnline.value ? 'confirm' : 'danger'}`} onClick$={toggleSealingOnline}>{sealingOnline.value ? '● 服务在线（点击模拟断网）' : '○ 服务离线（点击恢复）'}</button>
            <button class="button small ghost" onClick$={resetSealing}>重置封存服务</button>
          </div>
        </div>
        <div class="archive-grid">
          <article class="panel publish-panel">
            <div class="panel-heading"><div><span class="eyebrow">PUBLISH JOBS</span><h3>发布队列（本机工作区）</h3></div><span>{state.jobs.length} 个任务</span></div>
            <div class="job-list">
              {state.jobs.map((job) => (
                <div class={`job-card ${job.stage}`} key={job.id}>
                  <div class="job-head">
                    <strong>{job.title}</strong>
                    <span class={`job-stage ${job.stage}`}>{stageMeta[job.stage].label}{job.version ? ` · v${job.version}` : ''}</span>
                  </div>
                  <p class="job-hint">{job.lastError ?? stageMeta[job.stage].hint}</p>
                  <div class="job-meta">
                    <span>对象 <code>{job.objectId ?? '—'}</code></span>
                    <span>批次 <code>{job.batchId ?? '—'}</code></span>
                    <span>摘要 <code>{job.digest.slice(6, 16)}</code></span>
                    <span>尝试 {job.attempts} 次</span>
                    {job.reservedUntil && <span>预留至 {new Date(job.reservedUntil).toLocaleTimeString('zh-CN', { hour12: false })}</span>}
                  </div>
                  <div class="job-actions">
                    {job.stage !== 'sealed' && <button class="button primary small" onClick$={() => retryJob(job.id)}>恢复同一批次重试</button>}
                    {job.stage === 'conflict' && <button class="button small confirm" onClick$={() => doTakeover(job.id)}>接管过期预留</button>}
                    {(job.stage === 'conflict' || job.stage === 'reserved' || job.stage === 'sealed') && <button class="button small ghost" onClick$={() => doReconcile(job.id)}>发布对账</button>}
                    {job.stage !== 'sealed' && <button class="button small ghost" onClick$={() => simulateRival(job.id)} title="模拟两人同时发布">模拟工位-乙抢预留</button>}
                    {job.stage !== 'sealed' && <label class="fail-toggle"><input type="checkbox" checked={job.failSealOnce} onChange$={() => toggleFailSeal(job.id)} />下次封存失败</label>}
                  </div>
                </div>
              ))}
              {!state.jobs.length && <div class="empty-state">还没有发布任务。在「合并追溯」里把已合并的结论发布到封存服务。</div>}
            </div>

            <div class="compensation-block">
              <div class="comp-head"><span class="eyebrow">COMPENSATION</span><strong>撤回合并补偿任务</strong><span>{pendingCompensations.value.length} 待确认</span></div>
              {state.compensations.map((task) => (
                <div class={`comp-card ${task.status}`} key={task.id}>
                  <div class="job-head"><strong>合并 {task.mergeId.slice(-8)} 的补偿</strong><span class={`job-stage ${task.status === 'sealed' ? 'sealed' : task.status === 'pending' ? 'reserved' : 'rejected'}`}>{task.status === 'pending' ? '待确认' : task.status === 'submitted' ? '已提交' : task.status === 'sealed' ? `已封存 v${task.newVersion}` : '已放弃'}</span></div>
                  <ul class="comp-detail">
                    <li>受影响记录：{task.affectedRecordIds.map((id) => <code key={id}>{id.slice(0, 10)}</code>)}</li>
                    <li>引用对象：{task.referencedObjectIds.length ? task.referencedObjectIds.map((id) => <code key={id}>{id}</code>) : '无'}</li>
                    <li>现封存版本：{task.sealedVersion ? <code>v{task.sealedVersion}</code> : '未封存'}{task.newVersion ? <> → 新版本 <code>v{task.newVersion}</code>（旧版本保留）</> : null}</li>
                  </ul>
                  {task.status === 'pending' && <div class="job-actions"><button class="button primary small" onClick$={() => openCompensate(task.id)}>确认并生成新版本</button><button class="button ghost small" onClick$={() => discardCompensate(task.id)}>放弃补偿</button></div>}
                  {task.jobId && <p class="job-hint">补偿发布任务：{task.jobId}</p>}
                </div>
              ))}
              {!state.compensations.length && <p class="job-hint">撤回一个已封存的合并后，会在此列出受影响记录、引用对象和封存版本。</p>}
            </div>
          </article>

          <article class="panel service-panel">
            <Tabs.Root bind:selectedIndex={archiveTab} class="review-tabs">
              <Tabs.List class="tab-list"><Tabs.Tab>对象与版本</Tabs.Tab><Tabs.Tab>发布批次</Tabs.Tab><Tabs.Tab>服务流水</Tabs.Tab></Tabs.List>
              <Tabs.Panel class="tab-panel service-scroll">
                {serviceObjects.value.length ? serviceObjects.value.map((object) => (
                  <div class="service-card" key={object.id}>
                    <div class="job-head"><strong>{object.id}</strong><span class="kind-tag">{object.kind === 'merge' ? '合并发布' : object.kind === 'merge-withdraw' ? '撤回补偿' : '确认'}</span></div>
                    <p class="job-hint">结论 {object.conclusionKey.slice(-8)} · 摘要 {object.digest.slice(6, 16)}</p>
                    <div class="version-chain">{object.versions.map((version) => <span class="version-pill" key={version.version}>v{version.version} · {version.workstationId} · {new Date(version.at).toLocaleDateString('zh-CN')}</span>)}</div>
                  </div>
                )) : <div class="empty-state">封存服务中还没有对象。发布时按对象摘要复用，同一结论只建一次档。</div>}
              </Tabs.Panel>
              <Tabs.Panel class="tab-panel service-scroll">
                {serviceBatches.value.length ? serviceBatches.value.map((batch) => (
                  <div class="service-card" key={batch.id}>
                    <div class="job-head"><strong>{batch.id}</strong><span class={`job-stage ${batch.status === 'sealed' ? 'sealed' : batch.status === 'reserved' ? 'reserved' : 'rejected'}`}>{batch.status === 'sealed' ? `已封存 v${batch.version}` : batch.status === 'reserved' ? '预留中' : '已释放'}</span></div>
                    <p class="job-hint">对象 {batch.objectId} · 归属 {batch.workstationId}</p>
                    <p class="job-hint">预留 {new Date(batch.reservedAt).toLocaleTimeString('zh-CN', { hour12: false })} → {new Date(batch.reservedUntil).toLocaleTimeString('zh-CN', { hour12: false })}{batch.sealedAt ? ` · 封存 ${new Date(batch.sealedAt).toLocaleTimeString('zh-CN', { hour12: false })}` : ''}</p>
                    {batch.transfers.map((transfer, index) => <p class="transfer-note" key={index}>接管记录：{transfer.from} → {transfer.to}（{new Date(transfer.at).toLocaleTimeString('zh-CN', { hour12: false })}）{transfer.reason}</p>)}
                  </div>
                )) : <div class="empty-state">还没有发布批次。先预留批次再封存，失败后可恢复同一批次。</div>}
              </Tabs.Panel>
              <Tabs.Panel class="tab-panel service-scroll">
                {serviceLedger.value.length ? serviceLedger.value.slice(0, 40).map((event) => (
                  <div class="ledger-row" key={event.id}>
                    <time>{new Date(event.at).toLocaleTimeString('zh-CN', { hour12: false })}</time>
                    <span class={`ledger-type evt-${event.type}`}>{event.type}</span>
                    <p>{event.detail}</p>
                  </div>
                )) : <div class="empty-state">封存服务流水为空。</div>}
              </Tabs.Panel>
            </Tabs.Root>
          </article>
        </div>
      </section>

      {toast.value && <div class="toast">{toast.value}</div>}

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
          {activeMatch.value && (() => {
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

      <Modal.Root bind:show={withdrawOpen} closeOnBackdropClick>
        <Modal.Panel class="modal-panel">
          <Modal.Header class="modal-header"><div><span class="eyebrow">WITHDRAW MERGE</span><Modal.Title>撤回合并并生成补偿任务</Modal.Title></div><Modal.Close class="modal-close">×</Modal.Close></Modal.Header>
          <Modal.Description class="modal-description">本机工作区将恢复合并前的两条记录并保留字段选择与撤销记录。若该合并已在封存服务封存，会生成补偿任务：列出受影响记录、引用对象与当前封存版本，确认后在同一对象上生成新版本，旧版本保留。</Modal.Description>
          <textarea class="modal-textarea" value={withdrawReason.value} onInput$={(event) => withdrawReason.value = (event.target as HTMLTextAreaElement).value} placeholder="撤回原因（例如：研究者确认两份材料不应合并）" />
          <Modal.Footer class="modal-footer"><Modal.Close class="button ghost">取消</Modal.Close><button class="button danger" onClick$={confirmWithdraw}>撤回合并</button></Modal.Footer>
        </Modal.Panel>
      </Modal.Root>

      {compensateTaskId.value && (
        <div class="modal-backdrop" onClick$={() => compensateTaskId.value = ''}>
          <div class="modal-panel inline-modal" onClick$={(event) => event.stopPropagation()}>
            <div class="modal-header"><div><span class="eyebrow">CONFIRM COMPENSATION</span><h3 class="modal-title">确认补偿 · 生成新版本</h3></div><button class="modal-close" onClick$={() => compensateTaskId.value = ''}>×</button></div>
            {(() => {
              const task = state.compensations.find((item) => item.id === compensateTaskId.value);
              if (!task) return null;
              return <>
                <p class="modal-description">对象 <code>{task.objectId}</code> 当前为 <code>v{task.sealedVersion}</code>。确认后将提交「撤回合并」补偿，在对象上追加新版本并完整保留 v1–v{task.sealedVersion}。</p>
                <ul class="comp-detail">
                  <li>受影响记录（{task.affectedRecordIds.length}）：{task.affectedRecordIds.map((id) => <code key={id}>{id.slice(0, 10)}</code>)}</li>
                  <li>引用对象（{task.referencedObjectIds.length}）：{task.referencedObjectIds.map((id) => <code key={id}>{id}</code>)}</li>
                </ul>
                <textarea class="modal-textarea" value={compensateReason.value} onInput$={(event) => compensateReason.value = (event.target as HTMLTextAreaElement).value} placeholder="补偿说明（例如：重新核对后确认两份记录分属不同采访）" />
                <div class="modal-footer"><button class="button ghost" onClick$={() => compensateTaskId.value = ''}>取消</button><button class="button primary" onClick$={confirmCompensateNow}>确认并封存新版本</button></div>
              </>;
            })()}
          </div>
        </div>
      )}
    </div>
  );
});
