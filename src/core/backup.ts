import {
  applyChanges,
  browserName as currentBrowser,
  canToggle,
  isDemo,
  listExtensions,
  selfId,
} from './api';
import { parseBackup, recordActivity, updateData, validateData } from './storage';
import type {
  AppData,
  BackupV2,
  BatchResult,
  ExtensionItem,
  FullBackupInventoryItem,
  ParsedBackup,
  RestorePlan,
  RestorePlanRow,
  RestoreResult,
  RestoreRow,
} from './types';

export type { ParsedBackup, RestorePlan, RestorePlanRow, RestoreResult, RestoreRow } from './types';
const REPORT_KEY = 'qii.lastRestore.v1';
const DEMO_REPORT_KEY = 'qii.demo.lastRestore.v1';
const reportListeners = new Set<() => void>();
const CHROME_ID = /^[a-p]{32}$/;
const textError = (error: unknown) =>
  (error instanceof Error ? error.message : String(error)).slice(0, 2000);

function httpUrl(value: string | undefined): URL | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password
      ? url
      : undefined;
  } catch {
    return undefined;
  }
}

function storeSource(item: FullBackupInventoryItem): 'chrome' | 'edge' | undefined {
  const update = httpUrl(item.updateUrl);
  if (update?.protocol === 'https:' && !update.port) {
    if (update.hostname === 'clients2.google.com' && update.pathname === '/service/update2/crx')
      return 'chrome';
    if (
      update.hostname === 'edge.microsoft.com' &&
      update.pathname === '/extensionwebstorebase/v1/crx'
    )
      return 'edge';
  }
  for (const candidate of [item.installUrl, item.homepageUrl]) {
    const url = httpUrl(candidate);
    if (!url || url.protocol !== 'https:' || url.port || url.hash) continue;
    const chromePath =
      url.hostname === 'chromewebstore.google.com' &&
      (url.pathname === `/detail/${item.id}` ||
        (/^\/detail\/[^/]+\/[a-p]{32}$/.test(url.pathname) &&
          url.pathname.endsWith(`/${item.id}`)));
    const oldChromePath =
      url.hostname === 'chrome.google.com' &&
      /^\/webstore\/detail\/[^/]+\/[a-p]{32}$/.test(url.pathname) &&
      url.pathname.endsWith(`/${item.id}`);
    const edgePath =
      url.hostname === 'microsoftedge.microsoft.com' &&
      (url.pathname === `/addons/detail/${item.id}` ||
        (/^\/addons\/detail\/[^/]+\/[a-p]{32}$/.test(url.pathname) &&
          url.pathname.endsWith(`/${item.id}`)));
    if (chromePath || oldChromePath) return 'chrome';
    if (edgePath) return 'edge';
  }
  return undefined;
}

/** Navigation aid only: even an official store may no longer host an old listing. */
export function getStoreUrl(
  item: FullBackupInventoryItem,
  browserName = currentBrowser,
): string | undefined {
  if (item.installType === 'development') return undefined;
  const source = storeSource(item);
  if (CHROME_ID.test(item.id) && source === 'chrome')
    return `https://chromewebstore.google.com/detail/${encodeURIComponent(item.id)}`;
  if (CHROME_ID.test(item.id) && source === 'edge')
    return `https://microsoftedge.microsoft.com/addons/detail/${encodeURIComponent(item.id)}`;
  // An ID alone does not identify its source store. Keep unknown sources as a named search.
  const name = item.name.trim();
  if (!name) return undefined;
  return /edge/i.test(browserName)
    ? `https://microsoftedge.microsoft.com/addons/search/${encodeURIComponent(name)}`
    : `https://chromewebstore.google.com/search/${encodeURIComponent(name)}`;
}

