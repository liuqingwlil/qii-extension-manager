import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, expect as playwrightExpect } from '@playwright/test';

const expect = playwrightExpect.configure({ timeout: 15_000 });
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'dist');
const output = path.join(root, 'test-results');
const fixturePaths = [
  path.join(root, 'tests', 'fixtures', 'test-extension'),
  path.join(root, 'tests', 'fixtures', 'restore-extra'),
];
const checks = [];
const errors = [];
const report = {
  mode: 'Real MV3 UI in an isolated bundled Chromium profile; nativeMessaging host responses, optional permission prompts and clipboard writes are simulated inside test pages',
  actualNativeHostTested: false,
  brandedChromeOrEdgeTested: false,
  checks,
  geometry: [],
};
let context;
let profile;
let currentPage;
let main;
let base;
let inventory;
let fixture;
let migration;

async function check(name, run) {
  await run();
  checks.push({ name, passed: true });
  console.log(`PASS ${name}`);
}
async function screenshot(page, name) {
  await page.screenshot({ path: path.join(output, name), fullPage: false, animations: 'disabled' });
}
async function pairGeometry(group, label) {
  const geometry = await group.evaluate((element) => {
    const rect = (node) => {
      const r = node.getBoundingClientRect();
      return { x: r.x, y: r.y, width: r.width, height: r.height, right: r.right, bottom: r.bottom };
    };
    return {
      buttons: [...element.querySelectorAll('button')].map(rect),
      viewport: { width: innerWidth, height: innerHeight },
      filterHeight: element.closest('.filter-row')?.getBoundingClientRect().height,
    };
  });
  assert.equal(geometry.buttons.length, 2, `${label}: export and import must form a pair`);
  const [first, second] = geometry.buttons;
  assert.ok(Math.abs(first.y - second.y) <= 1, `${label}: buttons must share a row`);
  assert.ok(first.right <= second.x + 1, `${label}: buttons must not overlap`);
  assert.ok(first.x >= 0 && second.right <= geometry.viewport.width, `${label}: pair must fit`);
  report.geometry.push({ label, ...geometry });
  return geometry;
}
async function fixtureEnabled() {
  return main.evaluate(async (id) => (await chrome.management.get(id)).enabled, fixture.id);
}

