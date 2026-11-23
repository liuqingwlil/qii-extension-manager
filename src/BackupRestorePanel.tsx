import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowDownToLine,
  ArrowUpRight,
  Check,
  CircleAlert,
  FileJson,
  LoaderCircle,
  LockKeyhole,
  RefreshCw,
  ShieldCheck,
} from 'lucide-react';
import { listExtensions, openNativeManager, openUrl } from './core/api';
import {
  buildRestorePlan,
  executeRestore,
  getLastRestoreResult,
  getStoreUrl,
  subscribeRestoreReports,
} from './core/backup';
import { getData, parseBackup } from './core/storage';
import type {
  AppData,
  ExtensionItem,
  RestorePlanRow,
  RestoreResult,
  RestoreRow,
} from './core/types';
import './backup-restore.css';

export interface BackupRestorePanelProps {
  backup: ReturnType<typeof parseBackup>;
  items: ExtensionItem[];
  data: AppData;
  onApplied?: () => void | Promise<void>;
  onClose: () => void;
  onBusyChange?: (busy: boolean) => void;
}

const labels: Record<RestorePlanRow['status'] | RestoreRow['status'], string> = {
  enable: '要启用',
  disable: '要停用',
  unchanged: '已一致',
  missing: '未安装',
  protected: '受保护',
  'requires-permission': '需授权',
  applied: '已应用',
  failed: '未完成',
  'not-applied': '未应用状态',
};
function errorText(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
function displayTime(at: string) {
  return new Date(at).toLocaleString('zh-CN', { hour12: false });
}
function completed(result: RestoreResult) {
  return (
    result.complete &&
    result.configSaved &&
    !result.verificationError &&
    result.rows.every(
      (row) =>
        (row.status === 'applied' || row.status === 'unchanged') &&
        row.actualEnabled === row.targetEnabled,
    )
  );
}
function resultTitle(result: RestoreResult) {
  if (result.mode === 'config-only')
    return result.configSaved ? '配置已导入，未应用扩展状态' : '配置导入未完成';
  if (completed(result)) return '备份已全部应用';
  return result.configSaved || result.counts.applied > 0 || result.counts.unchanged > 0
    ? '备份部分应用'
    : '备份未完成';
}
function downloadReport(result: RestoreResult) {
  const url = URL.createObjectURL(
    new Blob(
      [
        JSON.stringify(
          { app: 'qii-extension-manager', kind: 'restore-report', version: 1, ...result },
          null,
          2,
        ),
      ],
      { type: 'application/json' },
    ),
  );
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `qii-restore-report-${result.at.replace(/[:.]/g, '-')}.json`;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

function RestoreRows({
  rows,
  items,
  result = false,
  disabled = false,
  onError,
}: {
  rows: (RestorePlanRow | RestoreRow)[];
  items: ExtensionItem[];
  result?: boolean;
  disabled?: boolean;
  onError: (error: string) => void;
}) {
  const [filter, setFilter] = useState('all');
  const statuses = Array.from(new Set(rows.map((row) => row.status)));
  useEffect(() => {
    if (filter !== 'all' && !rows.some((row) => row.status === filter)) setFilter('all');
  }, [rows, filter]);
  const shown = filter === 'all' ? rows : rows.filter((row) => row.status === filter);
  const open = (promise: Promise<void>) => {
    void promise.catch((error) => onError(errorText(error)));
  };
  return (
    <section className="restore-inventory" aria-label={result ? '逐项恢复结果' : '备份项目预览'}>
      <div className="restore-list-toolbar">
        <strong>
          {result ? '逐项核验结果' : '备份中的全部项目'} <small>{rows.length}</small>
        </strong>
        <select
          aria-label={result ? '筛选恢复结果' : '筛选恢复计划'}
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
        >
          <option value="all">全部项目</option>
          {statuses.map((status) => (
            <option value={status} key={status}>
              {labels[status]} · {rows.filter((row) => row.status === status).length}
            </option>
          ))}
        </select>
      </div>
      <div className="restore-item-list">
        {shown.map((row) => {
          const installed = items.find((item) => item.id === row.id);
          const actual = result ? (row as RestoreRow).actualEnabled : row.beforeEnabled;
          // Rebuild store links through the official-domain helper, including persisted reports.
          const storeUrl =
            row.status === 'missing' && row.installUrl
              ? getStoreUrl({ ...row, enabled: row.targetEnabled })
              : undefined;
          return (
            <article
              className={`restore-item status-${row.status}`}
              key={row.id}
              data-restore-id={row.id}
              data-restore-status={row.status}
            >
              <div className="restore-item-heading">
                <strong title={row.name}>{row.name}</strong>
                <span className="restore-status">
                  {row.status === 'protected' ? (
                    <LockKeyhole size={10} />
                  ) : row.status === 'applied' || row.status === 'unchanged' ? (
                    <Check size={10} />
                  ) : null}
                  {labels[row.status]}
                </span>
              </div>
              <div className="restore-item-meta">
                <span>{row.version ? `备份 v${row.version}` : '备份未记录版本'}</span>
                {installed && <span>当前 v{installed.version}</span>}
                <span>目标：{row.targetEnabled ? '启用' : '停用'}</span>
                <span>
                  {actual === undefined
                    ? `${result ? '核验时' : '当前'}：未安装或无法确认`
                    : `${result ? '核验时' : '当前'}：${actual ? '启用' : '停用'}`}
                </span>
              </div>
              {((row as RestoreRow).error || row.message) && (
                <p>{(row as RestoreRow).error || row.message}</p>
              )}
              {(storeUrl || installed) && (
                <div className="restore-item-links">
                  {storeUrl && (
                    <button
                      type="button"
                      disabled={disabled}
                      aria-label={`前往 ${row.name} 的官方商店`}
                      onClick={() => open(openUrl(storeUrl))}
                    >
                      官方商店查找 <ArrowUpRight size={11} />
                    </button>
                  )}
                  {installed && (
                    <button
                      type="button"
                      disabled={disabled}
                      aria-label={`查看 ${row.name} 的浏览器详情`}
                      onClick={() => open(openNativeManager(installed.id))}
                    >
                      浏览器详情 <ArrowUpRight size={11} />
                    </button>
                  )}
                </div>
              )}
            </article>
          );
        })}
        {!shown.length && <p className="restore-empty">此分类中没有项目。</p>}
      </div>
    </section>
  );
}

function ReportContent({
  result,
  items,
  busy = false,
  onRecheck,
  onClose,
}: {
  result: RestoreResult;
  items: ExtensionItem[];
  busy?: boolean;
  onRecheck?: () => void;
  onClose?: () => void;
}) {
  const [error, setError] = useState('');
  const allComplete = completed(result);
  return (
    <div className="restore-report" data-restore-complete={allComplete ? 'true' : 'false'}>
      <div className="restore-scroll-content">
        <div
          className={`restore-outcome ${allComplete ? 'is-complete' : 'is-partial'}`}
          role="status"
        >
          {allComplete ? <Check size={19} /> : <CircleAlert size={19} />}
          <div>
            <h3>{resultTitle(result)}</h3>
            <p>
              {displayTime(result.at)} ·{' '}
              {result.mode === 'apply-states'
                ? result.verificationError
                  ? '浏览器最终状态尚未完成核验'
                  : '已重新读取浏览器并逐项核验'
                : '保留导入前的扩展状态'}
            </p>
          </div>
        </div>
        <div className="restore-metrics result-metrics">
          <span>
            <b>{result.counts.applied}</b>已应用
          </span>
          <span>
            <b>{result.counts.unchanged}</b>已一致
          </span>
          <span>
            <b>{result.counts.missing}</b>未安装
          </span>
          <span>
            <b>{result.counts.protected}</b>受保护
          </span>
          <span>
            <b>{result.counts.requiresPermission}</b>需授权
          </span>
          <span>
            <b>{result.counts.failed + result.counts.notApplied}</b>未完成
          </span>
        </div>
        <div className={`restore-config-state ${result.configSaved ? '' : 'has-issue'}`}>
          <FileJson size={14} />
          <span>
            {result.configSaved ? '管理器配置已保存' : '管理器配置未保存'}
            {result.configError && <small>{result.configError}</small>}
          </span>
        </div>
        {result.verificationError && (
          <p className="restore-alert" role="alert">
            {result.verificationError} · 以上结果不能视为完整恢复。
          </p>
        )}
        {!result.reportSaved && (
          <p className="restore-note">
            {result.reportError || '本次恢复报告尚未持久保存，请下载报告留存。'}
          </p>
        )}
        {result.counts.missing > 0 && (
          <p className="restore-note">
            仍有 {result.counts.missing}{' '}
            个项目未安装。请自行确认官方商店中的项目，或重新加载开发者模式扩展，然后重新检查。管理器不会静默安装扩展。
          </p>
        )}
        {result.counts.requiresPermission > 0 && (
          <p className="restore-note">
            需要授权的扩展请在浏览器详情页单独启用，完成浏览器确认后再检查。
          </p>
        )}
        {error && (
          <p className="restore-alert" role="alert">
            {error}
          </p>
        )}
        <RestoreRows
          key={result.at}
          rows={result.rows}
          items={items}
          result
          disabled={busy}
          onError={setError}
        />
      </div>
      <div className="restore-footer">
        <div className="restore-actions">
          <button
            type="button"
            className="restore-button"
            onClick={() => {
              try {
                downloadReport(result);
              } catch (err) {
                setError(errorText(err));
              }
            }}
          >
            <ArrowDownToLine size={13} />
            下载恢复报告
          </button>
          {onRecheck && (
            <button type="button" className="restore-button" disabled={busy} onClick={onRecheck}>
              {busy ? <LoaderCircle size={13} className="spin" /> : <RefreshCw size={13} />}重新检查
            </button>
          )}
          {onClose && (
            <button
              type="button"
              className="restore-button is-primary"
              disabled={busy}
              onClick={onClose}
            >
              完成
            </button>
          )}
        </div>
        {onRecheck && (
          <p className="restore-footnote">
            重新检查只更新预览；仍需再次点击应用，才会更改扩展状态。恢复范围始终限定在备份清单内。
          </p>
        )}
      </div>
    </div>
  );
}

export function BackupRestorePanel({
  backup,
  items,
  data,
  onApplied,
  onClose,
  onBusyChange,
}: BackupRestorePanelProps) {
  const [snapshot, setSnapshot] = useState({ items, data });
  const [result, setResult] = useState<RestoreResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [secondary, setSecondary] = useState('');
  const [rechecked, setRechecked] = useState(false);
  const operationRef = useRef(false);
  const preview = useMemo(() => {
    try {
      return { plan: buildRestorePlan(backup, snapshot.items, snapshot.data), error: '' };
    } catch (err) {
      return { plan: null, error: errorText(err) };
    }
  }, [backup, snapshot]);
  function changeBusy(value: boolean) {
    operationRef.current = value;
    setBusy(value);
    onBusyChange?.(value);
  }
  async function apply() {
    if (operationRef.current || !preview.plan) return;
    changeBusy(true);
    setError('');
    setSecondary('');
    try {
      // No storage read or other await precedes this call: preserve the original click's user activation.
      const next = await executeRestore(backup, snapshot.items, 'apply-states', snapshot.data);
      setResult(next);
      try {
        await onApplied?.();
      } catch (err) {
        setSecondary(`恢复结果已返回，界面刷新失败：${errorText(err)}`);
      }
    } catch (err) {
      setError(errorText(err));
    } finally {
      changeBusy(false);
    }
  }
  async function recheck() {
    if (operationRef.current) return;
    changeBusy(true);
    setError('');
    setSecondary('');
    try {
      const [latestItems, latestData] = await Promise.all([listExtensions(), getData()]);
      setSnapshot({ items: latestItems, data: latestData });
      setResult(null);
      setRechecked(true);
    } catch (err) {
      setError(`重新检查失败：${errorText(err)}`);
    } finally {
      changeBusy(false);
    }
  }
  const plan = preview.plan;
  return (
    <div className="backup-restore-panel" aria-busy={busy}>
      {busy && (
        <p className="restore-note" role="status">
          正在处理恢复计划，请保持此面板打开，待结果显示后再关闭，以完成配置保存和报告生成。
        </p>
      )}
      {secondary && (
        <p className="restore-note" role="status">
          {secondary}
        </p>
      )}
      {error && (
        <p className="restore-alert" role="alert">
          {error}
        </p>
      )}
      {result ? (
        <ReportContent
          result={result}
          items={items}
          busy={busy}
          onRecheck={() => {
            void recheck();
          }}
          onClose={onClose}
        />
      ) : (
        <>
          <div className="restore-scroll-content">
            <div className="restore-preview-heading">
              <span className="restore-preview-icon">
                <FileJson size={21} />
              </span>
              <div>
                <h3>备份恢复预览</h3>
                <p>
                  备份包含 <b>{backup.inventory.length}</b> 个项目 ·{' '}
                  {backup.version === 2 ? '完整扩展备份 v2' : '兼容旧版备份 v1'}
                </p>
              </div>
            </div>
            <p className="restore-note">
              导出时间：{displayTime(backup.exportedAt)}。分组、场景、收藏、备注与外观将合并导入；同
              ID 的配置以备份为准。
            </p>
            {preview.error ? (
              <p className="restore-alert" role="alert">
                无法生成恢复计划：{preview.error}
              </p>
            ) : (
              plan && (
                <>
                  <div className="restore-metrics">
                    <span>
                      <b>{plan.counts.enable}</b>要启用
                    </span>
                    <span>
                      <b>{plan.counts.disable}</b>要停用
                    </span>
                    <span>
                      <b>{plan.counts.unchanged}</b>已一致
                    </span>
                    <span>
                      <b>{plan.counts.missing}</b>未安装
                    </span>
                    <span>
                      <b>{plan.counts.protected}</b>受保护
                    </span>
                    <span>
                      <b>{plan.counts.requiresPermission}</b>需授权
                    </span>
                  </div>
                  <p className="restore-boundary">
                    <ShieldCheck size={14} />
                    <span>
                      备份包含清单、管理器配置与启用状态，不含 CRX
                      安装包或扩展私有数据。未安装项目需要自行安装；受保护及需授权项目不会强行更改。清单之外的扩展保持原状。
                    </span>
                  </p>
                  <RestoreRows
                    rows={plan.rows}
                    items={snapshot.items}
                    disabled={busy}
                    onError={setError}
                  />
                </>
              )
            )}
          </div>
          <div className="restore-footer">
            <div className="restore-actions">
              <button type="button" className="restore-button" disabled={busy} onClick={onClose}>
                取消
              </button>
              <button
                type="button"
                className="restore-button"
                disabled={busy}
                onClick={() => {
                  void recheck();
                }}
              >
                <RefreshCw size={13} />
                重新检查
              </button>
              <button
                type="button"
                className="restore-button is-primary"
                disabled={busy || !plan}
                onClick={() => {
                  void apply();
                }}
              >
                {busy ? (
                  <>
                    <LoaderCircle size={13} className="spin" />
                    正在应用并核验
                  </>
                ) : rechecked ? (
                  '再次应用'
                ) : (
                  '确认导入并应用'
                )}
              </button>
            </div>
            <p className="restore-footnote">
              应用时浏览器可能要求确认。缺失项目、受限状态或核验失败会逐项报告，全部核验成功后才显示完整应用。
            </p>
          </div>
        </>
      )}
    </div>
  );
}

export function LastRestoreSummary({ refreshKey }: { refreshKey?: number } = {}) {
  const [result, setResult] = useState<RestoreResult | null>(null);
  const [error, setError] = useState('');
  const [inventoryError, setInventoryError] = useState('');
  const [items, setItems] = useState<ExtensionItem[]>([]);
  const requestRef = useRef(0);
  useEffect(() => {
    let active = true;
    const load = async () => {
      const id = ++requestRef.current;
      try {
        const report = await getLastRestoreResult();
        // A temporary management API failure must not hide an already saved report.
        let latestInventoryError = '';
        const latestItems = report
          ? await listExtensions().catch((err) => {
              latestInventoryError = `当前扩展信息暂不可读：${errorText(err)}。已保存的报告仍可查看和下载。`;
              return [] as ExtensionItem[];
            })
          : [];
        if (active && id === requestRef.current) {
          setResult(report);
          setItems(latestItems);
          setInventoryError(latestInventoryError);
          setError('');
        }
      } catch (err) {
        if (active && id === requestRef.current)
          setError(`上次恢复报告读取失败：${errorText(err)}`);
      }
    };
    void load();
    const dispose = subscribeRestoreReports(() => {
      void load();
    });
    return () => {
      active = false;
      dispose();
    };
  }, [refreshKey]);
  if (error)
    return (
      <p className="restore-alert" role="alert">
        {error}
      </p>
    );
  if (!result) return null;
  return (
    <details className="last-restore-summary">
      <summary>
        <span>
          <FileJson size={14} />
          <strong>上次恢复报告</strong>
          <small>{displayTime(result.at)}</small>
        </span>
        <span className="last-restore-status">{resultTitle(result)}</span>
      </summary>
      <div className="last-restore-content">
        {inventoryError && (
          <p className="restore-note" role="status">
            {inventoryError}
          </p>
        )}
        <p className="restore-note">
          这是上次操作时的核验结果，不代表浏览器当前状态。可下载留存或展开逐项查看。
        </p>
        <button
          type="button"
          className="restore-button last-report-download"
          onClick={() => {
            try {
              downloadReport(result);
            } catch (err) {
              setError(errorText(err));
            }
          }}
        >
          <ArrowDownToLine size={13} />
          下载上次恢复报告
        </button>
        <ReportContent result={result} items={items} />
      </div>
    </details>
  );
}
