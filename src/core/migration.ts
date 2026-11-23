import { isDemo, openUrl } from './api';
import { parseBackup } from './storage';
import type { ParsedBackup } from './types';

export const MIGRATION_HOST = 'com.qii.migration';
export interface MigrationEntry {
  id: string;
  name: string;
  status: 'included' | 'files-restored' | 'missing' | 'failed';
  message?: string;
  path?: string;
}
export interface MigrationResult {
  action: 'export' | 'import';
  complete: boolean;
  installed: false;
  items: MigrationEntry[];
  archivePath?: string;
  directory?: string;
  reportPath?: string;
  guidePath?: string;
  managerBackup?: ParsedBackup;
  messages: string[];
  totalItems: number;
  detailsTruncated: boolean;
}
function nativeAvailable() {
  if (isDemo || typeof chrome === 'undefined' || !chrome.runtime?.id)
    throw new Error(
      '完整文件迁移需要在 Windows 的 Chrome 或 Edge 中加载扩展，并连接本地迁移助手。',
    );
}
function object(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input))
    throw new Error('迁移助手返回了无效结果。');
  return input as Record<string, unknown>;
}
function text(input: unknown, max = 4000): string | undefined {
  return typeof input === 'string' ? input.slice(0, max) : undefined;
}
async function nativeRequest(request: Record<string, unknown>): Promise<Record<string, unknown>> {
  nativeAvailable();
  if (typeof chrome.runtime.sendNativeMessage !== 'function')
    throw new Error('请先允许本地通信权限，再连接迁移助手。');
  if (new TextEncoder().encode(JSON.stringify(request)).length > 1024 * 1024)
    throw new Error('管理配置超过本地通信大小限制，请先减少过长备注或使用助手独立备份扩展文件。');
  let response: unknown;
  try {
    response = await chrome.runtime.sendNativeMessage(MIGRATION_HOST, request);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(
      `无法连接迁移助手。请运行最新版 Windows 助手，等待自动配置；识别不到时再使用手动 ID。${detail}`,
    );
  }
  const result = object(response);
  if (result.ok !== true) throw new Error(text(result.error) || '迁移未完成。');
  return result;
}
/** Called directly from a button so the optional permission retains user activation. */
export async function connectMigration(): Promise<string> {
  nativeAvailable();
  const granted = await chrome.permissions.request({ permissions: ['nativeMessaging'] });
  if (!granted) throw new Error('未允许连接本地迁移助手。');
  return pingMigration();
}
export async function pingMigration(): Promise<string> {
  const result = await nativeRequest({ action: 'ping' });
  const capabilities = result.capabilities;
  if (
    !Array.isArray(capabilities) ||
    !['export', 'import'].every((action) => capabilities.includes(action))
  )
    throw new Error('迁移助手版本不支持文件导入导出，请更新助手。');
  return text(result.version, 50) || '1';
}
export async function migrationAccessGranted(): Promise<boolean> {
  if (isDemo || typeof chrome === 'undefined' || !chrome.runtime?.id) return false;
  return chrome.permissions.contains({ permissions: ['nativeMessaging'] });
}
export function parseMigrationResult(input: unknown, action: 'export' | 'import'): MigrationResult {
  const result = object(input);
  if (result.action !== action || !Array.isArray(result.items) || result.items.length > 10000)
    throw new Error('迁移助手报告格式无效。');
  const statuses =
    action === 'export'
      ? ['included', 'missing', 'failed']
      : ['files-restored', 'missing', 'failed'];
  const seen = new Set<string>();
  const items = result.items.map((input) => {
    const row = object(input);
    if (
      typeof row.id !== 'string' ||
      !row.id ||
      row.id.length > 200 ||
      seen.has(row.id) ||
      typeof row.name !== 'string' ||
      !statuses.includes(String(row.status))
    )
      throw new Error('迁移助手项目报告无效。');
    seen.add(row.id);
    return {
      id: row.id,
      name: row.name.slice(0, 500),
      status: row.status as MigrationEntry['status'],
      message: text(row.message),
      path: text(row.path),
    };
  });
  const success = action === 'export' ? 'included' : 'files-restored';
  const detailsTruncated = result.detailsTruncated === true;
  const totalItems = detailsTruncated ? result.totalItems : items.length;
  if (
    typeof totalItems !== 'number' ||
    !Number.isInteger(totalItems) ||
    totalItems < items.length ||
    totalItems > 10000 ||
    (detailsTruncated && !text(result.reportPath))
  )
    throw new Error('迁移助手的完整报告位置或项目总数无效。');
  return {
    action,
    complete:
      result.complete === true && totalItems > 0 && items.every((row) => row.status === success),
    installed: false,
    items,
    totalItems,
    detailsTruncated,
    archivePath: text(result.archivePath),
    directory: text(result.directory),
    reportPath: text(result.reportPath),
    guidePath: text(result.guidePath),
    managerBackup: result.managerBackup ? parseBackup(result.managerBackup) : undefined,
    messages: [result.message, result.reportWarning]
      .map((value) => text(value))
      .filter((value): value is string => !!value),
  };
}
export async function exportExtensionFiles(backup: unknown): Promise<MigrationResult> {
  const parsed = parseBackup(backup);
  const result = await nativeRequest({
    action: 'export',
    backup: { app: 'qii-extension-manager', ...parsed },
    browser: parsed.source?.browser,
    managerId: chrome.runtime.id,
  });
  return parseMigrationResult(result, 'export');
}
export async function importExtensionFiles(): Promise<MigrationResult> {
  return parseMigrationResult(await nativeRequest({ action: 'import' }), 'import');
}
export function openMigrationManager(action: 'export' | 'import'): Promise<void> {
  const path = `index.html?migration=${action}#migration`;
  return openUrl(isDemo ? new URL(path, location.href).href : chrome.runtime.getURL(path));
}
