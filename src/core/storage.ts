import { canToggle, isDemo } from './api';
import { demoItems } from './demo';
import type {
  Activity,
  AppData,
  Backup,
  FullBackupInventoryItem,
  ParsedBackup,
  ExtensionItem,
  ExtensionMeta,
  Group,
  Scene,
  Settings,
} from './types';

const DATA_KEY = 'qii.data.v1';
const DEMO_DATA_KEY = 'qii.demo.data.v1';
const listeners = new Set<() => void>();
const forbiddenKeys = new Set(['__proto__', 'constructor', 'prototype']);
let fallbackWriteQueue: Promise<unknown> = Promise.resolve();
type ObjectValue = Record<string, unknown>;

export function defaultData(): AppData {
  const data: AppData = {
    schemaVersion: 1,
    groups: [],
    scenes: [],
    meta: {},
    settings: {
      theme: 'light',
      view: 'grid',
      sort: 'name',
      confirmBulk: true,
      popupView: 'grid',
      popupDensity: 'comfortable',
      skin: 'forest',
    },
    activity: [],
  };
  if (isDemo) {
    data.groups = [
      { id: 'work', name: '工作效率' },
      { id: 'dev', name: '开发工具' },
      { id: 'read', name: '阅读收藏' },
    ];
    const working = [0, 1, 2, 9, 11, 13, 15].map((i) => demoItems[i].id);
    const reading = [0, 1, 2, 3, 6, 12, 13, 15].map((i) => demoItems[i].id);
    const light = [0, 1, 13, 15].map((i) => demoItems[i].id);
    const scopeIds = demoItems.filter(canToggle).map((item) => item.id);
    data.scenes = [
      {
        id: 'working',
        name: '工作模式',
        description: '翻译、密码与效率工具，准备好开始工作。',
        enabledIds: working.filter((id) => scopeIds.includes(id)),
        scopeIds,
        createdAt: 0,
      },
      {
        id: 'reading',
        name: '专注阅读',
        description: '留下翻译和收藏，让注意力回到内容。',
        enabledIds: reading.filter((id) => scopeIds.includes(id)),
        scopeIds,
        createdAt: 0,
      },
      {
        id: 'light',
        name: '轻量浏览',
        description: '只保留浏览时需要的基础工具。',
        enabledIds: light.filter((id) => scopeIds.includes(id)),
        scopeIds,
        createdAt: 0,
      },
    ];
    demoItems.forEach((item, i) => {
      data.meta[item.id] = {
        favorite: [0, 1, 2, 6].includes(i),
        groupId: [4, 5, 7, 8, 10].includes(i) ? 'dev' : [2, 3, 6, 12].includes(i) ? 'read' : 'work',
        note: '',
      };
    });
  }
  return data;
}

function invalid(message: string): never {
  throw new Error(`备份格式无效：${message}`);
}
function object(value: unknown, label: string): ObjectValue {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    invalid(`${label}必须是对象。`);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) invalid(`${label}含不支持的数据类型。`);
  const record = value as ObjectValue;
  if (Object.keys(record).some((key) => forbiddenKeys.has(key))) invalid(`${label}包含保留字段。`);
  return record;
}
function list(value: unknown, label: string, limit: number): unknown[] {
  if (!Array.isArray(value) || value.length > limit)
    invalid(`${label}必须是数组且最多包含 ${limit} 项。`);
  return value;
}
function string(value: unknown, label: string, limit: number, allowEmpty = false): string {
  if (typeof value !== 'string' || value.length > limit || (!allowEmpty && !value.trim()))
    invalid(`${label}必须是${allowEmpty ? '长度合适的' : '非空'}文本，最多 ${limit} 字符。`);
  return value;
}
function identifier(value: unknown, label: string): string {
  const id = string(value, label, 128);
  if (!/^[a-zA-Z0-9_-]+$/.test(id) || forbiddenKeys.has(id)) invalid(`${label}含不支持的标识符。`);
  return id;
}
function boolean(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') invalid(`${label}必须是布尔值。`);
  return value;
}
function time(value: unknown, label: string): number {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < 0 ||
    value > 8640000000000000
  )
    invalid(`${label}必须是有效时间。`);
  return value;
}
function unique<T>(items: T[], getId: (item: T) => string, label: string): T[] {
  const ids = items.map(getId);
  if (new Set(ids).size !== ids.length) invalid(`${label}存在重复标识符。`);
  return items;
}
function ids(value: unknown, label: string): string[] {
  return unique(
    list(value, label, 10000).map((entry) => identifier(entry, label)),
    (entry) => entry,
    label,
  );
}
function choice<T extends string>(value: unknown, options: readonly T[], label: string): T {
  if (typeof value !== 'string' || !options.includes(value as T)) invalid(`${label}不受支持。`);
  return value as T;
}