export function createFullBackup(data: AppData, items: ExtensionItem[]): string {
  const inventory: FullBackupInventoryItem[] = items.map((item) => {
    const entry: FullBackupInventoryItem = {
      id: item.id,
      name: item.name,
      enabled: item.enabled,
      version: item.version,
      type: item.type,
      installType: item.installType,
    };
    for (const field of ['homepageUrl', 'updateUrl'] as const) {
      const url = httpUrl(item[field]);
      if (url) entry[field] = url.href;
    }
    const installUrl = item.id === selfId ? undefined : getStoreUrl(entry);
    if (installUrl) entry.installUrl = installUrl;
    return entry;
  });
  const backup: BackupV2 = {
    app: 'qii-extension-manager',
    version: 2,
    kind: 'extensions',
    exportedAt: new Date().toISOString(),
    source: { browser: currentBrowser, managerId: selfId },
    data: validateData(data),
    inventory,
  };
  if (typeof chrome !== 'undefined' && typeof chrome.runtime?.getManifest === 'function')
    backup.source!.appVersion = chrome.runtime.getManifest().version;
  const validated = parseBackup(backup);
  return JSON.stringify({ app: 'qii-extension-manager', ...validated }, null, 2);
}

function normalize(backup: ParsedBackup): ParsedBackup {
  return parseBackup({ app: 'qii-extension-manager', ...backup });
}

function mergeConfiguration(current: AppData, incoming: AppData): AppData {
  return validateData({
    ...current,
    groups: [
      ...new Map(
        [...current.groups, ...incoming.groups].map((group) => [group.id, group]),
      ).values(),
    ],
    scenes: [
      ...new Map(
        [...current.scenes, ...incoming.scenes].map((scene) => [scene.id, scene]),
      ).values(),
    ],
    meta: { ...current.meta, ...incoming.meta },
    settings: { ...current.settings, ...incoming.settings },
  });
}

function currentItem(
  backup: ParsedBackup,
  entry: { id: string },
  items: ExtensionItem[],
): ExtensionItem | undefined {
  const exact = items.find((item) => item.id === entry.id);
  if (exact) return exact;
  if (entry.id === backup.source?.managerId && entry.id !== selfId)
    return items.find((item) => item.id === selfId);
  return undefined;
}

function protectedMessage(item: ExtensionItem | undefined, isManager: boolean): string {
  if (item?.id === selfId) return '管理器自身受到保护，保留当前管理入口。';
  if (isManager) return '此项在备份中标记为来源管理器，出于保护未自动修改。';
  if (item?.type === 'theme') return '主题的启用状态请在浏览器原生页面管理。';
  return '扩展受到浏览器或组织策略保护，无法自动调整。';
}

export function buildRestorePlan(
  backupInput: ParsedBackup,
  items: ExtensionItem[],
  currentData: AppData,
): RestorePlan {
  const backup = normalize(backupInput);
  const mergedData = mergeConfiguration(validateData(currentData), backup.data);
  const counts: RestorePlan['counts'] = {
    enable: 0,
    disable: 0,
    unchanged: 0,
    missing: 0,
    protected: 0,
    requiresPermission: 0,
  };
  const rows = backup.inventory.map((entry): RestorePlanRow => {
    const item = currentItem(backup, entry, items);
    const isManager = entry.id === selfId || entry.id === backup.source?.managerId;
    const row: RestorePlanRow = {
      id: entry.id,
      name: entry.name,
      version: entry.version,
      type: entry.type,
      installType: entry.installType,
      targetEnabled: entry.enabled,
      beforeEnabled: item?.enabled,
      status: 'unchanged',
    };
    const installUrl = isManager ? undefined : getStoreUrl(entry);
    if (installUrl) row.installUrl = installUrl;
    if (!item && isManager) {
      row.status = 'protected';
      row.message = protectedMessage(item, true);
    } else if (!item) {
      row.status = 'missing';
      row.message =
        entry.installType === 'development'
          ? '开发者模式扩展需要重新加载本地项目，备份不包含安装文件。'
          : '当前浏览器未安装；请在官方商店查找并确认安装后重新应用。';
    } else if (item.enabled === entry.enabled) {
      row.status = 'unchanged';
      if (isManager && entry.id !== selfId && item.id === selfId)
        row.message = '来源管理器 ID 已变化，当前管理器已启用并受到保护。';
    } else if (isManager || !canToggle(item)) {
      row.status = 'protected';
      row.message = protectedMessage(item, isManager);
    } else if (entry.enabled && item.disabledReason === 'permissions_increase') {
      row.status = 'requires-permission';
      row.message = '权限发生变化，需要单独启用并完成浏览器确认。';
    } else row.status = entry.enabled ? 'enable' : 'disable';
    counts[row.status === 'requires-permission' ? 'requiresPermission' : row.status]++;
    return row;
  });
  return { rows, counts, mergedData };
}

