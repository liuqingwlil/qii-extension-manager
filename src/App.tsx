import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import {
  ArrowDownToLine,
  ArrowUpRight,
  BookOpen,
  Check,
  CheckCheck,
  ChevronDown,
  ChevronRight,
  CircleHelp,
  Clock3,
  ExternalLink,
  FileJson,
  Folder,
  FolderPlus,
  Grid2X2,
  History,
  Layers3,
  List,
  Loader2,
  LockKeyhole,
  Monitor,
  MoreHorizontal,
  Pause,
  Pencil,
  Play,
  Plus,
  Puzzle,
  Search,
  Settings2,
  ShieldCheck,
  SlidersHorizontal,
  Sparkles,
  Sprout,
  Star,
  Sun,
  Trash2,
  Upload,
  X,
  Zap,
} from 'lucide-react';
import {
  applyChanges,
  browserName,
  canToggle,
  canUninstall,
  isDemo,
  listExtensions,
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
  updateData,
  subscribeData,
} from './core/storage';
import type { AppData, BatchResult, ExtensionItem, Group, Scene } from './core/types';
import { applyAppearance } from './core/appearance';
import { SkinAvatar, SkinPicker } from './SkinPicker';
import { createFullBackup } from './core/backup';
import { BackupRestorePanel, LastRestoreSummary } from './BackupRestorePanel';
import { MigrationPanel } from './MigrationPanel';

type ModalState =
  | { type: 'detail'; item: ExtensionItem }
  | { type: 'group'; group?: Group }
  | { type: 'scene'; scene?: Scene }
  | { type: 'apply'; scene: Scene }
  | { type: 'batch'; enabled: boolean; ids: string[] }
  | { type: 'result'; result: BatchResult }
  | { type: 'deleteGroup'; group: Group }
  | { type: 'deleteScene'; scene: Scene }
  | { type: 'import'; backup: ReturnType<typeof parseBackup> }
  | { type: 'restore'; backup: ReturnType<typeof parseBackup> }
  | { type: 'help' };
const permissionNames: Record<string, string> = {
  tabs: '读取标签页信息',
  storage: '存储本地数据',
  cookies: '访问 Cookie',
  webRequest: '观察网络请求',
  webRequestBlocking: '拦截网络请求',
  history: '访问浏览历史',
  bookmarks: '访问书签',
  downloads: '管理下载',
  clipboardRead: '读取剪贴板',
  clipboardWrite: '写入剪贴板',
  management: '管理其他扩展',
  nativeMessaging: '与本地应用通信',
  debugger: '调试浏览器',
  scripting: '执行页面脚本',
  activeTab: '访问当前标签页',
  notifications: '发送通知',
  contextMenus: '创建右键菜单',
  declarativeNetRequest: '过滤网络请求',
  alarms: '设置定时任务',
  unlimitedStorage: '扩展存储配额',
};
const installNames: Record<string, string> = {
  normal: '商店 / 普通安装',
  development: '开发者模式',
  admin: '组织策略安装',
  sideload: '外部安装',
  other: '其他来源',
};
const typeNames: Record<string, string> = {
  extension: '扩展',
  theme: '主题',
  hosted_app: '托管应用',
  packaged_app: '打包应用',
  legacy_packaged_app: '旧版应用',
  login_screen_extension: '登录扩展',
};
const sortNames = { name: '名称排序', enabled: '启用优先', group: '分组排序' };
const hasBroadAccess = (item: ExtensionItem) =>
  item.hostPermissions.some(
    (p) => p === '<all_urls>' || p === '*://*/*' || p === 'http://*/*' || p === 'https://*/*',
  );
const shortTime = (at: number) =>
  new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(at);

