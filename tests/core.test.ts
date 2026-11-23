import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ExtensionItem, Settings } from '../src/core/types';

const item = (override: Partial<ExtensionItem> = {}): ExtensionItem => ({
  id: 'abcdefghabcdefghabcdefghabcdefgh',
  name: 'Test extension',
  shortName: 'Test',
  version: '1.0',
  description: '',
  enabled: true,
  mayDisable: true,
  installType: 'normal',
  type: 'extension',
  isApp: false,
  offlineEnabled: false,
  optionsUrl: '',
  permissions: [],
  hostPermissions: [],
  ...override,
});
const fakeEvent = () => ({ addListener: vi.fn(), removeListener: vi.fn() });

beforeEach(() => {
  vi.resetModules();
  vi.stubGlobal('chrome', {
    runtime: { id: 'qii-real-self', openOptionsPage: vi.fn().mockResolvedValue(undefined) },
    management: {
      getAll: vi.fn().mockResolvedValue([]),
      setEnabled: vi.fn().mockResolvedValue(undefined),
      uninstall: vi.fn().mockResolvedValue(undefined),
      getPermissionWarningsById: vi.fn().mockResolvedValue([]),
      onEnabled: fakeEvent(),
      onDisabled: fakeEvent(),
      onInstalled: fakeEvent(),
      onUninstalled: fakeEvent(),
    },
    tabs: { create: vi.fn().mockResolvedValue({}) },
    storage: {
      local: { get: vi.fn().mockResolvedValue({}), set: vi.fn().mockResolvedValue(undefined) },
      onChanged: fakeEvent(),
    },
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('management protections and user actions', () => {
  it('protects self, policy, themes, and items with disabled controls', async () => {
    const api = await import('../src/core/api');
    expect(api.canToggle(item())).toBe(true);
    for (const override of [
      { id: api.selfId },
      { installType: 'admin' as const },
      { type: 'theme' as const },
      { mayDisable: false },
      { enabled: false, mayEnable: false },
    ]) {
      expect(api.canToggle(item(override))).toBe(false);
      await expect(api.setExtensionEnabled(item(override), false)).rejects.toThrow();
    }
    expect(api.canUninstall(item({ type: 'theme' }))).toBe(true);
    expect(api.canUninstall(item({ id: api.selfId }))).toBe(false);
    expect(chrome.management.setEnabled).not.toHaveBeenCalled();
  });

  it('invokes APIs immediately and reports partial batch failures without skipping unknown errors', async () => {
    const api = await import('../src/core/api');
    const failedId = 'failed-item';
    vi.mocked(chrome.management.setEnabled).mockImplementation(((id: string) =>
      id === failedId
        ? Promise.reject(new Error('Native rejection'))
        : Promise.resolve()) as typeof chrome.management.setEnabled);
    const items = [
      item(),
      item({ id: failedId }),
      item({ id: 'policy', installType: 'admin' }),
      item({ id: 'needs-permissions', enabled: false, disabledReason: 'permissions_increase' }),
    ];
    const task = api.applyChanges(
      items,
      ['needs-permissions'],
      [...items.map((entry) => entry.id), 'missing'],
    );
    expect(chrome.management.setEnabled).toHaveBeenCalledTimes(2);
    const result = await task;
    expect(result.succeeded).toEqual([items[0].id]);
    expect(result.failed).toEqual([{ id: failedId, error: 'Native rejection' }]);
    expect(result.skipped).toEqual(
      expect.arrayContaining(['missing', 'policy', 'needs-permissions']),
    );
  });

  it('does not replace a failing native extension list with demo data', async () => {
    vi.mocked(chrome.management.getAll).mockRejectedValue(new Error('Permission denied'));
    const api = await import('../src/core/api');
    expect(api.isDemo).toBe(false);
    await expect(api.listExtensions()).rejects.toThrow('Permission denied');
  });

  it('uses native confirmation for uninstalling another extension', async () => {
    const api = await import('../src/core/api');
    await api.uninstallExtension(item());
    expect(chrome.management.uninstall).toHaveBeenCalledWith(item().id, {
      showConfirmDialog: true,
    });
  });

  it('rejects executable URLs and encodes the native manager item ID', async () => {
    const api = await import('../src/core/api');
    await expect(api.openUrl('javascript:alert(1)')).rejects.toThrow();
    await api.openNativeManager('foo&bar');
    expect(chrome.tabs.create).toHaveBeenCalledWith({ url: 'chrome://extensions/?id=foo%26bar' });
  });

  it('allows turning a preview extension off and back on while keeping the preview isolated', async () => {
    vi.stubGlobal('chrome', undefined);
    vi.stubGlobal('location', { protocol: 'http:' });
    const saved = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => saved.get(key) ?? null,
      setItem: (key: string, value: string) => saved.set(key, value),
    });
    const api = await import('../src/core/api');
    expect(api.isDemo).toBe(true);
    const first = (await api.listExtensions())[0];
    await api.setExtensionEnabled(first, false);
    const disabled = (await api.listExtensions()).find((entry) => entry.id === first.id)!;
    expect(disabled.enabled).toBe(false);
    expect(api.canToggle(disabled)).toBe(true);
    await api.setExtensionEnabled(disabled, true);
    expect((await api.listExtensions()).find((entry) => entry.id === first.id)!.enabled).toBe(true);
    expect([...saved.keys()]).toEqual(['qii.demo.inventory.v1']);
  });

  it('does not offer demo inventory from a local file or an unsupported extension surface', async () => {
    vi.stubGlobal('chrome', undefined);
    vi.stubGlobal('location', { protocol: 'file:' });
    const api = await import('../src/core/api');
    expect(api.isDemo).toBe(false);
    await expect(api.listExtensions()).rejects.toThrow('API 不可用');
  });
});

describe('backup validation and local configuration', () => {
  it('round-trips configuration and inventory without claiming to archive extensions', async () => {
    const storage = await import('../src/core/storage');
    const data = storage.defaultData();
    expect(data.groups).toEqual([]);
    expect(data.scenes).toEqual([]);
    const result = storage.parseBackup(JSON.parse(storage.createBackup(data, [item()])));
    expect(result.data).toEqual(data);
    expect(result.inventory).toEqual([{ id: item().id, name: item().name, enabled: true }]);
  });

  it('imports a schema 1 backup without popup preferences using defaults while preserving manager preferences', async () => {
    const storage = await import('../src/core/storage');
    const backup = JSON.parse(storage.createBackup(storage.defaultData(), [item()]));
    delete backup.data.settings.popupView;
    delete backup.data.settings.popupDensity;
    backup.data.settings.view = 'list';
    backup.data.settings.theme = 'dark';
    const result = storage.parseBackup(backup);
    expect(result.data.schemaVersion).toBe(1);
    expect(result.data.settings).toEqual({
      theme: 'dark',
      view: 'list',
      sort: 'name',
      confirmBulk: true,
      popupView: 'grid',
      popupDensity: 'comfortable',
      skin: 'forest',
    });
  });

  it('reads an existing local configuration without forcing popup preference changes onto the manager', async () => {
    const storage = await import('../src/core/storage');
    const persisted = storage.defaultData();
    delete persisted.settings.popupView;
    delete persisted.settings.popupDensity;
    persisted.settings.view = 'list';
    vi.mocked(chrome.storage.local.get).mockResolvedValue({ 'qii.data.v1': persisted });
    const result = await storage.getData();
    expect(result.settings.view).toBe('list');
    expect(result.settings.popupView).toBe('grid');
    expect(result.settings.popupDensity).toBe('comfortable');
    expect(chrome.storage.local.set).not.toHaveBeenCalled();
  });

  it('preserves custom popup preferences through backup export and import without changing schema version', async () => {
    const storage = await import('../src/core/storage');
    const data = storage.defaultData();
    data.settings.popupView = 'list';
    data.settings.popupDensity = 'compact';
    const backup = JSON.parse(storage.createBackup(data, []));
    expect(backup.version).toBe(1);
    const imported = storage.parseBackup(backup);
    expect(imported.data).toEqual(data);
    expect(imported.data.settings.view).toBe('grid');
  });

  it('migrates schema 1 backups and local configuration without a skin while retaining existing popup preferences', async () => {
    const storage = await import('../src/core/storage');
    const oldData = storage.defaultData();
    delete oldData.settings.skin;
    oldData.settings.popupView = 'list';
    oldData.settings.popupDensity = 'compact';
    vi.mocked(chrome.storage.local.get).mockResolvedValue({ 'qii.data.v1': oldData });
    const restoredLocal = await storage.getData();
    expect(restoredLocal.settings.skin).toBe('forest');
    expect(restoredLocal.settings.popupView).toBe('list');
    expect(restoredLocal.settings.popupDensity).toBe('compact');
    expect(chrome.storage.local.set).not.toHaveBeenCalled();

    const backup = JSON.parse(storage.createBackup(oldData, []));
    delete backup.data.settings.skin;
    const restoredBackup = storage.parseBackup(backup).data;
    expect(restoredBackup.settings).toEqual(restoredLocal.settings);
    expect(restoredBackup.schemaVersion).toBe(1);
  });

  it('preserves the Elysia skin through local storage and backup round trips', async () => {
    const storage = await import('../src/core/storage');
    const data = storage.defaultData();
    data.settings.skin = 'elysia';
    data.settings.theme = 'dark';
    data.settings.popupView = 'list';
    await storage.saveData(data);
    const saved = vi.mocked(chrome.storage.local.set).mock.calls[0][0];
    vi.mocked(chrome.storage.local.get).mockResolvedValue(saved);
    const restored = await storage.getData();
    expect(restored).toEqual(data);
    expect(storage.parseBackup(JSON.parse(storage.createBackup(restored, []))).data).toEqual(data);
  });

  it.each(['pink', null, false])(
    'rejects an explicitly invalid skin %s rather than treating it as a legacy setting',
    async (skin) => {
      const storage = await import('../src/core/storage');
      const backup = JSON.parse(storage.createBackup(storage.defaultData(), []));
      backup.data.settings.skin = skin;
      expect(() => storage.parseBackup(backup)).toThrow('界面皮肤不受支持');
    },
  );

  it.each([
    ['popupView', 'cards'],
    ['popupView', null],
    ['popupDensity', 'dense'],
    ['popupDensity', false],
  ])(
    'rejects an explicitly invalid popup preference %s=%s rather than replacing it with a default',
    async (field, value) => {
      const storage = await import('../src/core/storage');
      const backup = JSON.parse(storage.createBackup(storage.defaultData(), []));
      backup.data.settings[field as string] = value;
      expect(() => storage.parseBackup(backup)).toThrow('备份格式无效');
    },
  );

  it.each([
    'schema',
    'duplicate',
    'missing-group',
    'outside-scope',
    'prototype',
    'huge-note',
    'unsupported-setting',
    'unrenderable-time',
  ])('rejects malformed backup: %s', async (kind) => {
    const storage = await import('../src/core/storage');
    const backup = JSON.parse(storage.createBackup(storage.defaultData(), [item()]));
    if (kind === 'schema') backup.version = 99;
    if (kind === 'duplicate') backup.inventory.push(backup.inventory[0]);
    if (kind === 'missing-group') backup.data.meta.foo = { groupId: 'missing' };
    if (kind === 'outside-scope')
      backup.data.scenes.push({
        id: 'scene',
        name: 'Scene',
        description: '',
        scopeIds: [],
        enabledIds: ['unknown'],
        createdAt: 0,
      });
    if (kind === 'prototype') backup.data.meta = JSON.parse('{"__proto__":{"favorite":true}}');
    if (kind === 'huge-note') backup.data.meta.foo = { note: 'x'.repeat(4001) };
    if (kind === 'unsupported-setting') backup.data.settings.theme = 'red';
    if (kind === 'unrenderable-time')
      backup.data.activity = [
        { id: 'activity', at: Number.MAX_SAFE_INTEGER, text: 'Invalid Date' },
      ];
    expect(() => storage.parseBackup(backup)).toThrow('备份格式无效');
  });

  it('caps activity retention and rejects damaged persisted settings', async () => {
    const storage = await import('../src/core/storage');
    let data = storage.defaultData();
    for (let i = 0; i < 220; i++) data = storage.recordActivity(data, `Action ${i}`);
    expect(data.activity).toHaveLength(200);
    expect(data.activity[0].text).toBe('Action 219');
    vi.mocked(chrome.storage.local.get).mockResolvedValue({ 'qii.data.v1': { invalid: true } });
    await expect(storage.getData()).rejects.toThrow();
    expect(chrome.storage.local.set).not.toHaveBeenCalled();
  });

  it('serializes simultaneous updates and continues accepting updates after a rejected transaction', async () => {
    const storage = await import('../src/core/storage');
    let persisted = storage.defaultData();
    vi.mocked(chrome.storage.local.get).mockImplementation((async () => ({
      'qii.data.v1': structuredClone(persisted),
    })) as typeof chrome.storage.local.get);
    vi.mocked(chrome.storage.local.set).mockImplementation((async (
      value: Record<string, unknown>,
    ) => {
      persisted = structuredClone(value['qii.data.v1'] as typeof persisted);
    }) as typeof chrome.storage.local.set);
    await Promise.all([
      storage.updateData((current) => ({
        ...current,
        groups: [...current.groups, { id: 'a', name: 'A' }],
      })),
      storage.updateData((current) => ({
        ...current,
        groups: [...current.groups, { id: 'b', name: 'B' }],
      })),
    ]);
    expect(persisted.groups.map((group) => group.id)).toEqual(['a', 'b']);
    await expect(
      storage.updateData(() => {
        throw new Error('Aborted update');
      }),
    ).rejects.toThrow('Aborted update');
    await storage.updateData((current) => storage.recordActivity(current, 'Still works'));
    expect(persisted.activity[0].text).toBe('Still works');
  });
});

describe('shared appearance lifecycle', () => {
  it('follows system color changes with the selected skin and releases its media listener on cleanup', async () => {
    const listeners = new Set<() => void>();
    const media = {
      matches: false,
      addEventListener: (_event: string, listener: () => void) => listeners.add(listener),
      removeEventListener: (_event: string, listener: () => void) => listeners.delete(listener),
    };
    const root = { dataset: {} as Record<string, string> };
    vi.stubGlobal('window', { matchMedia: () => media });
    vi.stubGlobal('document', { documentElement: root });
    const { applyAppearance } = await import('../src/core/appearance');
    const cleanup = applyAppearance({ theme: 'system', skin: 'elysia' });
    expect(root.dataset).toEqual({ theme: 'light', skin: 'elysia' });
    media.matches = true;
    listeners.forEach((listener) => listener());
    expect(root.dataset.theme).toBe('dark');
    cleanup();
    expect(listeners.size).toBe(0);
    media.matches = false;
    listeners.forEach((listener) => listener());
    expect(root.dataset.theme).toBe('dark');
  });

  it('applies safe defaults before settings load and falls back from an invalid runtime skin', async () => {
    const root = { dataset: {} as Record<string, string> };
    vi.stubGlobal('window', {
      matchMedia: () => ({
        matches: true,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      }),
    });
    vi.stubGlobal('document', { documentElement: root });
    const { applyAppearance } = await import('../src/core/appearance');
    applyAppearance(undefined)();
    expect(root.dataset).toEqual({ theme: 'light', skin: 'forest' });
    const malformed = { theme: 'dark', skin: 'unsupported' } as unknown as Pick<
      Settings,
      'theme' | 'skin'
    >;
    applyAppearance(malformed)();
    expect(root.dataset).toEqual({ theme: 'dark', skin: 'forest' });
  });
});