function parseData(input: unknown): AppData {
  const value = object(input, '配置');
  if (value.schemaVersion !== 1) invalid('不支持此配置版本。');
  const groups: Group[] = unique(
    list(value.groups, '分组', 300).map((entry) => {
      const item = object(entry, '分组');
      return { id: identifier(item.id, '分组 ID'), name: string(item.name, '分组名称', 80) };
    }),
    (item) => item.id,
    '分组',
  );
  const groupIds = new Set(groups.map((group) => group.id));
  const scenes: Scene[] = unique(
    list(value.scenes, '场景', 500).map((entry) => {
      const item = object(entry, '场景');
      const scopeIds = ids(item.scopeIds, '场景管理范围');
      const enabledIds = ids(item.enabledIds, '场景启用清单');
      if (enabledIds.some((id) => !scopeIds.includes(id)))
        invalid('场景启用清单必须包含在该场景的管理范围内。');
      return {
        id: identifier(item.id, '场景 ID'),
        name: string(item.name, '场景名称', 80),
        description: string(item.description, '场景说明', 500, true),
        enabledIds,
        scopeIds,
        createdAt: time(item.createdAt, '场景创建时间'),
      };
    }),
    (item) => item.id,
    '场景',
  );
  const metaObject = object(value.meta, '扩展标记');
  if (Object.keys(metaObject).length > 10000) invalid('扩展标记数量过多。');
  const meta: Record<string, ExtensionMeta> = {};
  for (const [id, entry] of Object.entries(metaObject)) {
    identifier(id, '扩展 ID');
    const item = object(entry, '扩展标记');
    const parsed: ExtensionMeta = {};
    if (item.favorite !== undefined) parsed.favorite = boolean(item.favorite, '收藏状态');
    if (item.groupId !== undefined) {
      parsed.groupId = identifier(item.groupId, '分组引用');
      if (!groupIds.has(parsed.groupId)) invalid('扩展标记引用了不存在的分组。');
    }
    if (item.note !== undefined) parsed.note = string(item.note, '扩展备注', 4000, true);
    meta[id] = parsed;
  }
  const settingsObject = object(value.settings, '设置');
  const settings: Settings = {
    theme: choice(settingsObject.theme, ['light', 'dark', 'system'], '主题'),
    view: choice(settingsObject.view, ['grid', 'list'], '视图'),
    sort: choice(settingsObject.sort, ['name', 'enabled', 'group'], '排序'),
    confirmBulk: boolean(settingsObject.confirmBulk, '批量确认设置'),
    popupView:
      settingsObject.popupView === undefined
        ? 'grid'
        : choice(settingsObject.popupView, ['grid', 'list'] as const, '快捷面板视图'),
    popupDensity:
      settingsObject.popupDensity === undefined
        ? 'comfortable'
        : choice(settingsObject.popupDensity, ['comfortable', 'compact'] as const, '快捷面板密度'),
    skin:
      settingsObject.skin === undefined
        ? 'forest'
        : choice(settingsObject.skin, ['forest', 'elysia'] as const, '界面皮肤'),
  };
  const activity: Activity[] = unique(
    list(value.activity, '活动记录', 200).map((entry) => {
      const item = object(entry, '活动记录');
      return {
        id: identifier(item.id, '活动 ID'),
        at: time(item.at, '活动时间'),
        text: string(item.text, '活动描述', 1000),
      };
    }),
    (item) => item.id,
    '活动记录',
  );
  return { schemaVersion: 1, groups, scenes, meta, settings, activity };
}

/** Validates and rebuilds data without writing it, for restore preflight and transactions. */
export function validateData(input: unknown): AppData {
  return parseData(input);
}

export async function getData(): Promise<AppData> {
  let value: unknown;
  if (isDemo) {
    const raw = localStorage.getItem(DEMO_DATA_KEY);
    if (raw === null) return defaultData();
    try {
      value = JSON.parse(raw);
    } catch {
      throw new Error('预览配置无法读取。请清除该站点的本地存储后重试。');
    }
  } else {
    if (typeof chrome === 'undefined' || !chrome.storage?.local)
      throw new Error('浏览器存储 API 不可用。请加载此扩展后使用。');
    value = (await chrome.storage.local.get(DATA_KEY))[DATA_KEY];
    if (value === undefined) return defaultData();
  }
  return parseData(value);
}

export async function saveData(data: AppData): Promise<void> {
  const clean = parseData(data);
  if (isDemo) {
    localStorage.setItem(DEMO_DATA_KEY, JSON.stringify(clean));
    listeners.forEach((listener) => listener());
  } else {
    if (typeof chrome === 'undefined' || !chrome.storage?.local)
      throw new Error('浏览器存储 API 不可用。');
    await chrome.storage.local.set({ [DATA_KEY]: clean });
  }
}

/** Serializes read/modify/write transactions across this extension's manager and popup. */
export async function updateData(mutator: (current: AppData) => AppData): Promise<AppData> {
  const transaction = async () => {
    const current = await getData();
    const next = mutator(current);
    await saveData(next);
    return next;
  };
  if (typeof navigator !== 'undefined' && navigator.locks?.request) {
    return navigator.locks.request('qii.data.v1.mutation', { mode: 'exclusive' }, transaction);
  }
  // Tests and unsupported non-browser environments retain per-context serialization.
  const pending = fallbackWriteQueue.then(transaction, transaction);
  fallbackWriteQueue = pending.catch(() => {});
  return pending;
}