function Modal({
  title,
  subtitle,
  children,
  onClose,
  wide = false,
}: {
  title: string;
  subtitle?: string;
  children: ReactNode;
  onClose: () => void;
  wide?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    ref.current?.showModal();
    return () => ref.current?.close();
  }, []);
  return (
    <dialog
      ref={ref}
      className={`modal ${wide ? 'wide' : ''}`}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) {
          const r = e.currentTarget.getBoundingClientRect();
          if (
            e.clientX < r.left ||
            e.clientX > r.right ||
            e.clientY < r.top ||
            e.clientY > r.bottom
          )
            onClose();
        }
      }}
      aria-labelledby="modal-title"
    >
      <header className="modal-head">
        <div>
          <h2 id="modal-title">{title}</h2>
          {subtitle && <p>{subtitle}</p>}
        </div>
        <button className="icon-button" aria-label="关闭弹窗" onClick={onClose}>
          <X size={20} />
        </button>
      </header>
      {children}
    </dialog>
  );
}
function AppIcon({ item }: { item: ExtensionItem }) {
  const [broken, setBroken] = useState(false);
  const icon = item.icons?.slice().sort((a, b) => b.size - a.size)[0]?.url;
  if (icon && !broken)
    return <img className="app-icon" src={icon} alt="" onError={() => setBroken(true)} />;
  return (
    <span
      className="app-icon fallback"
      style={{
        background: item.demoColor || 'var(--subtle)',
        color: item.demoColor ? '#fff' : 'var(--green)',
      }}
    >
      {item.demoGlyph || item.name.slice(0, 1).toUpperCase()}
    </span>
  );
}
function GroupForm({ group, onSave }: { group?: Group; onSave: (name: string) => void }) {
  const [name, setName] = useState(group?.name || '');
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (name.trim()) onSave(name.trim());
      }}
    >
      <label className="field">
        分组名称
        <input
          autoFocus
          required
          maxLength={40}
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="例如：工作效率、阅读收藏"
        />
      </label>
      <p className="hint">给常用工具一个位置。每个扩展可以归入一个分组。</p>
      <footer className="modal-actions">
        <button className="button primary" type="submit">
          {group ? '保存修改' : '创建分组'}
        </button>
      </footer>
    </form>
  );
}
function SceneForm({
  scene,
  items,
  onSave,
}: {
  scene?: Scene;
  items: ExtensionItem[];
  onSave: (scene: Scene) => void;
}) {
  const [name, setName] = useState(scene?.name || '');
  const [description, setDescription] = useState(scene?.description || '');
  const [ids, setIds] = useState(
    new Set(scene?.enabledIds || items.filter((i) => i.enabled).map((i) => i.id)),
  );
  const [q, setQ] = useState('');
  const scope = items.filter(canToggle);
  const show = scope.filter((i) => i.name.toLowerCase().includes(q.toLowerCase()));
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (name.trim())
          onSave({
            id: scene?.id || crypto.randomUUID(),
            name: name.trim(),
            description: description.trim(),
            enabledIds: [...ids].filter((id) => scope.some((i) => i.id === id)),
            scopeIds: scope.map((i) => i.id),
            createdAt: scene?.createdAt || Date.now(),
          });
      }}
    >
      <div className="form-columns">
        <label className="field">
          场景名称
          <input
            autoFocus
            required
            maxLength={40}
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="例如：专注工作"
          />
        </label>
        <label className="field">
          一句话描述
          <input
            maxLength={120}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="只留下此刻需要的工具"
          />
        </label>
      </div>
      <div className="notice">
        <Layers3 size={17} />
        <span>
          勾选此场景需要启用的扩展，未勾选的可管理扩展将停用。应用前可以预览变更；未来安装的扩展不受影响。
        </span>
      </div>
      <div className="search-field compact">
        <Search size={17} />
        <input
          aria-label="搜索场景扩展"
          placeholder="搜索扩展"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
      </div>
      <div className="scene-checklist">
        {show.map((item) => (
          <label className="check-row" key={item.id}>
            <input
              type="checkbox"
              checked={ids.has(item.id)}
              onChange={(e) =>
                setIds((s) => {
                  const n = new Set(s);
                  e.target.checked ? n.add(item.id) : n.delete(item.id);
                  return n;
                })
              }
            />
            <AppIcon item={item} />
            <span>
              {item.name}
              <small>当前{item.enabled ? '已启用' : '已停用'}</small>
            </span>
            {ids.has(item.id) && <span className="muted small">场景中启用</span>}
          </label>
        ))}
        {!show.length && <p className="empty-small">没有匹配的可管理扩展</p>}
      </div>
      <footer className="modal-actions">
        <span className="muted small">场景将管理 {scope.length} 个扩展</span>
        <button className="button primary" type="submit">
          保存场景
        </button>
      </footer>
    </form>
  );
}
function ExtensionDetail({
  item,
  data,
  onMeta,
  onToggle,
  onUninstall,
  notify,
}: {
  item: ExtensionItem;
  data: AppData;
  onMeta: (patch: { groupId?: string; note?: string }) => void;
  onToggle: () => void;
  onUninstall: () => void;
  notify: (text: string) => void;
}) {
  const [warnings, setWarnings] = useState<string[] | null>(null);
  const [error, setError] = useState('');
  const [note, setNote] = useState(data.meta[item.id]?.note || '');
  useEffect(() => {
    let alive = true;
    permissionWarnings(item.id)
      .then((w) => alive && setWarnings(w))
      .catch((e) => alive && setError(String(e)));
    return () => {
      alive = false;
    };
  }, [item.id]);
  return (
    <div className="detail">
      <div className="detail-identity">
        <AppIcon item={item} />
        <div>
          <h3>{item.name}</h3>
          <span className="muted">
            版本 {item.versionName || item.version} · {typeNames[item.type] || item.type}
          </span>
        </div>
        <span className={`status-pill ${item.enabled ? 'on' : ''}`}>
          {item.enabled ? '已启用' : '已停用'}
        </span>
      </div>
      <p className="detail-description">{item.description || '此项目没有提供描述。'}</p>
      <div className="detail-actions">
        <button
          className="button"
          onClick={() => void openNativeManager(item.id).catch((e) => notify(String(e)))}
        >
          <SlidersHorizontal size={16} />
          浏览器详情
        </button>
        {item.optionsUrl && (
          <button
            className="button"
            onClick={() => void openUrl(item.optionsUrl).catch((e) => notify(String(e)))}
          >
            <Settings2 size={16} />
            扩展选项
          </button>
        )}
        {item.homepageUrl && (
          <button
            className="button"
            onClick={() => void openUrl(item.homepageUrl!).catch((e) => notify(String(e)))}
          >
            <ExternalLink size={16} />
            主页
          </button>
        )}
      </div>
      <div className="detail-grid">
        <label className="field">
          所属分组
          <select
            value={data.meta[item.id]?.groupId || ''}
            onChange={(e) => onMeta({ groupId: e.target.value || undefined })}
          >
            <option value="">未分组</option>
            {data.groups.map((g) => (
              <option key={g.id} value={g.id}>
                {g.name}
              </option>
            ))}
          </select>
        </label>
        <div className="field">
          安装来源
          <div className="static-field">
            {installNames[item.installType] || item.installType}
            {!item.mayDisable && <LockKeyhole size={14} />}
          </div>
        </div>
      </div>
      <label className="field">
        我的备注
        <textarea
          rows={2}
          maxLength={1000}
          value={note}
          onChange={(e) => setNote(e.target.value)}
          onBlur={() => {
            if (note !== (data.meta[item.id]?.note || '')) onMeta({ note });
          }}
          placeholder="记下用途、快捷键，或暂时停用的原因……"
        />
      </label>
      <div className="id-row">
        <code>{item.id}</code>
        <button
          className="text-button"
          onClick={() =>
            void navigator.clipboard
              .writeText(item.id)
              .then(() => notify('扩展 ID 已复制'))
              .catch(() => notify('无法访问剪贴板，请手动复制 ID'))
          }
        >
          复制 ID
        </button>
      </div>
      <section className="permissions-section">
        <h3>
          <ShieldCheck size={17} />
          权限审阅
        </h3>
        <p className="hint">
          以下为浏览器报告的声明权限，不代表恶意判断。站点访问、无痕及文件访问请在浏览器详情中调整。
        </p>
        {error ? (
          <p className="error-inline">{error}</p>
        ) : warnings === null ? (
          <p className="muted">正在读取浏览器权限说明…</p>
        ) : warnings.length ? (
          <ul className="warning-list">
            {warnings.map((w, i) => (
              <li key={i}>{w}</li>
            ))}
          </ul>
        ) : (
          <p className="notice small">浏览器未提供权限警告。</p>
        )}
        <details className="permission-details">
          <summary>
            API 权限（{item.permissions.length}）与站点声明（{item.hostPermissions.length}）
            <ChevronDown size={15} />
          </summary>
          <div className="permission-tags">
            {item.permissions.map((p) => (
              <span key={p} title={p}>
                {permissionNames[p] || p}
              </span>
            ))}
          </div>
          <div className="host-list">
            {item.hostPermissions.map((p) => (
              <code key={p}>{p}</code>
            ))}
            {!item.hostPermissions.length && <span className="muted small">未声明站点权限</span>}
          </div>
        </details>
      </section>
      {item.id === selfId && (
        <p className="notice">
          <LockKeyhole size={16} />
          管理器受到自我保护，避免失去管理入口。
        </p>
      )}
      {item.disabledReason === 'permissions_increase' && (
        <p className="notice">此扩展需要重新授权，请单独点击启用，并完成浏览器确认。</p>
      )}
      <footer className="modal-actions">
        <button className="button danger-text" disabled={!canUninstall(item)} onClick={onUninstall}>
          <Trash2 size={16} />
          卸载扩展
        </button>
        <button className="button primary" disabled={!canToggle(item)} onClick={onToggle}>
          {item.enabled ? '停用扩展' : '启用扩展'}
        </button>
      </footer>
    </div>
  );
}

