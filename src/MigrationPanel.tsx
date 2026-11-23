import { useEffect, useRef, useState } from 'react';
import {
  ArrowDownToLine,
  ArrowUpFromLine,
  Check,
  CircleAlert,
  Copy,
  FolderArchive,
  LoaderCircle,
  PlugZap,
  RefreshCw,
} from 'lucide-react';
import { browserName, isDemo, listExtensions, selfId } from './core/api';
import { createFullBackup } from './core/backup';
import { getData } from './core/storage';
import {
  connectMigration,
  migrationAccessGranted,
  pingMigration,
  exportExtensionFiles,
  importExtensionFiles,
  type MigrationResult,
} from './core/migration';
import type { ParsedBackup } from './core/types';
import './migration.css';

export function MigrationPanel({
  onRestoreBackup,
}: {
  onRestoreBackup: (backup: ParsedBackup) => void;
}) {
  const [connected, setConnected] = useState(false);
  const [connection, setConnection] = useState('正在检测本地助手…');
  const [checkedAt, setCheckedAt] = useState('');
  const [refreshing, setRefreshing] = useState(false);
  const [busy, setBusy] = useState<'connect' | 'export' | 'import' | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [result, setResult] = useState<MigrationResult | null>(null);
  const section = useRef<HTMLElement>(null);
  const pending = useRef(false);
  const checking = useRef(false);
  const liveConnection = useRef(false);
  const refreshConnection = useRef<() => void>(() => {});
  const probeGeneration = useRef(0);
  const helperUrl = isDemo
    ? '/migration/QiiMigration.exe'
    : chrome.runtime.getURL('migration/QiiMigration.exe');
  useEffect(() => {
    if (new URLSearchParams(location.search).has('migration'))
      section.current?.scrollIntoView({ block: 'start' });
  }, []);
  useEffect(() => {
    let active = true;
    let lastCheck = 0;
    let queued = false;
    async function check(force = false) {
      if (pending.current || checking.current) {
        if (force) queued = true;
        return;
      }
      if (document.visibilityState === 'hidden') return;
      if (!force && Date.now() - lastCheck < (liveConnection.current ? 30000 : 5000)) return;
      lastCheck = Date.now();
      checking.current = true;
      queued = false;
      const generation = ++probeGeneration.current;
      setRefreshing(true);
      try {
        if (!(await migrationAccessGranted())) {
          if (active && generation === probeGeneration.current) {
            setConnected(false);
            liveConnection.current = false;
            setConnection(isDemo ? '演示页面不能连接本地助手' : '待授权 · 首次使用请允许本地通信');
          }
          return;
        }
        const version = await pingMigration();
        if (active && generation === probeGeneration.current) {
          setConnected(true);
          liveConnection.current = true;
          setConnection(`已连接 · 助手 v${version}`);
        }
      } catch (err) {
        if (active && generation === probeGeneration.current) {
          setConnected(false);
          liveConnection.current = false;
          setConnection(`未连接 · ${err instanceof Error ? err.message : String(err)}`);
        }
      } finally {
        checking.current = false;
        if (active) {
          setRefreshing(false);
          if (generation === probeGeneration.current) setCheckedAt(new Date().toLocaleTimeString());
          if (queued) {
            queued = false;
            void check(true);
          }
        }
      }
    }
    void check();
    const timer = setInterval(() => void check(), 5000);
    const foreground = () => void check(true);
    refreshConnection.current = foreground;
    window.addEventListener('focus', foreground);
    document.addEventListener('visibilitychange', foreground);
    const permissionChanged = () => foreground();
    if (!isDemo && typeof chrome !== 'undefined') {
      chrome.permissions?.onAdded?.addListener(permissionChanged);
      chrome.permissions?.onRemoved?.addListener(permissionChanged);
    }
    return () => {
      active = false;
      clearInterval(timer);
      window.removeEventListener('focus', foreground);
      document.removeEventListener('visibilitychange', foreground);
      refreshConnection.current = () => {};
      if (!isDemo && typeof chrome !== 'undefined') {
        chrome.permissions?.onAdded?.removeListener(permissionChanged);
        chrome.permissions?.onRemoved?.removeListener(permissionChanged);
      }
    };
  }, []);
  async function run(action: 'connect' | 'export' | 'import') {
    if (pending.current) return;
    pending.current = true;
    probeGeneration.current++;
    setBusy(action);
    setError('');
    setNotice('');
    try {
      if (action === 'connect') {
        const version = await connectMigration();
        setConnected(true);
        liveConnection.current = true;
        setConnection(`已连接 · 助手 v${version}`);
        setCheckedAt(new Date().toLocaleTimeString());
        setNotice(`迁移助手已连接 · v${version}`);
      } else if (action === 'export') {
        const [inventory, data] = await Promise.all([listExtensions(), getData()]);
        setResult(await exportExtensionFiles(JSON.parse(createFullBackup(data, inventory))));
      } else setResult(await importExtensionFiles());
    } catch (err) {
      if (action === 'connect') {
        setError('');
        setConnected(false);
        liveConnection.current = false;
        setConnection(`未连接 · ${err instanceof Error ? err.message : String(err)}`);
      } else setError(err instanceof Error ? err.message : String(err));
    } finally {
      pending.current = false;
      setBusy(null);
      refreshConnection.current();
    }
  }
  async function copy(value: string) {
    try {
      await navigator.clipboard.writeText(value);
      setNotice('已复制');
    } catch {
      setError('无法复制，请选中上方文字手动复制。');
    }
  }
  return (
    <section ref={section} id="migration" className="settings-card migration-section">
      <div className="section-title">
        <FolderArchive size={20} />
        <div>
          <h2>扩展文件迁移（ZIP）</h2>
          <p>备份已安装的实际文件和本地扩展目录，附带管理配置。</p>
        </div>
      </div>
      <div className="migration-connection-state" role="status" aria-live="polite">
        <span className={connected ? 'migration-connected' : ''}>{connection}</span>
        <div className="migration-connection-actions">
          <small aria-hidden="true">{checkedAt ? `最近检测 ${checkedAt}` : '尚未完成检测'}</small>
          <button
            className="button"
            type="button"
            disabled={!!busy || refreshing || isDemo}
            aria-busy={refreshing}
            onClick={() => refreshConnection.current()}
          >
            <RefreshCw size={14} className={refreshing ? 'spin' : undefined} />
            {refreshing ? '正在刷新…' : '立即刷新'}
          </button>
        </div>
      </div>
      <p className="migration-auto-hint">
        {connected
          ? '已自动连接；返回此页面或权限变化时立即检查，后台每 30 秒核验。'
          : '每 5 秒自动重试；在助手完成配置后，无需刷新整个页面。'}
      </p>
      <div className="migration-transfer" role="group" aria-label="扩展文件导入导出">
        <button
          className="button"
          disabled={!!busy || !connected}
          onClick={() => void run('export')}
        >
          {busy === 'export' ? (
            <LoaderCircle className="spin" size={16} />
          ) : (
            <ArrowDownToLine size={16} />
          )}
          导出扩展文件 ZIP
        </button>
        <button
          className="button primary"
          disabled={!!busy || !connected}
          onClick={() => void run('import')}
        >
          {busy === 'import' ? (
            <LoaderCircle className="spin" size={16} />
          ) : (
            <ArrowUpFromLine size={16} />
          )}
          导入扩展文件 ZIP
        </button>
      </div>
      <p className="migration-boundary">
        ZIP
        包含实际扩展文件。新电脑可一次解包并校验；浏览器要求的首次安装确认仍需完成，解包不会自动安装扩展。
      </p>
      {!connected && (
        <details className="migration-setup" open>
          <summary>首次连接 Windows 迁移助手</summary>
          <ol>
            <li>
              <a href={helperUrl} download="QiiMigration.exe">
                下载本地迁移助手
              </a>
              ，运行后会自动识别并配置已安装的栖管理器。
            </li>
            <li>
              自动识别不到时，可用手动 ID 连接：<code>{selfId}</code>
              <button
                className="button"
                aria-label="复制当前扩展 ID"
                onClick={() => void copy(selfId)}
              >
                <Copy size={13} />
                复制 ID
              </button>
            </li>
            <li>首次允许本地通信后会自动连接，助手完成配置后无需再次点击或刷新页面。</li>
          </ol>
          <button
            className="button"
            disabled={!!busy || isDemo}
            onClick={() => void run('connect')}
          >
            {busy === 'connect' ? (
              <LoaderCircle size={15} className="spin" />
            ) : (
              <PlugZap size={15} />
            )}
            连接本地迁移助手
          </button>
          <span className="migration-browser">
            当前浏览器：{browserName}
            {isDemo ? ' · 演示页面不能连接本地助手' : ''}
          </span>
        </details>
      )}
      {connected && (
        <p className="migration-connected">
          <Check size={14} />
          本地助手已连接
        </p>
      )}
      {busy && (
        <p className="migration-busy" role="status">
          请在助手窗口中选择文件位置，完成后再关闭本管理页。
        </p>
      )}
      {error && (
        <p className="migration-error" role="alert">
          <CircleAlert size={15} />
          <span>{error}</span>
        </p>
      )}
      {notice && (
        <p role="status" className="migration-connected">
          {notice}
        </p>
      )}
      {result && (
        <div className="migration-result">
          <h3>
            {result.action === 'export'
              ? result.complete
                ? '扩展文件备份完成'
                : '文件备份不完整'
              : result.complete
                ? '扩展文件已还原，等待安装确认'
                : '部分文件未能还原'}
          </h3>
          {result.detailsTruncated ? (
            <p>
              显示 {result.items.length} / {result.totalItems} 项结果，完整逐项记录请查看本地报告。
            </p>
          ) : (
            <p>
              {
                result.items.filter((row) => ['included', 'files-restored'].includes(row.status))
                  .length
              }{' '}
              / {result.items.length} 项文件{result.action === 'export' ? '已打包' : '已还原'}
              {result.action === 'import' ? ' · 尚未自动安装' : ''}
            </p>
          )}
          {result.messages.map((entry, index) => (
            <p key={index} className="migration-report-path">
              {entry}
            </p>
          ))}
          {(result.archivePath || result.directory) && (
            <div className="migration-path">
              <code>{result.archivePath || result.directory}</code>
              <button
                className="button"
                onClick={() => void copy(result.archivePath || result.directory || '')}
              >
                <Copy size={13} />
                复制路径
              </button>
            </div>
          )}
          {result.reportPath && (
            <p className="migration-report-path">
              详细报告：<code>{result.reportPath}</code>
            </p>
          )}
          {result.guidePath && (
            <div className="migration-path">
              <span>
                安装清单：<code>{result.guidePath}</code>
              </span>
              <button className="button" onClick={() => void copy(result.guidePath!)}>
                复制清单路径
              </button>
            </div>
          )}
          <ul>
            {result.items.map((row) => (
              <li key={row.id}>
                <b>{row.name}</b>
                <span>
                  {
                    {
                      included: '文件已打包',
                      'files-restored': '文件已还原 · 待安装',
                      missing: '缺少文件',
                      failed: '未完成',
                    }[row.status]
                  }
                </span>
                {row.message && <small>{row.message}</small>}
                {row.path && <code>{row.path}</code>}
              </li>
            ))}
          </ul>
          {result.managerBackup && (
            <button className="button" onClick={() => onRestoreBackup(result.managerBackup!)}>
              预览管理配置与已安装扩展的启停恢复
            </button>
          )}
        </div>
      )}
    </section>
  );
}
