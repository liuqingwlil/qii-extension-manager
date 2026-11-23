import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  AppData,
  ExtensionItem,
  FullBackupInventoryItem,
  ParsedBackup,
} from '../src/core/types';

const id = (letter: string) => letter.repeat(32);
const SELF = id('a');
const CHROME_UPDATE = 'https://clients2.google.com/service/update2/crx';
const EDGE_UPDATE = 'https://edge.microsoft.com/extensionwebstorebase/v1/crx';
const DATA_KEY = 'qii.data.v1';
const REPORT_KEY = 'qii.lastRestore.v1';
const event = () => ({ addListener: vi.fn(), removeListener: vi.fn() });
let live: ExtensionItem[];
let stored: Record<string, unknown>;

function extension(
  letter: string,
  enabled = true,
  overrides: Partial<ExtensionItem> = {},
): ExtensionItem {
  return {
    id: id(letter),
    name: `Tool ${letter}`,
    shortName: `Tool ${letter}`,
    description: '',
    version: '1.2.3',
    enabled,
    mayEnable: enabled ? undefined : true,
    mayDisable: true,
    installType: 'normal',
    type: 'extension',
    isApp: false,
    offlineEnabled: false,
    optionsUrl: '',
    permissions: [],
    hostPermissions: [],
    ...overrides,
  };
}