try {
  assert.ok(
    existsSync(path.join(dist, 'manifest.json')),
    'Build before running migration UI checks.',
  );
  await mkdir(output, { recursive: true });
  profile = await mkdtemp(path.join(output, 'migration-profile-'));
  const paths = [dist, ...fixturePaths].join(',');
  context = await chromium.launchPersistentContext(profile, {
    channel: 'chromium',
    headless: true,
    viewport: { width: 1360, height: 1000 },
    locale: 'zh-CN',
    args: [
      '--screen-info={1600x1200}',
      '--window-size=1440,1000',
      `--disable-extensions-except=${paths}`,
      `--load-extension=${paths}`,
    ],
  });
  context.setDefaultTimeout(15_000);
  context.on('page', (page) => page.on('pageerror', (error) => errors.push(error.message)));
  report.browserVersion = context.browser()?.version();
  let worker = context.serviceWorkers().find((entry) => entry.url().endsWith('/background.js'));
  if (!worker)
    worker = await context.waitForEvent('serviceworker', {
      predicate: (entry) => entry.url().endsWith('/background.js'),
    });
  base = `chrome-extension://${new URL(worker.url()).hostname}`;

  // These renderer-local mocks test the documented bridge contract without registering
  // a host, showing permission prompts or writing anything to the OS clipboard.
  await context.addInitScript(() => {
    if (!globalThis.chrome?.runtime?.id) return;
    const state = {
      permissionGranted: true,
      permissionAuthorized: false,
      permissionRequests: [],
      requests: [],
      clipboard: [],
      toggleCalls: [],
      hostMode: 'normal',
      exportMode: 'complete',
      importMode: 'complete',
      lastBackup: null,
      managerBackup: null,
    };
    window.__migrationUiTest = state;
    chrome.permissions.request = async (options) => {
      state.permissionRequests.push(structuredClone(options));
      if (state.permissionGranted) state.permissionAuthorized = true;
      return state.permissionGranted;
    };
    chrome.permissions.contains = async () => state.permissionAuthorized;
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: async (value) => {
          state.clipboard.push(value);
        },
      },
    });
    chrome.management.setEnabled = (id, enabled) => {
      state.toggleCalls.push({ id, enabled });
      return Promise.reject(
        new Error('Migration UI test forbids implicit extension state changes.'),
      );
    };
    chrome.runtime.sendNativeMessage = async (host, request) => {
      state.requests.push({ host, request: structuredClone(request) });
      if (host !== 'com.qii.migration') throw new Error('Unexpected native host name.');
      if (state.hostMode === 'reject')
        throw new Error('Migration test: native host is unavailable.');
      if (request.action === 'ping')
        return {
          ok: true,
          version: 'test-contract-1',
          capabilities: state.hostMode === 'incompatible' ? ['export'] : ['export', 'import'],
        };
      if (request.action === 'export') {
        if (state.exportMode === 'cancel')
          return { ok: false, error: 'Migration test: export cancelled.' };
        state.lastBackup = structuredClone(request.backup);
        return {
          ok: true,
          action: 'export',
          complete: true,
          archivePath: 'C:\\MigrationUiTest\\all-extension-files.zip',
          reportPath: 'C:\\MigrationUiTest\\export-report.json',
          items: request.backup.inventory.map((item, index, rows) => ({
            id: item.id,
            name: item.name,
            status:
              state.exportMode === 'partial' && index === rows.length - 1 ? 'missing' : 'included',
            message:
              state.exportMode === 'partial' && index === rows.length - 1
                ? 'Migration test: this local source directory could not be found.'
                : undefined,
          })),
        };
      }
      if (request.action === 'import') {
        if (state.importMode === 'cancel')
          return { ok: false, error: 'Migration test: import cancelled.' };
        const backup = state.managerBackup || state.lastBackup;
        return {
          ok: true,
          action: 'import',
          complete: true,
          installed: true,
          directory: 'C:\\MigrationUiTest\\RestoredExtensions',
          reportPath: 'C:\\MigrationUiTest\\import-report.json',
          guidePath: 'C:\\MigrationUiTest\\install-guide.html',
          managerBackup: backup,
          items: backup.inventory.map((item) => ({
            id: item.id,
            name: item.name,
            status: 'files-restored',
            path: `C:\\MigrationUiTest\\RestoredExtensions\\${item.id}`,
          })),
        };
      }
      throw new Error(`Unexpected mock native action: ${request.action}`);
    };
  });

  main = await context.newPage();
  currentPage = main;
  await main.goto(`${base}/index.html`);
  inventory = await main.evaluate(() => chrome.management.getAll());
  fixture = inventory.find((item) => item.name === 'Qii Test Fixture');
  assert.ok(
    fixture && inventory.length >= 3,
    'Two disposable fixtures and the manager must be loaded.',
  );
  assert.equal(await fixtureEnabled(), true);

  await check('main header keeps JSON import and export adjacent', async () => {
    const pair = main.getByRole('group', { name: '配置与清单 JSON 导入导出', exact: true });
    await expect(
      pair.getByRole('button', { name: '导出配置与清单 JSON', exact: true }),
    ).toBeVisible();
    await expect(pair.getByRole('button', { name: '导入 JSON 并应用', exact: true })).toBeVisible();
    await pairGeometry(pair, 'main header JSON');
  });

  await check(
    'settings present paired ZIP and JSON actions with local first-time setup',
    async () => {
      await main.getByRole('button', { name: '偏好设置', exact: true }).click();
      const panel = main.locator('#migration');
      await expect(panel).toBeVisible();
      assert.equal(
        await main.locator('.settings-page > section').first().getAttribute('id'),
        'migration',
      );
      await pairGeometry(
        panel.getByRole('group', { name: '扩展文件导入导出', exact: true }),
        'settings ZIP',
      );
      await expect(
        panel.getByRole('button', { name: '导出扩展文件 ZIP', exact: true }),
      ).toBeDisabled();
      await expect(
        panel.getByRole('button', { name: '导入扩展文件 ZIP', exact: true }),
      ).toBeDisabled();
      await expect(panel.getByText('首次连接 Windows 迁移助手', { exact: true })).toBeVisible();
      const download = panel.getByRole('link', { name: '下载本地迁移助手', exact: true });
      await expect(download).toHaveAttribute('href', `${base}/migration/QiiMigration.exe`);
      await expect(download).toHaveAttribute('download', 'QiiMigration.exe');
      await panel.getByRole('button', { name: '复制当前扩展 ID', exact: true }).click();
      assert.deepEqual(await main.evaluate(() => window.__migrationUiTest.clipboard), [
        new URL(base).hostname,
      ]);
      const json = main.getByRole('group', { name: '配置与清单 JSON 导入导出', exact: true });
      await json.scrollIntoViewIfNeeded();
      await pairGeometry(json, 'settings JSON');
    },
  );

  const popup = await context.newPage();
  currentPage = popup;
  await popup.setViewportSize({ width: 600, height: 590 });
  await popup.goto(`${base}/popup.html`);
  await check(
    'popup JSON pair remains on one compact row and its import file input is mounted',
    async () => {
      const pair = popup.getByRole('group', { name: '配置与清单 JSON 导入导出', exact: true });
      for (const viewport of [
        { width: 600, height: 590 },
        { width: 466, height: 510 },
        { width: 420, height: 480 },
      ]) {
        await popup.setViewportSize(viewport);
        const geometry = await pairGeometry(
          pair,
          `popup ${viewport.width}x${viewport.height} JSON`,
        );
        assert.ok(geometry.filterHeight <= 34, 'backup controls must not add another filter row');
      }
      const choosing = popup.waitForEvent('filechooser');
      await pair.getByRole('button', { name: '导入 JSON 并应用', exact: true }).click();
      const chooser = await choosing;
      assert.equal(await chooser.element().getAttribute('aria-label'), '导入全部扩展备份文件');
      await chooser.setFiles([]);
      await popup.setViewportSize({ width: 600, height: 590 });
    },
  );

  await check(
    'popup ZIP actions open the full migration page while a filter only shows one extension',
    async () => {
      await popup.getByRole('searchbox', { name: '搜索扩展', exact: true }).fill(fixture.name);
      await expect(popup.getByRole('article')).toHaveCount(1);
      await popup.getByRole('tab', { name: /^工具$/ }).click();
      for (const [name, action] of [
        ['导出扩展文件 ZIP', 'export'],
        ['导入扩展文件 ZIP', 'import'],
      ]) {
        const opening = context.waitForEvent('page');
        await popup.getByRole('button', { name, exact: true }).click();
        const page = await opening;
        currentPage = page;
        await page.waitForURL(`${base}/index.html?migration=${action}#migration`);
        await expect(page.locator('#migration')).toBeVisible();
        assert.equal(
          await page.locator('.settings-page > section').first().getAttribute('id'),
          'migration',
        );
        if (action === 'export') migration = page;
        else await page.close();
      }
    },
  );

  currentPage = migration;
  const panel = migration.locator('#migration');
  const connect = panel.getByRole('button', { name: '连接本地迁移助手', exact: true });
  const exportFiles = panel.getByRole('button', { name: '导出扩展文件 ZIP', exact: true });
  const importFiles = panel.getByRole('button', { name: '导入扩展文件 ZIP', exact: true });
  await check(
    'denied optional permission and an incompatible host keep ZIP actions disabled',
    async () => {
      await migration.evaluate(() => (window.__migrationUiTest.permissionGranted = false));
      await connect.click();
      await expect(panel.locator('.migration-connection-state')).toContainText('待授权');
      await expect(exportFiles).toBeDisabled();
      assert.equal(await migration.evaluate(() => window.__migrationUiTest.requests.length), 0);
      await migration.evaluate(() => {
        window.__migrationUiTest.permissionGranted = true;
        window.__migrationUiTest.hostMode = 'incompatible';
      });
      await connect.click();
      await expect(panel.locator('.migration-connection-state')).toContainText(
        '版本不支持文件导入导出',
      );
      await expect(importFiles).toBeDisabled();
    },
  );

  await check(
    'connecting requests only nativeMessaging and full export sends every installed ID',
    async () => {
      await migration.evaluate(() => (window.__migrationUiTest.hostMode = 'normal'));
      await connect.click();
      await expect(panel.getByText('本地助手已连接', { exact: true })).toBeVisible();
      await expect(exportFiles).toBeEnabled();
      await exportFiles.click();
      await expect(
        panel.getByRole('heading', { name: '扩展文件备份完成', exact: true }),
      ).toBeVisible();
      const state = await migration.evaluate(() => window.__migrationUiTest);
      assert.ok(
        state.permissionRequests.every(
          (request) =>
            JSON.stringify(request) === JSON.stringify({ permissions: ['nativeMessaging'] }),
        ),
      );
      assert.ok(state.requests.every((request) => request.host === 'com.qii.migration'));
      const exported = state.requests
        .filter((request) => request.request.action === 'export')
        .at(-1).request;
      assert.equal(exported.backup.app, 'qii-extension-manager');
      assert.equal(exported.backup.version, 2);
      assert.deepEqual(
        exported.backup.inventory.map((entry) => entry.id).sort(),
        inventory.map((entry) => entry.id).sort(),
      );
      assert.ok(exported.backup.inventory.some((entry) => entry.installType === 'development'));
      assert.equal(exported.managerId, new URL(base).hostname);
      await expect(panel.locator('.migration-result li')).toHaveCount(inventory.length);
      await screenshot(migration, 'migration-full-backup.png');
      report.exportedInventoryIds = exported.backup.inventory.map((entry) => entry.id);
    },
  );

  await check('a host complete flag cannot hide missing files in an export', async () => {
    await migration.evaluate(() => (window.__migrationUiTest.exportMode = 'partial'));
    await exportFiles.click();
    await expect(panel.getByRole('heading', { name: '文件备份不完整', exact: true })).toBeVisible();
    await expect(panel.getByRole('heading', { name: '扩展文件备份完成', exact: true })).toHaveCount(
      0,
    );
    await expect(panel.getByText('缺少文件', { exact: true })).toBeVisible();
    await expect(panel.locator('.migration-result > p').first()).toContainText(
      `${inventory.length - 1} / ${inventory.length}`,
    );
  });

  await check('host cancellation and connection errors remain visible and retryable', async () => {
    await migration.evaluate(() => (window.__migrationUiTest.exportMode = 'cancel'));
    await exportFiles.click();
    await expect(panel.getByRole('alert')).toContainText('Migration test: export cancelled.');
    await expect(exportFiles).toBeEnabled();
    await migration.evaluate(() => {
      window.__migrationUiTest.exportMode = 'complete';
      window.__migrationUiTest.hostMode = 'reject';
    });
    await importFiles.click();
    await expect(panel.getByRole('alert')).toContainText('无法连接迁移助手');
    await expect(panel.getByRole('alert')).toContainText(
      'Migration test: native host is unavailable.',
    );
    await expect(importFiles).toBeDisabled();
    await migration.evaluate(() => {
      window.__migrationUiTest.hostMode = 'normal';
      window.__migrationUiTest.importMode = 'cancel';
    });
    await panel.getByRole('button', { name: '立即刷新', exact: true }).click();
    await expect(importFiles).toBeEnabled();
    await importFiles.click();
    await expect(panel.getByRole('alert')).toContainText('Migration test: import cancelled.');
    await migration.evaluate(() => (window.__migrationUiTest.importMode = 'complete'));
  });

  await check(
    'import never claims installation even when a host reports installed true',
    async () => {
      await migration.evaluate((fixtureId) => {
        const state = window.__migrationUiTest;
        state.managerBackup = structuredClone(state.lastBackup);
        const target = state.managerBackup.inventory.find((entry) => entry.id === fixtureId);
        target.enabled = false;
      }, fixture.id);
      await importFiles.click();
      await expect(
        panel.getByRole('heading', { name: '扩展文件已还原，等待安装确认', exact: true }),
      ).toBeVisible();
      await expect(panel.getByText('文件已还原 · 待安装', { exact: true })).toHaveCount(
        inventory.length,
      );
      await expect(panel.locator('.migration-result > p').first()).toContainText('尚未自动安装');
      await expect(panel.getByRole('heading', { name: /安装成功|全部安装/ })).toHaveCount(0);
      assert.equal(await fixtureEnabled(), true);
      assert.deepEqual(await migration.evaluate(() => window.__migrationUiTest.toggleCalls), []);
      await screenshot(migration, 'migration-import-pending.png');
    },
  );

  await check(
    'restored manager JSON opens a preview without applying any extension state',
    async () => {
      await panel
        .getByRole('button', { name: '预览管理配置与已安装扩展的启停恢复', exact: true })
        .click();
      const dialog = migration.getByRole('dialog', { name: '导入 JSON 并应用', exact: true });
      await expect(
        dialog.getByRole('heading', { name: '备份恢复预览', exact: true }),
      ).toBeVisible();
      await expect(
        dialog.getByRole('button', { name: '确认导入并应用', exact: true }),
      ).toBeVisible();
      assert.equal(await fixtureEnabled(), true);
      assert.deepEqual(await migration.evaluate(() => window.__migrationUiTest.toggleCalls), []);
      assert.deepEqual(errors, []);
    },
  );

  await check(
    'an authorized page reconnects automatically after opening and reloading without asking for permission',
    async () => {
      const automatic = await context.newPage();
      currentPage = automatic;
      await automatic.addInitScript(() => {
        chrome.permissions.contains = async () => true;
      });
      await automatic.goto(`${base}/index.html?migration=import`);
      const status = automatic.locator('.migration-connection-state');
      await expect(status).toContainText('已连接');
      await expect(
        automatic.getByRole('button', { name: '导入扩展文件 ZIP', exact: true }),
      ).toBeEnabled();
      assert.deepEqual(
        await automatic.evaluate(() => window.__migrationUiTest.permissionRequests),
        [],
      );
      await automatic.reload();
      await expect(status).toContainText('已连接');
      assert.deepEqual(
        await automatic.evaluate(() => window.__migrationUiTest.permissionRequests),
        [],
      );
      await check(
        'connection loss and recovery update visible status and ZIP controls automatically',
        async () => {
          await automatic.evaluate(() => {
            window.__migrationUiTest.hostMode = 'reject';
            window.dispatchEvent(new Event('focus'));
          });
          await expect(status).toContainText('未连接');
          await expect(
            automatic.getByRole('button', { name: '导入扩展文件 ZIP', exact: true }),
          ).toBeDisabled();
          await automatic.evaluate(() => {
            window.__migrationUiTest.hostMode = 'normal';
            window.dispatchEvent(new Event('focus'));
          });
          await expect(status).toContainText('已连接');
          await expect(
            automatic.getByRole('button', { name: '导入扩展文件 ZIP', exact: true }),
          ).toBeEnabled();
          await expect(status).toContainText('最近检测');
        },
      );
      await screenshot(automatic, 'migration-auto-connected.png');
      await check(
        'refreshing the connection block updates state without reloading the page',
        async () => {
          const openedAt = await automatic.evaluate(() => performance.timeOrigin);
          await automatic.evaluate(() => {
            window.__migrationUiTest.hostMode = 'reject';
          });
          await automatic.getByRole('button', { name: '立即刷新', exact: true }).click();
          await expect(status).toContainText('未连接');
          await automatic.evaluate(() => {
            window.__migrationUiTest.hostMode = 'normal';
          });
          await automatic.getByRole('button', { name: '立即刷新', exact: true }).click();
          await expect(status).toContainText('已连接');
          assert.equal(await automatic.evaluate(() => performance.timeOrigin), openedAt);
        },
      );
      await check(
        'an unavailable helper is rechecked and becomes ready automatically without focus or navigation',
        async () => {
          await automatic.evaluate(() => {
            window.__migrationUiTest.hostMode = 'reject';
          });
          await automatic.getByRole('button', { name: '立即刷新', exact: true }).click();
          await expect(status).toContainText('未连接');
          await automatic.evaluate(() => {
            window.__migrationUiTest.hostMode = 'normal';
          });
          await expect(status).toContainText('已连接', { timeout: 12000 });
          await expect(
            automatic.getByRole('button', { name: '导入扩展文件 ZIP', exact: true }),
          ).toBeEnabled();
        },
      );
      await automatic.close();
    },
  );
  await check(
    'a nativeMessaging permission change triggers an immediate check without navigation',
    async () => {
      const page = await context.newPage();
      await page.addInitScript(() => {
        window.__connectionGranted = false;
        window.__permissionAddedHandlers = [];
        chrome.permissions.contains = async () => window.__connectionGranted;
        chrome.permissions.onAdded.addListener = (handler) =>
          window.__permissionAddedHandlers.push(handler);
      });
      await page.goto(`${base}/index.html?migration=import`);
      const state = page.locator('.migration-connection-state');
      await expect(state).toContainText('待授权');
      await page.evaluate(() => {
        window.__connectionGranted = true;
        window.__permissionAddedHandlers.forEach((handler) =>
          handler({ permissions: ['nativeMessaging'] }),
        );
      });
      await expect(state).toContainText('已连接', { timeout: 2000 });
      assert.deepEqual(await page.evaluate(() => window.__migrationUiTest.permissionRequests), []);
      await page.close();
    },
  );
  report.passed = true;
  report.notes = [
    'The manager and two disposable fixture extensions are genuinely loaded in an isolated MV3 profile.',
    'All native host responses and optional permission prompts are explicit renderer-local simulations. No native host was registered, launched or integrated by this UI test.',
    'Clipboard writes are captured locally and no operating-system clipboard or user profile was changed.',
    'The host mock intentionally reports complete=true with a missing row, and installed=true for an import; the UI must reject those misleading success claims.',
    'The test never installs, exports or restores real extension files. File/ZIP engine coverage belongs to the separate migration helper tests.',
    'No implicit native extension-state changes were permitted, and the real fixture remained enabled throughout the imported JSON preview.',
  ];
  console.log(`Completed ${checks.length} migration UI integration checks.`);
} catch (error) {
  report.passed = false;
  report.failure = error instanceof Error ? error.stack : String(error);
  console.error(report.failure);
  if (currentPage && !currentPage.isClosed())
    await screenshot(currentPage, 'migration-failure.png').catch(() => {});
  process.exitCode = 1;
} finally {
  await context?.close().catch(() => {});
  if (profile) {
    const relative = path.relative(output, path.resolve(profile));
    assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative));
    await rm(profile, { recursive: true, force: true }).catch(() => {});
  }
  await mkdir(output, { recursive: true });
  await writeFile(path.join(output, 'migration-e2e-report.json'), JSON.stringify(report, null, 2));
}
