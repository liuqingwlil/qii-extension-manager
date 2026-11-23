import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, expect as playwrightExpect } from '@playwright/test';

const expect = playwrightExpect.configure({ timeout: 12_000 });
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'dist');
const artifacts = path.join(root, 'test-results');
const fixturePath = path.join(root, 'tests', 'fixtures', 'test-extension');
const checks = [];
const errors = [];
const remoteRequests = [];
const assetResponses = [];
const report = {
  browser: 'Isolated Playwright Chromium; real MV3 storage and local HTTP demonstration',
  brandedChromeOrEdgeTested: false,
  checks,
};
let context;
let profile;
let server;
let demoOrigin;
let currentPage;

async function check(name, run) {
  await run();
  checks.push({ name, passed: true });
  console.log(`PASS ${name}`);
}

function picker(page) {
  return page.getByRole('radiogroup', { name: '界面皮肤', exact: true });
}
function skin(page, name) {
  return picker(page).getByRole('radio', { name, exact: true });
}
function tile(page, name = 'Dark Reader') {
  return page
    .getByRole('article')
    .filter({ has: page.getByRole('button', { name: `查看 ${name} 详情`, exact: true }) });
}
async function tools(page) {
  await page.getByRole('tab', { name: '工具', exact: true }).click();
}
async function extensions(page) {
  await page.getByRole('tab', { name: /^扩展(?:\s*\d+)?$/ }).click();
}
async function preferences(page) {
  await page.getByRole('button', { name: '偏好设置', exact: true }).click();
}
async function assertSkin(page, value) {
  await expect(page.locator('html')).toHaveAttribute('data-skin', value);
}
async function shot(page, filename, fullPage = true) {
  await page.screenshot({ path: path.join(artifacts, filename), fullPage, animations: 'disabled' });
}
async function styles(locator) {
  return locator.evaluate(async (element) => {
    const transitions = element
      .getAnimations()
      .filter((animation) => Number.isFinite(animation.effect?.getComputedTiming().endTime));
    await Promise.all(transitions.map((animation) => animation.finished.catch(() => {})));
    const s = getComputedStyle(element);
    return {
      background: s.backgroundColor,
      color: s.color,
      borderColors: [s.borderTopColor, s.borderRightColor, s.borderBottomColor, s.borderLeftColor],
      borderWidths: [s.borderTopWidth, s.borderRightWidth, s.borderBottomWidth, s.borderLeftWidth],
      shadow: s.boxShadow,
      outlineStyle: s.outlineStyle,
      outlineWidth: s.outlineWidth,
      focusVisible: element.matches(':focus-visible'),
      decoration: s.textDecorationLine,
    };
  });
}
function colorDistance(first, second) {
  const rgb = (value) =>
    value
      .match(/[\d.]+/g)
      .slice(0, 3)
      .map(Number);
  const a = rgb(first),
    b = rgb(second);
  return Math.sqrt(a.reduce((sum, value, index) => sum + (value - b[index]) ** 2, 0));
}
async function importBackup(page, backup) {
  await page
    .getByLabel('导入配置文件', { exact: true })
    .setInputFiles({
      name: 'skin-backup.json',
      mimeType: 'application/json',
      buffer: Buffer.from(JSON.stringify(backup)),
    });
  const dialog = page.getByRole('dialog');
  await expect(dialog).toContainText('不会安装、启停扩展');
  await dialog.getByRole('button', { name: '合并导入', exact: true }).click();
  await expect(dialog).toHaveCount(0);
}