export default function App() {
  const [items, setItems] = useState<ExtensionItem[]>([]);
  const [data, setData] = useState<AppData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [dataError, setDataError] = useState('');
  const [route, setRoute] = useState(() =>
    new URLSearchParams(location.search).has('migration') ? 'settings' : 'all',
  );
  const [query, setQuery] = useState('');
  const [groupFilter, setGroupFilter] = useState('all');
  const [statusFilter, setStatusFilter] = useState('all');
  const [typeFilter, setTypeFilter] = useState('all');
  const [modal, setModal] = useState<ModalState | null>(null);
  const [toast, setToast] = useState('');
  const [batchMode, setBatchMode] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [exportingFull, setExportingFull] = useState(false);
  const [restoreRevision, setRestoreRevision] = useState(0);
  const [pending, setPending] = useState<Set<string>>(new Set());
  const searchRef = useRef<HTMLInputElement>(null);
  const importRef = useRef<HTMLInputElement>(null);
  const restoreImportRef = useRef<HTMLInputElement>(null);
  const latest = useRef(data);
  const reloadRequestId = useRef(0);
  latest.current = data;
  const notify = useCallback((text: string) => setToast(text), []);
  const reload = useCallback(async () => {
    const requestId = ++reloadRequestId.current;
    try {
      const next = await listExtensions();
      if (requestId !== reloadRequestId.current) return;
      setItems(next);
      setError('');
    } catch (e) {
      if (requestId === reloadRequestId.current)
        setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (requestId === reloadRequestId.current) setLoading(false);
    }
  }, []);
  useEffect(() => {
    void reload();
    void getData()
      .then((value) => {
        setData(value);
        setDataError('');
      })
      .catch((e) => {
        setDataError(`读取配置失败：${String(e)}`);
        setLoading(false);
      });
    const off = subscribeExtensions(() => void reload());
    const offData = subscribeData(
      () =>
        void getData()
          .then(setData)
          .catch((e) => notify(String(e))),
    );
    return () => {
      off();
      offData();
    };
  }, [reload, notify]);
  useEffect(() => {
    if (!toast) return;
    const id = setTimeout(() => setToast(''), 5500);
    return () => clearTimeout(id);
  }, [toast]);
  useEffect(() => applyAppearance(data?.settings), [data?.settings.theme, data?.settings.skin]);
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
        e.preventDefault();
        searchRef.current?.focus();
      }
      if (e.key === 'Escape' && !modal) {
        setBatchMode(false);
        setSelected(new Set());
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [modal]);
  const commit = async (fn: (current: AppData) => AppData) => {
    try {
      const next = await updateData(fn);
      setData(next);
    } catch (e) {
      notify(`保存失败：${e instanceof Error ? e.message : String(e)}`);
      throw e;
    }
  };
  const safeCommit = (fn: (current: AppData) => AppData) => void commit(fn).catch(() => {});
  const meta = (id: string, patch: Partial<AppData['meta'][string]>) =>
    safeCommit((d) => ({ ...d, meta: { ...d.meta, [id]: { ...d.meta[id], ...patch } } }));
  const go = (r: string) => {
    setRoute(r);
    setQuery('');
    setGroupFilter('all');
    setStatusFilter('all');
    setTypeFilter('all');
    setSelected(new Set());
    setBatchMode(false);
  };
  const toggle = (item: ExtensionItem) => {
    if (pending.has(item.id) || !canToggle(item)) return;
    reloadRequestId.current++;
    const operation = setExtensionEnabled(item, !item.enabled);
    setPending((s) => new Set(s).add(item.id));
    void operation
      .then(async () => {
        setItems((current) =>
          current.map((entry) =>
            entry.id === item.id ? { ...entry, enabled: !item.enabled } : entry,
          ),
        );
        await reload();
        safeCommit((d) => recordActivity(d, `${item.enabled ? '停用' : '启用'} ${item.name}`));
        notify(`${item.name} 已${item.enabled ? '停用' : '启用'}`);
      })
      .catch((e) => notify(`操作未完成：${e instanceof Error ? e.message : String(e)}`))
      .finally(() =>
        setPending((s) => {
          const n = new Set(s);
          n.delete(item.id);
          return n;
        }),
      );
  };
  const uninstall = (item: ExtensionItem) => {
    if (!canUninstall(item)) return;
    const operation = uninstallExtension(item);
    setModal(null);
    void operation
      .then(async () => {
        await reload();
        safeCommit((d) => recordActivity(d, `卸载 ${item.name}`));
        notify(`${item.name} 已卸载`);
      })
      .catch((e) => notify(`卸载未完成：${e instanceof Error ? e.message : String(e)}`));
  };
  const runChanges = (enabledIds: string[], scopeIds: string[], label: string) => {
    if (busy) return;
    const operation = applyChanges(items, enabledIds, scopeIds);
    setBusy(true);
    void operation
      .then(async (result) => {
        await reload();
        safeCommit((d) =>
          recordActivity(
            d,
            `${label}：成功 ${result.succeeded.length}，跳过 ${result.skipped.length}，失败 ${result.failed.length}`,
          ),
        );
        setModal({ type: 'result', result });
        setSelected(new Set());
        setBatchMode(false);
      })
      .catch((e) => notify(`操作未完成：${String(e)}`))
      .finally(() => setBusy(false));
  };
  const count = {
    all: items.length,
    enabled: items.filter((i) => i.enabled).length,
    disabled: items.filter((i) => !i.enabled).length,
    favorites: items.filter((i) => data?.meta[i.id]?.favorite).length,
  };
  const groupName = (id: string) => data?.groups.find((g) => g.id === id)?.name || '未分组';
  const filtered = items
    .filter((i) => {
      const m = data?.meta[i.id];
      const text =
        `${i.name} ${i.description} ${i.id} ${m?.note || ''} ${groupName(m?.groupId || '')}`.toLowerCase();
      return (
        text.includes(query.trim().toLowerCase()) &&
        (route !== 'enabled' || i.enabled) &&
        (route !== 'disabled' || !i.enabled) &&
        (route !== 'favorites' || m?.favorite) &&
        (!route.startsWith('group:') || m?.groupId === route.slice(6)) &&
        (groupFilter === 'all' ||
          (groupFilter === 'ungrouped' ? !m?.groupId : m?.groupId === groupFilter)) &&
        (statusFilter === 'all' || (statusFilter === 'enabled' ? i.enabled : !i.enabled)) &&
        (typeFilter === 'all' ||
          (typeFilter === 'extension'
            ? i.type === 'extension'
            : typeFilter === 'protected'
              ? !canToggle(i)
              : i.type !== 'extension'))
      );
    })
    .sort((a, b) => {
      if (route === 'permissions') {
        const delta = Number(hasBroadAccess(b)) - Number(hasBroadAccess(a));
        if (delta) return delta;
      }
      if (data?.settings.sort === 'enabled' && a.enabled !== b.enabled)
        return Number(b.enabled) - Number(a.enabled);
      if (data?.settings.sort === 'group') {
        const delta = groupName(data.meta[a.id]?.groupId || '').localeCompare(
          groupName(data.meta[b.id]?.groupId || ''),
          'zh-CN',
        );
        if (delta) return delta;
      }
      return a.name.localeCompare(b.name, 'zh-CN');
    });
  const titles: Record<string, string> = {
    all: '全部扩展',
    enabled: '已启用',
    disabled: '已停用',
    favorites: '我的收藏',
    permissions: '权限审阅',
    scenes: '我的场景',
    activity: '操作记录',
    settings: '偏好设置',
  };
  const title = route.startsWith('group:')
    ? groupName(route.slice(6))
    : titles[route] || '全部扩展';
  const isCollection = !['scenes', 'settings', 'activity'].includes(route);
  const selectItem = (id: string) =>
    setSelected((s) => {
      const n = new Set(s);
      n.has(id) ? n.delete(id) : n.add(id);
      return n;
    });
  const exportData = () => {
    if (!data) return;
    const url = URL.createObjectURL(
      new Blob([createBackup(data, items)], { type: 'application/json' }),
    );
    const a = document.createElement('a');
    a.href = url;
    a.download = `qii-backup-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    notify('配置与扩展清单已导出');
  };
  const importFile = async (file?: File) => {
    if (!file) return;
    try {
      if (file.size > 2 * 1024 * 1024) throw new Error('备份文件不能超过 2 MB');
      setModal({ type: 'import', backup: parseBackup(JSON.parse(await file.text())) });
    } catch (e) {
      notify(`无法导入：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      if (importRef.current) importRef.current.value = '';
    }
  };
  const exportAllExtensions = async () => {
    if (exportingFull) return;
    setExportingFull(true);
    try {
      const [latestData, inventory] = await Promise.all([getData(), listExtensions()]);
      const url = URL.createObjectURL(
        new Blob([createFullBackup(latestData, inventory)], { type: 'application/json' }),
      );
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = `qii-all-extensions-${new Date().toISOString().slice(0, 10)}.json`;
      document.body.append(anchor);
      anchor.click();
      anchor.remove();
      setTimeout(() => URL.revokeObjectURL(url), 30000);
      notify(`已导出配置与清单 JSON：${inventory.length} 个项目，不含扩展安装文件`);
    } catch (e) {
      notify(`导出失败：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setExportingFull(false);
    }
  };
  const importExtensionsBackup = async (file?: File) => {
    if (!file) return;
    try {
      if (file.size > 5 * 1024 * 1024) throw new Error('备份文件不能超过 5 MB');
      setModal({ type: 'restore', backup: parseBackup(JSON.parse(await file.text())) });
    } catch (e) {
      notify(`无法读取扩展备份：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      if (restoreImportRef.current) restoreImportRef.current.value = '';
    }
  };
  const handleRestoreApplied = () => {
    setRestoreRevision((value) => value + 1);
    void reload();
    void getData()
      .then(setData)
      .catch((e) => notify(`刷新配置失败：${String(e)}`));
  };
  const nav = [
    { id: 'all', label: '全部扩展', icon: Puzzle, count: count.all },
    { id: 'enabled', label: '已启用', icon: Play, count: count.enabled },
    { id: 'disabled', label: '已停用', icon: Pause, count: count.disabled },
    { id: 'favorites', label: '我的收藏', icon: Star, count: count.favorites },
  ];
  return (
    <div className="app-shell">
      <aside className="sidebar">
        <a
          className="brand"
          href="#"
          onClick={(e) => {
            e.preventDefault();
            go('all');
          }}
          aria-label="栖，返回全部扩展"
        >
          {data?.settings.skin === 'elysia' ? (
            <SkinAvatar />
          ) : (
            <span className="brand-mark">
              <i />
              <i />
              <i />
              <i />
            </span>
          )}
          <span>
            <strong>
              栖 <b>·</b> {data?.settings.skin === 'elysia' ? '爱莉希雅' : '扩展管理'}
            </strong>
            <small>A home for every extension.</small>
          </span>
        </a>
        <div className="workspace-label">
          <span className="online-dot" />
          {isDemo ? '交互演示空间' : `${browserName} 工作空间`}
          <span className="version">v1.4</span>
        </div>
        <nav aria-label="主要导航">
          <p className="nav-heading">我的工具箱</p>
          {nav.map((n) => (
            <button
              key={n.id}
              className={`nav-item ${route === n.id ? 'active' : ''}`}
              onClick={() => go(n.id)}
            >
              <n.icon size={18} />
              <span>{n.label}</span>
              <small>{n.count}</small>
            </button>
          ))}
          <div className="nav-divider" />
          {[
            { id: 'scenes', label: '场景切换', icon: Layers3 },
            { id: 'permissions', label: '权限审阅', icon: ShieldCheck },
            { id: 'activity', label: '操作记录', icon: History },
          ].map((n) => (
            <button
              key={n.id}
              className={`nav-item ${route === n.id ? 'active' : ''}`}
              onClick={() => go(n.id)}
            >
              <n.icon size={18} />
              <span>{n.label}</span>
              {n.id === 'scenes' && <small>{data?.scenes.length || 0}</small>}
            </button>
          ))}
          <div className="group-heading">
            <p className="nav-heading">自定义分组</p>
            <button
              className="icon-button"
              aria-label="新建分组"
              onClick={() => setModal({ type: 'group' })}
            >
              <Plus size={16} />
            </button>
          </div>
          {data?.groups.map((g) => (
            <div className={`group-nav ${route === `group:${g.id}` ? 'active' : ''}`} key={g.id}>
              <button className="nav-item" onClick={() => go(`group:${g.id}`)}>
                <Folder size={17} />
                <span>{g.name}</span>
                <small>{items.filter((i) => data.meta[i.id]?.groupId === g.id).length}</small>
              </button>
              <details className="mini-menu">
                <summary aria-label={`管理分组 ${g.name}`}>
                  <MoreHorizontal size={15} />
                </summary>
                <div className="dropdown">
                  <button onClick={() => setModal({ type: 'group', group: g })}>
                    <Pencil size={14} />
                    重命名
                  </button>
                  <button onClick={() => setModal({ type: 'deleteGroup', group: g })}>
                    <Trash2 size={14} />
                    删除分组
                  </button>
                </div>
              </details>
            </div>
          ))}
          {!data?.groups.length && (
            <button className="empty-group" onClick={() => setModal({ type: 'group' })}>
              <Plus size={15} />
              给工具创建一个分组
            </button>
          )}
        </nav>
        <div className="sidebar-bottom">
          <div className="sidebar-note">
            <Sprout size={24} />
            <span>
              少一点杂乱
              <br />
              <strong>多一点专注。</strong>
            </span>
          </div>
          <button
            className={`nav-item ${route === 'settings' ? 'active' : ''}`}
            onClick={() => go('settings')}
          >
            <Settings2 size={17} />
            <span>偏好设置</span>
          </button>
          <button className="nav-item" onClick={() => setModal({ type: 'help' })}>
            <CircleHelp size={17} />
            <span>使用帮助</span>
            <ArrowUpRight size={14} />
          </button>
          <div className="local-note">
            <LockKeyhole size={12} />
            数据仅保存在此设备
          </div>
        </div>
      </aside>
      <main className="main">
        <div className="topline">
          <span>
            我的工作空间 <ChevronRight size={13} /> {title}
          </span>
          <button
            className="text-button"
            onClick={() => void openNativeManager().catch((e) => notify(String(e)))}
          >
            浏览器扩展页 <ArrowUpRight size={14} />
          </button>
        </div>
        <header className="page-header">
          <div>
            <div className="eyebrow">YOUR EXTENSIONS, IN HARMONY</div>
            <h1>
              {title}
              <span className="title-dot">.</span>
            </h1>
            <p>
              {route === 'scenes'
                ? '把工具组合成场景，为不同的专注时刻快速切换。'
                : route === 'permissions'
                  ? '了解工具的访问范围，让每一次授权都心中有数。'
                  : route === 'settings'
                    ? '调整你的使用习惯，让工具箱更顺手。'
                    : route === 'activity'
                      ? '留住每次调整，清楚知道工具箱发生了什么。'
                      : '给每一个工具，留一个恰好的位置。'}
            </p>
          </div>
          <div className="header-actions">
            {route !== 'settings' && (
              <div
                className="backup-transfer-pair"
                role="group"
                aria-label="配置与清单 JSON 导入导出"
              >
                <button
                  className="button"
                  aria-label="导出配置与清单 JSON"
                  title="导出配置与清单 JSON"
                  disabled={!data || exportingFull}
                  onClick={() => void exportAllExtensions()}
                >
                  {exportingFull ? (
                    <Loader2 size={16} className="spin" />
                  ) : (
                    <ArrowDownToLine size={16} />
                  )}
                </button>
                <button
                  className="button"
                  aria-label="导入 JSON 并应用"
                  title="导入 JSON 并应用"
                  disabled={!data}
                  onClick={() => restoreImportRef.current?.click()}
                >
                  <Upload size={16} />
                </button>
              </div>
            )}
            <button className="button" onClick={() => setModal({ type: 'group' })}>
              <FolderPlus size={16} />
              新建分组
            </button>
            <button
              className="button primary"
              disabled={!data}
              onClick={() => setModal({ type: 'scene' })}
            >
              <Plus size={17} />
              创建场景
            </button>
          </div>
        </header>
        {isDemo && (
          <div className="demo-banner">
            <Monitor size={16} />
            <span>
              当前为交互演示，示例扩展不会影响浏览器。安装扩展后将显示当前浏览器的真实数据。
            </span>
            <button onClick={() => setModal({ type: 'help' })}>
              安装方法 <ArrowUpRight size={13} />
            </button>
          </div>
        )}
        {(error || dataError) && (
          <div role="alert" className="error-banner">
            <span>{error || dataError}</span>
            <button
              className="text-button"
              onClick={() => {
                setLoading(true);
                void reload();
                void getData()
                  .then((value) => {
                    setData(value);
                    setDataError('');
                  })
                  .catch((e) => setDataError(`读取配置失败：${String(e)}`));
              }}
            >
              重新加载
            </button>
          </div>
        )}
        {loading || !data ? (
          <div className="loading-state">
            <Loader2 className="spin" size={24} />
            <p>{error || dataError ? '配置暂不可用，请重试。' : '正在整理你的工具箱…'}</p>
          </div>
        ) : (
          <>
            {isCollection && (
              <>
                <section className="stats" aria-label="扩展统计">
                  {[
                    { label: '已安装', value: count.all, icon: Puzzle, desc: '当前浏览器可见项目' },
                    {
                      label: '已启用',
                      value: count.enabled,
                      icon: Play,
                      desc: '已启用的扩展与应用',
                    },
                    {
                      label: '已停用',
                      value: count.disabled,
                      icon: Pause,
                      desc: '需要时，再轻轻唤醒',
                    },
                  ].map((s, i) => (
                    <button
                      className="stat"
                      key={s.label}
                      onClick={() => go(['all', 'enabled', 'disabled'][i])}
                    >
                      <span className="stat-icon">
                        <s.icon size={20} />
                      </span>
                      <div>
                        <span className="stat-label">{s.label}</span>
                        <strong>{s.value.toString().padStart(2, '0')}</strong>
                        <small>{s.desc}</small>
                      </div>
                    </button>
                  ))}
                  <div className="stats-aside">
                    <span className="online-dot" />
                    <span>
                      {isDemo ? '演示数据' : '已连接 ' + browserName}
                      <small>
                        {items.filter((i) => !canToggle(i)).length} 个项目受保护或需原生管理
                      </small>
                    </span>
                  </div>
                </section>
                {route !== 'permissions' && (
                  <section className="scene-banner">
                    <div className="scene-intro">
                      <span className="tiny-label">
                        <Sparkles size={13} />
                        为你的专注时刻
                      </span>
                      <h2>让扩展，各就其位。</h2>
                      <p>切换一个场景，进入恰好的工作状态。</p>
                    </div>
                    <div className="quick-scenes">
                      {data.scenes.slice(0, 3).map((s, i) => (
                        <button
                          className="scene-pill"
                          key={s.id}
                          onClick={() => setModal({ type: 'apply', scene: s })}
                        >
                          {i === 0 ? (
                            <Monitor size={16} />
                          ) : i === 1 ? (
                            <BookOpen size={16} />
                          ) : (
                            <Zap size={16} />
                          )}
                          <span>{s.name}</span>
                          <ArrowUpRight size={13} />
                        </button>
                      ))}
                      {!data.scenes.length && (
                        <button className="scene-pill" onClick={() => setModal({ type: 'scene' })}>
                          <Plus size={16} />
                          保存当前为场景
                        </button>
                      )}
                      <button
                        className="scene-more"
                        aria-label="查看所有场景"
                        onClick={() => go('scenes')}
                      >
                        <ChevronRight size={18} />
                      </button>
                    </div>
                    {data.settings.skin === 'elysia' && (
                      <img
                        className="elysia-banner-art"
                        src="skins/elysia.png"
                        alt=""
                        aria-hidden="true"
                      />
                    )}
                    <div className="botanical" aria-hidden="true">
                      <span />
                      <span />
                      <span />
                      <i />
                      <i />
                      <i />
                    </div>
                  </section>
                )}
                {route === 'permissions' && (
                  <div className="notice permission-notice">
                    <ShieldCheck size={20} />
                    <div>
                      <strong>权限值得了解，不应仅凭数量判断安全。</strong>
                      <p>
                        以下项目按广泛站点访问声明优先展示。点击扩展可查看浏览器提供的权限说明。
                      </p>
                    </div>
                  </div>
                )}
                <section className="collection">
                  <div className="collection-heading">
                    <div>
                      <h2>{route === 'all' ? '你的工具箱' : title}</h2>
                      <span>{filtered.length} 个项目</span>
                    </div>
                    <button
                      className={`text-button ${batchMode ? 'strong' : ''}`}
                      onClick={() => {
                        setBatchMode(!batchMode);
                        setSelected(new Set());
                      }}
                    >
                      <CheckCheck size={15} />
                      {batchMode ? '退出批量管理' : '批量管理'}
                    </button>
                  </div>
                  <div className="toolbar">
                    <div className="search-field">
                      <Search size={17} />
                      <input
                        ref={searchRef}
                        value={query}
                        onChange={(e) => setQuery(e.target.value)}
                        placeholder="搜索名称、功能、备注或 ID…"
                        aria-label="搜索扩展"
                      />
                      {query ? (
                        <button
                          className="icon-button"
                          aria-label="清空搜索"
                          onClick={() => setQuery('')}
                        >
                          <X size={14} />
                        </button>
                      ) : (
                        <kbd>Ctrl K</kbd>
                      )}
                    </div>
                    <div className="filter-controls">
                      <select
                        aria-label="筛选分组"
                        value={groupFilter}
                        onChange={(e) => setGroupFilter(e.target.value)}
                      >
                        <option value="all">所有分组</option>
                        <option value="ungrouped">未分组</option>
                        {data.groups.map((g) => (
                          <option key={g.id} value={g.id}>
                            {g.name}
                          </option>
                        ))}
                      </select>
                      <select
                        aria-label="筛选状态"
                        value={statusFilter}
                        onChange={(e) => setStatusFilter(e.target.value)}
                      >
                        <option value="all">所有状态</option>
                        <option value="enabled">已启用</option>
                        <option value="disabled">已停用</option>
                      </select>
                      <select
                        aria-label="筛选类型"
                        value={typeFilter}
                        onChange={(e) => setTypeFilter(e.target.value)}
                      >
                        <option value="all">所有类型</option>
                        <option value="extension">扩展</option>
                        <option value="other">主题与应用</option>
                        <option value="protected">受保护项目</option>
                      </select>
                      <select
                        aria-label="排序方式"
                        value={data.settings.sort}
                        onChange={(e) => {
                          const sort = e.currentTarget.value as AppData['settings']['sort'];
                          safeCommit((d) => ({ ...d, settings: { ...d.settings, sort } }));
                        }}
                      >
                        {Object.entries(sortNames).map(([v, t]) => (
                          <option key={v} value={v}>
                            {t}
                          </option>
                        ))}
                      </select>
                      <div className="view-switch">
                        <button
                          aria-label="网格视图"
                          aria-pressed={data.settings.view === 'grid'}
                          onClick={() =>
                            safeCommit((d) => ({ ...d, settings: { ...d.settings, view: 'grid' } }))
                          }
                        >
                          <Grid2X2 size={17} />
                        </button>
                        <button
                          aria-label="列表视图"
                          aria-pressed={data.settings.view === 'list'}
                          onClick={() =>
                            safeCommit((d) => ({ ...d, settings: { ...d.settings, view: 'list' } }))
                          }
                        >
                          <List size={18} />
                        </button>
                      </div>
                    </div>
                  </div>
                  {batchMode && (
                    <div className="batch-bar">
                      <label>
                        <input
                          type="checkbox"
                          checked={filtered.length > 0 && filtered.every((i) => selected.has(i.id))}
                          onChange={(e) =>
                            setSelected(
                              e.target.checked ? new Set(filtered.map((i) => i.id)) : new Set(),
                            )
                          }
                        />
                        选择当前结果
                      </label>
                      <span>已选 {selected.size} 项</span>
                      <button
                        className="button small-button"
                        disabled={!selected.size}
                        onClick={() =>
                          setModal({ type: 'batch', enabled: true, ids: [...selected] })
                        }
                      >
                        <Play size={14} />
                        启用
                      </button>
                      <button
                        className="button small-button"
                        disabled={!selected.size}
                        onClick={() =>
                          setModal({ type: 'batch', enabled: false, ids: [...selected] })
                        }
                      >
                        <Pause size={14} />
                        停用
                      </button>
                      <select
                        aria-label="批量移动到分组"
                        defaultValue=""
                        disabled={!selected.size}
                        onChange={(e) => {
                          const id = e.target.value;
                          safeCommit((d) => {
                            const m = { ...d.meta };
                            selected.forEach((key) => {
                              m[key] = { ...m[key], groupId: id === 'ungrouped' ? undefined : id };
                            });
                            return recordActivity(
                              { ...d, meta: m },
                              `移动 ${selected.size} 个项目至${id === 'ungrouped' ? '未分组' : groupName(id)}`,
                            );
                          });
                          e.target.value = '';
                          notify('分组已更新');
                        }}
                      >
                        <option value="" disabled>
                          移动到分组…
                        </option>
                        <option value="ungrouped">未分组</option>
                        {data.groups.map((g) => (
                          <option key={g.id} value={g.id}>
                            {g.name}
                          </option>
                        ))}
                      </select>
                    </div>
                  )}
                  {filtered.length ? (
                    <div
                      className={`extension-grid ${data.settings.view === 'list' ? 'list-view' : ''}`}
                    >
                      {filtered.map((item) => {
                        const m = data.meta[item.id];
                        return (
                          <article
                            key={item.id}
                            className={`extension-card ${selected.has(item.id) ? 'selected' : ''} ${!item.enabled ? 'is-disabled' : ''}`}
                          >
                            <div className="card-top">
                              {batchMode && (
                                <input
                                  type="checkbox"
                                  aria-label={`选择 ${item.name}`}
                                  checked={selected.has(item.id)}
                                  onChange={() => selectItem(item.id)}
                                />
                              )}
                              <AppIcon item={item} />
                              <button
                                className="card-title"
                                onClick={() => setModal({ type: 'detail', item })}
                              >
                                <h3>{item.name}</h3>
                                <span>
                                  v{item.versionName || item.version}
                                  {item.type !== 'extension' &&
                                    ` · ${typeNames[item.type] || item.type}`}
                                </span>
                              </button>
                              <button
                                className={`icon-button favorite ${m?.favorite ? 'is-favorite' : ''}`}
                                aria-label={`${m?.favorite ? '取消收藏' : '收藏'} ${item.name}`}
                                aria-pressed={!!m?.favorite}
                                onClick={() => meta(item.id, { favorite: !m?.favorite })}
                              >
                                <Star size={17} fill={m?.favorite ? 'currentColor' : 'none'} />
                              </button>
                              <details className="card-menu">
                                <summary aria-label={`${item.name} 更多操作`}>
                                  <MoreHorizontal size={18} />
                                </summary>
                                <div className="dropdown">
                                  <button onClick={() => setModal({ type: 'detail', item })}>
                                    <Settings2 size={15} />
                                    详情与分组
                                  </button>
                                  {item.optionsUrl && (
                                    <button
                                      onClick={() =>
                                        void openUrl(item.optionsUrl).catch((e) =>
                                          notify(String(e)),
                                        )
                                      }
                                    >
                                      <SlidersHorizontal size={15} />
                                      扩展选项
                                    </button>
                                  )}
                                  <button
                                    onClick={() =>
                                      void openNativeManager(item.id).catch((e) =>
                                        notify(String(e)),
                                      )
                                    }
                                  >
                                    <ExternalLink size={15} />
                                    浏览器管理
                                  </button>
                                  <button
                                    disabled={!canUninstall(item)}
                                    className="danger-text"
                                    onClick={() => uninstall(item)}
                                  >
                                    <Trash2 size={15} />
                                    卸载扩展
                                  </button>
                                </div>
                              </details>
                            </div>
                            <p className="card-description">
                              {item.description || '这个工具暂时没有介绍，点击名称查看详情。'}
                            </p>
                            {route === 'permissions' && (
                              <button
                                className="permission-summary"
                                onClick={() => setModal({ type: 'detail', item })}
                              >
                                <ShieldCheck size={14} />
                                {hasBroadAccess(item)
                                  ? '声明广泛站点访问'
                                  : `${item.permissions.length} 项 API 权限`}
                                <ChevronRight size={13} />
                              </button>
                            )}
                            <div className="card-bottom">
                              {selected.has(item.id) && (
                                <span className="selection-label main-selection-label">
                                  <Check size={12} />
                                  已选中
                                </span>
                              )}
                              <button
                                className="group-tag"
                                onClick={() => setModal({ type: 'detail', item })}
                              >
                                <Folder size={12} />
                                {groupName(m?.groupId || '')}
                              </button>
                              <div className="toggle-wrap">
                                <span>
                                  {!canToggle(item) ? (
                                    <>
                                      <LockKeyhole size={11} />
                                      {item.id === selfId
                                        ? '管理器'
                                        : item.type === 'theme'
                                          ? '主题'
                                          : item.installType === 'admin'
                                            ? '组织管理'
                                            : '受保护'}
                                    </>
                                  ) : item.enabled ? (
                                    '已启用'
                                  ) : item.disabledReason === 'permissions_increase' ? (
                                    '待授权'
                                  ) : (
                                    '已停用'
                                  )}
                                </span>
                                <button
                                  className={`toggle ${item.enabled ? 'on' : ''}`}
                                  role="switch"
                                  aria-checked={item.enabled}
                                  aria-label={`${item.enabled ? '停用' : '启用'} ${item.name}`}
                                  disabled={!canToggle(item) || pending.has(item.id)}
                                  onClick={() => toggle(item)}
                                >
                                  <i />
                                  {pending.has(item.id) && <Loader2 size={10} className="spin" />}
                                </button>
                              </div>
                            </div>
                          </article>
                        );
                      })}
                    </div>
                  ) : (
                    <div className="empty-state">
                      <Search size={30} />
                      <h3>{query ? '没有找到匹配的扩展' : '这里还很安静'}</h3>
                      <p>
                        {query
                          ? '试试其他名称、功能或备注关键词。'
                          : '你可以调整筛选条件，或在扩展详情中整理分组与收藏。'}
                      </p>
                      <button
                        className="button"
                        onClick={() => {
                          setQuery('');
                          setGroupFilter('all');
                          setStatusFilter('all');
                          setTypeFilter('all');
                        }}
                      >
                        清除筛选
                      </button>
                    </div>
                  )}
                </section>
              </>
            )}
            {route === 'scenes' && (
              <section className="scene-page">
                <div className="notice">
                  <Layers3 size={19} />
                  <span>
                    场景只记录创建时可管理扩展的启用组合。每次应用都会先展示变化，受保护项目保持原状。
                  </span>
                </div>
                <div className="scenes-grid">
                  {data.scenes.map((s, i) => (
                    <article className="scene-card" key={s.id}>
                      <span className="scene-card-icon">
                        {i % 3 === 0 ? <Monitor /> : i % 3 === 1 ? <BookOpen /> : <Zap />}
                      </span>
                      <h2>{s.name}</h2>
                      <p>{s.description || '为此刻保留需要的工具。'}</p>
                      <div className="scene-meta">
                        <span>{s.enabledIds.length} 个启用</span>
                        <span>管理 {s.scopeIds.length} 项</span>
                      </div>
                      <div className="scene-card-actions">
                        <button
                          className="button primary"
                          onClick={() => setModal({ type: 'apply', scene: s })}
                        >
                          预览并应用
                          <ArrowUpRight size={15} />
                        </button>
                        <button
                          className="icon-button"
                          aria-label={`编辑场景 ${s.name}`}
                          onClick={() => setModal({ type: 'scene', scene: s })}
                        >
                          <Pencil size={16} />
                        </button>
                        <button
                          className="icon-button"
                          aria-label={`删除场景 ${s.name}`}
                          onClick={() => setModal({ type: 'deleteScene', scene: s })}
                        >
                          <Trash2 size={16} />
                        </button>
                      </div>
                    </article>
                  ))}
                  <button className="new-scene" onClick={() => setModal({ type: 'scene' })}>
                    <Plus size={28} />
                    <strong>创建一个新场景</strong>
                    <span>从当前的扩展组合开始</span>
                  </button>
                </div>
              </section>
            )}
            {route === 'settings' && (
              <div className="settings-page">
                <MigrationPanel
                  onRestoreBackup={(backup) => setModal({ type: 'restore', backup })}
                />
                <section className="settings-card skin-section">
                  <div className="section-title">
                    <Sparkles size={20} />
                    <div>
                      <h2>皮肤外观</h2>
                      <p>让喜欢的色彩，陪伴每一次专注。皮肤与浅色、深色模式独立搭配。</p>
                    </div>
                  </div>
                  <SkinPicker
                    skin={data.settings.skin ?? 'forest'}
                    onSelect={(skin) =>
                      safeCommit((d) => ({ ...d, settings: { ...d.settings, skin } }))
                    }
                  />
                </section>
                <section className="settings-card">
                  <div className="section-title">
                    <Sun size={20} />
                    <div>
                      <h2>外观与偏好</h2>
                      <p>把工具箱调成你喜欢的样子。</p>
                    </div>
                  </div>
                  <div className="setting-row">
                    <div>
                      <strong>界面主题</strong>
                      <p>浅色、深色，或随系统自动切换。</p>
                    </div>
                    <select
                      aria-label="界面主题"
                      value={data.settings.theme}
                      onChange={(e) => {
                        const theme = e.currentTarget.value as AppData['settings']['theme'];
                        safeCommit((d) => ({ ...d, settings: { ...d.settings, theme } }));
                      }}
                    >
                      <option value="light">浅色 · 暖白</option>
                      <option value="dark">深色 · 松墨</option>
                      <option value="system">跟随系统</option>
                    </select>
                  </div>
                  <div className="setting-row">
                    <div>
                      <strong>键盘快捷键</strong>
                      <p>Alt + Shift + E 打开管理页，Ctrl + K 搜索。</p>
                    </div>
                    <button
                      className="button"
                      onClick={() => void openShortcuts().catch((e) => notify(String(e)))}
                    >
                      自定义快捷键
                      <ArrowUpRight size={14} />
                    </button>
                  </div>
                </section>
                <section className="settings-card extension-backup-section">
                  <div className="section-title">
                    <Puzzle size={20} />
                    <div>
                      <h2>配置与清单（JSON）</h2>
                      <p>保存全部扩展的清单、启停状态与管理器配置，不包含扩展安装文件。</p>
                    </div>
                  </div>
                  <div className="setting-row json-backup-row">
                    <div>
                      <strong>导出清单或导入状态</strong>
                      <p>
                        全部项目均会进入 JSON，不受筛选影响；导入前先预览，再应用已安装项目的状态。
                      </p>
                    </div>
                    <div
                      className="json-backup-actions"
                      role="group"
                      aria-label="配置与清单 JSON 导入导出"
                    >
                      <button
                        className="button"
                        aria-label="导出配置与清单 JSON"
                        title="导出配置与清单 JSON"
                        disabled={exportingFull}
                        onClick={() => void exportAllExtensions()}
                      >
                        {exportingFull ? (
                          <Loader2 size={16} className="spin" />
                        ) : (
                          <ArrowDownToLine size={16} />
                        )}
                        导出配置与清单 JSON
                      </button>
                      <button
                        className="button primary"
                        aria-label="导入 JSON 并应用"
                        title="导入 JSON 并应用"
                        onClick={() => restoreImportRef.current?.click()}
                      >
                        <Upload size={16} />
                        导入 JSON 并应用
                      </button>
                    </div>
                  </div>
                  <p className="notice small">
                    备份包含扩展清单与本管理器配置，不含 CRX
                    安装包或其他扩展的内部设置。缺失项目需要安装后重新检查。
                  </p>
                  <LastRestoreSummary refreshKey={restoreRevision} />
                </section>
                <section className="settings-card">
                  <div className="section-title">
                    <FileJson size={20} />
                    <div>
                      <h2>配置备份</h2>
                      <p>带走分组、收藏、备注、场景和扩展清单。</p>
                    </div>
                  </div>
                  <div className="setting-row json-backup-row">
                    <div>
                      <strong>导出配置 / 导入配置</strong>
                      <p>下载 JSON 文件，或预览后合并管理器配置；不会自动安装或启停扩展。</p>
                    </div>
                    <div
                      className="json-backup-actions"
                      role="group"
                      aria-label="管理器配置导入导出"
                    >
                      <button className="button" onClick={exportData}>
                        <ArrowDownToLine size={16} />
                        导出配置
                      </button>
                      <button className="button" onClick={() => importRef.current?.click()}>
                        <Upload size={16} />
                        选择备份文件
                      </button>
                    </div>
                  </div>
                  <p className="notice small">
                    备份不包含扩展安装文件、密码、扩展内部设置或站点数据。不同商店的扩展 ID
                    可能不同，导入后需要手动调整对应关系。
                  </p>
                </section>
                <section className="settings-card about-card">
                  <span className="brand-mark">
                    <i />
                    <i />
                    <i />
                    <i />
                  </span>
                  <div>
                    <h2>
                      栖 · 扩展管理器 <small>1.4.2</small>
                    </h2>
                    <p>让工具有序，让专注自然发生。</p>
                    <span className="muted small">
                      仅申请 management 与 storage 权限 · 本地存储 · 无遥测
                    </span>
                  </div>
                </section>
              </div>
            )}
            {route === 'activity' && (
              <section className="activity-page">
                <div className="collection-heading">
                  <div>
                    <h2>最近的调整</h2>
                    <span>最多保留 200 条</span>
                  </div>
                  <button
                    className="text-button"
                    disabled={!data.activity.length}
                    onClick={() => safeCommit((d) => ({ ...d, activity: [] }))}
                  >
                    <Trash2 size={14} />
                    清空记录
                  </button>
                </div>
                {data.activity.length ? (
                  <div className="activity-list">
                    {data.activity.map((a) => (
                      <div className="activity-row" key={a.id}>
                        <span className="activity-icon">
                          <Clock3 size={16} />
                        </span>
                        <p>{a.text}</p>
                        <time dateTime={new Date(a.at).toISOString()}>{shortTime(a.at)}</time>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="empty-state">
                    <History size={32} />
                    <h3>新的秩序，从现在开始</h3>
                    <p>在管理器内完成的启停、场景应用等操作会记录在这里。</p>
                  </div>
                )}
              </section>
            )}
            <footer className="page-footer">
              <span>
                <span className="online-dot" />
                {isDemo ? '交互演示' : '已连接当前 ' + browserName}
                <i />
                仅本地存储
              </span>
              <span>
                {count.all} 个项目 · {count.enabled} 个已启用
                <span className="footer-shortcut">Alt ⇧ E 快速打开</span>
              </span>
            </footer>
          </>
        )}
      </main>
      <input
        ref={importRef}
        type="file"
        accept=".json,application/json"
        aria-label="导入配置文件"
        hidden
        onChange={(e) => void importFile(e.target.files?.[0])}
      />
      <input
        ref={restoreImportRef}
        type="file"
        accept=".json,application/json"
        aria-label="导入全部扩展备份文件"
        hidden
        onChange={(e) => void importExtensionsBackup(e.target.files?.[0])}
      />
      {toast && (
        <div className="toast" role="status">
          <Check size={16} />
          <span>{toast}</span>
          <button aria-label="关闭提示" onClick={() => setToast('')}>
            <X size={15} />
          </button>
        </div>
      )}
      {modal && data && (
        <Modal
          title={
            modal.type === 'detail'
              ? '扩展详情'
              : modal.type === 'group'
                ? modal.group
                  ? '编辑分组'
                  : '新建分组'
                : modal.type === 'scene'
                  ? modal.scene
                    ? '编辑场景'
                    : '创建场景'
                  : modal.type === 'apply'
                    ? '切换场景'
                    : modal.type === 'batch'
                      ? '确认批量操作'
                      : modal.type === 'result'
                        ? '操作结果'
                        : modal.type === 'restore'
                          ? '导入 JSON 并应用'
                          : modal.type === 'import'
                            ? '导入配置预览'
                            : modal.type === 'help'
                              ? '认识你的新工具箱'
                              : modal.type === 'deleteGroup'
                                ? '删除分组'
                                : '删除场景'
          }
          wide={['scene', 'detail', 'apply', 'result', 'import', 'restore'].includes(modal.type)}
          onClose={() => {
            if (!busy) setModal(null);
          }}
        >
          {modal.type === 'restore' && (
            <BackupRestorePanel
              backup={modal.backup}
              items={items}
              data={data}
              onBusyChange={setBusy}
              onApplied={handleRestoreApplied}
              onClose={() => setModal(null)}
            />
          )}
          {modal.type === 'group' && (
            <GroupForm
              group={modal.group}
              onSave={(name) => {
                void commit((d) => {
                  const id = modal.group?.id || crypto.randomUUID();
                  return recordActivity(
                    {
                      ...d,
                      groups: modal.group
                        ? d.groups.map((g) => (g.id === id ? { id, name } : g))
                        : [...d.groups, { id, name }],
                    },
                    `${modal.group ? '重命名' : '创建'}分组「${name}」`,
                  );
                })
                  .then(() => {
                    setModal(null);
                    notify('分组已保存');
                  })
                  .catch(() => {});
              }}
            />
          )}
          {modal.type === 'scene' && (
            <SceneForm
              scene={modal.scene}
              items={items}
              onSave={(scene) => {
                void commit((d) =>
                  recordActivity(
                    {
                      ...d,
                      scenes: modal.scene
                        ? d.scenes.map((s) => (s.id === scene.id ? scene : s))
                        : [...d.scenes, scene],
                    },
                    `${modal.scene ? '更新' : '创建'}场景「${scene.name}」`,
                  ),
                )
                  .then(() => {
                    setModal(null);
                    notify('场景已保存');
                  })
                  .catch(() => {});
              }}
            />
          )}
          {modal.type === 'detail' &&
            (() => {
              const current = items.find((i) => i.id === modal.item.id) || modal.item;
              return (
                <ExtensionDetail
                  item={current}
                  data={data}
                  onMeta={(p) => meta(current.id, p)}
                  onToggle={() => toggle(current)}
                  onUninstall={() => uninstall(current)}
                  notify={notify}
                />
              );
            })()}
          {(modal.type === 'apply' || modal.type === 'batch') &&
            (() => {
              const scope = modal.type === 'apply' ? modal.scene.scopeIds : modal.ids;
              const enabledIds =
                modal.type === 'apply' ? modal.scene.enabledIds : modal.enabled ? scope : [];
              const changes = items.filter(
                (i) => scope.includes(i.id) && i.enabled !== enabledIds.includes(i.id),
              );
              const missing = scope.filter((id) => !items.some((i) => i.id === id));
              return (
                <>
                  <p className="modal-description">
                    {modal.type === 'apply'
                      ? `即将应用「${modal.scene.name}」。`
                      : `即将${modal.enabled ? '启用' : '停用'}选中的 ${scope.length} 个项目。`}{' '}
                    请确认以下变化。
                  </p>
                  <div className="change-summary">
                    <span>
                      <Play size={16} />
                      {changes.filter((i) => enabledIds.includes(i.id)).length} 个启用
                    </span>
                    <span>
                      <Pause size={16} />
                      {changes.filter((i) => !enabledIds.includes(i.id)).length} 个停用
                    </span>
                    <span>{scope.length - changes.length - missing.length} 个无需变化</span>
                  </div>
                  <div className="change-list">
                    {changes.map((i) => (
                      <div className="change-row" key={i.id}>
                        <AppIcon item={i} />
                        <span>
                          {i.name}
                          <small>
                            {!canToggle(i)
                              ? '受保护，操作将跳过'
                              : i.disabledReason === 'permissions_increase' &&
                                  enabledIds.includes(i.id)
                                ? '需单独授权，操作将跳过'
                                : ''}
                          </small>
                        </span>
                        <span className={enabledIds.includes(i.id) ? 'green-text' : 'muted'}>
                          {enabledIds.includes(i.id) ? '启用' : '停用'}
                        </span>
                      </div>
                    ))}
                    {!changes.length && <p className="empty-small">当前状态已经符合设置。</p>}
                    {missing.length > 0 && (
                      <p className="notice small">
                        {missing.length} 个项目未在当前浏览器安装，将跳过。
                      </p>
                    )}
                  </div>
                  <p className="hint">
                    管理器自身、组织保护、主题以及需重新授权的项目会跳过。浏览器可能要求原生确认，操作结果会逐项反馈。
                  </p>
                  <footer className="modal-actions">
                    <button className="button" disabled={busy} onClick={() => setModal(null)}>
                      取消
                    </button>
                    <button
                      className="button primary"
                      disabled={busy || !changes.length}
                      onClick={() =>
                        runChanges(
                          enabledIds,
                          scope,
                          modal.type === 'apply' ? `应用场景「${modal.scene.name}」` : '批量启停',
                        )
                      }
                    >
                      {busy ? <Loader2 className="spin" size={16} /> : <CheckCheck size={16} />}确认
                      {modal.type === 'apply' ? '切换' : '执行'}
                    </button>
                  </footer>
                </>
              );
            })()}
          {modal.type === 'result' && (
            <>
              <div className="result-summary">
                <CheckCheck size={28} />
                <h3>本次操作已结束</h3>
                <p>
                  成功 {modal.result.succeeded.length} · 跳过 {modal.result.skipped.length} · 失败{' '}
                  {modal.result.failed.length}
                </p>
              </div>
              <div className="result-list">
                {modal.result.failed.map((f) => (
                  <div key={f.id} className="result-row">
                    <strong>{items.find((i) => i.id === f.id)?.name || f.id}</strong>
                    <p className="error-inline">{f.error}</p>
                  </div>
                ))}
                {modal.result.skipped.length > 0 && (
                  <>
                    <h4>已跳过的项目</h4>
                    {modal.result.skipped.map((id) => (
                      <p className="small muted" key={id}>
                        {items.find((i) => i.id === id)?.name || id} ·
                        受保护、需要单独授权、已是目标状态或未安装
                      </p>
                    ))}
                  </>
                )}
                {modal.result.succeeded.length > 0 && (
                  <details>
                    <summary>查看成功项目（{modal.result.succeeded.length}）</summary>
                    {modal.result.succeeded.map((id) => (
                      <p className="small" key={id}>
                        {items.find((i) => i.id === id)?.name || id}
                      </p>
                    ))}
                  </details>
                )}
              </div>
              <footer className="modal-actions">
                <button className="button primary" onClick={() => setModal(null)}>
                  完成
                </button>
              </footer>
            </>
          )}
          {modal.type === 'deleteGroup' && (
            <>
              <p className="modal-description">
                删除分组「{modal.group.name}」后，其中的扩展会回到未分组。扩展及其启用状态不受影响。
              </p>
              <footer className="modal-actions">
                <button className="button" onClick={() => setModal(null)}>
                  取消
                </button>
                <button
                  className="button danger"
                  onClick={() => {
                    const id = modal.group.id;
                    void commit((d) => {
                      const m = { ...d.meta };
                      Object.keys(m).forEach((k) => {
                        if (m[k].groupId === id) m[k] = { ...m[k], groupId: undefined };
                      });
                      return recordActivity(
                        { ...d, groups: d.groups.filter((g) => g.id !== id), meta: m },
                        `删除分组「${modal.group.name}」`,
                      );
                    })
                      .then(() => {
                        setModal(null);
                        if (route === `group:${id}`) go('all');
                      })
                      .catch(() => {});
                  }}
                >
                  删除分组
                </button>
              </footer>
            </>
          )}
          {modal.type === 'deleteScene' && (
            <>
              <p className="modal-description">
                删除场景「{modal.scene.name}」？当前扩展状态不会改变。
              </p>
              <footer className="modal-actions">
                <button className="button" onClick={() => setModal(null)}>
                  取消
                </button>
                <button
                  className="button danger"
                  onClick={() =>
                    void commit((d) =>
                      recordActivity(
                        { ...d, scenes: d.scenes.filter((s) => s.id !== modal.scene.id) },
                        `删除场景「${modal.scene.name}」`,
                      ),
                    )
                      .then(() => setModal(null))
                      .catch(() => {})
                  }
                >
                  删除场景
                </button>
              </footer>
            </>
          )}
          {modal.type === 'import' && (
            <>
              <p className="modal-description">
                将备份配置合并到当前工作空间，同 ID 的分组、场景和扩展备注以备份为准。
              </p>
              <div className="change-summary">
                <span>{modal.backup.data.groups.length} 个分组</span>
                <span>{modal.backup.data.scenes.length} 个场景</span>
                <span>{Object.keys(modal.backup.data.meta).length} 个扩展配置</span>
              </div>
              <p className="notice">
                <FileJson size={18} />
                <span>
                  仅恢复管理器配置与外观偏好。不会安装、启停扩展，也不会恢复扩展自身的数据。
                </span>
              </p>
              <div className="import-inventory">
                <h4>备份中的扩展清单</h4>
                {modal.backup.inventory.map((i) => (
                  <div className="import-row" key={i.id}>
                    <span>{i.name}</span>
                    <small>
                      {items.some((v) => v.id === i.id) ? '已安装' : '当前浏览器未安装'}
                    </small>
                  </div>
                ))}
                {!modal.backup.inventory.length && (
                  <p className="muted small">备份中没有扩展清单。</p>
                )}
              </div>
              <footer className="modal-actions">
                <button className="button" onClick={() => setModal(null)}>
                  取消
                </button>
                <button
                  className="button primary"
                  onClick={() => {
                    const b = modal.backup.data;
                    void commit((d) =>
                      recordActivity(
                        {
                          ...d,
                          groups: [
                            ...new Map([...d.groups, ...b.groups].map((g) => [g.id, g])).values(),
                          ],
                          scenes: [
                            ...new Map([...d.scenes, ...b.scenes].map((s) => [s.id, s])).values(),
                          ],
                          meta: { ...d.meta, ...b.meta },
                          settings: b.settings,
                        },
                        '导入并合并备份配置',
                      ),
                    )
                      .then(() => {
                        setModal(null);
                        notify('配置已导入，扩展状态保持不变');
                      })
                      .catch(() => {});
                  }}
                >
                  合并导入
                </button>
              </footer>
            </>
          )}
          {modal.type === 'help' && (
            <div className="help-content">
              <p>一个安静、顺手的扩展工具箱，为 Chrome 与 Microsoft Edge 而做。</p>
              <ol>
                <li>
                  <strong>安装到浏览器</strong>
                  <p>
                    先运行项目的 <code>npm run build</code>，或解压安装包。在{' '}
                    <code>chrome://extensions</code> 或 <code>edge://extensions</code>{' '}
                    开启开发者模式，点击“加载已解压的扩展”，选择包含 manifest.json
                    的文件夹（开发项目选择 dist）。
                  </p>
                </li>
                <li>
                  <strong>整理你的工具</strong>
                  <p>用搜索快速定位，在扩展详情中分组、写备注、检查权限。点击星标收藏常用工具。</p>
                </li>
                <li>
                  <strong>为不同工作保存场景</strong>
                  <p>创建场景时勾选要启用的扩展，应用前查看变更。受保护的项目会保留并给出说明。</p>
                </li>
              </ol>
              <div className="notice small">
                每个浏览器与用户资料单独管理。浏览器策略、主题、站点访问及无痕设置可通过“浏览器详情”继续管理。备份可跨浏览器迁移配置，商店
                ID 不一致的项目需手动调整。
              </div>
              <div className="shortcut-guide">
                <span>
                  快速搜索 <kbd>Ctrl K</kbd>
                </span>
                <span>
                  打开管理页 <kbd>Alt ⇧ E</kbd>
                </span>
              </div>
              <footer className="modal-actions">
                <button className="button primary" onClick={() => setModal(null)}>
                  开始整理
                </button>
              </footer>
            </div>
          )}
        </Modal>
      )}
    </div>
  );
}
