import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

beforeEach(() => {
  vi.resetModules();
  vi.stubGlobal('chrome', {
    runtime: {
      id: 'a'.repeat(32),
      sendNativeMessage: vi.fn(),
      getURL: (path: string) => `chrome-extension://${'a'.repeat(32)}/${path}`,
    },
    permissions: { request: vi.fn(async () => true) },
    management: {},
  });
});
afterEach(() => vi.unstubAllGlobals());
const item = { id: 'b'.repeat(32), name: 'Local extension', status: 'files-restored' };

describe('file migration reports', () => {
  it('requests permission before checking an API that is hidden until authorization', async () => {
    const { connectMigration } = await import('../src/core/migration');
    const ping = vi.fn(async () => ({
      ok: true,
      version: '1.1.0',
      capabilities: ['export', 'import'],
    }));
    (chrome.runtime as any).sendNativeMessage = undefined;
    vi.mocked(chrome.permissions.request).mockImplementation(async () => {
      (chrome.runtime as any).sendNativeMessage = ping;
      return true;
    });
    await expect(connectMigration()).resolves.toBe('1.1.0');
    expect(ping).toHaveBeenCalledOnce();
  });
  it('passive detection never requests a user permission', async () => {
    (chrome.permissions as any).contains = vi.fn(async () => false);
    const { migrationAccessGranted } = await import('../src/core/migration');
    await expect(migrationAccessGranted()).resolves.toBe(false);
    expect(chrome.permissions.request).not.toHaveBeenCalled();
    expect(chrome.runtime.sendNativeMessage).not.toHaveBeenCalled();
  });
  it('retains completed file work when large details are kept in the local report', async () => {
    const { parseMigrationResult } = await import('../src/core/migration');
    const result = parseMigrationResult(
      {
        action: 'import',
        complete: true,
        items: [],
        detailsTruncated: true,
        totalItems: 2000,
        reportPath: 'C:\\Restore\\report.json',
      },
      'import',
    );
    expect(result.complete).toBe(true);
    expect(result.totalItems).toBe(2000);
    expect(result.installed).toBe(false);
  });
  it('rejects truncated summaries without a complete local report reference', async () => {
    const { parseMigrationResult } = await import('../src/core/migration');
    expect(() =>
      parseMigrationResult(
        { action: 'export', complete: true, items: [], detailsTruncated: true, totalItems: 2000 },
        'export',
      ),
    ).toThrow();
  });
  it('never equates restored files with installed extensions', async () => {
    const { parseMigrationResult } = await import('../src/core/migration');
    const result = parseMigrationResult(
      { action: 'import', complete: true, installed: true, items: [item] },
      'import',
    );
    expect(result.complete).toBe(true);
    expect(result.installed).toBe(false);
  });
  it('cannot label missing file entries as a complete archive', async () => {
    const { parseMigrationResult } = await import('../src/core/migration');
    const result = parseMigrationResult(
      { action: 'export', complete: true, items: [{ ...item, status: 'missing' }] },
      'export',
    );
    expect(result.complete).toBe(false);
  });
  it('does not claim a zero-entry backup is complete', async () => {
    const { parseMigrationResult } = await import('../src/core/migration');
    expect(
      parseMigrationResult({ action: 'export', complete: true, items: [] }, 'export').complete,
    ).toBe(false);
  });
  it('rejects duplicate extension rows and mixed operation statuses', async () => {
    const { parseMigrationResult } = await import('../src/core/migration');
    expect(() =>
      parseMigrationResult({ action: 'import', items: [item, item] }, 'import'),
    ).toThrow();
    expect(() => parseMigrationResult({ action: 'export', items: [item] }, 'export')).toThrow();
  });
  it('validates the attached manager configuration before exposing its restore action', async () => {
    const { parseMigrationResult } = await import('../src/core/migration');
    expect(() =>
      parseMigrationResult(
        { action: 'import', items: [item], managerBackup: { app: 'unknown' } },
        'import',
      ),
    ).toThrow();
  });
  it('asks for optional native access before contacting the installed helper', async () => {
    const { connectMigration, MIGRATION_HOST } = await import('../src/core/migration');
    vi.mocked(chrome.runtime.sendNativeMessage).mockResolvedValue({
      ok: true,
      version: '1',
      capabilities: ['export', 'import'],
    });
    await expect(connectMigration()).resolves.toBe('1');
    expect(chrome.permissions.request).toHaveBeenCalledWith({ permissions: ['nativeMessaging'] });
    expect(chrome.runtime.sendNativeMessage).toHaveBeenCalledWith(MIGRATION_HOST, {
      action: 'ping',
    });
  });
  it('never contacts the helper after optional access is declined', async () => {
    const { connectMigration } = await import('../src/core/migration');
    vi.mocked(chrome.permissions.request).mockResolvedValue(false);
    await expect(connectMigration()).rejects.toThrow('未允许');
    expect(chrome.runtime.sendNativeMessage).not.toHaveBeenCalled();
  });
  it('reports missing or incompatible helpers without claiming backup success', async () => {
    const { connectMigration } = await import('../src/core/migration');
    vi.mocked(chrome.runtime.sendNativeMessage).mockRejectedValue(
      new Error('Specified native messaging host not found.'),
    );
    await expect(connectMigration()).rejects.toThrow('无法连接迁移助手');
    vi.mocked(chrome.runtime.sendNativeMessage).mockResolvedValue({
      ok: true,
      capabilities: ['export'],
    });
    await expect(connectMigration()).rejects.toThrow('不支持');
  });
});