function countResults(rows: RestoreRow[]): RestoreResult['counts'] {
  const counts: RestoreResult['counts'] = {
    applied: 0,
    unchanged: 0,
    missing: 0,
    protected: 0,
    requiresPermission: 0,
    failed: 0,
    notApplied: 0,
  };
  for (const row of rows)
    counts[
      row.status === 'requires-permission'
        ? 'requiresPermission'
        : row.status === 'not-applied'
          ? 'notApplied'
          : row.status
    ]++;
  return counts;
}

/** Starts all management calls before its first await; callers pass their already loaded data. */
export async function restoreBackup(
  backupInput: ParsedBackup,
  items: ExtensionItem[],
  mode: 'config-only' | 'apply-states',
  currentData?: AppData,
): Promise<RestoreResult> {
  if (mode !== 'config-only' && mode !== 'apply-states') throw new Error('不支持此恢复模式。');
  if (mode === 'apply-states' && !currentData)
    throw new Error('应用扩展状态前，请先读取当前工作空间配置并预览恢复计划。');
  const backup = normalize(backupInput);
  const plan = buildRestorePlan(backup, items, currentData ?? backup.data);
  const changeIds = plan.rows
    .filter((row) => row.status === 'enable' || row.status === 'disable')
    .map((row) => row.id);
  // Do not move a storage read, lock, or any other await above this call.
  const pending =
    mode === 'apply-states'
      ? applyChanges(
          items,
          backup.inventory.filter((entry) => entry.enabled).map((entry) => entry.id),
          changeIds,
        )
      : Promise.resolve<BatchResult>({ succeeded: [], failed: [], skipped: [] });
  let operations: BatchResult;
  try {
    operations = await pending;
  } catch (error) {
    operations = {
      succeeded: [],
      skipped: [],
      failed: changeIds.map((id) => ({ id, error: textError(error) })),
    };
  }

  let configSaved = false;
  let configError: string | undefined;
  try {
    await updateData((latest) =>
      recordActivity(
        mergeConfiguration(latest, backup.data),
        mode === 'apply-states'
          ? `导入完整备份并应用 ${backup.inventory.length} 项扩展状态`
          : '导入备份配置，保留当前扩展状态',
      ),
    );
    configSaved = true;
  } catch (error) {
    configError = textError(error);
  }

  let actualItems: ExtensionItem[] | undefined;
  let verificationError: string | undefined;
  try {
    actualItems = await listExtensions();
  } catch (error) {
    verificationError = `无法核验浏览器最终状态：${textError(error)}`;
  }
  const succeeded = new Set(operations.succeeded);
  const failures = new Map(operations.failed.map((entry) => [entry.id, entry.error]));
  const rows = plan.rows.map((planned): RestoreRow => {
    const row: RestoreRow = { ...planned, status: 'failed' };
    if (!actualItems) {
      row.status = planned.status === 'missing' ? 'missing' : 'failed';
      row.error = verificationError;
      return row;
    }
    const item = currentItem(backup, planned, actualItems);
    const isManager = planned.id === selfId || planned.id === backup.source?.managerId;
    row.actualEnabled = item?.enabled;
    if (!item) {
      row.status = isManager ? 'protected' : 'missing';
      return row;
    }
    if (item.enabled === row.targetEnabled) {
      row.status = succeeded.has(row.id) ? 'applied' : 'unchanged';
      return row;
    }
    if (isManager || !canToggle(item)) {
      row.status = 'protected';
      row.message = protectedMessage(item, isManager);
      return row;
    }
    if (row.targetEnabled && item.disabledReason === 'permissions_increase') {
      row.status = 'requires-permission';
      row.message = '请单独启用并完成新增权限授权。';
      return row;
    }
    if (mode === 'config-only') {
      row.status = 'not-applied';
      row.message = '仅导入配置，未应用此扩展的备份状态。';
      return row;
    }
    row.error = failures.get(row.id) ?? '浏览器最终状态未达到备份目标，请在原生扩展页检查后重试。';
    return row;
  });
  const result: RestoreResult = {
    at: new Date().toISOString(),
    mode,
    rows,
    counts: countResults(rows),
    configSaved,
    configError,
    verificationError,
    reportSaved: false,
    complete:
      configSaved &&
      !verificationError &&
      rows.every((row) => row.status === 'applied' || row.status === 'unchanged'),
  };
  try {
    await saveLastRestoreResult({ ...result, reportSaved: true });
    result.reportSaved = true;
  } catch (error) {
    result.reportError = `恢复结果已返回，但报告保存失败：${textError(error)}`;
  }
  return result;
}

