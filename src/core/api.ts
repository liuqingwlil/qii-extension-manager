import type { BatchResult, ExtensionItem } from './types';
import { DEMO_SELF_ID, demoItems } from './demo';

const nativeApi = typeof chrome !== 'undefined' && !!chrome.management && !!chrome.runtime?.id;
export const isDemo =
  !nativeApi && typeof location !== 'undefined' && /^https?:$/.test(location.protocol);
export const selfId = nativeApi ? chrome.runtime.id : DEMO_SELF_ID;
export const browserName =
  typeof navigator !== 'undefined' && /Edg\//.test(navigator.userAgent) ? 'Edge' : 'Chrome';
const DEMO_KEY = 'qii.demo.inventory.v1';
const listeners = new Set<() => void>();

function requireApi(): void {
  if (!nativeApi && !isDemo)
    throw new Error('浏览器扩展 API 不可用。请在 Chrome 或 Edge 中加载此扩展。');
}

function readDemo(): ExtensionItem[] {
  try {
    const saved = JSON.parse(localStorage.getItem(DEMO_KEY) ?? 'null') as {
      disabled?: string[];
      removed?: string[];
    } | null;
    if (saved && Array.isArray(saved.disabled) && Array.isArray(saved.removed)) {
      return demoItems
        .filter((item) => !saved.removed!.includes(item.id))
        .map((item) => {
          const enabled = !saved.disabled!.includes(item.id);
          return {
            ...item,
            enabled,
            mayEnable: enabled ? undefined : item.installType !== 'admin',
          };
        });
    }
  } catch {
    /* An invalid preview cache can be safely reset to the preview fixture. */
  }
  return structuredClone(demoItems);
}

