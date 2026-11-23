import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { createRoot } from 'react-dom/client';
import {
  ArrowDownToLine,
  ArrowUpFromLine,
  ArrowUpRight,
  Check,
  CheckCheck,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  CircleAlert,
  Columns3,
  Copy,
  Ellipsis,
  FileJson,
  FolderPlus,
  Grid2X2,
  LayoutGrid,
  List,
  LoaderCircle,
  LockKeyhole,
  Monitor,
  Moon,
  Pencil,
  Plus,
  Puzzle,
  Search,
  Settings2,
  ShieldCheck,
  SlidersHorizontal,
  Sparkles,
  Star,
  Sun,
  Trash2,
  WandSparkles,
  X,
} from 'lucide-react';
import {
  applyChanges,
  browserName,
  canToggle,
  canUninstall,
  isDemo,
  listExtensions,
  openManager,
  openNativeManager,
  openShortcuts,
  openUrl,
  permissionWarnings,
  selfId,
  setExtensionEnabled,
  subscribeExtensions,
  uninstallExtension,
} from './core/api';
import {
  createBackup,
  getData,
  parseBackup,
  recordActivity,
  subscribeData,
  updateData,
} from './core/storage';
import type { AppData, BatchResult, ExtensionItem, Scene, Settings } from './core/types';
import { applyAppearance } from './core/appearance';
import { SkinAvatar, SkinPicker, type SkinName } from './SkinPicker';
import { ElysiaPopupArt } from './ElysiaPopupArt';
import { createFullBackup } from './core/backup';
import { openMigrationManager } from './core/migration';
import { BackupRestorePanel, LastRestoreSummary } from './BackupRestorePanel';
import './popup.css';
import './popup-feedback.css';

type Page = 'extensions' | 'scenes' | 'tools';
type Filter = 'all' | 'enabled' | 'disabled' | 'favorites';
type Dialog =
  | { type: 'detail'; id: string; groupId: string; note: string }
  | { type: 'group'; name: string }
  | { type: 'batch-group'; groupId: string; ids: string[] }
  | {
      type: 'scene-form';
      id?: string;
      name: string;
      description: string;
      scopeIds: string[];
      enabledIds: string[];
    }
  | { type: 'delete-scene'; scene: Scene }
  | { type: 'apply'; title: string; description: string; scopeIds: string[]; enabledIds: string[] }
  | { type: 'result'; title: string; result: BatchResult; secondary?: string }
  | { type: 'import'; backup: ReturnType<typeof parseBackup> }
  | { type: 'restore'; backup: ReturnType<typeof parseBackup> };