export const executeRestore = restoreBackup;

export async function saveLastRestoreResult(result: RestoreResult): Promise<void> {
  if (isDemo) {
    localStorage.setItem(DEMO_REPORT_KEY, JSON.stringify(result));
    reportListeners.forEach((listener) => listener());
    return;
  }
  if (typeof chrome === 'undefined' || !chrome.storage?.local)
    throw new Error('浏览器存储 API 不可用。');
  await chrome.storage.local.set({ [REPORT_KEY]: result });
}

export async function getLastRestoreResult(): Promise<RestoreResult | null> {
  let value: unknown;
  if (isDemo) {
    const raw = localStorage.getItem(DEMO_REPORT_KEY);
    if (raw === null) return null;
    try {
      value = JSON.parse(raw);
    } catch {
      throw new Error('上次恢复报告无法读取。');
    }
  } else {
    if (typeof chrome === 'undefined' || !chrome.storage?.local)
      throw new Error('浏览器存储 API 不可用。');
    value = (await chrome.storage.local.get(REPORT_KEY))[REPORT_KEY];
  }
  if (value === undefined || value === null) return null;
  const report = value as RestoreResult;
  const statuses = new Set([
    'applied',
    'unchanged',
    'missing',
    'protected',
    'requires-permission',
    'failed',
    'not-applied',
  ]);
  if (
    typeof report !== 'object' ||
    !Array.isArray(report.rows) ||
    report.rows.length > 10000 ||
    !['config-only', 'apply-states'].includes(report.mode) ||
    !Number.isFinite(Date.parse(report.at)) ||
    typeof report.configSaved !== 'boolean' ||
    typeof report.complete !== 'boolean' ||
    report.rows.some(
      (row) =>
        !row ||
        typeof row.id !== 'string' ||
        typeof row.name !== 'string' ||
        typeof row.targetEnabled !== 'boolean' ||
        !statuses.has(row.status),
    )
  )
    throw new Error('上次恢复报告格式无效。');
  return {
    ...report,
    counts: countResults(report.rows),
    complete:
      report.configSaved &&
      !report.verificationError &&
      report.rows.every(
        (row) =>
          (row.status === 'applied' || row.status === 'unchanged') &&
          row.actualEnabled === row.targetEnabled,
      ),
  };
}

export const getLastRestoreReport = getLastRestoreResult;

export function subscribeRestoreReports(callback: () => void): () => void {
  if (isDemo) {
    reportListeners.add(callback);
    const listener = (event: StorageEvent) => {
      if (event.key === DEMO_REPORT_KEY) callback();
    };
    window.addEventListener('storage', listener);
    return () => {
      reportListeners.delete(callback);
      window.removeEventListener('storage', listener);
    };
  }
  if (typeof chrome === 'undefined' || !chrome.storage?.onChanged) return () => {};
  const listener = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
    if (area === 'local' && changes[REPORT_KEY]) callback();
  };
  chrome.storage.onChanged.addListener(listener);
  return () => chrome.storage.onChanged.removeListener(listener);
}
