import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, expect as playwrightExpect } from '@playwright/test';

// Real MV3 support requires a persistent Chromium context. Branded Chrome / Edge
// no longer guarantee command-line extension side-loading. See:
// https://playwright.dev/docs/chrome-extensions
const expect = playwrightExpect.configure({ timeout: 15_000 });
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'dist');
const fixturePath = path.join(root, 'tests', 'fixtures', 'test-extension');
const resultsPath = path.join(root, 'test-results');
const fixtureName = 'Qii Test Fixture';
const managerName = '栖 · 扩展管理器';
const checks = [];
const pageErrors = [];
let context;
let server;
let profile;
let currentPage;
const report = {
  browser: 'Playwright bundled Chromium; real Manifest V3 isolated profile',
  brandedChromeOrEdgeTested: false,
  checks,
};

async function check(name, run) {
  await run();
  checks.push({ name, passed: true });
  console.log(`PASS ${name}`);
}

function card(page, name = fixtureName) {
  return page
    .getByRole('article')
    .filter({ has: page.getByRole('heading', { name, exact: true }) });
}

function navigation(page, name) {
  if (name === '偏好设置') return page.getByRole('button', { name, exact: true });
  return page.getByRole('navigation', { name: '主要导航' }).getByRole('button', { name });
}

async function showAll(page) {
  await navigation(page, /^全部扩展/).click();
  await expect(card(page)).toBeVisible();
}

async function closeModal(page) {
  await page.getByRole('dialog').getByRole('button', { name: '关闭弹窗' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
}

async function fixtureEnabled(page, id) {
  return page.evaluate(async (targetId) => (await chrome.management.get(targetId)).enabled, id);
}

async function assertFixtureEnabled(page, id, enabled) {
  await expect
    .poll(() => fixtureEnabled(page, id), { message: `native fixture enabled=${enabled}` })
    .toBe(enabled);
}

async function startStaticServer() {
  const mime = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.png': 'image/png',
    '.svg': 'image/svg+xml',
    '.json': 'application/json',
  };
  server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url || '/', 'http://127.0.0.1');
      const requested =
        decodeURIComponent(url.pathname) === '/' ? '/index.html' : decodeURIComponent(url.pathname);
      const file = path.resolve(dist, `.${requested}`);
      const relative = path.relative(dist, file);
      if (relative.startsWith('..') || path.isAbsolute(relative)) {
        response.writeHead(403).end();
        return;
      }
      const body = await readFile(file);
      response.writeHead(200, {
        'content-type': mime[path.extname(file)] || 'application/octet-stream',
        'cache-control': 'no-store',
      });
      response.end(body);
    } catch {
      response.writeHead(404).end('Not found');
    }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return `http://127.0.0.1:${server.address().port}`;
}