beforeEach(() => {
  vi.resetModules();
  live = [
    extension('a', true, { name: 'Qii', installType: 'development' }),
    extension('b', false),
    extension('c', true),
    extension('p', true),
  ];
  stored = {};
  vi.stubGlobal('chrome', {
    runtime: { id: SELF, getManifest: () => ({ version: '1.3.0' }) },
    management: {
      getAll: vi.fn(async () => structuredClone(live)),
      setEnabled: vi.fn(async (targetId: string, enabled: boolean) => {
        const current = live.find((item) => item.id === targetId);
        if (!current) throw new Error('No such extension');
        current.enabled = enabled;
      }),
      onEnabled: event(),
      onDisabled: event(),
      onInstalled: event(),
      onUninstalled: event(),
    },
    storage: {
      local: {
        get: vi.fn(async (key: string) => ({ [key]: structuredClone(stored[key]) })),
        set: vi.fn(async (values: Record<string, unknown>) => {
          Object.assign(stored, structuredClone(values));
        }),
      },
      onChanged: event(),
    },
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
});

async function makeBackup(
  inventory: FullBackupInventoryItem[],
  data?: AppData,
  source?: ParsedBackup['source'],
): Promise<ParsedBackup> {
  const storage = await import('../src/core/storage');
  return storage.parseBackup({
    app: 'qii-extension-manager',
    version: 2,
    kind: 'extensions',
    exportedAt: '2026-11-18T00:00:00.000Z',
    source,
    data: data ?? storage.defaultData(),
    inventory,
  });
}

describe('complete inventory backup and trusted store navigation', () => {
  it('exports every supplied item with its real metadata, source manager, and no private extension data', async () => {
    const { defaultData, parseBackup } = await import('../src/core/storage');
    const { createFullBackup } = await import('../src/core/backup');
    live[1].updateUrl = CHROME_UPDATE;
    live[2].updateUrl = EDGE_UPDATE;
    live.push(extension('d', false, { type: 'theme' }));
    const raw = JSON.parse(createFullBackup(defaultData(), live));
    expect(raw.version).toBe(2);
    expect(raw.kind).toBe('extensions');
    expect(raw.source).toEqual({ browser: 'Chrome', managerId: SELF, appVersion: '1.3.0' });
    expect(raw.inventory.map((item: FullBackupInventoryItem) => item.id)).toEqual(
      live.map((item) => item.id),
    );
    expect(
      raw.inventory.find((item: FullBackupInventoryItem) => item.id === id('b')).installUrl,
    ).toBe(`https://chromewebstore.google.com/detail/${id('b')}`);
    expect(
      raw.inventory.find((item: FullBackupInventoryItem) => item.id === id('c')).installUrl,
    ).toBe(`https://microsoftedge.microsoft.com/addons/detail/${id('c')}`);
    expect(raw.inventory[0].installUrl).toBeUndefined();
    expect(raw.inventory[1].permissions).toBeUndefined();
    expect(raw.inventory[1].optionsUrl).toBeUndefined();
    expect(parseBackup(raw).inventory).toHaveLength(live.length);
  });

  it('respects the source store instead of guessing from the current browser or an unknown ID', async () => {
    const { getStoreUrl } = await import('../src/core/backup');
    const entry = {
      id: id('b'),
      name: 'A tool / 工具',
      enabled: false,
      installType: 'normal' as const,
    };
    expect(getStoreUrl({ ...entry, updateUrl: CHROME_UPDATE }, 'Edge')).toBe(
      `https://chromewebstore.google.com/detail/${entry.id}`,
    );
    expect(getStoreUrl({ ...entry, updateUrl: EDGE_UPDATE }, 'Chrome')).toBe(
      `https://microsoftedge.microsoft.com/addons/detail/${entry.id}`,
    );
    expect(
      getStoreUrl(
        { ...entry, updateUrl: 'https://clients2.google.com.evil.example/service/update2/crx' },
        'Edge',
      ),
    ).toBe(`https://microsoftedge.microsoft.com/addons/search/${encodeURIComponent(entry.name)}`);
    expect(
      getStoreUrl({ ...entry, updateUrl: 'https://clients2.google.com/unrecognized-path' }),
    ).toContain('/search/');
    expect(getStoreUrl({ ...entry, id: 'not-a-store-id', updateUrl: CHROME_UPDATE })).toContain(
      '/search/',
    );
    expect(
      getStoreUrl({ ...entry, installType: 'development', updateUrl: CHROME_UPDATE }),
    ).toBeUndefined();
  });

  it.each([
    ['homepageUrl', 'javascript:alert(1)'],
    ['updateUrl', 'file:///C:/private/config'],
    ['updateUrl', 'https://user:secret@example.com/update.xml'],
    ['installUrl', 'https://evil.example/install'],
    ['installUrl', `https://chromewebstore.google.com.evil.example/detail/${id('b')}`],
    ['installUrl', `https://chromewebstore.google.com/detail/${id('c')}`],
    ['installUrl', `http://chromewebstore.google.com/detail/${id('b')}`],
  ])('rejects an unsafe inventory URL %s=%s', async (field, value) => {
    await expect(
      makeBackup([{ id: id('b'), name: 'Tool', enabled: true, [field]: value }]),
    ).rejects.toThrow('备份格式无效');
  });

  it('keeps legacy v1 configuration backups readable and still exports the existing v1 format', async () => {
    const { createBackup, defaultData, parseBackup } = await import('../src/core/storage');
    const raw = JSON.parse(createBackup(defaultData(), live));
    expect(raw.version).toBe(1);
    expect(raw.kind).toBeUndefined();
    const parsed = parseBackup(raw);
    expect(parsed.version).toBe(1);
    expect(parsed.inventory).toEqual(
      live.map((item) => ({ id: item.id, name: item.name, enabled: item.enabled })),
    );
    expect(parsed.data.settings.skin).toBe('forest');
  });
});

describe('verified restoration with explicit scope and independent persistence results', () => {
  it('applies legacy v1 states immediately within the click turn, verifies them, and leaves extra local extensions alone', async () => {
    const storage = await import('../src/core/storage');
    const backupApi = await import('../src/core/backup');
    const data = storage.defaultData();
    const incoming = {
      ...data,
      groups: [{ id: 'work', name: 'Work' }],
      meta: { [id('b')]: { groupId: 'work', favorite: true } },
      settings: { ...data.settings, skin: 'elysia' as const },
    };
    const raw = JSON.parse(storage.createBackup(incoming, live.slice(0, 3)));
    raw.inventory[1].enabled = true;
    raw.inventory[2].enabled = false;
    const backup = storage.parseBackup(raw);
    const task = backupApi.executeRestore(backup, structuredClone(live), 'apply-states', data);
    expect(chrome.management.setEnabled).toHaveBeenCalledTimes(2);
    expect(chrome.storage.local.get).not.toHaveBeenCalled();
    const result = await task;
    expect(result.complete).toBe(true);
    expect(result.counts).toMatchObject({ applied: 2, unchanged: 1, missing: 0, failed: 0 });
    expect(result.configSaved).toBe(true);
    expect(result.reportSaved).toBe(true);
    expect(live.find((item) => item.id === id('p'))!.enabled).toBe(true);
    expect(vi.mocked(chrome.management.setEnabled).mock.calls.map((call) => call[0])).toEqual([
      id('b'),
      id('c'),
    ]);
    expect(result.rows.find((row) => row.id === id('b'))).toMatchObject({
      beforeEnabled: false,
      targetEnabled: true,
      actualEnabled: true,
      status: 'applied',
    });
    expect((stored[DATA_KEY] as AppData).settings.skin).toBe('elysia');
    expect((await backupApi.getLastRestoreResult())?.complete).toBe(true);
  });

  it('preflights invalid merged configuration before starting any extension mutations', async () => {
    const storage = await import('../src/core/storage');
    const api = await import('../src/core/backup');
    const current = storage.defaultData();
    current.groups = Array.from({ length: 300 }, (_, index) => ({
      id: `group-${index}`,
      name: `Group ${index}`,
    }));
    const incoming = storage.defaultData();
    incoming.groups = [{ id: 'new-group', name: 'One more' }];
    const backup = await makeBackup([{ id: id('b'), name: 'B', enabled: true }], incoming);
    await expect(api.restoreBackup(backup, live, 'apply-states', current)).rejects.toThrow(
      '最多包含 300 项',
    );
    expect(chrome.management.setEnabled).not.toHaveBeenCalled();
    expect(chrome.storage.local.set).not.toHaveBeenCalled();
    await expect(api.restoreBackup(backup, live, 'apply-states')).rejects.toThrow(
      '先读取当前工作空间配置',
    );
  });

  it('reports missing items, protected mismatches, authorization requirements, native errors, and resolved-but-unverified changes separately', async () => {
    const { defaultData } = await import('../src/core/storage');
    const api = await import('../src/core/backup');
    live = [
      extension('a'),
      extension('b', false, { disabledReason: 'permissions_increase' }),
      extension('c', true, { installType: 'admin' }),
      extension('d', true, { type: 'theme' }),
      extension('f'),
      extension('g'),
      extension('h', false),
      extension('p'),
    ];
    vi.mocked(chrome.management.setEnabled).mockImplementation((async (
      targetId: string,
      enabled: boolean,
    ) => {
      if (targetId === id('f')) throw new Error('Native rejection');
      if (targetId === id('g')) return; // A resolved API promise is not proof of the final state.
      live.find((item) => item.id === targetId)!.enabled = enabled;
    }) as typeof chrome.management.setEnabled);
    const backup = await makeBackup([
      { id: SELF, name: 'Qii', enabled: false },
      { id: id('b'), name: 'Needs permissions', enabled: true },
      { id: id('c'), name: 'Policy', enabled: false },
      { id: id('d'), name: 'Theme', enabled: false },
      { id: id('f'), name: 'Failure', enabled: false },
      { id: id('g'), name: 'Not changed', enabled: false },
      { id: id('h'), name: 'Success', enabled: true },
      { id: id('i'), name: 'Local project', enabled: true, installType: 'development' },
      { id: id('j'), name: 'Store extension', enabled: true, updateUrl: CHROME_UPDATE },
    ]);
    const result = await api.restoreBackup(
      backup,
      structuredClone(live),
      'apply-states',
      defaultData(),
    );
    expect(result.complete).toBe(false);
    expect(result.counts).toEqual({
      applied: 1,
      unchanged: 0,
      missing: 2,
      protected: 3,
      requiresPermission: 1,
      failed: 2,
      notApplied: 0,
    });
    expect(vi.mocked(chrome.management.setEnabled).mock.calls.map((call) => call[0])).toEqual([
      id('f'),
      id('g'),
      id('h'),
    ]);
    expect(result.rows.find((row) => row.id === id('f'))?.error).toBe('Native rejection');
    expect(result.rows.find((row) => row.id === id('g'))).toMatchObject({
      actualEnabled: true,
      targetEnabled: false,
      status: 'failed',
    });
    expect(result.rows.find((row) => row.id === id('i'))?.installUrl).toBeUndefined();
    expect(result.rows.find((row) => row.id === id('j'))?.installUrl).toBe(
      `https://chromewebstore.google.com/detail/${id('j')}`,
    );
    expect(live.find((item) => item.id === id('p'))!.enabled).toBe(true);
  });

  it('treats already matched protected items as unchanged and maps only a missing source manager ID to the current manager', async () => {
    const { defaultData } = await import('../src/core/storage');
    const api = await import('../src/core/backup');
    live.push(
      extension('d', true, { installType: 'admin' }),
      extension('e', true, { type: 'theme' }),
    );
    const backup = await makeBackup(
      [
        { id: id('l'), name: 'Previous manager', enabled: true },
        { id: id('d'), name: 'Policy', enabled: true },
        { id: id('e'), name: 'Theme', enabled: true },
      ],
      undefined,
      { browser: 'Edge', managerId: id('l') },
    );
    const result = await api.restoreBackup(backup, live, 'apply-states', defaultData());
    expect(result.complete).toBe(true);
    expect(result.counts.unchanged).toBe(3);
    expect(result.rows[0]).toMatchObject({
      id: id('l'),
      beforeEnabled: true,
      actualEnabled: true,
      status: 'unchanged',
    });
    expect(result.rows[0].installUrl).toBeUndefined();
    expect(chrome.management.setEnabled).not.toHaveBeenCalled();
  });

  it('prefers an exact local ID over source-manager aliasing and never substitutes the manager enabled state for a different installed item', async () => {
    const { defaultData } = await import('../src/core/storage');
    const api = await import('../src/core/backup');
    live.push(extension('l', false));
    const backup = await makeBackup(
      [{ id: id('l'), name: 'Claimed source manager', enabled: true }],
      undefined,
      { browser: 'Chrome', managerId: id('l') },
    );
    const result = await api.restoreBackup(backup, live, 'apply-states', defaultData());
    expect(result.complete).toBe(false);
    expect(result.rows[0]).toMatchObject({
      beforeEnabled: false,
      actualEnabled: false,
      targetEnabled: true,
      status: 'protected',
    });
    expect(chrome.management.setEnabled).not.toHaveBeenCalled();
  });

  it('keeps successful state changes visible when saving configuration fails', async () => {
    const { defaultData } = await import('../src/core/storage');
    const api = await import('../src/core/backup');
    vi.mocked(chrome.storage.local.set).mockImplementation((async (
      values: Record<string, unknown>,
    ) => {
      if (DATA_KEY in values) throw new Error('Configuration storage failed');
      Object.assign(stored, structuredClone(values));
    }) as typeof chrome.storage.local.set);
    const backup = await makeBackup([{ id: id('b'), name: 'B', enabled: true }]);
    const result = await api.restoreBackup(backup, live, 'apply-states', defaultData());
    expect(result).toMatchObject({
      configSaved: false,
      configError: 'Configuration storage failed',
      reportSaved: true,
      complete: false,
    });
    expect(result.rows[0]).toMatchObject({ status: 'applied', actualEnabled: true });
    expect((await api.getLastRestoreResult())?.configError).toBe('Configuration storage failed');
  });

  it('does not relabel a completed restore as failed when only report persistence fails', async () => {
    const { defaultData } = await import('../src/core/storage');
    const api = await import('../src/core/backup');
    vi.mocked(chrome.storage.local.set).mockImplementation((async (
      values: Record<string, unknown>,
    ) => {
      if (REPORT_KEY in values) throw new Error('Report storage failed');
      Object.assign(stored, structuredClone(values));
    }) as typeof chrome.storage.local.set);
    const backup = await makeBackup([{ id: id('b'), name: 'B', enabled: true }]);
    const result = await api.restoreBackup(backup, live, 'apply-states', defaultData());
    expect(result).toMatchObject({ configSaved: true, reportSaved: false, complete: true });
    expect(result.reportError).toContain('Report storage failed');
    expect(result.rows[0].status).toBe('applied');
  });

  it('does not claim verified success if the final native inventory cannot be read', async () => {
    const { defaultData } = await import('../src/core/storage');
    const api = await import('../src/core/backup');
    vi.mocked(chrome.management.getAll).mockRejectedValue(new Error('Inventory unavailable'));
    const backup = await makeBackup([{ id: id('b'), name: 'B', enabled: true }]);
    const result = await api.restoreBackup(backup, live, 'apply-states', defaultData());
    expect(result.configSaved).toBe(true);
    expect(result.complete).toBe(false);
    expect(result.verificationError).toContain('Inventory unavailable');
    expect(result.rows[0].actualEnabled).toBeUndefined();
    expect(result.rows[0].status).toBe('failed');
    expect(live.find((item) => item.id === id('b'))!.enabled).toBe(true);
  });

  it('imports configuration without issuing management mutations when config-only was selected', async () => {
    const { defaultData } = await import('../src/core/storage');
    const api = await import('../src/core/backup');
    const backup = await makeBackup([{ id: id('b'), name: 'B', enabled: true }]);
    const result = await api.restoreBackup(backup, live, 'config-only', defaultData());
    expect(chrome.management.setEnabled).not.toHaveBeenCalled();
    expect(result.configSaved).toBe(true);
    expect(result.complete).toBe(false);
    expect(result.rows[0]).toMatchObject({
      status: 'not-applied',
      actualEnabled: false,
      targetEnabled: true,
    });
    expect(result.counts.notApplied).toBe(1);
  });

  it('subscribes specifically to the report key so a configuration write is not mistaken for the later report write', async () => {
    const api = await import('../src/core/backup');
    const listener = vi.fn();
    const dispose = api.subscribeRestoreReports(listener);
    const callback = vi.mocked(chrome.storage.onChanged.addListener).mock.calls[0][0];
    callback({ [DATA_KEY]: { newValue: {} } }, 'local');
    callback({ [REPORT_KEY]: { newValue: {} } }, 'sync');
    expect(listener).not.toHaveBeenCalled();
    callback({ [REPORT_KEY]: { newValue: {} } }, 'local');
    expect(listener).toHaveBeenCalledOnce();
    dispose();
    expect(chrome.storage.onChanged.removeListener).toHaveBeenCalledWith(callback);
  });
});