function writeDemo(items: ExtensionItem[]): void {
  localStorage.setItem(
    DEMO_KEY,
    JSON.stringify({
      disabled: items.filter((x) => !x.enabled).map((x) => x.id),
      removed: demoItems.filter((x) => !items.some((item) => x.id === item.id)).map((x) => x.id),
    }),
  );
  listeners.forEach((listener) => listener());
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function canToggle(item: ExtensionItem): boolean {
  if (
    item.id === selfId ||
    item.installType === 'admin' ||
    item.type === 'theme' ||
    !item.mayDisable
  )
    return false;
  return item.enabled || item.mayEnable !== false;
}

export function canUninstall(item: ExtensionItem): boolean {
  return item.id !== selfId && item.installType !== 'admin' && item.mayDisable;
}

export async function listExtensions(): Promise<ExtensionItem[]> {
  requireApi();
  return isDemo ? readDemo() : chrome.management.getAll();
}

export async function setExtensionEnabled(item: ExtensionItem, enabled: boolean): Promise<void> {
  requireApi();
  if (!canToggle(item))
    throw new Error(
      item.id === selfId
        ? '管理器自身受到保护。'
        : item.type === 'theme'
          ? '请在浏览器原生扩展页管理主题。'
          : '此扩展受到浏览器或管理员策略保护。',
    );
  if (isDemo) {
    const items = readDemo();
    const current = items.find((entry) => entry.id === item.id);
    if (!current) throw new Error('此扩展已被移除。');
    current.enabled = enabled;
    writeDemo(items);
    return;
  }
  // Keep this call before the first await: Chromium may need the original click's user activation.
  return chrome.management.setEnabled(item.id, enabled);
}

export async function uninstallExtension(item: ExtensionItem): Promise<void> {
  requireApi();
  if (!canUninstall(item)) throw new Error('此扩展受到保护，无法卸载。');
  if (isDemo) {
    if (!window.confirm(`预览：确认移除“${item.name}”？此操作只影响演示数据。`))
      throw new Error('已取消卸载。');
    writeDemo(readDemo().filter((entry) => entry.id !== item.id));
    return;
  }
  return chrome.management.uninstall(item.id, { showConfirmDialog: true });
}

export async function permissionWarnings(id: string): Promise<string[]> {
  requireApi();
  if (!isDemo) return chrome.management.getPermissionWarningsById(id);
  const item = readDemo().find((entry) => entry.id === id);
  if (!item) throw new Error('此扩展已被移除。');
  const warnings: string[] = [];
  if (item.hostPermissions?.includes('<all_urls>') || item.hostPermissions?.includes('https://*/*'))
    warnings.push('读取和更改您在网站上的数据（预览示例）');
  if (item.permissions.includes('tabs')) warnings.push('读取浏览器标签页信息（预览示例）');
  if (item.permissions.includes('management'))
    warnings.push('管理您的应用、扩展程序和主题背景（预览示例）');
  return warnings;
}

export function subscribeExtensions(callback: () => void): () => void {
  if (isDemo) {
    listeners.add(callback);
    const storageListener = (event: StorageEvent) => {
      if (event.key === DEMO_KEY) callback();
    };
    window.addEventListener('storage', storageListener);
    return () => {
      listeners.delete(callback);
      window.removeEventListener('storage', storageListener);
    };
  }
  if (!nativeApi) return () => {};
  const events = [
    chrome.management.onInstalled,
    chrome.management.onUninstalled,
    chrome.management.onEnabled,
    chrome.management.onDisabled,
  ];
  events.forEach((event) => event.addListener(callback));
  return () => events.forEach((event) => event.removeListener(callback));
}

export async function openUrl(url: string): Promise<void> {
  const allowed =
    /^(https?:|chrome-extension:|chrome:\/\/extensions(?:\/|\?|$)|edge:\/\/extensions(?:\/|\?|$))/i;
  if (!allowed.test(url)) throw new Error('不支持打开此链接。');
  if (isDemo) {
    if (/^(chrome|edge):/i.test(url))
      throw new Error('预览无法打开浏览器设置。加载扩展后可使用此功能。');
    if (url.includes('example.invalid'))
      throw new Error('此设置页是演示入口。加载扩展后会打开真实设置页。');
    window.open(url, '_blank', 'noopener,noreferrer');
    return;
  }
  requireApi();
  await chrome.tabs.create({ url });
}

export async function openManager(): Promise<void> {
  if (isDemo) {
    window.open(new URL('index.html', location.href).href, '_blank', 'noopener,noreferrer');
    return;
  }
  requireApi();
  await chrome.runtime.openOptionsPage();
}

export function openNativeManager(id?: string): Promise<void> {
  const base = browserName === 'Edge' ? 'edge://extensions/' : 'chrome://extensions/';
  return openUrl(id ? `${base}?id=${encodeURIComponent(id)}` : base);
}

export function openShortcuts(): Promise<void> {
  return openUrl(
    browserName === 'Edge' ? 'edge://extensions/shortcuts' : 'chrome://extensions/shortcuts',
  );
}

export async function applyChanges(
  items: ExtensionItem[],
  enabledIds: string[],
  scopeIds?: string[],
): Promise<BatchResult> {
  const result: BatchResult = { succeeded: [], failed: [], skipped: [] };
  const enabled = new Set(enabledIds);
  const scope = new Set(scopeIds ?? items.map((item) => item.id));
  const known = new Set(items.map((item) => item.id));
  scope.forEach((id) => {
    if (!known.has(id)) result.skipped.push(id);
  });
  const pending: Promise<void>[] = [];
  for (const item of items) {
    if (!scope.has(item.id)) continue;
    const target = enabled.has(item.id);
    if (target === item.enabled) continue;
    if (!canToggle(item) || (!item.enabled && item.disabledReason === 'permissions_increase')) {
      result.skipped.push(item.id);
      continue;
    }
    // Invoke every browser API synchronously in the click's activation turn; settle failures separately.
    pending.push(
      setExtensionEnabled(item, target).then(
        () => {
          result.succeeded.push(item.id);
        },
        (error: unknown) => {
          result.failed.push({ id: item.id, error: errorText(error) });
        },
      ),
    );
  }
  await Promise.all(pending);
  return result;
}