try {
  assert.ok(
    existsSync(path.join(dist, 'manifest.json')),
    'Build missing: run npm run build before npm run test:e2e.',
  );
  await mkdir(resultsPath, { recursive: true });
  profile = await mkdtemp(path.join(resultsPath, 'chromium-profile-'));
  try {
    context = await chromium.launchPersistentContext(profile, {
      channel: 'chromium',
      headless: true,
      viewport: { width: 1440, height: 1100 },
      acceptDownloads: true,
      locale: 'zh-CN',
      args: [
        `--disable-extensions-except=${dist},${fixturePath}`,
        `--load-extension=${dist},${fixturePath}`,
      ],
    });
  } catch (error) {
    throw new Error(
      `Unable to launch the bundled Chromium. If its executable is missing, run npx playwright install chromium. ${String(error)}`,
    );
  }
  context.on('page', (page) => page.on('pageerror', (error) => pageErrors.push(error.message)));
  context.setDefaultTimeout(15_000);
  context.setDefaultNavigationTimeout(20_000);
  report.browserVersion = context.browser()?.version() || 'persistent Chromium';
  let worker = context.serviceWorkers().find((entry) => entry.url().endsWith('/background.js'));
  if (!worker)
    worker = await context.waitForEvent('serviceworker', {
      predicate: (entry) => entry.url().endsWith('/background.js'),
      timeout: 20_000,
    });
  const managerId = new URL(worker.url()).hostname;
  const base = `chrome-extension://${managerId}`;
  report.extensionId = managerId;
  const page = await context.newPage();
  currentPage = page;
  await page.goto(`${base}/index.html`);
  await expect(card(page)).toBeVisible();
  const inventory = await page.evaluate(() => chrome.management.getAll());
  const fixture = inventory.find((item) => item.name === fixtureName);
  assert.ok(fixture, 'Native management.getAll must return the installed test fixture.');

  await check('real MV3 inventory, minimal permissions and manager self protection', async () => {
    assert.ok(inventory.some((item) => item.id === managerId && item.name === managerName));
    const manifest = await page.evaluate(() => chrome.runtime.getManifest());
    assert.equal(manifest.manifest_version, 3);
    assert.deepEqual([...manifest.permissions].sort(), ['management', 'storage']);
    assert.equal(manifest.host_permissions, undefined);
    assert.equal(manifest.content_scripts, undefined);
    await expect(page.getByText('交互演示空间', { exact: true })).toHaveCount(0);
    await expect(card(page, managerName).getByRole('switch')).toBeDisabled();
    await page.screenshot({
      path: path.join(resultsPath, 'native-desktop.png'),
      fullPage: true,
      animations: 'disabled',
    });
  });

  await check('real native disable and enable through visible switches', async () => {
    await card(page)
      .getByRole('switch', { name: `停用 ${fixtureName}`, exact: true })
      .click();
    await assertFixtureEnabled(page, fixture.id, false);
    await expect(card(page).getByRole('switch')).toHaveAttribute('aria-checked', 'false');
    await card(page)
      .getByRole('switch', { name: `启用 ${fixtureName}`, exact: true })
      .click();
    await assertFixtureEnabled(page, fixture.id, true);
  });

  await check('create group, assign extension, favorite and persist personal note', async () => {
    await page.getByRole('button', { name: '新建分组', exact: true }).first().click();
    const groupDialog = page.getByRole('dialog');
    await groupDialog.getByLabel('分组名称').fill('E2E 工具组');
    await groupDialog.getByRole('button', { name: '创建分组', exact: true }).click();
    await expect(groupDialog).toHaveCount(0);
    await card(page)
      .getByRole('button', { name: `收藏 ${fixtureName}`, exact: true })
      .click();
    await card(page).getByRole('heading', { name: fixtureName, exact: true }).click();
    const detail = page.getByRole('dialog');
    await detail.getByLabel('所属分组').selectOption({ label: 'E2E 工具组' });
    await detail.getByLabel('我的备注').fill('E2E persistent note / 只管理隔离测试扩展');
    await detail.getByLabel('所属分组').focus();
    await closeModal(page);
    await page.reload();
    await expect(
      card(page).getByRole('button', { name: `取消收藏 ${fixtureName}`, exact: true }),
    ).toHaveAttribute('aria-pressed', 'true');
    await navigation(page, /^E2E 工具组/).click();
    await expect(page.getByRole('article')).toHaveCount(1);
    await card(page).getByRole('heading', { name: fixtureName, exact: true }).click();
    await expect(page.getByRole('dialog').getByLabel('我的备注')).toHaveValue(
      'E2E persistent note / 只管理隔离测试扩展',
    );
    await expect(page.getByRole('dialog').getByLabel('所属分组')).toHaveValue(/.+/);
    await closeModal(page);
    await showAll(page);
  });

  await check('permission review displays browser supplied API permission details', async () => {
    await navigation(page, '权限审阅').click();
    await card(page).getByRole('heading', { name: fixtureName, exact: true }).click();
    const detail = page.getByRole('dialog');
    await expect(detail.getByText('以下为浏览器报告的声明权限', { exact: false })).toBeVisible();
    await detail.getByText(/^API 权限（/).click();
    await expect(detail.getByText('存储本地数据', { exact: true })).toBeVisible();
    await expect(detail.getByRole('button', { name: '扩展选项', exact: true })).toBeVisible();
    await closeModal(page);
    await showAll(page);
  });

  await check('save scene, preview native changes, apply and inspect per item result', async () => {
    await page.getByRole('button', { name: '创建场景', exact: true }).click();
    const sceneForm = page.getByRole('dialog');
    await sceneForm.getByLabel('场景名称').fill('E2E 专注场景');
    await sceneForm.getByLabel('一句话描述').fill('关闭测试扩展，保留管理器。');
    await sceneForm.getByRole('checkbox', { name: new RegExp(fixtureName) }).uncheck();
    await sceneForm.getByRole('button', { name: '保存场景', exact: true }).click();
    await expect(sceneForm).toHaveCount(0);
    await navigation(page, /^场景切换/).click();
    await page
      .getByRole('article')
      .filter({ has: page.getByRole('heading', { name: 'E2E 专注场景', exact: true }) })
      .getByRole('button', { name: '预览并应用' })
      .click();
    const preview = page.getByRole('dialog');
    await expect(preview).toContainText(fixtureName);
    await expect(preview).toContainText('1 个停用');
    await assertFixtureEnabled(page, fixture.id, true);
    await preview.getByRole('button', { name: '确认切换', exact: true }).click();
    await expect(page.getByRole('dialog')).toContainText('成功 1');
    await assertFixtureEnabled(page, fixture.id, false);
    await page.getByRole('dialog').getByRole('button', { name: '完成', exact: true }).click();
    await showAll(page);
    await expect(card(page, managerName).getByRole('switch')).toHaveAttribute(
      'aria-checked',
      'true',
    );
  });

  const popup = await context.newPage();
  await popup.setViewportSize({ width: 600, height: 590 });
  await popup.goto(`${base}/popup.html`);
  await check('popup reads real state and native toggle synchronizes the full page', async () => {
    await expect(
      popup.getByRole('switch', { name: `启用 ${fixtureName}`, exact: true }),
    ).toBeVisible();
    await popup.getByRole('switch', { name: `启用 ${fixtureName}`, exact: true }).click();
    await assertFixtureEnabled(page, fixture.id, true);
    await expect(card(page).getByRole('switch')).toHaveAttribute('aria-checked', 'true');
    await popup
      .getByRole('combobox', { name: '按分组筛选', exact: true })
      .selectOption({ label: 'E2E 工具组' });
    await expect(popup.getByRole('article')).toHaveCount(1);
    await popup.screenshot({
      path: path.join(resultsPath, 'native-popup.png'),
      fullPage: true,
      animations: 'disabled',
    });
    await popup.close();
  });

  await check('batch disable and enable retain manager protection and native state', async () => {
    await page.getByRole('button', { name: '批量管理', exact: true }).click();
    await page.getByRole('checkbox', { name: `选择 ${fixtureName}`, exact: true }).check();
    await page.getByRole('button', { name: '停用', exact: true }).click();
    await page.getByRole('dialog').getByRole('button', { name: '确认执行', exact: true }).click();
    await expect(page.getByRole('dialog')).toContainText('成功 1');
    await assertFixtureEnabled(page, fixture.id, false);
    await page.getByRole('dialog').getByRole('button', { name: '完成', exact: true }).click();
    await card(page)
      .getByRole('switch', { name: `启用 ${fixtureName}`, exact: true })
      .click();
    await assertFixtureEnabled(page, fixture.id, true);
    await expect(card(page, managerName).getByRole('switch')).toBeDisabled();
  });

  await check(
    'download export and merge import preserve current native enabled states',
    async () => {
      await navigation(page, '偏好设置').click();
      const downloaded = page.waitForEvent('download');
      await page.getByRole('button', { name: '导出配置', exact: true }).click();
      const download = await downloaded;
      const exportPath = path.join(resultsPath, 'exported-backup.json');
      await download.saveAs(exportPath);
      const backup = JSON.parse(await readFile(exportPath, 'utf8'));
      assert.equal(backup.app, 'qii-extension-manager');
      assert.ok(backup.data.groups.some((group) => group.name === 'E2E 工具组'));
      assert.ok(backup.inventory.some((item) => item.id === fixture.id));
      assert.deepEqual(
        Object.keys(backup.inventory.find((item) => item.id === fixture.id)).sort(),
        ['enabled', 'id', 'name'],
      );
      // Deliberately contradict the current native state in the inventory. Import
      // should restore configuration only, and must never apply this false state.
      backup.inventory.find((item) => item.id === fixture.id).enabled = false;
      backup.data.meta[fixture.id].note = '通过配置导入恢复的备注';
      await page.getByLabel('导入配置文件', { exact: true }).setInputFiles({
        name: 'restore.json',
        mimeType: 'application/json',
        buffer: Buffer.from(JSON.stringify(backup)),
      });
      await expect(page.getByRole('dialog')).toContainText('不会安装、启停扩展');
      await page.getByRole('dialog').getByRole('button', { name: '合并导入', exact: true }).click();
      await expect(page.getByRole('dialog')).toHaveCount(0);
      await assertFixtureEnabled(page, fixture.id, true);
      await showAll(page);
      await card(page).getByRole('heading', { name: fixtureName, exact: true }).click();
      await expect(page.getByRole('dialog').getByLabel('我的备注')).toHaveValue(
        '通过配置导入恢复的备注',
      );
      await closeModal(page);
    },
  );

  await check(
    'invalid backup reports validation error without losing current inventory',
    async () => {
      await page.getByLabel('导入配置文件', { exact: true }).setInputFiles({
        name: 'invalid.json',
        mimeType: 'application/json',
        buffer: Buffer.from('{"app":"wrong"}'),
      });
      await expect(page.getByRole('status')).toContainText('无法导入');
      await expect(card(page)).toBeVisible();
      await assertFixtureEnabled(page, fixture.id, true);
    },
  );

  await check(
    'native API failures stay errors and never substitute demonstration data',
    async () => {
      const failed = await context.newPage();
      currentPage = failed;
      await failed.addInitScript(() => {
        chrome.management.getAll = () =>
          Promise.reject(new Error('E2E simulated native API failure'));
      });
      await failed.goto(`${base}/index.html`);
      await expect(failed.getByRole('alert')).toContainText('E2E simulated native API failure');
      await expect(failed.getByText('uBlock Origin Lite', { exact: true })).toHaveCount(0);
      await expect(failed.getByText('交互演示空间', { exact: true })).toHaveCount(0);
      await failed.close();
      currentPage = page;
    },
  );

  const demoBase = await startStaticServer();
  const demo = await context.newPage();
  currentPage = demo;
  await demo.goto(demoBase);
  await check('HTTP preview clearly identifies demonstration data', async () => {
    await expect(demo.getByText('当前为交互演示', { exact: false })).toBeVisible();
    await expect(card(demo, 'uBlock Origin Lite')).toBeVisible();
    await expect(demo.getByRole('article')).toHaveCount(16);
    await demo.screenshot({
      path: path.join(resultsPath, 'demo-desktop.png'),
      fullPage: true,
      animations: 'disabled',
    });
    assert.equal(
      await demo.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
      true,
      'desktop must not overflow horizontally',
    );
    for (const width of [1360, 900]) {
      await demo.setViewportSize({ width, height: 1000 });
      await demo.screenshot({
        path: path.join(resultsPath, `demo-${width}x1000.png`),
        fullPage: true,
        animations: 'disabled',
      });
      if (width === 1360) {
        await demo.screenshot({
          path: path.join(resultsPath, 'preview.png'),
          fullPage: false,
          animations: 'disabled',
        });
      }
      assert.equal(
        await demo.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
        true,
        `${width}px viewport must not overflow horizontally`,
      );
    }
    await demo.setViewportSize({ width: 1440, height: 1100 });
  });

  await check('search, no results, clearing filters and list/grid views work', async () => {
    const search = demo.getByRole('textbox', { name: '搜索扩展', exact: true });
    await search.fill('Dark Reader');
    await expect(demo.getByRole('article')).toHaveCount(1);
    await expect(card(demo, 'Dark Reader')).toBeVisible();
    await search.fill('E2E-no-extension-has-this-name');
    await expect(
      demo.getByRole('heading', { name: '没有找到匹配的扩展', exact: true }),
    ).toBeVisible();
    await demo.getByRole('button', { name: '清除筛选', exact: true }).click();
    await expect(demo.getByRole('article')).toHaveCount(16);
    await demo.getByRole('button', { name: '列表视图', exact: true }).click();
    await expect(demo.getByRole('button', { name: '列表视图', exact: true })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await demo.reload();
    await expect(demo.getByRole('button', { name: '列表视图', exact: true })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await demo.getByRole('button', { name: '网格视图', exact: true }).click();
    await expect(demo.getByRole('button', { name: '网格视图', exact: true })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
  });

  await check('dark theme persists across reload and popup preview', async () => {
    await navigation(demo, '偏好设置').click();
    await demo.getByRole('combobox', { name: '界面主题', exact: true }).selectOption('dark');
    await expect(demo.locator('html')).toHaveAttribute('data-theme', 'dark');
    await demo.reload();
    await expect(demo.locator('html')).toHaveAttribute('data-theme', 'dark');
    await navigation(demo, /^全部扩展/).click();
    await demo.screenshot({
      path: path.join(resultsPath, 'demo-dark.png'),
      fullPage: true,
      animations: 'disabled',
    });
    const demoPopup = await context.newPage();
    await demoPopup.setViewportSize({ width: 600, height: 590 });
    await demoPopup.goto(`${demoBase}/popup.html`);
    await expect(
      demoPopup.getByText('预览模式 · 操作仅影响演示数据', { exact: false }),
    ).toBeVisible();
    await expect(demoPopup.locator('html')).toHaveAttribute('data-theme', 'dark');
    await demoPopup.screenshot({
      path: path.join(resultsPath, 'demo-popup.png'),
      fullPage: true,
      animations: 'disabled',
    });
    await demoPopup.close();
  });

  await check('corrupt preview configuration displays a recoverable error', async () => {
    await demo.evaluate(() => localStorage.setItem('qii.demo.data.v1', '{broken-json'));
    await demo.reload();
    await expect(demo.getByRole('alert')).toContainText('配置无法读取');
    await demo.evaluate(() => localStorage.removeItem('qii.demo.data.v1'));
    await demo.getByRole('button', { name: '重新加载', exact: true }).click();
    await expect(card(demo, 'uBlock Origin Lite')).toBeVisible();
  });

  await check('no unhandled JavaScript exceptions during tested workflows', async () => {
    assert.deepEqual(pageErrors, []);
  });
  report.passed = true;
  report.notes = [
    'Real management API exercised against a local fixture in an isolated bundled Chromium profile.',
    'Popup HTML was tested at popup dimensions as a real extension page; browser toolbar popup opening was not automated.',
    'Branded Google Chrome and Microsoft Edge were not manually installed or claimed as tested.',
    'Native uninstall confirmation and permissions-increase dialogs require manual verification; no user extensions were touched.',
  ];
  console.log(`Completed ${checks.length} browser integration checks.`);
} catch (error) {
  report.passed = false;
  report.failure = error instanceof Error ? error.stack : String(error);
  if (currentPage && !currentPage.isClosed())
    await currentPage
      .screenshot({ path: path.join(resultsPath, 'failure.png'), fullPage: true })
      .catch(() => {});
  console.error(report.failure);
  process.exitCode = 1;
} finally {
  await context?.close().catch(() => {});
  if (server) await new Promise((resolve) => server.close(resolve));
  if (profile) {
    const relative = path.relative(resultsPath, path.resolve(profile));
    if (relative && !relative.startsWith('..') && !path.isAbsolute(relative))
      await rm(profile, { recursive: true, force: true }).catch(() => {});
  }
  await mkdir(resultsPath, { recursive: true });
  await writeFile(path.join(resultsPath, 'e2e-report.json'), JSON.stringify(report, null, 2));
}