function message(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
function uid() {
  return crypto.randomUUID();
}
function protectedReason(item: ExtensionItem) {
  return item.id === selfId
    ? '本管理器受保护'
    : item.type === 'theme'
      ? '主题请在浏览器中管理'
      : item.installType === 'admin' || !item.mayDisable
        ? '管理员策略保护'
        : '浏览器限制操作';
}
function ExtensionIcon({ item }: { item: ExtensionItem }) {
  const [failed, setFailed] = useState(false);
  const icon = item.icons?.slice().sort((a, b) => b.size - a.size)[0]?.url;
  return (
    <span
      className="extension-icon"
      style={{
        backgroundColor: item.demoColor || undefined,
        color: item.demoColor ? '#fff' : undefined,
      }}
    >
      {icon && !failed ? (
        <img src={icon} alt="" onError={() => setFailed(true)} />
      ) : (
        <span>{item.demoGlyph || item.name.slice(0, 1).toUpperCase()}</span>
      )}
    </span>
  );
}
function Brand({ skin = 'forest' }: { skin?: SkinName }) {
  return (
    <div className="brand">
      {skin === 'elysia' ? (
        <SkinAvatar />
      ) : (
        <span className="brand-mark" aria-hidden="true">
          <i />
          <i />
          <i />
          <i />
        </span>
      )}
      <div>
        <strong>
          栖 <span>· {skin === 'elysia' ? '爱莉希雅' : '扩展管理'}</span>
        </strong>
        <small>A PLACE FOR EVERY EXTENSION</small>
      </div>
    </div>
  );
}

function Popup() {
  const [items, setItems] = useState<ExtensionItem[]>([]);
  const [data, setData] = useState<AppData | null>(null);
  const [page, setPage] = useState<Page>('extensions');
  const [filter, setFilter] = useState<Filter>('all');
  const [query, setQuery] = useState('');
  const [groupFilter, setGroupFilter] = useState('all');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [headerCollapsed, setHeaderCollapsed] = useState(() => {
    try {
      return localStorage.getItem('qii.popup.headerCollapsed') === '1';
    } catch {
      return false;
    }
  });
  const [busyIds, setBusyIds] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [applying, setApplying] = useState(false);
  const [restoreBusy, setRestoreBusy] = useState(false);
  const [exportingFull, setExportingFull] = useState(false);
  const [batch, setBatch] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [warnings, setWarnings] = useState<string[] | null>(null);
  const [warningsError, setWarningsError] = useState('');
  const searchRef = useRef<HTMLInputElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const fullBackupFileRef = useRef<HTMLInputElement>(null);
  const dialogRef = useRef<HTMLElement>(null);
  const requestId = useRef(0);
  const dataRequestId = useRef(0);
  const pendingToggleIds = useRef(new Set<string>());
  const inventoryRefreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const dialogOpenRef = useRef(false);
  const view = data?.settings.popupView ?? 'grid';
  const density = data?.settings.popupDensity ?? 'comfortable';
  const sort = data?.settings.sort ?? 'name';
  const detailId = dialog?.type === 'detail' ? dialog.id : null;
  const detailItem = detailId ? items.find((item) => item.id === detailId) : undefined;
  const refreshItems = useCallback(async () => {
    // Local changes update their own row. Defer snapshots until they settle so an older
    // management event cannot briefly put a switch back in its previous state.
    if (pendingToggleIds.current.size) return;
    const id = ++requestId.current;
    try {
      const nextItems = await listExtensions();
      if (id !== requestId.current || pendingToggleIds.current.size) return;
      setItems(nextItems);
      setSelected((ids) => ids.filter((value) => nextItems.some((item) => item.id === value)));
    } catch (err) {
      if (id === requestId.current) setError(message(err));
    }
  }, []);
  const refreshData = useCallback(async () => {
    const id = ++dataRequestId.current;
    try {
      const nextData = await getData();
      if (id === dataRequestId.current) setData(nextData);
    } catch (err) {
      if (id === dataRequestId.current) setError(message(err));
    }
  }, []);
  const refresh = useCallback(async () => {
    await Promise.all([refreshItems(), refreshData()]);
    setLoading(false);
  }, [refreshItems, refreshData]);
  const queueInventoryRefresh = useCallback(() => {
    if (inventoryRefreshTimer.current) clearTimeout(inventoryRefreshTimer.current);
    inventoryRefreshTimer.current = setTimeout(() => {
      inventoryRefreshTimer.current = null;
      void refreshItems();
    }, 25);
  }, [refreshItems]);
  useEffect(() => {
    void refresh();
    const a = subscribeExtensions(queueInventoryRefresh);
    const b = subscribeData(() => void refreshData());
    return () => {
      a();
      b();
      if (inventoryRefreshTimer.current) clearTimeout(inventoryRefreshTimer.current);
      requestId.current++;
      dataRequestId.current++;
    };
  }, [refresh, refreshData, queueInventoryRefresh]);
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(''), 3500);
    return () => clearTimeout(timer);
  }, [notice]);
  function toggleHeader() {
    const next = !headerCollapsed;
    setHeaderCollapsed(next);
    try {
      localStorage.setItem('qii.popup.headerCollapsed', next ? '1' : '0');
    } catch {
      // The layout remains usable when the browser disallows preference storage.
    }
  }
  useEffect(() => applyAppearance(data?.settings), [data?.settings.theme, data?.settings.skin]);
  useEffect(() => {
    if (!detailId) return;
    let active = true;
    setWarnings(null);
    setWarningsError('');
    void permissionWarnings(detailId).then(
      (value) => {
        if (active) setWarnings(value);
      },
      (err) => {
        if (active) setWarningsError(message(err));
      },
    );
    return () => {
      active = false;
    };
  }, [detailId]);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        if (dialog) {
          if (!saving && !applying && !restoreBusy) {
            setDialog(null);
            setError('');
          }
        } else window.close();
      }
      if (
        event.key === '/' &&
        !dialog &&
        page === 'extensions' &&
        !(event.target instanceof HTMLInputElement) &&
        !(event.target instanceof HTMLTextAreaElement)
      ) {
        event.preventDefault();
        searchRef.current?.focus();
      }
      if (event.key === 'Tab' && dialog) {
        const nodes = dialogRef.current?.querySelectorAll<HTMLElement>(
          'button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled),summary,[tabindex="0"]',
        );
        const focusable = nodes
          ? Array.from(nodes).filter((node) => node.getClientRects().length > 0)
          : [];
        if (!focusable.length) {
          event.preventDefault();
          dialogRef.current?.focus();
          return;
        }
        const first = focusable[0],
          last = focusable[focusable.length - 1];
        if (
          event.shiftKey &&
          (document.activeElement === first || document.activeElement === dialogRef.current)
        ) {
          event.preventDefault();
          last.focus();
        } else if (
          !event.shiftKey &&
          (document.activeElement === last || !dialogRef.current?.contains(document.activeElement))
        ) {
          event.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [dialog, saving, applying, restoreBusy, page]);
  useEffect(() => {
    if (dialog) {
      if (!dialogOpenRef.current)
        returnFocusRef.current =
          document.activeElement instanceof HTMLElement ? document.activeElement : null;
      dialogOpenRef.current = true;
      dialogRef.current?.focus();
    } else if (dialogOpenRef.current) {
      dialogOpenRef.current = false;
      if (returnFocusRef.current?.isConnected) returnFocusRef.current.focus();
      returnFocusRef.current = null;
    }
  }, [dialog?.type]);
  const groupName = (item: ExtensionItem) =>
    data?.groups.find((group) => group.id === data.meta[item.id]?.groupId)?.name || '';
  const visible = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    return items
      .filter((item) => {
        const meta = data?.meta[item.id];
        const group = data?.groups.find((entry) => entry.id === meta?.groupId);
        const text =
          `${item.name} ${item.description} ${item.id} ${meta?.note ?? ''} ${group?.name ?? ''}`.toLocaleLowerCase();
        return (
          (!needle || text.includes(needle)) &&
          (filter === 'all' ||
            (filter === 'enabled' && item.enabled) ||
            (filter === 'disabled' && !item.enabled) ||
            (filter === 'favorites' && meta?.favorite)) &&
          (groupFilter === 'all' ||
            (groupFilter === 'ungrouped' && !meta?.groupId) ||
            meta?.groupId === groupFilter)
        );
      })
      .sort((a, b) => {
        if (sort === 'enabled' && a.enabled !== b.enabled) return a.enabled ? -1 : 1;
        if (sort === 'group') {
          const aGroup =
            data?.groups.find((group) => group.id === data.meta[a.id]?.groupId)?.name || '\uffff';
          const bGroup =
            data?.groups.find((group) => group.id === data.meta[b.id]?.groupId)?.name || '\uffff';
          const order = aGroup.localeCompare(bGroup, 'zh-CN');
          if (order) return order;
        }
        return a.name.localeCompare(b.name, 'zh-CN');
      });
  }, [items, data, query, filter, groupFilter, sort]);
  const enabledCount = items.filter((item) => item.enabled).length;
  const favoriteCount = items.filter((item) => data?.meta[item.id]?.favorite).length;
  const allVisibleSelected =
    visible.length > 0 && visible.every((item) => selected.includes(item.id));
  const sceneCandidates = items.filter(canToggle);
  const currentChanges =
    dialog?.type === 'apply'
      ? dialog.scopeIds.filter((id) => {
          const item = items.find((entry) => entry.id === id);
          return !item || item.enabled !== dialog.enabledIds.includes(id);
        })
      : [];
  function showDialog(next: Dialog) {
    setError('');
    setDialog(next);
  }
  function showDetail(item: ExtensionItem) {
    showDialog({
      type: 'detail',
      id: item.id,
      groupId: data?.meta[item.id]?.groupId || '',
      note: data?.meta[item.id]?.note || '',
    });
  }
  async function commit(mutator: (current: AppData) => AppData, success?: string) {
    setSaving(true);
    setError('');
    try {
      const next = await updateData(mutator);
      dataRequestId.current++;
      setData(next);
      if (success) setNotice(success);
      return true;
    } catch (err) {
      setError(message(err));
      return false;
    } finally {
      setSaving(false);
    }
  }
  async function logActivity(text: string) {
    try {
      const next = await updateData((latest) => recordActivity(latest, text));
      dataRequestId.current++;
      setData(next);
      return '';
    } catch (err) {
      return `操作结果已返回，但活动记录保存失败：${message(err)}`;
    }
  }
  function runLink(promise: Promise<void>) {
    void promise.catch((err) => setError(message(err)));
  }
  function preference(patch: Partial<Settings>) {
    void commit((current) => ({ ...current, settings: { ...current.settings, ...patch } }));
  }
  async function toggle(item: ExtensionItem) {
    if (!canToggle(item) || pendingToggleIds.current.has(item.id) || applying) return;
    pendingToggleIds.current.add(item.id);
    requestId.current++;
    setBusyIds((ids) => [...ids, item.id]);
    setError('');
    try {
      await setExtensionEnabled(item, !item.enabled);
      setItems((current) =>
        current.map((entry) =>
          entry.id === item.id ? { ...entry, enabled: !item.enabled } : entry,
        ),
      );
      setNotice(`已${item.enabled ? '停用' : '启用'} · ${item.name}`);
      void logActivity(`${item.enabled ? '停用' : '启用'} ${item.name}`).then((warning) => {
        if (warning) setError(warning);
      });
    } catch (err) {
      setError(message(err));
    } finally {
      pendingToggleIds.current.delete(item.id);
      setBusyIds((ids) => ids.filter((id) => id !== item.id));
      queueInventoryRefresh();
    }
  }
  async function removeItem(item: ExtensionItem) {
    if (!canUninstall(item) || busyIds.includes(item.id)) return;
    setBusyIds((ids) => [...ids, item.id]);
    setError('');
    try {
      await uninstallExtension(item);
    } catch (err) {
      setError(message(err));
      setBusyIds((ids) => ids.filter((id) => id !== item.id));
      return;
    }
    setItems((current) => current.filter((entry) => entry.id !== item.id));
    setDialog(null);
    const warning = await logActivity(`卸载 ${item.name}`);
    setNotice(warning || `${item.name} 已卸载`);
    setBusyIds((ids) => ids.filter((id) => id !== item.id));
    await refresh();
  }
  function prepareBatch(enabled: boolean) {
    showDialog({
      type: 'apply',
      title: enabled ? '批量启用' : '批量停用',
      description: '仅调整所选扩展。受保护项目和需要重新授权的扩展会跳过。',
      scopeIds: [...selected],
      enabledIds: enabled ? [...selected] : [],
    });
  }
  async function executeChanges() {
    if (dialog?.type !== 'apply' || applying) return;
    const action = dialog;
    setApplying(true);
    setError('');
    try {
      const result = await applyChanges(items, action.enabledIds, action.scopeIds);
      const secondary = await logActivity(
        `${action.title}：完成 ${result.succeeded.length} 项，跳过 ${result.skipped.length} 项，失败 ${result.failed.length} 项`,
      );
      setDialog({ type: 'result', title: action.title, result, secondary });
      await refresh();
    } catch (err) {
      setError(message(err));
    } finally {
      setApplying(false);
    }
  }
  function newScene(scene?: Scene) {
    showDialog({
      type: 'scene-form',
      id: scene?.id,
      name: scene?.name ?? '',
      description: scene?.description ?? '',
      scopeIds: scene ? [...scene.scopeIds] : sceneCandidates.map((item) => item.id),
      enabledIds: scene
        ? [...scene.enabledIds]
        : sceneCandidates.filter((item) => item.enabled).map((item) => item.id),
    });
  }
  async function saveScene(event: FormEvent) {
    event.preventDefault();
    if (dialog?.type !== 'scene-form') return;
    const form = dialog;
    const name = form.name.trim();
    if (!name) {
      setError('请输入场景名称。');
      return;
    }
    const success = await commit((current) => {
      if (current.scenes.some((entry) => entry.id !== form.id && entry.name === name))
        throw new Error('已有同名场景，请换一个名称。');
      const old = current.scenes.find((entry) => entry.id === form.id);
      const scene: Scene = {
        id: form.id || uid(),
        name,
        description: form.description.trim(),
        scopeIds: form.scopeIds,
        enabledIds: form.enabledIds.filter((id) => form.scopeIds.includes(id)),
        createdAt: old?.createdAt ?? Date.now(),
      };
      return recordActivity(
        {
          ...current,
          scenes: old
            ? current.scenes.map((entry) => (entry.id === scene.id ? scene : entry))
            : [...current.scenes, scene],
        },
        `${old ? '编辑' : '创建'}场景「${name}」`,
      );
    }, '场景已保存');
    if (success) setDialog(null);
  }
  async function exportConfig() {
    setError('');
    try {
      const latest = await getData();
      const text = createBackup(latest, items);
      const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = `qii-backup-${new Date().toISOString().slice(0, 10)}.json`;
      document.body.append(anchor);
      anchor.click();
      anchor.remove();
      setTimeout(() => URL.revokeObjectURL(url), 30_000);
      setNotice('配置备份已导出，包含分组、场景、备注和外观偏好。');
    } catch (err) {
      setError(message(err));
    }
  }
  async function importFile(file: File | undefined) {
    if (!file) return;
    setError('');
    try {
      if (file.size > 5 * 1024 * 1024) throw new Error('请选择小于 5 MB 的 JSON 备份。');
      showDialog({ type: 'import', backup: parseBackup(JSON.parse(await file.text())) });
    } catch (err) {
      setError(message(err));
    } finally {
      if (fileRef.current) fileRef.current.value = '';
    }
  }
  async function exportAllExtensions() {
    if (exportingFull) return;
    setExportingFull(true);
    setError('');
    try {
      const [allItems, latestData] = await Promise.all([listExtensions(), getData()]);
      const text = createFullBackup(latestData, allItems);
      const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = `qii-all-extensions-${new Date().toISOString().slice(0, 10)}.json`;
      document.body.append(anchor);
      anchor.click();
      anchor.remove();
      setTimeout(() => URL.revokeObjectURL(url), 30_000);
      setNotice(`已导出配置与清单 JSON：${allItems.length} 个项目，不含扩展安装文件。`);
    } catch (err) {
      setError(message(err));
    } finally {
      setExportingFull(false);
    }
  }
  async function importFullBackup(file: File | undefined) {
    if (!file) return;
    setError('');
    try {
      if (file.size > 10 * 1024 * 1024) throw new Error('请选择小于 10 MB 的 JSON 备份。');
      const backup = parseBackup(JSON.parse(await file.text()));
      const [allItems, latestData] = await Promise.all([listExtensions(), getData()]);
      setItems(allItems);
      setData(latestData);
      showDialog({ type: 'restore', backup });
    } catch (err) {
      setError(message(err));
    } finally {
      if (fullBackupFileRef.current) fullBackupFileRef.current.value = '';
    }
  }
  function switchControl(item: ExtensionItem) {
    return canToggle(item) ? (
      <button
        className={`toggle ${item.enabled ? 'on' : ''}`}
        role="switch"
        aria-checked={item.enabled}
        aria-busy={busyIds.includes(item.id)}
        aria-label={`${item.enabled ? '停用' : '启用'} ${item.name}`}
        disabled={busyIds.includes(item.id) || applying || batch}
        onClick={() => {
          void toggle(item);
        }}
      >
        <span className="toggle-thumb">
          {busyIds.includes(item.id) && <LoaderCircle size={8} className="spin" />}
        </span>
      </button>
    ) : (
      <span className="protected-item" title={protectedReason(item)}>
        <LockKeyhole size={13} />
        <span className="sr-only">{protectedReason(item)}</span>
      </span>
    );
  }
  const dialogTitle =
    dialog?.type === 'detail'
      ? detailItem?.name || '扩展已移除'
      : dialog?.type === 'group'
        ? '新建分组'
        : dialog?.type === 'batch-group'
          ? '移动分组'
          : dialog?.type === 'scene-form'
            ? dialog.id
              ? '编辑场景'
              : '新建场景'
            : dialog?.type === 'delete-scene'
              ? '删除场景'
              : dialog?.type === 'apply'
                ? dialog.title
                : dialog?.type === 'result'
                  ? `${dialog.title}结果`
                  : dialog?.type === 'restore'
                    ? '导入 JSON 并应用'
                    : '导入配置预览';
  return (
    <main className={`popup-shell density-${density}${headerCollapsed ? ' header-collapsed' : ''}`}>
      {data?.settings.skin === 'elysia' && <div className="elysia-ambient" aria-hidden="true" />}
      <div className="popup-base" inert={!!dialog}>
        <header className="popup-header">
          <Brand skin={data?.settings.skin ?? 'forest'} />
          {data?.settings.skin === 'elysia' && (
            <>
              <div className="elysia-header-caption" aria-hidden="true">
                <small>PINK ELF / CRYSTAL GARDEN</small>
                <strong>粉色花庭，与你相遇</strong>
              </div>
              <ElysiaPopupArt />
            </>
          )}
          <div className="header-actions">
            <button
              className="icon-button header-collapse-button"
              aria-label={headerCollapsed ? '展开顶部' : '收起顶部'}
              aria-expanded={!headerCollapsed}
              title={headerCollapsed ? '展开人物页头' : '收起顶部，显示更多扩展'}
              onClick={toggleHeader}
            >
              {headerCollapsed ? <ChevronDown size={15} /> : <ChevronUp size={15} />}
            </button>
            <span className="running-stat">
              <span className="live-dot" />
              <b>{enabledCount}</b> 已启用
            </span>
            <button
              className="text-icon"
              aria-label="打开完整管理页"
              onClick={() => runLink(openManager())}
            >
              完整管理 <ArrowUpRight size={13} />
            </button>
            <button
              className="icon-button close-button"
              aria-label="关闭扩展面板"
              title="关闭 · Esc"
              onClick={() => window.close()}
            >
              <X size={16} />
            </button>
          </div>
        </header>
        <nav className="main-tabs" role="tablist" aria-label="管理功能">
          {(
            [
              { id: 'extensions', label: '扩展', icon: LayoutGrid, count: items.length },
              { id: 'scenes', label: '场景', icon: Sparkles, count: data?.scenes.length || 0 },
              { id: 'tools', label: '工具', icon: SlidersHorizontal },
            ] as const
          ).map((entry) => (
            <button
              key={entry.id}
              role="tab"
              id={`tab-${entry.id}`}
              aria-controls={`panel-${entry.id}`}
              aria-selected={page === entry.id}
              className={page === entry.id ? 'active' : ''}
              onClick={() => {
                setPage(entry.id);
                setError('');
              }}
            >
              <entry.icon size={15} />
              {entry.label}
              {'count' in entry && <small>{entry.count}</small>}
            </button>
          ))}
          <span className="browser-chip">
            {browserName}
            <span>本地工作空间</span>
          </span>
        </nav>
        {isDemo && (
          <div className="demo-notice">
            <CircleAlert size={11} />
            预览模式 · 操作仅影响演示数据，加载扩展后可管理真实项目
          </div>
        )}
        {!dialog && error && (
          <div className="message message-error popup-feedback" role="alert">
            <CircleAlert size={14} />
            <span>{error}</span>
            <button
              className="text-button"
              onClick={() => {
                setError('');
                setLoading(true);
                void refresh();
              }}
            >
              重试
            </button>
            <button className="icon-button" aria-label="关闭错误" onClick={() => setError('')}>
              <X size={13} />
            </button>
          </div>
        )}
        {page === 'extensions' && (
          <section
            className="extensions-panel"
            id="panel-extensions"
            role="tabpanel"
            aria-labelledby="tab-extensions"
          >
            <div className="extension-toolbar">
              <div className="search-wrap">
                <Search size={15} />
                <input
                  ref={searchRef}
                  type="search"
                  aria-label="搜索扩展"
                  placeholder="搜索名称、备注、分组或 ID…"
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                />
                <kbd>/</kbd>
              </div>
              <div className="view-controls">
                <button
                  aria-label="图标视图"
                  aria-pressed={view === 'grid'}
                  className={view === 'grid' ? 'active' : ''}
                  disabled={saving}
                  onClick={() => preference({ popupView: 'grid' })}
                >
                  <Grid2X2 size={15} />
                </button>
                <button
                  aria-label="列表视图"
                  aria-pressed={view === 'list'}
                  className={view === 'list' ? 'active' : ''}
                  disabled={saving}
                  onClick={() => preference({ popupView: 'list' })}
                >
                  <List size={16} />
                </button>
                <button
                  aria-label="紧凑密度"
                  title={density === 'compact' ? '恢复舒适密度' : '紧凑显示，每行容纳更多扩展'}
                  aria-pressed={density === 'compact'}
                  className={density === 'compact' ? 'active' : ''}
                  disabled={saving}
                  onClick={() =>
                    preference({ popupDensity: density === 'compact' ? 'comfortable' : 'compact' })
                  }
                >
                  <Columns3 size={14} />
                </button>
              </div>
            </div>
            <div className="filter-row">
              <div className="status-filters" aria-label="扩展状态筛选">
                {(
                  [
                    { id: 'all', label: '全部', count: items.length },
                    {
                      id: 'enabled',
                      label: '已启用',
                      count: items.filter((item) => item.enabled).length,
                    },
                    {
                      id: 'disabled',
                      label: '已停用',
                      count: items.filter((item) => !item.enabled).length,
                    },
                    { id: 'favorites', label: '收藏', count: favoriteCount },
                  ] as const
                ).map((entry) => (
                  <button
                    key={entry.id}
                    aria-pressed={filter === entry.id}
                    className={filter === entry.id ? 'active' : ''}
                    onClick={() => setFilter(entry.id)}
                  >
                    {entry.label}
                    <small>{entry.count}</small>
                  </button>
                ))}
              </div>
              <div className="backup-quick-actions">
                <div
                  className="backup-transfer-pair"
                  role="group"
                  aria-label="配置与清单 JSON 导入导出"
                >
                  <button
                    className="icon-button"
                    aria-label="导出配置与清单 JSON"
                    title="导出配置与清单 JSON"
                    disabled={exportingFull}
                    onClick={() => {
                      void exportAllExtensions();
                    }}
                  >
                    {exportingFull ? (
                      <LoaderCircle size={14} className="spin" />
                    ) : (
                      <ArrowDownToLine size={14} />
                    )}
                  </button>
                  <button
                    className="icon-button"
                    aria-label="导入 JSON 并应用"
                    title="导入 JSON 并应用"
                    onClick={() => fullBackupFileRef.current?.click()}
                  >
                    <ArrowUpFromLine size={14} />
                  </button>
                </div>
                <button
                  className={`text-icon batch-toggle ${batch ? 'active' : ''}`}
                  aria-label={batch ? '结束批量' : '批量管理'}
                  aria-pressed={batch}
                  title={batch ? '结束批量' : '批量管理'}
                  onClick={() => {
                    setBatch(!batch);
                    setSelected([]);
                  }}
                >
                  <CheckCheck size={14} />
                  <span className="batch-toggle-label">{batch ? '结束批量' : '批量管理'}</span>
                </button>
              </div>
            </div>
            <div className="organize-row">
              <div className="group-controls">
                <select
                  aria-label="按分组筛选"
                  value={groupFilter}
                  onChange={(event) => setGroupFilter(event.target.value)}
                >
                  <option value="all">所有分组</option>
                  <option value="ungrouped">未分组</option>
                  {data?.groups.map((group) => (
                    <option key={group.id} value={group.id}>
                      {group.name}
                    </option>
                  ))}
                </select>
                <button
                  className="icon-button"
                  aria-label="新建分组"
                  title="新建分组"
                  onClick={() => showDialog({ type: 'group', name: '' })}
                >
                  <FolderPlus size={14} />
                </button>
                <span className="result-count">{visible.length} 个结果</span>
              </div>
              <select
                className="sort-select"
                aria-label="扩展排序"
                value={sort}
                disabled={saving}
                onChange={(event) => preference({ sort: event.target.value as Settings['sort'] })}
              >
                <option value="name">名称排序</option>
                <option value="enabled">启用优先</option>
                <option value="group">按分组排序</option>
              </select>
            </div>
            {batch && (
              <div className="batch-bar">
                <label>
                  <input
                    type="checkbox"
                    aria-label="全选当前结果"
                    checked={allVisibleSelected}
                    onChange={() =>
                      setSelected((ids) =>
                        allVisibleSelected
                          ? ids.filter((id) => !visible.some((item) => item.id === id))
                          : Array.from(new Set([...ids, ...visible.map((item) => item.id)])),
                      )
                    }
                  />
                  已选 {selected.length}
                </label>
                <div>
                  <button disabled={!selected.length} onClick={() => prepareBatch(true)}>
                    启用所选
                  </button>
                  <button disabled={!selected.length} onClick={() => prepareBatch(false)}>
                    停用所选
                  </button>
                  <button
                    disabled={!selected.length}
                    onClick={() =>
                      showDialog({ type: 'batch-group', groupId: '', ids: [...selected] })
                    }
                  >
                    移动分组
                  </button>
                </div>
              </div>
            )}
            <div
              className={`extension-list view-${view}`}
              aria-label="扩展列表"
              aria-busy={loading}
            >
              {loading ? (
                <div className="empty-state">
                  <LoaderCircle className="spin" size={24} />
                  <p>正在读取扩展…</p>
                </div>
              ) : !visible.length ? (
                <div className="empty-state">
                  <Search size={26} />
                  <p>
                    {filter === 'favorites' && !query
                      ? '收藏常用扩展，下一次更快找到'
                      : '没有找到匹配的扩展'}
                  </p>
                  <small>调整关键词或筛选条件，试试看。</small>
                  {(query || filter !== 'all' || groupFilter !== 'all') && (
                    <button
                      className="secondary-button"
                      onClick={() => {
                        setQuery('');
                        setFilter('all');
                        setGroupFilter('all');
                      }}
                    >
                      清除筛选
                    </button>
                  )}
                </div>
              ) : (
                visible.map((item) => (
                  <article
                    key={item.id}
                    className={`extension-row extension-tile ${batch && selected.includes(item.id) ? 'selected' : ''} ${!item.enabled ? 'is-disabled' : ''}`}
                  >
                    <div className="tile-top">
                      {batch ? (
                        <label className="tile-select">
                          <input
                            type="checkbox"
                            aria-label={`选择 ${item.name}`}
                            checked={selected.includes(item.id)}
                            onChange={() =>
                              setSelected((ids) =>
                                ids.includes(item.id)
                                  ? ids.filter((id) => id !== item.id)
                                  : [...ids, item.id],
                              )
                            }
                          />
                        </label>
                      ) : (
                        <span className="tile-star">
                          {data?.meta[item.id]?.favorite && (
                            <Star size={10} fill="currentColor" aria-label="已收藏" />
                          )}
                        </span>
                      )}
                      {batch && selected.includes(item.id) && (
                        <span className="selection-label">
                          <Check size={10} aria-hidden="true" />
                          已选中
                        </span>
                      )}
                      <button
                        className="icon-button detail-button"
                        aria-label={`查看 ${item.name} 详情`}
                        title="扩展详情"
                        onClick={() => showDetail(item)}
                      >
                        <Ellipsis size={15} />
                      </button>
                    </div>
                    <button
                      className="tile-identity"
                      aria-label={`${item.name} 详情`}
                      onClick={() => showDetail(item)}
                    >
                      <ExtensionIcon item={item} />
                      <span className="tile-name" title={item.name}>
                        {item.name}
                      </span>
                      <span className="tile-group" title={groupName(item)}>
                        {groupName(item) || (item.type === 'theme' ? '浏览器主题' : '未分组')}
                      </span>
                    </button>
                    <div className="tile-bottom">
                      <span className={`state-label ${item.enabled ? 'enabled' : ''}`}>
                        <i />
                        {item.enabled ? '已启用' : '已停用'}
                      </span>
                      {switchControl(item)}
                    </div>
                  </article>
                ))
              )}
            </div>
          </section>
        )}
        {page === 'scenes' && (
          <section
            className="scroll-panel scenes-panel"
            id="panel-scenes"
            role="tabpanel"
            aria-labelledby="tab-scenes"
          >
            <div className="page-intro">
              <div>
                <span className="eyebrow">YOUR BROWSER, IN THE RIGHT MOOD</span>
                <h1>一个场景，一种节奏。</h1>
                <p>把常用扩展组合收好，工作与生活轻松切换。</p>
              </div>
              <button className="primary-button" onClick={() => newScene()}>
                <Plus size={14} />
                新建场景
              </button>
            </div>
            <div className="scene-grid">
              {data?.scenes.map((scene, index) => {
                const members = items.filter((item) => scene.enabledIds.includes(item.id));
                const changes = scene.scopeIds.filter((id) => {
                  const item = items.find((entry) => entry.id === id);
                  return !item || item.enabled !== scene.enabledIds.includes(id);
                }).length;
                return (
                  <article className="scene-card" key={scene.id}>
                    <header>
                      <span className={`scene-symbol symbol-${index % 3}`}>
                        <Sparkles size={18} />
                      </span>
                      <div className="scene-card-actions">
                        <button
                          className="icon-button"
                          aria-label={`编辑场景 ${scene.name}`}
                          onClick={() => newScene(scene)}
                        >
                          <Pencil size={13} />
                        </button>
                        <button
                          className="icon-button"
                          aria-label={`删除场景 ${scene.name}`}
                          onClick={() => showDialog({ type: 'delete-scene', scene })}
                        >
                          <Trash2 size={13} />
                        </button>
                      </div>
                    </header>
                    <h2>{scene.name}</h2>
                    <p>{scene.description || '属于你的扩展组合，随时准备就绪。'}</p>
                    <div className="scene-member-icons">
                      {members.slice(0, 5).map((item) => (
                        <ExtensionIcon key={item.id} item={item} />
                      ))}
                      {members.length > 5 && (
                        <span className="more-members">+{members.length - 5}</span>
                      )}
                      {!members.length && <small>此场景不启用任何扩展</small>}
                    </div>
                    <footer>
                      <span>
                        {scene.enabledIds.length} 启用 · {scene.scopeIds.length} 项管理
                      </span>
                      <button
                        aria-label={`切换场景 ${scene.name}`}
                        className={changes ? 'scene-apply' : 'scene-apply matched'}
                        onClick={() =>
                          showDialog({
                            type: 'apply',
                            title: `切换到「${scene.name}」`,
                            description: scene.description || '按此场景保存的状态调整扩展。',
                            scopeIds: [...scene.scopeIds],
                            enabledIds: [...scene.enabledIds],
                          })
                        }
                      >
                        {changes ? '切换' : '已匹配'}
                        {changes ? <ChevronRight size={13} /> : <Check size={13} />}
                      </button>
                    </footer>
                  </article>
                );
              })}
            </div>
            {!data?.scenes.length && (
              <div className="empty-state scene-empty">
                <WandSparkles size={30} />
                <p>为不同的时刻，准备不同的工具</p>
                <small>从当前启用状态创建第一个场景，之后可自由编辑。</small>
                <button className="secondary-button" onClick={() => newScene()}>
                  创建第一个场景
                </button>
              </div>
            )}
            <div className="quiet-note">
              <ShieldCheck size={14} />
              切换前会展示预览；保护项和需要重新授权的扩展会跳过。
            </div>
          </section>
        )}
        {page === 'tools' && (
          <section
            className="scroll-panel tools-panel"
            id="panel-tools"
            role="tabpanel"
            aria-labelledby="tab-tools"
          >
            <div className="tool-section skin-section">
              <div className="tool-heading">
                <span>
                  <Sparkles size={16} />
                  <b>皮肤外观</b>
                </span>
                <small>换一种心情，管理每一个扩展</small>
              </div>
              <SkinPicker
                skin={data?.settings.skin ?? 'forest'}
                disabled={!data}
                onSelect={(skin) => preference({ skin })}
              />
            </div>
            <div className="tool-section">
              <div className="tool-heading">
                <span>
                  <Sun size={16} />
                  <b>外观与布局</b>
                </span>
                <small>把工具箱变成喜欢的样子</small>
              </div>
              <div className="preference-row">
                <label>界面主题</label>
                <div className="segmented" role="group" aria-label="界面主题">
                  {(
                    [
                      { id: 'light', label: '浅色', icon: Sun },
                      { id: 'dark', label: '深色', icon: Moon },
                      { id: 'system', label: '跟随系统', icon: Monitor },
                    ] as const
                  ).map((entry) => (
                    <button
                      key={entry.id}
                      aria-pressed={data?.settings.theme === entry.id}
                      className={data?.settings.theme === entry.id ? 'active' : ''}
                      disabled={saving}
                      onClick={() => preference({ theme: entry.id })}
                    >
                      <entry.icon size={13} />
                      {entry.label}
                    </button>
                  ))}
                </div>
              </div>
              <div className="preference-row">
                <label>扩展布局</label>
                <div className="segmented" role="group" aria-label="弹窗布局">
                  <button
                    aria-pressed={view === 'grid'}
                    className={view === 'grid' ? 'active' : ''}
                    onClick={() => preference({ popupView: 'grid' })}
                  >
                    <Grid2X2 size={13} />
                    图标网格
                  </button>
                  <button
                    aria-pressed={view === 'list'}
                    className={view === 'list' ? 'active' : ''}
                    onClick={() => preference({ popupView: 'list' })}
                  >
                    <List size={13} />
                    简洁列表
                  </button>
                </div>
              </div>
              <div className="preference-row">
                <label>内容密度</label>
                <div className="segmented" role="group" aria-label="内容密度">
                  <button
                    aria-pressed={density === 'comfortable'}
                    className={density === 'comfortable' ? 'active' : ''}
                    onClick={() => preference({ popupDensity: 'comfortable' })}
                  >
                    舒适
                  </button>
                  <button
                    aria-pressed={density === 'compact'}
                    className={density === 'compact' ? 'active' : ''}
                    onClick={() => preference({ popupDensity: 'compact' })}
                  >
                    紧凑
                  </button>
                </div>
              </div>
            </div>
            <div className="tool-section">
              <div className="tool-heading">
                <span>
                  <Puzzle size={16} />
                  <b>扩展文件迁移（ZIP）</b>
                </span>
                <small>在完整管理页中处理</small>
              </div>
              <div className="backup-full-actions migration-open-actions">
                <button
                  type="button"
                  aria-label="导出扩展文件 ZIP"
                  title="导出扩展文件 ZIP"
                  onClick={() => runLink(openMigrationManager('export'))}
                >
                  <ArrowDownToLine size={19} />
                  <span>
                    导出扩展文件 ZIP<small>通过本机助手备份扩展文件</small>
                  </span>
                </button>
                <button
                  type="button"
                  aria-label="导入扩展文件 ZIP"
                  title="导入扩展文件 ZIP"
                  onClick={() => runLink(openMigrationManager('import'))}
                >
                  <ArrowUpFromLine size={19} />
                  <span>
                    导入扩展文件 ZIP<small>在完整管理页查看并恢复</small>
                  </span>
                </button>
              </div>
            </div>
            <div className="tool-section">
              <div className="tool-heading">
                <span>
                  <FileJson size={16} />
                  <b>配置与清单（JSON）</b>
                </span>
                <small>配置保存在当前浏览器本地</small>
              </div>
              <div className="backup-full-actions">
                <button
                  type="button"
                  aria-label="导出配置与清单 JSON"
                  title="导出配置与清单 JSON"
                  disabled={exportingFull}
                  onClick={() => {
                    void exportAllExtensions();
                  }}
                >
                  {exportingFull ? (
                    <LoaderCircle size={19} className="spin" />
                  ) : (
                    <ArrowDownToLine size={19} />
                  )}
                  <span>
                    导出配置与清单 JSON<small>全部清单、启用状态与管理器配置</small>
                  </span>
                </button>
                <button
                  type="button"
                  aria-label="导入 JSON 并应用"
                  title="导入 JSON 并应用"
                  onClick={() => fullBackupFileRef.current?.click()}
                >
                  <ArrowUpFromLine size={19} />
                  <span>
                    导入 JSON 并应用<small>预览差异后恢复状态，逐项核验</small>
                  </span>
                </button>
              </div>
              <div className="tool-card-grid">
                <button
                  className="tool-card"
                  aria-label="导出配置"
                  onClick={() => {
                    void exportConfig();
                  }}
                >
                  <span className="tool-icon">
                    <ArrowDownToLine size={19} />
                  </span>
                  <span>
                    <b>导出配置</b>
                    <small>分组、场景、收藏与备注</small>
                  </span>
                  <ArrowUpRight size={14} />
                </button>
                <button
                  className="tool-card"
                  aria-label="导入配置"
                  onClick={() => fileRef.current?.click()}
                >
                  <span className="tool-icon">
                    <ArrowUpFromLine size={19} />
                  </span>
                  <span>
                    <b>导入配置</b>
                    <small>预览 JSON 备份后合并</small>
                  </span>
                  <ArrowUpRight size={14} />
                </button>
              </div>
              <input
                ref={fileRef}
                type="file"
                accept=".json,application/json"
                aria-label="导入配置文件"
                className="file-input"
                onChange={(event) => {
                  void importFile(event.target.files?.[0]);
                }}
              />
              <p className="section-hint">
                “导入配置”仅合并管理器配置，不会启停扩展。恢复启用状态请使用“导入 JSON 并应用”。JSON
                不包含安装文件、密码或扩展自身的数据；扩展文件请使用上方 ZIP 迁移入口。
              </p>
              <LastRestoreSummary />
            </div>
            <div className="tool-section browser-tools">
              <div className="tool-heading">
                <span>
                  <Settings2 size={16} />
                  <b>浏览器工具</b>
                </span>
                <small>需要浏览器设置时，一步抵达</small>
              </div>
              <button className="tool-link" onClick={() => runLink(openNativeManager())}>
                <span>
                  <LayoutGrid size={15} />
                  浏览器原生扩展管理
                </span>
                <ArrowUpRight size={14} />
              </button>
              <button className="tool-link" onClick={() => runLink(openShortcuts())}>
                <span>
                  <SlidersHorizontal size={15} />
                  管理扩展快捷键
                </span>
                <ArrowUpRight size={14} />
              </button>
              <button className="tool-link" onClick={() => runLink(openManager())}>
                <span>
                  <ArrowUpRight size={15} />
                  打开完整管理页
                </span>
                <ArrowUpRight size={14} />
              </button>
            </div>
            <div className="quiet-note">
              <ShieldCheck size={14} />
              仅使用 management 与 storage 权限，无追踪、无远程脚本。
            </div>
          </section>
        )}
        <input
          ref={fullBackupFileRef}
          type="file"
          accept=".json,application/json"
          aria-label="导入全部扩展备份文件"
          className="file-input"
          onChange={(event) => {
            void importFullBackup(event.target.files?.[0]);
          }}
        />
        <footer className="popup-footer">
          <span
            className={notice ? 'footer-notice' : 'footer-inventory'}
            role="status"
            title={notice || undefined}
          >
            {notice ? <Check size={11} /> : <span className="live-dot" />}
            <span>
              {notice || (loading ? '正在连接浏览器…' : `${items.length} 个项目，井然有序`)}
            </span>
          </span>
          <span>
            <kbd>Alt ⇧ Q</kbd> 打开 <i>·</i> <kbd>Esc</kbd> 关闭
          </span>
        </footer>
      </div>
      {dialog && (
        <div className="dialog-overlay">
          <section
            ref={dialogRef}
            className={`popup-dialog dialog-${dialog.type}`}
            role="dialog"
            aria-modal="true"
            aria-labelledby="dialog-title"
            tabIndex={-1}
          >
            <header className="dialog-header">
              <div>
                <span className="eyebrow">
                  QII /{' '}
                  {dialog.type === 'detail'
                    ? 'EXTENSION'
                    : dialog.type.includes('scene')
                      ? 'SCENE'
                      : 'WORKSPACE'}
                </span>
                <h2 id="dialog-title">{dialogTitle}</h2>
              </div>
              <div className="dialog-header-actions">
                <button
                  className="text-button"
                  aria-label="关闭扩展面板"
                  onClick={() => window.close()}
                >
                  关闭面板
                </button>
                <button
                  className="icon-button"
                  aria-label="关闭对话框"
                  disabled={saving || applying || restoreBusy}
                  onClick={() => {
                    setDialog(null);
                    setError('');
                  }}
                >
                  <X size={18} />
                </button>
              </div>
            </header>
            {error && (
              <div className="message message-error dialog-feedback" role="alert">
                <CircleAlert size={14} />
                <span>{error}</span>
              </div>
            )}
            <div className="dialog-content">
              {dialog.type === 'restore' && data && (
                <BackupRestorePanel
                  backup={dialog.backup}
                  items={items}
                  data={data}
                  onApplied={refresh}
                  onClose={() => setDialog(null)}
                  onBusyChange={setRestoreBusy}
                />
              )}
              {dialog.type === 'detail' &&
                (detailItem ? (
                  <>
                    <div className="detail-overview">
                      <ExtensionIcon item={detailItem} />
                      <div>
                        <span className="detail-version">
                          v{detailItem.version} <i>·</i>{' '}
                          {{
                            extension: '浏览器扩展',
                            theme: '浏览器主题',
                            hosted_app: '托管应用',
                            packaged_app: '打包应用',
                            legacy_packaged_app: '旧版打包应用',
                            login_screen_extension: '登录界面扩展',
                          }[detailItem.type] || detailItem.type}
                        </span>
                        <span className="detail-state">
                          {detailItem.enabled ? '已启用' : '已停用'}
                          {!canToggle(detailItem) && ` · ${protectedReason(detailItem)}`}
                        </span>
                      </div>
                      <button
                        className={`favorite-button ${data?.meta[detailItem.id]?.favorite ? 'active' : ''}`}
                        disabled={saving}
                        onClick={() => {
                          void commit((current) => ({
                            ...current,
                            meta: {
                              ...current.meta,
                              [detailItem.id]: {
                                ...current.meta[detailItem.id],
                                favorite: !current.meta[detailItem.id]?.favorite,
                              },
                            },
                          }));
                        }}
                      >
                        <Star
                          size={14}
                          fill={data?.meta[detailItem.id]?.favorite ? 'currentColor' : 'none'}
                        />
                        {data?.meta[detailItem.id]?.favorite ? '取消收藏' : '收藏'}
                      </button>
                    </div>
                    <p className="detail-description">
                      {detailItem.description || '此扩展没有提供说明。'}
                    </p>
                    {detailItem.disabledReason === 'permissions_increase' && (
                      <p className="inline-note">
                        <ShieldCheck size={14} />
                        权限发生变化。请单独启用，并在浏览器提示中确认新的权限。
                      </p>
                    )}
                    <div className="detail-id">
                      <code>{detailItem.id}</code>
                      <button
                        className="icon-button"
                        aria-label="复制扩展 ID"
                        onClick={() => {
                          void navigator.clipboard.writeText(detailItem.id).then(
                            () => setNotice('扩展 ID 已复制'),
                            (err) => setError(message(err)),
                          );
                        }}
                      >
                        <Copy size={13} />
                      </button>
                    </div>
                    <form
                      onSubmit={(event) => {
                        event.preventDefault();
                        const form = dialog;
                        void commit((current) => {
                          const meta = { ...current.meta[detailItem.id], note: form.note };
                          if (form.groupId) meta.groupId = form.groupId;
                          else delete meta.groupId;
                          return recordActivity(
                            { ...current, meta: { ...current.meta, [detailItem.id]: meta } },
                            `更新 ${detailItem.name} 的分组与备注`,
                          );
                        }, '扩展配置已保存').then((success) => {
                          if (success) setDialog(null);
                        });
                      }}
                    >
                      <label className="field-label">
                        所属分组
                        <select
                          aria-label="所属分组"
                          value={dialog.groupId}
                          onChange={(event) =>
                            setDialog({ ...dialog, groupId: event.target.value })
                          }
                        >
                          <option value="">未分组</option>
                          {data?.groups.map((group) => (
                            <option key={group.id} value={group.id}>
                              {group.name}
                            </option>
                          ))}
                        </select>
                      </label>
                      <label className="field-label">
                        扩展备注
                        <textarea
                          aria-label="扩展备注"
                          placeholder="记下用途、使用技巧或待办…"
                          maxLength={4000}
                          rows={2}
                          value={dialog.note}
                          onChange={(event) => setDialog({ ...dialog, note: event.target.value })}
                        />
                      </label>
                      <button
                        className="primary-button save-detail"
                        type="submit"
                        disabled={saving}
                      >
                        {saving ? <LoaderCircle size={13} className="spin" /> : <Check size={13} />}
                        保存更改
                      </button>
                    </form>
                    <details className="permission-section" open>
                      <summary>
                        <ShieldCheck size={14} />
                        权限与访问范围
                        <span>
                          {detailItem.permissions.length +
                            (detailItem.hostPermissions?.length || 0)}
                        </span>
                      </summary>
                      {warningsError ? (
                        <p className="permission-error">{warningsError}</p>
                      ) : warnings === null ? (
                        <p>正在读取浏览器权限提示…</p>
                      ) : warnings.length ? (
                        warnings.map((warning, index) => <p key={index}>{warning}</p>)
                      ) : (
                        <p>浏览器未返回额外权限警告。这不代表扩展没有权限。</p>
                      )}
                      <div className="permission-tags">
                        {[...detailItem.permissions, ...(detailItem.hostPermissions || [])].map(
                          (permission) => (
                            <code key={permission}>{permission}</code>
                          ),
                        )}
                      </div>
                    </details>
                    <div className="detail-actions">
                      {detailItem.optionsUrl && (
                        <button
                          className="secondary-button"
                          onClick={() => runLink(openUrl(detailItem.optionsUrl))}
                        >
                          扩展设置
                          <ArrowUpRight size={12} />
                        </button>
                      )}
                      <button
                        className="secondary-button"
                        onClick={() => runLink(openNativeManager(detailItem.id))}
                      >
                        浏览器详情
                        <ArrowUpRight size={12} />
                      </button>
                      {detailItem.homepageUrl && (
                        <button
                          className="secondary-button"
                          onClick={() => runLink(openUrl(detailItem.homepageUrl!))}
                        >
                          项目主页
                          <ArrowUpRight size={12} />
                        </button>
                      )}
                      <button
                        className="danger-button"
                        disabled={!canUninstall(detailItem) || busyIds.includes(detailItem.id)}
                        onClick={() => {
                          void removeItem(detailItem);
                        }}
                      >
                        <Trash2 size={12} />
                        卸载扩展
                      </button>
                    </div>
                  </>
                ) : (
                  <div className="empty-state">
                    <CircleAlert size={25} />
                    <p>此扩展已被移除</p>
                    <button className="secondary-button" onClick={() => setDialog(null)}>
                      返回
                    </button>
                  </div>
                ))}
              {dialog.type === 'group' && (
                <form
                  onSubmit={(event) => {
                    event.preventDefault();
                    const name = dialog.name.trim();
                    if (!name) {
                      setError('请输入分组名称。');
                      return;
                    }
                    void commit((current) => {
                      if (current.groups.some((group) => group.name === name))
                        throw new Error('已有同名分组，请换一个名称。');
                      return recordActivity(
                        { ...current, groups: [...current.groups, { id: uid(), name }] },
                        `创建分组「${name}」`,
                      );
                    }, '分组已创建').then((success) => {
                      if (success) setDialog(null);
                    });
                  }}
                >
                  <p className="dialog-description">按用途收纳扩展，常用工具更容易找到。</p>
                  <label className="field-label">
                    分组名称
                    <input
                      aria-label="分组名称"
                      maxLength={80}
                      required
                      value={dialog.name}
                      placeholder="例如：设计与灵感"
                      onChange={(event) => setDialog({ ...dialog, name: event.target.value })}
                    />
                  </label>
                  <div className="dialog-actions">
                    <button
                      className="secondary-button"
                      type="button"
                      disabled={saving}
                      onClick={() => setDialog(null)}
                    >
                      取消
                    </button>
                    <button className="primary-button" type="submit" disabled={saving}>
                      创建分组
                    </button>
                  </div>
                </form>
              )}
              {dialog.type === 'batch-group' && (
                <>
                  <p className="dialog-description">
                    将 {dialog.ids.length} 个所选扩展移动到同一分组。
                  </p>
                  <label className="field-label">
                    目标分组
                    <select
                      aria-label="目标分组"
                      value={dialog.groupId}
                      onChange={(event) => setDialog({ ...dialog, groupId: event.target.value })}
                    >
                      <option value="">未分组</option>
                      {data?.groups.map((group) => (
                        <option key={group.id} value={group.id}>
                          {group.name}
                        </option>
                      ))}
                    </select>
                  </label>
                  <div className="dialog-actions">
                    <button
                      className="secondary-button"
                      disabled={saving}
                      onClick={() => setDialog(null)}
                    >
                      取消
                    </button>
                    <button
                      className="primary-button"
                      disabled={saving}
                      onClick={() => {
                        const form = dialog;
                        void commit((current) => {
                          const meta = { ...current.meta };
                          for (const id of form.ids) {
                            meta[id] = { ...meta[id] };
                            if (form.groupId) meta[id].groupId = form.groupId;
                            else delete meta[id].groupId;
                          }
                          return recordActivity(
                            { ...current, meta },
                            `批量调整 ${form.ids.length} 个扩展的分组`,
                          );
                        }, '所选扩展的分组已更新').then((success) => {
                          if (success) setDialog(null);
                        });
                      }}
                    >
                      确认移动
                    </button>
                  </div>
                </>
              )}
              {dialog.type === 'scene-form' && (
                <form
                  onSubmit={(event) => {
                    void saveScene(event);
                  }}
                >
                  <div className="scene-form-fields">
                    <label className="field-label">
                      场景名称
                      <input
                        aria-label="场景名称"
                        maxLength={80}
                        required
                        placeholder="例如：专注写作"
                        value={dialog.name}
                        onChange={(event) => setDialog({ ...dialog, name: event.target.value })}
                      />
                    </label>
                    <label className="field-label">
                      场景说明
                      <input
                        aria-label="场景说明"
                        maxLength={500}
                        placeholder="为这个场景写一句话"
                        value={dialog.description}
                        onChange={(event) =>
                          setDialog({ ...dialog, description: event.target.value })
                        }
                      />
                    </label>
                  </div>
                  <div className="scene-editor-label">
                    <b>选择场景管理的扩展</b>
                    <span>
                      <button
                        className="text-button"
                        type="button"
                        onClick={() =>
                          setDialog({
                            ...dialog,
                            scopeIds: sceneCandidates.map((item) => item.id),
                            enabledIds: sceneCandidates
                              .filter((item) => item.enabled)
                              .map((item) => item.id),
                          })
                        }
                      >
                        使用当前状态
                      </button>
                      <button
                        className="text-button"
                        type="button"
                        onClick={() => setDialog({ ...dialog, scopeIds: [], enabledIds: [] })}
                      >
                        清空
                      </button>
                    </span>
                  </div>
                  <p className="section-hint">
                    勾选管理范围，再选择切换时启用或停用。未勾选的扩展保持原状。
                  </p>
                  <div className="scene-editor-list">
                    {sceneCandidates.map((item) => (
                      <div className="scene-editor-row" key={item.id}>
                        <label>
                          <input
                            type="checkbox"
                            aria-label={`场景管理 ${item.name}`}
                            checked={dialog.scopeIds.includes(item.id)}
                            onChange={() =>
                              setDialog({
                                ...dialog,
                                scopeIds: dialog.scopeIds.includes(item.id)
                                  ? dialog.scopeIds.filter((id) => id !== item.id)
                                  : [...dialog.scopeIds, item.id],
                                enabledIds: dialog.scopeIds.includes(item.id)
                                  ? dialog.enabledIds.filter((id) => id !== item.id)
                                  : dialog.enabledIds,
                              })
                            }
                          />
                          <ExtensionIcon item={item} />
                          <span>{item.name}</span>
                        </label>
                        <button
                          type="button"
                          className={`scene-state ${dialog.enabledIds.includes(item.id) ? 'active' : ''}`}
                          disabled={!dialog.scopeIds.includes(item.id)}
                          aria-label={`场景中${dialog.enabledIds.includes(item.id) ? '停用' : '启用'} ${item.name}`}
                          onClick={() =>
                            setDialog({
                              ...dialog,
                              enabledIds: dialog.enabledIds.includes(item.id)
                                ? dialog.enabledIds.filter((id) => id !== item.id)
                                : [...dialog.enabledIds, item.id],
                            })
                          }
                        >
                          {dialog.enabledIds.includes(item.id) ? '启用' : '停用'}
                        </button>
                      </div>
                    ))}
                    {dialog.scopeIds
                      .filter((id) => !sceneCandidates.some((item) => item.id === id))
                      .map((id) => (
                        <div className="scene-editor-row unavailable" key={id}>
                          <span>{items.find((item) => item.id === id)?.name || id}</span>
                          <small>已保存 · 当前不可管理</small>
                          <button
                            className="icon-button"
                            type="button"
                            aria-label={`移出场景 ${id}`}
                            onClick={() =>
                              setDialog({
                                ...dialog,
                                scopeIds: dialog.scopeIds.filter((value) => value !== id),
                                enabledIds: dialog.enabledIds.filter((value) => value !== id),
                              })
                            }
                          >
                            <X size={12} />
                          </button>
                        </div>
                      ))}
                  </div>
                  <div className="dialog-actions">
                    <span className="dialog-selection-count">
                      {dialog.scopeIds.length} 项管理 · {dialog.enabledIds.length} 项启用
                    </span>
                    <button
                      className="secondary-button"
                      type="button"
                      disabled={saving}
                      onClick={() => setDialog(null)}
                    >
                      取消
                    </button>
                    <button
                      className="primary-button"
                      type="submit"
                      disabled={saving || !dialog.scopeIds.length}
                    >
                      保存场景
                    </button>
                  </div>
                </form>
              )}
              {dialog.type === 'delete-scene' && (
                <>
                  <p className="dialog-description">
                    删除「{dialog.scene.name}」？仅删除此场景配置，当前扩展状态保持不变。
                  </p>
                  <div className="dialog-actions">
                    <button
                      className="secondary-button"
                      disabled={saving}
                      onClick={() => setDialog(null)}
                    >
                      取消
                    </button>
                    <button
                      className="danger-button danger-filled"
                      disabled={saving}
                      onClick={() => {
                        const scene = dialog.scene;
                        void commit(
                          (current) =>
                            recordActivity(
                              {
                                ...current,
                                scenes: current.scenes.filter((entry) => entry.id !== scene.id),
                              },
                              `删除场景「${scene.name}」`,
                            ),
                          '场景已删除',
                        ).then((success) => {
                          if (success) setDialog(null);
                        });
                      }}
                    >
                      确认删除
                    </button>
                  </div>
                </>
              )}
              {dialog.type === 'apply' && (
                <>
                  <p className="dialog-description">{dialog.description}</p>
                  <div className="change-summary">
                    <span>
                      <b>{currentChanges.length}</b> 项待调整
                    </span>
                    <span>
                      <b>{dialog.scopeIds.length}</b> 项管理范围
                    </span>
                  </div>
                  <div className="change-list">
                    {currentChanges.map((id) => {
                      const item = items.find((entry) => entry.id === id);
                      const reason = !item
                        ? '未安装 · 跳过'
                        : !canToggle(item)
                          ? `${protectedReason(item)} · 跳过`
                          : !item.enabled && item.disabledReason === 'permissions_increase'
                            ? '需要单独授权 · 跳过'
                            : dialog.enabledIds.includes(id)
                              ? '启用'
                              : '停用';
                      return (
                        <div key={id}>
                          {item ? (
                            <ExtensionIcon item={item} />
                          ) : (
                            <span className="unknown-icon">
                              <CircleAlert size={15} />
                            </span>
                          )}
                          <span>{item?.name || id}</span>
                          <small>{reason}</small>
                        </div>
                      );
                    })}
                    {!currentChanges.length && (
                      <div className="unchanged">
                        <Check size={17} />
                        当前状态已匹配，无需调整。
                      </div>
                    )}
                  </div>
                  <p className="section-hint">
                    浏览器可能要求再次确认。未安装的扩展不会自动安装。批量操作逐项执行，无法保证全部成功。
                  </p>
                  <div className="dialog-actions">
                    <button
                      className="secondary-button"
                      disabled={applying}
                      onClick={() => setDialog(null)}
                    >
                      取消
                    </button>
                    <button
                      className="primary-button"
                      disabled={applying || !currentChanges.length}
                      onClick={() => {
                        void executeChanges();
                      }}
                    >
                      {applying ? (
                        <>
                          <LoaderCircle className="spin" size={13} />
                          正在执行
                        </>
                      ) : (
                        '确认执行'
                      )}
                    </button>
                  </div>
                </>
              )}
              {dialog.type === 'result' && (
                <>
                  <div className="result-summary">
                    <span>
                      <b>{dialog.result.succeeded.length}</b>已完成
                    </span>
                    <span>
                      <b>{dialog.result.skipped.length}</b>已跳过
                    </span>
                    <span>
                      <b>{dialog.result.failed.length}</b>未完成
                    </span>
                  </div>
                  <div className="change-list result-list">
                    {dialog.result.succeeded.map((id) => (
                      <div key={id}>
                        <Check size={14} />
                        <span>{items.find((item) => item.id === id)?.name || id}</span>
                        <small>已完成</small>
                      </div>
                    ))}
                    {dialog.result.skipped.map((id) => (
                      <div key={id}>
                        <LockKeyhole size={14} />
                        <span>{items.find((item) => item.id === id)?.name || id}</span>
                        <small>
                          {!items.some((item) => item.id === id) ? '未安装' : '受保护或需单独授权'}
                        </small>
                      </div>
                    ))}
                    {dialog.result.failed.map((failure) => (
                      <div className="failed-result" key={failure.id}>
                        <CircleAlert size={14} />
                        <span>
                          {items.find((item) => item.id === failure.id)?.name || failure.id}
                          <small>{failure.error}</small>
                        </span>
                      </div>
                    ))}
                  </div>
                  {dialog.secondary && <p className="inline-note">{dialog.secondary}</p>}
                  <div className="dialog-actions">
                    <button className="primary-button" onClick={() => setDialog(null)}>
                      完成
                    </button>
                  </div>
                </>
              )}
              {dialog.type === 'import' && (
                <>
                  <p className="dialog-description">
                    将备份合并到当前工作空间。同 ID 的分组、场景和备注以备份为准，并恢复外观偏好。
                  </p>
                  <div className="result-summary">
                    <span>
                      <b>{dialog.backup.data.groups.length}</b>个分组
                    </span>
                    <span>
                      <b>{dialog.backup.data.scenes.length}</b>个场景
                    </span>
                    <span>
                      <b>{Object.keys(dialog.backup.data.meta).length}</b>项扩展配置
                    </span>
                  </div>
                  <p className="inline-note">
                    <FileJson size={15} />
                    仅恢复管理器配置。不会安装、启停扩展或恢复扩展自身的数据。
                  </p>
                  <div className="change-list import-list">
                    {dialog.backup.inventory.map((item) => (
                      <div key={item.id}>
                        <span>{item.name}</span>
                        <small>
                          {items.some((entry) => entry.id === item.id) ? '已安装' : '当前未安装'}
                        </small>
                      </div>
                    ))}
                  </div>
                  <div className="dialog-actions">
                    <button
                      className="secondary-button"
                      disabled={saving}
                      onClick={() => setDialog(null)}
                    >
                      取消
                    </button>
                    <button
                      className="primary-button"
                      disabled={saving}
                      onClick={() => {
                        const backup = dialog.backup.data;
                        void commit(
                          (current) =>
                            recordActivity(
                              {
                                ...current,
                                groups: [
                                  ...new Map(
                                    [...current.groups, ...backup.groups].map((group) => [
                                      group.id,
                                      group,
                                    ]),
                                  ).values(),
                                ],
                                scenes: [
                                  ...new Map(
                                    [...current.scenes, ...backup.scenes].map((scene) => [
                                      scene.id,
                                      scene,
                                    ]),
                                  ).values(),
                                ],
                                meta: { ...current.meta, ...backup.meta },
                                settings: { ...current.settings, ...backup.settings },
                              },
                              '导入并合并备份配置',
                            ),
                          '配置已导入，扩展状态保持不变',
                        ).then((success) => {
                          if (success) setDialog(null);
                        });
                      }}
                    >
                      合并导入
                    </button>
                  </div>
                </>
              )}
            </div>
          </section>
        </div>
      )}
    </main>
  );
}
createRoot(document.getElementById('root')!).render(<Popup />);