export function subscribeData(callback: () => void): () => void {
  if (isDemo) {
    listeners.add(callback);
    const handler = (event: StorageEvent) => {
      if (event.key === DEMO_DATA_KEY) callback();
    };
    window.addEventListener('storage', handler);
    return () => {
      listeners.delete(callback);
      window.removeEventListener('storage', handler);
    };
  }
  if (typeof chrome === 'undefined' || !chrome.storage?.onChanged) return () => {};
  const handler = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
    if (area === 'local' && changes[DATA_KEY]) callback();
  };
  chrome.storage.onChanged.addListener(handler);
  return () => chrome.storage.onChanged.removeListener(handler);
}

export function parseBackup(input: unknown): ParsedBackup {
  const value = object(input, '备份');
  if (value.app !== 'qii-extension-manager' || (value.version !== 1 && value.version !== 2))
    invalid('这不是受支持的栖备份文件。');
  if (value.version === 2 && value.kind !== 'extensions') invalid('不支持此完整备份类型。');
  const exportedAt = string(value.exportedAt, '导出时间', 64);
  if (!Number.isFinite(Date.parse(exportedAt))) invalid('导出时间无效。');
  const inventory = unique(
    list(value.inventory, '扩展清单', 10000).map((entry) => {
      const item = object(entry, '扩展清单项');
      const parsed: FullBackupInventoryItem = {
        id: identifier(item.id, '扩展清单 ID'),
        name: string(item.name, '扩展名称', 512),
        enabled: boolean(item.enabled, '扩展状态'),
      };
      if (item.version !== undefined) parsed.version = string(item.version, '扩展版本', 128);
      if (item.type !== undefined)
        parsed.type = choice(
          item.type,
          [
            'extension',
            'theme',
            'hosted_app',
            'packaged_app',
            'legacy_packaged_app',
            'login_screen_extension',
          ] as const,
          '扩展类型',
        );
      if (item.installType !== undefined)
        parsed.installType = choice(
          item.installType,
          ['normal', 'development', 'admin', 'sideload', 'other'] as const,
          '安装来源',
        );
      for (const field of ['homepageUrl', 'updateUrl', 'installUrl'] as const) {
        if (item[field] === undefined) continue;
        const raw = string(item[field], `${field} 链接`, 4096);
        let url: URL;
        try {
          url = new URL(raw);
        } catch {
          invalid(`${field} 链接无效。`);
        }
        if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password)
          invalid(`${field} 仅支持不含账户信息的 HTTP(S) 链接。`);
        if (field === 'installUrl') {
          const validStoreId = /^[a-p]{32}$/.test(parsed.id);
          const official =
            url.protocol === 'https:' &&
            !url.port &&
            !url.hash &&
            ((url.hostname === 'chromewebstore.google.com' &&
              ((validStoreId &&
                (url.pathname === `/detail/${parsed.id}` ||
                  (/^\/detail\/[^/]+\/[a-p]{32}$/.test(url.pathname) &&
                    url.pathname.endsWith(`/${parsed.id}`)))) ||
                url.pathname.startsWith('/search/'))) ||
              (url.hostname === 'microsoftedge.microsoft.com' &&
                ((validStoreId &&
                  (url.pathname === `/addons/detail/${parsed.id}` ||
                    (/^\/addons\/detail\/[^/]+\/[a-p]{32}$/.test(url.pathname) &&
                      url.pathname.endsWith(`/${parsed.id}`)))) ||
                  url.pathname.startsWith('/addons/search/'))));
          if (!official) invalid('安装链接必须是匹配该扩展 ID 的官方商店详情或官方搜索页。');
        }
        parsed[field] = url.href;
      }
      return parsed;
    }),
    (item) => item.id,
    '扩展清单',
  );
  const parsed: ParsedBackup = {
    version: value.version,
    exportedAt,
    data: parseData(value.data),
    inventory,
  };
  if (value.version === 2) parsed.kind = 'extensions';
  if (value.source !== undefined) {
    const source = object(value.source, '备份来源');
    parsed.source = {
      browser: string(source.browser, '来源浏览器', 64),
      managerId: identifier(source.managerId, '来源管理器 ID'),
    };
    if (source.appVersion !== undefined)
      parsed.source.appVersion = string(source.appVersion, '来源管理器版本', 128);
  }
  return parsed;
}

export function createBackup(data: AppData, items: ExtensionItem[]): string {
  const backup: Backup = {
    app: 'qii-extension-manager',
    version: 1,
    exportedAt: new Date().toISOString(),
    data: parseData(data),
    inventory: items.map((item) => ({ id: item.id, name: item.name, enabled: item.enabled })),
  };
  return JSON.stringify(backup, null, 2);
}

export function recordActivity(data: AppData, text: string): AppData {
  const id =
    typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return {
    ...data,
    activity: [{ id, at: Date.now(), text: text.slice(0, 1000) }, ...data.activity].slice(0, 200),
  };
}