async function startServer() {
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
      response.writeHead(404).end();
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
    'Run npm run build before skin integration tests.',
  );
  await mkdir(artifacts, { recursive: true });
  profile = await mkdtemp(path.join(artifacts, 'skin-profile-'));
  context = await chromium.launchPersistentContext(profile, {
    channel: 'chromium',
    headless: true,
    viewport: { width: 1360, height: 1000 },
    locale: 'zh-CN',
    acceptDownloads: true,
    args: [
      '--screen-info={1600x1200}',
      '--window-size=1440,1000',
      `--disable-extensions-except=${dist},${fixturePath}`,
      `--load-extension=${dist},${fixturePath}`,
    ],
  });
  context.setDefaultTimeout(12_000);
  context.setDefaultNavigationTimeout(20_000);
  context.on('page', (page) => page.on('pageerror', (error) => errors.push(error.message)));
  context.on('request', (request) => {
    const url = request.url();
    if (/^https?:/.test(url) && (!demoOrigin || !url.startsWith(`${demoOrigin}/`)))
      remoteRequests.push(url);
  });
  context.on('response', (response) => {
    if (response.url().includes('/skins/'))
      assetResponses.push({ url: response.url(), status: response.status() });
  });
  report.browserVersion = context.browser()?.version();
  let worker = context.serviceWorkers().find((entry) => entry.url().endsWith('/background.js'));
  if (!worker)
    worker = await context.waitForEvent('serviceworker', {
      predicate: (entry) => entry.url().endsWith('/background.js'),
    });
  const base = `chrome-extension://${new URL(worker.url()).hostname}`;
  const main = await context.newPage();
  currentPage = main;
  await main.goto(`${base}/index.html`);
  const fixture = (await main.evaluate(() => chrome.management.getAll())).find(
    (entry) => entry.name === 'Qii Test Fixture',
  );
  assert.ok(fixture);
  const popup = await context.newPage();
  await popup.setViewportSize({ width: 600, height: 590 });
  await popup.goto(`${base}/popup.html`);
  await tools(popup);
  await preferences(main);

  await check('fresh native settings select forest in both skin pickers', async () => {
    await expect(skin(main, '森林序曲')).toHaveAttribute('aria-checked', 'true');
    await expect(skin(popup, '森林序曲')).toHaveAttribute('aria-checked', 'true');
    await expect(skin(popup, '爱莉希雅')).toHaveAttribute('aria-checked', 'false');
    await expect(skin(popup, '森林序曲').getByText('使用中', { exact: true })).toBeVisible();
    await assertSkin(main, 'forest');
    await assertSkin(popup, 'forest');
  });

  await check(
    'native skin selection preserves dark theme and synchronizes across surfaces',
    async () => {
      await popup.getByRole('button', { name: '深色', exact: true }).click();
      await expect(popup.locator('html')).toHaveAttribute('data-theme', 'dark');
      await expect(main.locator('html')).toHaveAttribute('data-theme', 'dark');
      const forestAccent = await popup
        .locator('html')
        .evaluate((element) => getComputedStyle(element).getPropertyValue('--green').trim());
      await skin(popup, '爱莉希雅').click();
      await expect(skin(popup, '爱莉希雅')).toHaveAttribute('aria-checked', 'true');
      await expect(skin(main, '爱莉希雅')).toHaveAttribute('aria-checked', 'true');
      await assertSkin(main, 'elysia');
      await assertSkin(popup, 'elysia');
      await expect(popup.locator('html')).toHaveAttribute('data-theme', 'dark');
      await expect(main.locator('html')).toHaveAttribute('data-theme', 'dark');
      const elysiaAccent = await popup
        .locator('html')
        .evaluate((element) => getComputedStyle(element).getPropertyValue('--green').trim());
      assert.notEqual(
        elysiaAccent,
        forestAccent,
        'changing a skin must change its actual CSS palette',
      );
      report.nativePalettes = { forestAccent, elysiaAccent };
      await popup.reload();
      await tools(popup);
      await main.reload();
      await preferences(main);
      await expect(skin(main, '爱莉希雅')).toHaveAttribute('aria-checked', 'true');
      await expect(skin(popup, '爱莉希雅')).toHaveAttribute('aria-checked', 'true');
      await expect(popup.locator('html')).toHaveAttribute('data-theme', 'dark');
      await skin(main, '森林序曲').click();
      await expect(skin(popup, '森林序曲')).toHaveAttribute('aria-checked', 'true');
      await expect(popup.locator('html')).toHaveAttribute('data-theme', 'dark');
    },
  );

  await check(
    'backup export and import restore skin without changing extension states',
    async () => {
      await skin(popup, '爱莉希雅').click();
      await expect(skin(popup, '爱莉希雅')).toHaveAttribute('aria-checked', 'true');
      const downloading = popup.waitForEvent('download');
      await popup.getByRole('button', { name: /^导出配置/ }).click();
      const download = await downloading;
      const exported = path.join(artifacts, 'skin-export.json');
      await download.saveAs(exported);
      const backup = JSON.parse(await readFile(exported, 'utf8'));
      assert.equal(backup.data.settings.skin, 'elysia');
      assert.equal(backup.data.settings.theme, 'dark');
      const originalState = await main.evaluate(
        async (id) => (await chrome.management.get(id)).enabled,
        fixture.id,
      );
      backup.inventory.find((entry) => entry.id === fixture.id).enabled = !originalState;
      await skin(popup, '森林序曲').click();
      await expect(skin(main, '森林序曲')).toHaveAttribute('aria-checked', 'true');
      await importBackup(popup, backup);
      await expect(skin(main, '爱莉希雅')).toHaveAttribute('aria-checked', 'true');
      await expect(skin(popup, '爱莉希雅')).toHaveAttribute('aria-checked', 'true');
      assert.equal(
        await main.evaluate(async (id) => (await chrome.management.get(id)).enabled, fixture.id),
        originalState,
      );

      delete backup.data.settings.skin;
      await importBackup(popup, backup);
      await expect(skin(popup, '森林序曲')).toHaveAttribute('aria-checked', 'true');
      await expect(skin(main, '森林序曲')).toHaveAttribute('aria-checked', 'true');
      await expect(popup.locator('html')).toHaveAttribute('data-theme', 'dark');
    },
  );

  await check(
    'skin picker keyboard navigation keeps visible focus and mouse click has no outer ring',
    async () => {
      const forest = skin(popup, '森林序曲');
      await forest.click();
      const mouse = await styles(forest);
      assert.equal(mouse.focusVisible, false);
      assert.ok(mouse.outlineStyle === 'none' || mouse.outlineWidth === '0px');
      await expect(forest).toBeEnabled();
      await forest.focus();
      await popup.keyboard.press('ArrowRight');
      const elysia = skin(popup, '爱莉希雅');
      await expect(elysia).toHaveAttribute('aria-checked', 'true');
      await expect(elysia).toBeFocused();
      const keyboard = await styles(elysia);
      assert.equal(keyboard.focusVisible, true);
      const keyboardLabelDecoration = await elysia
        .getByText('爱莉希雅', { exact: true })
        .evaluate((element) => getComputedStyle(element).textDecorationLine);
      assert.ok(
        keyboard.decoration.includes('underline') ||
          keyboardLabelDecoration.includes('underline') ||
          keyboard.shadow !== 'none' ||
          (keyboard.outlineStyle !== 'none' && keyboard.outlineWidth !== '0px'),
        'keyboard skin selection needs a perceptible focus cue',
      );
      report.skinPickerFocus = { mouse, keyboard, keyboardLabelDecoration };
    },
  );

  demoOrigin = await startServer();
  const demoPopup = await context.newPage();
  currentPage = demoPopup;
  await demoPopup.setViewportSize({ width: 600, height: 590 });
  await demoPopup.goto(`${demoOrigin}/popup.html`);
  await expect(tile(demoPopup, 'uBlock Origin Lite')).toBeVisible();
  await check('forest remains the default demonstration skin', async () => {
    await assertSkin(demoPopup, 'forest');
    await expect(demoPopup.getByRole('article')).toHaveCount(16);
    await shot(demoPopup, 'skin-forest-popup.png');
  });

  await check('Elysia picker and illustration render from a local decoded image', async () => {
    await tools(demoPopup);
    await skin(demoPopup, '爱莉希雅').click();
    await expect(skin(demoPopup, '爱莉希雅')).toHaveAttribute('aria-checked', 'true');
    await assertSkin(demoPopup, 'elysia');
    await picker(demoPopup).scrollIntoViewIfNeeded();
    const inactive = await styles(skin(demoPopup, '森林序曲'));
    await demoPopup.getByRole('tab', { name: '工具', exact: true }).hover();
    const selected = await styles(skin(demoPopup, '爱莉希雅'));
    await skin(demoPopup, '爱莉希雅').hover();
    const hovered = await styles(skin(demoPopup, '爱莉希雅'));
    assert.notEqual(hovered.background, inactive.background);
    assert.ok(
      colorDistance(hovered.background, selected.background) <
        colorDistance(hovered.background, inactive.background),
      'hovering the current skin must retain the selected color family rather than falling back to a neutral hover',
    );
    report.currentSkinHover = { inactive, selected, hovered };
    const image = skin(demoPopup, '爱莉希雅').locator('img');
    await expect(image).toBeVisible();
    await expect
      .poll(() => image.evaluate((element) => element.complete && element.naturalWidth > 0))
      .toBe(true);
    const asset = await image.evaluate((element) => ({
      src: element.currentSrc,
      width: element.naturalWidth,
      height: element.naturalHeight,
    }));
    assert.ok(
      asset.src.startsWith(`${demoOrigin}/skins/`),
      'the character image must be served by this local app',
    );
    report.illustration = asset;
    await shot(demoPopup, 'skin-picker.png');
    await extensions(demoPopup);
    await shot(demoPopup, 'skin-elysia-popup.png');
    await demoPopup.reload();
    await assertSkin(demoPopup, 'elysia');
  });

  const demoMain = await context.newPage();
  await demoMain.setViewportSize({ width: 1360, height: 1000 });
  await demoMain.goto(`${demoOrigin}/index.html`);
  await check(
    'Elysia applies consistently to the full manager and independent dark theme',
    async () => {
      await assertSkin(demoMain, 'elysia');
      await shot(demoMain, 'skin-elysia-main.png', false);
      await preferences(demoMain);
      await demoMain.getByRole('combobox', { name: '界面主题', exact: true }).selectOption('dark');
      await expect(demoPopup.locator('html')).toHaveAttribute('data-theme', 'dark');
      await assertSkin(demoPopup, 'elysia');
      await shot(demoPopup, 'skin-elysia-dark.png');
      await tools(demoPopup);
      await demoPopup.getByRole('button', { name: '浅色', exact: true }).click();
      await expect(demoMain.locator('html')).toHaveAttribute('data-theme', 'light');
      await expect(skin(demoMain, '爱莉希雅')).toHaveAttribute('aria-checked', 'true');
      await extensions(demoPopup);
    },
  );

  await check(
    'active navigation and filters differ in background and text from inactive controls',
    async () => {
      const popupActive = await styles(demoPopup.getByRole('tab', { name: /^扩展(?:\s*\d+)?$/ }));
      const popupInactive = await styles(demoPopup.getByRole('tab', { name: /^场景(?:\s*\d+)?$/ }));
      assert.notEqual(popupActive.background, popupInactive.background);
      assert.notEqual(popupActive.color, popupInactive.color);
      const filterActive = await styles(demoPopup.getByRole('button', { name: /^全部/ }));
      const filterInactive = await styles(demoPopup.getByRole('button', { name: /^已停用/ }));
      assert.notEqual(filterActive.background, filterInactive.background);
      assert.notEqual(filterActive.color, filterInactive.color);
      const nav = demoMain.getByRole('navigation', { name: '主要导航', exact: true });
      await nav.getByRole('button', { name: /^全部扩展/ }).click();
      const mainActive = await styles(nav.getByRole('button', { name: /^全部扩展/ }));
      const mainInactive = await styles(nav.getByRole('button', { name: /^已停用/ }));
      assert.notEqual(mainActive.background, mainInactive.background);
      assert.notEqual(mainActive.color, mainInactive.color);
      report.activeControls = {
        popupActive,
        popupInactive,
        filterActive,
        filterInactive,
        mainActive,
        mainInactive,
      };
    },
  );

  await check(
    'selected tiles show a check and explicit state while preserving neutral borders',
    async () => {
      await demoPopup.getByRole('button', { name: '批量管理', exact: true }).click();
      const target = tile(demoPopup);
      await target.hover();
      const before = await styles(target);
      const checkbox = demoPopup.getByRole('checkbox', { name: '选择 Dark Reader', exact: true });
      await checkbox.check();
      await expect(target.getByText('已选中', { exact: true })).toBeVisible();
      await expect(target.locator('.selection-label svg')).toBeVisible();
      const after = await styles(target);
      assert.notEqual(
        after.background,
        before.background,
        'selected tile background must visibly differ from its hovered unselected state',
      );
      assert.deepEqual(after.borderColors, before.borderColors);
      assert.deepEqual(after.borderWidths, before.borderWidths);
      assert.equal(after.shadow, before.shadow, 'selection must not introduce an outer glow');
      const mouse = await styles(checkbox);
      assert.equal(mouse.focusVisible, false);
      assert.ok(mouse.outlineStyle === 'none' || mouse.outlineWidth === '0px');
      report.selection = { before, after, mouse };
      await shot(demoPopup, 'skin-selection.png');
    },
  );

  await check(
    'skin assets remain local and tested surfaces have no unhandled exceptions',
    async () => {
      assert.ok(
        assetResponses.some((asset) => asset.url.startsWith('chrome-extension:')),
        'native skin preview should use its bundled image',
      );
      assert.ok(
        assetResponses.some((asset) => asset.url.startsWith(`${demoOrigin}/`)),
        'HTTP preview should use its own bundled image',
      );
      assert.ok(
        assetResponses.every((asset) => asset.status >= 200 && asset.status < 400),
        JSON.stringify(assetResponses),
      );
      assert.deepEqual(
        remoteRequests,
        [],
        'skin selection must not fetch images or tracking from a remote host',
      );
      assert.deepEqual(errors, []);
      report.assets = assetResponses;
    },
  );

  report.passed = true;
  report.notes = [
    'Native MV3 storage and cross-surface updates were verified in a fresh isolated profile.',
    'Screenshots show explicitly marked local demonstration data; no user profiles or external extensions were accessed.',
    'Light/dark color modes remain independent from forest/Elysia skins.',
  ];
  console.log(`Completed ${checks.length} skin integration checks.`);
} catch (error) {
  report.passed = false;
  report.failure = error instanceof Error ? error.stack : String(error);
  console.error(report.failure);
  if (currentPage && !currentPage.isClosed())
    await shot(currentPage, 'skin-failure.png').catch(() => {});
  process.exitCode = 1;
} finally {
  await context?.close().catch(() => {});
  if (server) await new Promise((resolve) => server.close(resolve));
  if (profile) {
    const relative = path.relative(artifacts, path.resolve(profile));
    if (relative && !relative.startsWith('..') && !path.isAbsolute(relative))
      await rm(profile, { recursive: true, force: true }).catch(() => {});
  }
  await mkdir(artifacts, { recursive: true });
  await writeFile(path.join(artifacts, 'skin-e2e-report.json'), JSON.stringify(report, null, 2));
}
