import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
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
const downloadedReports = [];
const report = {
  mode: 'Real Manifest V3 extension in an isolated Playwright Chromium profile with two local synthetic fixtures',
  brandedChromeOrEdgeTested: false,
  checks,
};
let context;
let profile;
let currentPage;
let main;
let base;
let first;
let extra;
let originalInventory;
let exportedBackup;

async function check(name, run) {
  await run();
  checks.push({ name, passed: true });
  console.log(`PASS ${name}`);
}
function restoreRow(page, id) {
  return page.getByRole('dialog').locator(`.restore-item[data-restore-id="${id}"]`);
}
async function tools(page) {
  await page.getByRole('tab', { name: /^工具(?:\s*\d+)?$/ }).click();
}
async function preferences(page) {
  await page.getByRole('button', { name: '偏好设置', exact: true }).click();
}
async function nativeEnabled(id, expected) {
  await expect
    .poll(() => main.evaluate(async (target) => (await chrome.management.get(target)).enabled, id))
    .toBe(expected);
}
async function shot(page, name) {
  await page.screenshot({ path: path.join(output, name), fullPage: false, animations: 'disabled' });
}
async function closeDialog(page) {
  const dialog = page.getByRole('dialog');
  const close = dialog.getByRole('button', { name: /^(关闭对话框|关闭弹窗)$/ });
  await close.click();
  await expect(dialog).toHaveCount(0);
}
async function newPopup(init) {
  const page = await context.newPage();
  currentPage = page;
  await page.setViewportSize({ width: 600, height: 590 });
  if (init) await page.addInitScript(init, { firstId: first.id, extraId: extra.id });
  await page.goto(`${base}/popup.html`);
  await tools(page);
  return page;
}
async function preview(page, backup) {
  await page.getByLabel('导入全部扩展备份文件', { exact: true }).setInputFiles({
    name: 'extensions-backup.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(backup)),
  });
  const dialog = page.getByRole('dialog', { name: '导入 JSON 并应用', exact: true });
  await expect(dialog.getByRole('heading', { name: '备份恢复预览', exact: true })).toBeVisible();
  const action = dialog.getByRole('button', { name: '确认导入并应用', exact: true });
  const buttonBounds = await action.boundingBox();
  const dialogBounds = await dialog.boundingBox();
  const viewport = page.viewportSize();
  assert.ok(
    buttonBounds.x >= dialogBounds.x &&
      buttonBounds.y >= dialogBounds.y &&
      buttonBounds.x + buttonBounds.width <= dialogBounds.x + dialogBounds.width + 1 &&
      buttonBounds.y + buttonBounds.height <= dialogBounds.y + dialogBounds.height + 1,
    'initial restore action must fit entirely inside its dialog without scrolling',
  );
  assert.ok(
    buttonBounds.x >= 0 &&
      buttonBounds.y >= 0 &&
      buttonBounds.x + buttonBounds.width <= viewport.width &&
      buttonBounds.y + buttonBounds.height <= viewport.height,
    'initial restore action must be entirely visible inside the viewport',
  );
  assert.equal(
    await action.evaluate((element) => {
      const r = element.getBoundingClientRect();
      const hit = document.elementFromPoint(r.x + r.width / 2, r.bottom - 2);
      return hit === element || element.contains(hit);
    }),
    true,
    'the bottom of the initial restore action must not be clipped by a scroll container',
  );
  return dialog;
}
async function confirm(page, buttonName = '确认导入并应用') {
  await page.getByRole('dialog').getByRole('button', { name: buttonName, exact: true }).click();
  await expect(
    page.getByRole('dialog').getByRole('button', { name: '下载恢复报告', exact: true }),
  ).toBeVisible();
}
async function downloadReport(page, name) {
  const downloading = page.waitForEvent('download');
  await page.getByRole('dialog').getByRole('button', { name: '下载恢复报告', exact: true }).click();
  const download = await downloading;
  const filename = path.join(output, name);
  await download.saveAs(filename);
  const result = JSON.parse(await readFile(filename, 'utf8'));
  downloadedReports.push(result);
  return result;
}
function onlyFirst(enabled, note = 'Restored through the complete extension backup') {
  const backup = structuredClone(exportedBackup);
  backup.inventory = [{ ...backup.inventory.find((item) => item.id === first.id), enabled }];
  backup.data.groups = [
    ...backup.data.groups.filter((group) => group.id !== 'restore-e2e-group'),
    { id: 'restore-e2e-group', name: '恢复测试分组' },
  ];
  backup.data.meta[first.id] = { favorite: true, groupId: 'restore-e2e-group', note };
  return backup;
}

try {
  assert.ok(
    existsSync(path.join(dist, 'manifest.json')),
    'Build the extension before the restore integration checks.',
  );
  await mkdir(output, { recursive: true });
  profile = await mkdtemp(path.join(output, 'restore-profile-'));
  const extensions = [dist, ...fixturePaths].join(',');
  context = await chromium.launchPersistentContext(profile, {
    channel: 'chromium',
    headless: true,
    viewport: { width: 1360, height: 1000 },
    locale: 'zh-CN',
    acceptDownloads: true,
    args: [
      '--screen-info={1600x1200}',
      '--window-size=1440,1000',
      `--disable-extensions-except=${extensions}`,
      `--load-extension=${extensions}`,
    ],
  });
  context.setDefaultTimeout(15_000);
  context.setDefaultNavigationTimeout(20_000);
  context.on('page', (page) => page.on('pageerror', (error) => errors.push(error.message)));
  report.browserVersion = context.browser()?.version();
  let worker = context.serviceWorkers().find((entry) => entry.url().endsWith('/background.js'));
  if (!worker)
    worker = await context.waitForEvent('serviceworker', {
      predicate: (entry) => entry.url().endsWith('/background.js'),
    });
  base = `chrome-extension://${new URL(worker.url()).hostname}`;
  main = await context.newPage();
  currentPage = main;
  await main.goto(`${base}/index.html`);
  originalInventory = await main.evaluate(() => chrome.management.getAll());
  first = originalInventory.find((item) => item.name === 'Qii Test Fixture');
  extra = originalInventory.find((item) => item.name === 'Qii Restore Extra Fixture');
  assert.ok(first && extra, 'Both isolated restore fixtures must be installed.');
  await nativeEnabled(first.id, true);
  await nativeEnabled(extra.id, true);
  const privateFixture = await context.newPage();
  await privateFixture.goto(`chrome-extension://${extra.id}/options.html`);
  await expect
    .poll(() =>
      privateFixture.evaluate(
        async () =>
          (await chrome.storage.local.get('restorePrivateSentinel')).restorePrivateSentinel,
      ),
    )
    .toBe('fixture-private-value-not-a-backup');
  await privateFixture.close();

  const popup = await context.newPage();
  currentPage = popup;
  await popup.setViewportSize({ width: 600, height: 590 });
  await popup.goto(`${base}/popup.html`);
  await popup.getByRole('searchbox', { name: '搜索扩展', exact: true }).fill('Qii Test Fixture');
  await expect(popup.getByRole('article')).toHaveCount(1);
  await tools(popup);
  await popup.getByRole('radio', { name: '爱莉希雅', exact: true }).click();
  await expect(popup.locator('html')).toHaveAttribute('data-skin', 'elysia');

  await check(
    'full export includes every real extension despite the current filter and excludes private payloads',
    async () => {
      const downloading = popup.waitForEvent('download');
      await popup.getByRole('button', { name: '导出配置与清单 JSON', exact: true }).click();
      const download = await downloading;
      const filename = path.join(output, 'restore-full-export.json');
      await download.saveAs(filename);
      const text = await readFile(filename, 'utf8');
      exportedBackup = JSON.parse(text);
      assert.equal(exportedBackup.version, 2);
      assert.equal(exportedBackup.kind, 'extensions');
      assert.deepEqual(
        exportedBackup.inventory.map((item) => item.id).sort(),
        originalInventory.map((item) => item.id).sort(),
      );
      assert.equal(exportedBackup.data.settings.skin, 'elysia');
      assert.ok(exportedBackup.inventory.every((item) => typeof item.enabled === 'boolean'));
      assert.equal(text.includes('fixture-private-value-not-a-backup'), false);
      assert.equal(text.includes('restorePrivateSentinel'), false);
      await preferences(main);
      await expect(
        main.getByRole('button', { name: '导出配置与清单 JSON', exact: true }),
      ).toBeVisible();
      await expect(
        main.getByRole('button', { name: '导入 JSON 并应用', exact: true }),
      ).toBeVisible();
    },
  );

  await check(
    'preview has no side effects and applying one backup entry keeps extra extensions unchanged',
    async () => {
      const backup = onlyFirst(false);
      const beforeConfig = await main.evaluate(() => chrome.storage.local.get('qii.data.v1'));
      await preview(popup, backup);
      await nativeEnabled(first.id, true);
      await nativeEnabled(extra.id, true);
      assert.deepEqual(
        await main.evaluate(() => chrome.storage.local.get('qii.data.v1')),
        beforeConfig,
      );
      await shot(popup, 'restore-preview.png');
      await confirm(popup);
      await nativeEnabled(first.id, false);
      await nativeEnabled(extra.id, true);
      await expect(
        popup.getByRole('heading', { name: '备份已全部应用', exact: true }),
      ).toBeVisible();
      await expect(restoreRow(popup, first.id)).toHaveAttribute('data-restore-status', 'applied');
      const result = await downloadReport(popup, 'restore-success-report.json');
      assert.equal(result.complete, true);
      assert.equal(result.configSaved, true);
      const restored = result.rows.find((item) => item.id === first.id);
      assert.equal(restored.actualEnabled, false);
      assert.equal(restored.targetEnabled, false);
      assert.equal(restored.status, 'applied');
      const extraResult = result.rows.find((item) => item.id === extra.id);
      if (extraResult) assert.equal(extraResult.actualEnabled, true);
      await shot(popup, 'restore-result.png');
    },
  );

  await check(
    'rechecking a result only refreshes preview until an explicit second application',
    async () => {
      await main.evaluate((id) => chrome.management.setEnabled(id, true), first.id);
      await nativeEnabled(first.id, true);
      await popup
        .getByRole('dialog')
        .getByRole('button', { name: '重新检查', exact: true })
        .click();
      await expect(
        popup.getByRole('dialog').getByRole('heading', { name: '备份恢复预览', exact: true }),
      ).toBeVisible();
      await expect(
        popup.getByRole('dialog').getByRole('button', { name: '再次应用', exact: true }),
      ).toBeVisible();
      await nativeEnabled(first.id, true);
      await confirm(popup, '再次应用');
      await nativeEnabled(first.id, false);
      await nativeEnabled(extra.id, true);
      await expect(
        popup.getByRole('dialog').getByRole('heading', { name: '备份已全部应用', exact: true }),
      ).toBeVisible();
      await closeDialog(popup);
    },
  );

  await check('last restore result survives closing and reopening the popup', async () => {
    const reopened = await newPopup();
    const saved = reopened.locator('details.last-restore-summary');
    await saved.locator('summary').click();
    await expect(saved.getByRole('heading', { name: '备份已全部应用', exact: true })).toBeVisible();
    await expect(saved.locator(`.restore-item[data-restore-id="${first.id}"]`)).toHaveAttribute(
      'data-restore-status',
      'applied',
    );
    await reopened.close();
    currentPage = popup;
  });

  await check(
    'legacy version-one inventory can be explicitly applied through the new restore entry',
    async () => {
      const backup = onlyFirst(true);
      backup.version = 1;
      delete backup.kind;
      backup.inventory = backup.inventory.map(({ id, name, enabled }) => ({ id, name, enabled }));
      await preview(popup, backup);
      await nativeEnabled(first.id, false);
      await confirm(popup);
      await nativeEnabled(first.id, true);
      await nativeEnabled(extra.id, true);
      await expect(
        popup.getByRole('heading', { name: '备份已全部应用', exact: true }),
      ).toBeVisible();
      await closeDialog(popup);
    },
  );

  await check(
    'the existing configuration-only merge still never applies inventory enabled states',
    async () => {
      const backup = onlyFirst(false, 'Configuration-only import must not disable the fixture');
      backup.version = 1;
      delete backup.kind;
      backup.inventory = backup.inventory.map(({ id, name, enabled }) => ({ id, name, enabled }));
      await popup.getByLabel('导入配置文件', { exact: true }).setInputFiles({
        name: 'legacy-config.json',
        mimeType: 'application/json',
        buffer: Buffer.from(JSON.stringify(backup)),
      });
      const dialog = popup.getByRole('dialog', { name: '导入配置预览', exact: true });
      await expect(dialog).toContainText('不会安装、启停扩展');
      await dialog.getByRole('button', { name: '合并导入', exact: true }).click();
      await expect(dialog).toHaveCount(0);
      await nativeEnabled(first.id, true);
      await nativeEnabled(extra.id, true);
    },
  );

  await check(
    'missing store entries and protected items produce an accurate partial result in the full manager',
    async () => {
      const policyPage = await context.newPage();
      currentPage = policyPage;
      await policyPage.addInitScript(
        ({ extraId }) => {
          const getAll = chrome.management.getAll.bind(chrome.management);
          chrome.management.getAll = async () =>
            (await getAll()).map((item) =>
              item.id === extraId ? { ...item, installType: 'admin', mayDisable: false } : item,
            );
        },
        { extraId: extra.id },
      );
      await policyPage.goto(`${base}/index.html`);
      await preferences(policyPage);
      const missingChrome = 'p'.repeat(31) + 'a';
      const missingEdge = 'p'.repeat(31) + 'b';
      const missingDevelopment = 'p'.repeat(31) + 'c';
      assert.ok(
        !originalInventory.some((item) =>
          [missingChrome, missingEdge, missingDevelopment].includes(item.id),
        ),
      );
      const backup = onlyFirst(false);
      const manager = exportedBackup.inventory.find((item) => item.id === new URL(base).hostname);
      const extraItem = exportedBackup.inventory.find((item) => item.id === extra.id);
      backup.inventory.push(
        { ...manager, enabled: false },
        { ...extraItem, enabled: false },
        {
          id: missingChrome,
          name: 'Missing Chrome Store Extension',
          enabled: true,
          type: 'extension',
          installType: 'normal',
          version: '1.0.0',
          updateUrl: 'https://clients2.google.com/service/update2/crx',
        },
        {
          id: missingEdge,
          name: 'Missing Edge Store Extension',
          enabled: true,
          type: 'extension',
          installType: 'normal',
          version: '1.0.0',
          updateUrl: 'https://edge.microsoft.com/extensionwebstorebase/v1/crx',
        },
        {
          id: missingDevelopment,
          name: 'Missing Local Development Extension',
          enabled: true,
          type: 'extension',
          installType: 'development',
          version: '1.0.0',
        },
      );
      await preview(policyPage, backup);
      await expect(
        policyPage.getByRole('button', {
          name: '前往 Missing Chrome Store Extension 的官方商店',
          exact: true,
        }),
      ).toBeVisible();
      await expect(
        policyPage.getByRole('button', {
          name: '前往 Missing Edge Store Extension 的官方商店',
          exact: true,
        }),
      ).toBeVisible();
      await expect(
        policyPage.getByRole('button', {
          name: '前往 Missing Local Development Extension 的官方商店',
          exact: true,
        }),
      ).toHaveCount(0);
      await confirm(policyPage);
      await expect(
        policyPage.getByRole('heading', { name: '备份部分应用', exact: true }),
      ).toBeVisible();
      await nativeEnabled(first.id, false);
      await nativeEnabled(extra.id, true);
      await expect(restoreRow(policyPage, new URL(base).hostname)).toHaveAttribute(
        'data-restore-status',
        'protected',
      );
      await expect(restoreRow(policyPage, extra.id)).toHaveAttribute(
        'data-restore-status',
        'protected',
      );
      const result = await downloadReport(policyPage, 'restore-partial-report.json');
      assert.equal(result.complete, false);
      for (const id of [missingChrome, missingEdge, missingDevelopment])
        assert.equal(result.rows.find((item) => item.id === id).status, 'missing');
      const chromeUrl = new URL(result.rows.find((item) => item.id === missingChrome).installUrl);
      const edgeUrl = new URL(result.rows.find((item) => item.id === missingEdge).installUrl);
      assert.ok(['chromewebstore.google.com', 'chrome.google.com'].includes(chromeUrl.hostname));
      assert.equal(edgeUrl.hostname, 'microsoftedge.microsoft.com');
      assert.equal(
        result.rows.find((item) => item.id === missingDevelopment).installUrl,
        undefined,
      );
      assert.deepEqual(
        (await main.evaluate(() => chrome.management.getAll())).map((item) => item.id).sort(),
        originalInventory.map((item) => item.id).sort(),
        'missing items must never be silently installed',
      );
      await policyPage
        .getByRole('dialog')
        .getByRole('combobox', { name: '筛选恢复结果', exact: true })
        .selectOption('missing');
      await shot(policyPage, 'restore-partial.png');
      await policyPage.close();
      currentPage = popup;
      report.policySimulation =
        'Only readonly policy metadata for the real extra fixture was simulated in one isolated page; no OS policies or user profiles were changed.';
    },
  );

  await check(
    'rejected writes and resolved no-op writes cannot be reported as successful restores',
    async () => {
      const failed = await newPopup(({ firstId }) => {
        const setEnabled = chrome.management.setEnabled.bind(chrome.management);
        globalThis.__restoreFailureMode = 'reject';
        chrome.management.setEnabled = (id, value) =>
          id === firstId
            ? globalThis.__restoreFailureMode === 'reject'
              ? Promise.reject(new Error('E2E management write rejected'))
              : Promise.resolve()
            : setEnabled(id, value);
      });
      for (const mode of ['reject', 'noop']) {
        await failed.evaluate((value) => {
          globalThis.__restoreFailureMode = value;
        }, mode);
        await preview(failed, onlyFirst(true));
        await confirm(failed);
        await nativeEnabled(first.id, false);
        await expect(
          failed.getByRole('heading', { name: '备份已全部应用', exact: true }),
        ).toHaveCount(0);
        await expect(restoreRow(failed, first.id)).toHaveAttribute('data-restore-status', 'failed');
        const result = await downloadReport(failed, `restore-${mode}-report.json`);
        assert.equal(result.complete, false);
        assert.equal(result.rows.find((item) => item.id === first.id).actualEnabled, false);
        assert.equal(result.rows.find((item) => item.id === first.id).targetEnabled, true);
        await closeDialog(failed);
      }
      await failed.close();
      currentPage = popup;
    },
  );

  await check(
    'configuration-save failure is separate from verified extension state changes',
    async () => {
      const failedConfig = await newPopup(() => {
        const set = chrome.storage.local.set.bind(chrome.storage.local);
        chrome.storage.local.set = (values) =>
          Object.hasOwn(values, 'qii.data.v1')
            ? Promise.reject(new Error('E2E configuration persistence rejected'))
            : set(values);
      });
      await preview(
        failedConfig,
        onlyFirst(true, 'This note must not be persisted when configuration storage fails'),
      );
      await confirm(failedConfig);
      await nativeEnabled(first.id, true);
      await nativeEnabled(extra.id, true);
      await expect(
        failedConfig.getByRole('heading', { name: '备份已全部应用', exact: true }),
      ).toHaveCount(0);
      const result = await downloadReport(failedConfig, 'restore-config-failure-report.json');
      assert.equal(result.configSaved, false);
      assert.match(result.configError, /E2E configuration persistence rejected/);
      assert.equal(result.complete, false);
      const actual = result.rows.find((item) => item.id === first.id);
      assert.equal(actual.status, 'applied');
      assert.equal(actual.actualEnabled, true);
      const data = (await main.evaluate(() => chrome.storage.local.get('qii.data.v1')))[
        'qii.data.v1'
      ];
      assert.notEqual(
        data.meta[first.id]?.note,
        'This note must not be persisted when configuration storage fails',
      );
      await failedConfig.close();
      currentPage = popup;
    },
  );

  await check(
    'verification read failure never claims that actual extension states were confirmed',
    async () => {
      const failedVerification = await newPopup(({ firstId }) => {
        const getAll = chrome.management.getAll.bind(chrome.management);
        const setEnabled = chrome.management.setEnabled.bind(chrome.management);
        let rejectVerification = false;
        chrome.management.getAll = () =>
          rejectVerification
            ? Promise.reject(new Error('E2E final state read rejected'))
            : getAll();
        chrome.management.setEnabled = (id, value) => {
          const operation = setEnabled(id, value);
          if (id === firstId) rejectVerification = true;
          return operation;
        };
      });
      await preview(failedVerification, onlyFirst(false));
      await confirm(failedVerification);
      await nativeEnabled(first.id, false);
      await expect(
        failedVerification.getByRole('heading', { name: '备份已全部应用', exact: true }),
      ).toHaveCount(0);
      const result = await downloadReport(
        failedVerification,
        'restore-verification-failure-report.json',
      );
      assert.equal(result.complete, false);
      assert.match(result.verificationError, /E2E final state read rejected/);
      assert.equal(result.rows.find((item) => item.id === first.id).status, 'failed');
      assert.equal(result.rows.find((item) => item.id === first.id).actualEnabled, undefined);
      await failedVerification.close();
      currentPage = popup;
    },
  );

  await check(
    'saved restore reports remain downloadable while management inventory is unavailable',
    async () => {
      const reopened = await newPopup(() => {
        chrome.management.getAll = () =>
          Promise.reject(new Error('E2E management still unavailable after reopening'));
      });
      const saved = reopened.locator('details.last-restore-summary');
      await saved.locator('summary').click();
      await expect(saved.getByRole('heading', { name: '备份已全部应用', exact: true })).toHaveCount(
        0,
      );
      const downloading = reopened.waitForEvent('download');
      await saved.getByRole('button', { name: '下载上次恢复报告', exact: true }).click();
      const download = await downloading;
      const filename = path.join(output, 'restore-offline-history-report.json');
      await download.saveAs(filename);
      const result = JSON.parse(await readFile(filename, 'utf8'));
      assert.equal(result.complete, false);
      assert.match(result.verificationError, /E2E final state read rejected/);
      assert.equal(result.rows.find((item) => item.id === first.id).status, 'failed');
      downloadedReports.push(result);
      await reopened.close();
      currentPage = popup;
    },
  );

  await check('handled restore failures produce no unhandled browser exceptions', async () => {
    assert.deepEqual(errors, []);
  });
  report.passed = true;
  report.downloadedReports = downloadedReports.map(
    ({ complete, configSaved, configError, reportSaved, verificationError, counts }) => ({
      complete,
      configSaved,
      configError,
      reportSaved,
      verificationError,
      counts,
    }),
  );
  report.notes = [
    'All successful state changes were checked through the original native chrome.management API.',
    'Only the two disposable local fixtures were managed; no user profiles or external extensions were accessed.',
    'Policy flags and API/storage faults were deliberately simulated in isolated pages and are identified separately from native positive-path checks.',
    'No CRX extraction or automatic installation was attempted; exported backups contain manager configuration, inventory and state only.',
  ];
  console.log(`Completed ${checks.length} restore integration checks.`);
} catch (error) {
  report.passed = false;
  report.failure = error instanceof Error ? error.stack : String(error);
  console.error(report.failure);
  if (currentPage && !currentPage.isClosed())
    await shot(currentPage, 'restore-failure.png').catch(() => {});
  process.exitCode = 1;
} finally {
  await context?.close().catch(() => {});
  if (profile) {
    const relative = path.relative(output, path.resolve(profile));
    if (relative && !relative.startsWith('..') && !path.isAbsolute(relative))
      await rm(profile, { recursive: true, force: true }).catch(() => {});
  }
  await mkdir(output, { recursive: true });
  await writeFile(path.join(output, 'restore-e2e-report.json'), JSON.stringify(report, null, 2));
}
