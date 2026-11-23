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
const fixtureName = 'Qii Test Fixture';
const checks = [];
const errors = [];
const report = {
  browser: 'Playwright bundled Chromium in an isolated real MV3 profile',
  brandedChromeOrEdgeTested: false,
  checks,
  nativeActionProbes: [],
};
let context;
let profile;
let server;
let currentPage;

async function check(name, run) {
  await run();
  checks.push({ name, passed: true });
  console.log(`PASS ${name}`);
}

function item(page, name) {
  return page.getByRole('article').filter({
    has: page.getByRole('button', { name: `查看 ${name} 详情`, exact: true }),
  });
}

async function extensions(page) {
  await page.getByRole('tab', { name: /^扩展(?:\s*\d+)?$/ }).click();
}

async function screenshot(page, filename) {
  await page.screenshot({
    path: path.join(artifacts, filename),
    fullPage: true,
    animations: 'disabled',
  });
}

async function closeDialog(page) {
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
}

async function enabled(controller, id, value) {
  await expect
    .poll(async () =>
      controller.evaluate(async (target) => (await chrome.management.get(target)).enabled, id),
    )
    .toBe(value);
}

async function assertWindowFits(page) {
  const dimensions = await page.evaluate(() => {
    const shell = document.querySelector('main');
    const rect = shell.getBoundingClientRect();
    return {
      width: rect.width,
      height: rect.height,
      scrollWidth: document.documentElement.scrollWidth,
      scrollHeight: document.documentElement.scrollHeight,
      viewportWidth: innerWidth,
      viewportHeight: innerHeight,
    };
  });
  assert.equal(
    Math.round(dimensions.width),
    600,
    'popup shell should use the intended 600px width',
  );
  assert.ok(dimensions.height <= 590, `popup shell exceeds 590px: ${JSON.stringify(dimensions)}`);
  assert.ok(
    dimensions.height >= 560,
    `normal-size popup must retain a useful preferred height: ${JSON.stringify(dimensions)}`,
  );
  assert.ok(
    dimensions.scrollWidth <= dimensions.viewportWidth,
    'popup must not horizontally overflow',
  );
  assert.ok(
    dimensions.scrollHeight <= dimensions.viewportHeight,
    'only inner content should scroll, not the popup window',
  );
  return dimensions;
}

async function staticServer() {
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
      const file = path.resolve(
        dist,
        `.${decodeURIComponent(url.pathname) === '/' ? '/index.html' : decodeURIComponent(url.pathname)}`,
      );
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

async function nativeActionGeometry(controller) {
  return controller.evaluate(() => {
    const view = chrome.extension.getViews({ type: 'popup' })[0];
    if (!view) return null;
    const doc = view.document;
    const rect = (element) => {
      if (!element) return null;
      const r = element.getBoundingClientRect();
      return { x: r.x, y: r.y, width: r.width, height: r.height, right: r.right, bottom: r.bottom };
    };
    const within = (a, b) =>
      !!a &&
      !!b &&
      a.width > 0 &&
      a.height > 0 &&
      a.x >= b.x - 0.5 &&
      a.y >= b.y - 0.5 &&
      a.right <= b.right + 0.5 &&
      a.bottom <= b.bottom + 0.5;
    const painted = (element) => {
      if (!element) return false;
      const style = view.getComputedStyle(element);
      return (
        style.display !== 'none' && style.visibility === 'visible' && Number(style.opacity) > 0
      );
    };
    const hitAtCenter = (element) => {
      if (!painted(element)) return false;
      const r = element.getBoundingClientRect();
      const hit = doc.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
      return !!hit && (element === hit || element.contains(hit));
    };
    const viewport = { x: 0, y: 0, right: view.innerWidth, bottom: view.innerHeight };
    const list = rect(doc.querySelector('.extension-list'));
    const cards = [...doc.querySelectorAll('.extension-list article')];
    const first = cards[0];
    const firstCard = rect(first);
    const search = rect(doc.querySelector('input[aria-label="搜索扩展"]'));
    const footer = rect(doc.querySelector('.popup-footer'));
    const close = rect(doc.querySelector('button[aria-label="关闭扩展面板"]'));
    const firstIcon = rect(first?.querySelector('.extension-icon'));
    const firstName = rect(first?.querySelector('.tile-name'));
    const firstRowCards = cards
      .filter((card) => firstCard && Math.abs(card.getBoundingClientRect().y - firstCard.y) <= 1)
      .map(rect);
    const portrait = doc.querySelector('img.elysia-portrait');
    return {
      width: view.innerWidth,
      height: view.innerHeight,
      bodyWidth: doc.body.scrollWidth,
      bodyHeight: doc.body.scrollHeight,
      shell: rect(doc.querySelector('.popup-shell')),
      preferredRoot: {
        width: view.getComputedStyle(doc.documentElement).width,
        height: view.getComputedStyle(doc.documentElement).height,
      },
      list,
      search,
      footer,
      close,
      firstCard,
      firstIcon,
      firstName,
      firstRowCards,
      skin: doc.documentElement.dataset.skin,
      inventoryCount: cards.length,
      portrait: portrait
        ? { ...rect(portrait), decoded: portrait.complete && portrait.naturalWidth > 0 }
        : null,
      visible: {
        search: within(search, viewport),
        searchReceivesInput: hitAtCenter(doc.querySelector('input[aria-label="搜索扩展"]')),
        list: within(list, viewport),
        firstCard: within(firstCard, list) && within(firstCard, viewport),
        firstIcon: within(firstIcon, firstCard),
        firstName: within(firstName, firstCard),
        firstContentPainted:
          painted(first?.querySelector('.extension-icon')) &&
          painted(first?.querySelector('.tile-name')),
        firstRow:
          firstRowCards.length > 0 &&
          firstRowCards.every((card) => within(card, list) && within(card, viewport)),
        firstRowReceivesInput: cards
          .filter(
            (card) => firstCard && Math.abs(card.getBoundingClientRect().y - firstCard.y) <= 1,
          )
          .every(hitAtCenter),
        footer: within(footer, viewport),
        close: within(close, viewport),
      },
    };
  });
}

function assertNativeActionUsable(dimensions) {
  assert.ok(dimensions, 'the native action view must remain open while measured');
  assert.ok(
    dimensions.width >= 580 && dimensions.width <= 600,
    `native popup width must remain close to 600px in this normal-size test browser: ${JSON.stringify(dimensions)}`,
  );
  assert.ok(
    dimensions.height >= 560 && dimensions.height <= 590,
    `native popup must not collapse or shrink its working area: ${JSON.stringify(dimensions)}`,
  );
  assert.ok(
    dimensions.bodyWidth <= dimensions.width && dimensions.bodyHeight <= dimensions.height,
    'the actual native viewport must contain the document',
  );
  assert.ok(dimensions.list.height >= 200, 'native inventory needs a usable working height');
  assert.ok(dimensions.search.height >= 25, 'search must be rendered at a usable size');
  assert.ok(
    dimensions.firstCard.width >= 75 && dimensions.firstCard.height >= 60,
    'inventory cards must have usable rendered dimensions',
  );
  for (const [region, visible] of Object.entries(dimensions.visible))
    assert.equal(visible, true, `native ${region} must be fully visible and not clipped`);
}

async function nativeActionProbe(controller, worker, label = 'forest') {
  const result = {
    label,
    tested: false,
    method: 'chrome.action.openPopup + chrome.extension.getViews({type:popup})',
  };
  report.nativeActionProbes.push(result);
  const opened = await worker.evaluate(async () => {
    try {
      await Promise.race([
        chrome.action.openPopup(),
        new Promise((_, reject) => setTimeout(() => reject(new Error('openPopup timeout')), 4000)),
      ]);
      return { ok: true };
    } catch (error) {
      return { ok: false, error: String(error) };
    }
  });
  assert.equal(opened.ok, true, `real native action popup must open: ${opened.error || ''}`);
  await expect
    .poll(() => controller.evaluate(() => chrome.extension.getViews({ type: 'popup' }).length), {
      timeout: 5000,
    })
    .toBe(1);
  await expect
    .poll(
      () =>
        controller.evaluate(
          () =>
            !!chrome.extension.getViews({ type: 'popup' })[0]?.document.querySelector('article'),
        ),
      { timeout: 5000 },
    )
    .toBe(true);
  await expect
    .poll(
      async () => {
        result.dimensions = await nativeActionGeometry(controller);
        return (
          !!result.dimensions &&
          result.dimensions.width >= 580 &&
          result.dimensions.height >= 560 &&
          result.dimensions.visible.firstRow &&
          result.dimensions.visible.search
        );
      },
      {
        timeout: 5000,
        message: 'native popup must grow to its preferred size and expose the inventory',
      },
    )
    .toBe(true);
  assertNativeActionUsable(result.dimensions);
  // Measure after browser auto-sizing settles too; article DOM existence alone does not prove paint visibility.
  await controller.waitForTimeout(150);
  result.settledDimensions = await nativeActionGeometry(controller);
  assertNativeActionUsable(result.settledDimensions);
  const nativePage = context.pages().find((view) => view.url().endsWith('/popup.html'));
  if (nativePage) {
    const filename = `native-action-${label}.png`;
    try {
      await nativePage.screenshot({
        path: path.join(artifacts, filename),
        fullPage: false,
        animations: 'disabled',
      });
      result.nativeTargetScreenshot = filename;
    } catch (error) {
      result.screenshotNote = `Native target screenshot unavailable: ${String(error)}`;
    }
  } else {
    result.screenshotNote =
      'The action view is accessible through chrome.extension.getViews but was not exposed as a Playwright Page target; no HTML-tab screenshot is substituted for the native view.';
  }
  result.tested = true;
  return result;
}

try {
  assert.ok(
    existsSync(path.join(dist, 'manifest.json')),
    'Run npm run build before the popup browser tests.',
  );
  await mkdir(artifacts, { recursive: true });
  profile = await mkdtemp(path.join(artifacts, 'popup-profile-'));
  context = await chromium.launchPersistentContext(profile, {
    channel: 'chromium',
    headless: true,
    locale: 'zh-CN',
    acceptDownloads: true,
    viewport: { width: 1360, height: 1000 },
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
  report.browserVersion = context.browser()?.version();
  let worker = context.serviceWorkers().find((entry) => entry.url().endsWith('/background.js'));
  if (!worker)
    worker = await context.waitForEvent('serviceworker', {
      predicate: (entry) => entry.url().endsWith('/background.js'),
    });
  const extensionId = new URL(worker.url()).hostname;
  const base = `chrome-extension://${extensionId}`;
  const controller = await context.newPage();
  await controller.goto(`${base}/index.html`);
  report.browserWindow = await controller.evaluate(async () => {
    const bounds = await chrome.windows.getCurrent();
    return {
      width: bounds.width,
      height: bounds.height,
      screenWidth: screen.width,
      screenHeight: screen.height,
    };
  });
  const inventory = await controller.evaluate(() => chrome.management.getAll());
  const fixture = inventory.find((entry) => entry.name === fixtureName);
  assert.ok(fixture, 'The isolated native fixture must be installed.');

  await check('toolbar action and command shortcuts target the popup and manager', async () => {
    const commands = await controller.evaluate(() => chrome.commands.getAll());
    assert.ok(commands.some((command) => command.name === '_execute_action'));
    assert.ok(commands.some((command) => command.name === 'open-manager'));
    const actionPopup = await controller.evaluate(() => chrome.action.getPopup({}));
    assert.equal(actionPopup, `${base}/popup.html`);
    report.commands = commands.map(({ name, shortcut }) => ({ name, shortcut }));
    report.actionPopup = actionPopup;
  });

  report.nativeActionPopup = await nativeActionProbe(controller, worker);
  if (report.nativeActionPopup.tested) {
    await check(
      'real browser action popup respects native size limits and close button',
      async () => {
        const dimensions = report.nativeActionPopup.dimensions;
        assert.equal(dimensions.width, 600);
        assert.ok(dimensions.height <= 590);
        assert.ok(dimensions.bodyWidth <= dimensions.width);
        assert.ok(dimensions.bodyHeight <= dimensions.height);
        try {
          await controller.bringToFront();
          await controller.mouse.click(15, 15);
          await expect
            .poll(
              () => controller.evaluate(() => chrome.extension.getViews({ type: 'popup' }).length),
              { timeout: 2000 },
            )
            .toBe(0);
          report.nativeActionPopup.focusLossDismissed = true;
          await worker.evaluate(() => chrome.action.openPopup());
          await expect
            .poll(() =>
              controller.evaluate(() => chrome.extension.getViews({ type: 'popup' }).length),
            )
            .toBe(1);
          await expect
            .poll(() =>
              controller.evaluate(
                () =>
                  !!chrome.extension
                    .getViews({ type: 'popup' })[0]
                    ?.document.querySelector('article'),
              ),
            )
            .toBe(true);
        } catch {
          report.nativeActionPopup.focusLossDismissed = false;
          report.nativeActionPopup.focusLossNote =
            'Headless target mouse dispatch did not reproduce operating-system focus loss; no product blur handler is required or inferred.';
        }
        const found = await controller.evaluate(() => {
          const view = chrome.extension.getViews({ type: 'popup' })[0];
          const button = view.document.querySelector('button[aria-label="关闭扩展面板"]');
          button?.click();
          return !!button;
        });
        assert.equal(found, true, 'native action view must offer its close button');
        await expect
          .poll(() =>
            controller.evaluate(() => chrome.extension.getViews({ type: 'popup' }).length),
          )
          .toBe(0);
      },
    );
    await check('Escape closes the real native action view', async () => {
      await worker.evaluate(() => chrome.action.openPopup());
      await expect
        .poll(() => controller.evaluate(() => chrome.extension.getViews({ type: 'popup' }).length))
        .toBe(1);
      await expect
        .poll(() =>
          controller.evaluate(
            () =>
              !!chrome.extension.getViews({ type: 'popup' })[0]?.document.querySelector('article'),
          ),
        )
        .toBe(true);
      await controller.evaluate(() => {
        const view = chrome.extension.getViews({ type: 'popup' })[0];
        view.document.dispatchEvent(
          new view.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
        );
      });
      await expect
        .poll(() => controller.evaluate(() => chrome.extension.getViews({ type: 'popup' }).length))
        .toBe(0);
    });
  }

  await check(
    'real Elysia action popup retains its preferred size and paints the inventory without clipping',
    async () => {
      const originalData = await controller.evaluate(
        async () => (await chrome.storage.local.get('qii.data.v1'))['qii.data.v1'],
      );
      try {
        await controller.evaluate(async (original) => {
          const next = original ?? {
            schemaVersion: 1,
            groups: [],
            scenes: [],
            meta: {},
            activity: [],
            settings: {
              theme: 'light',
              view: 'grid',
              sort: 'name',
              confirmBulk: true,
              popupView: 'grid',
              popupDensity: 'comfortable',
            },
          };
          next.settings = {
            ...next.settings,
            skin: 'elysia',
            theme: 'light',
            popupView: 'grid',
            popupDensity: 'comfortable',
          };
          localStorage.setItem('qii.popup.headerCollapsed', '0');
          await chrome.storage.local.set({ 'qii.data.v1': next });
        }, originalData);
        report.nativeElysiaActionPopup = await nativeActionProbe(controller, worker, 'elysia');
        await expect
          .poll(async () => {
            const geometry = await nativeActionGeometry(controller);
            return geometry?.skin === 'elysia' && geometry?.portrait?.decoded;
          })
          .toBe(true);
        const geometry = await nativeActionGeometry(controller);
        assertNativeActionUsable(geometry);
        report.nativeElysiaActionPopup.artworkDimensions = geometry;
        assert.ok(
          geometry.portrait.width > 100,
          'real native Elysia popup must paint its character artwork',
        );
        const firstRow = geometry.firstRowCards;
        assert.ok(
          firstRow.length >= 2,
          'both isolated installed extensions must fit in the first row',
        );
      } finally {
        await controller.evaluate(async (original) => {
          chrome.extension.getViews({ type: 'popup' })[0]?.close();
          if (original === undefined) await chrome.storage.local.remove('qii.data.v1');
          else await chrome.storage.local.set({ 'qii.data.v1': original });
        }, originalData);
        await expect
          .poll(() =>
            controller.evaluate(() => chrome.extension.getViews({ type: 'popup' }).length),
          )
          .toBe(0);
      }
    },
  );

  const popup = await context.newPage();
  currentPage = popup;
  await popup.setViewportSize({ width: 600, height: 590 });
  await popup.goto(`${base}/popup.html`);
  await expect(item(popup, fixtureName)).toBeVisible();
  await check(
    'bootstrap sizing requests a full-size body even from a tiny initial HTML viewport',
    async () => {
      try {
        await popup.setViewportSize({ width: 48, height: 50 });
        const size = await popup.evaluate(() => {
          const rect = (element) => {
            const value = element.getBoundingClientRect();
            return { width: value.width, height: value.height };
          };
          return {
            viewport: { width: innerWidth, height: innerHeight },
            body: rect(document.body),
            root: rect(document.querySelector('#root')),
            shell: rect(document.querySelector('.popup-shell')),
          };
        });
        report.bootstrapSizing = size;
        assert.ok(
          size.body.width >= 580 && size.body.height >= 560,
          `the body must provide an intrinsic preferred-size seed independent of the initial viewport: ${JSON.stringify(size)}`,
        );
        assert.ok(
          size.root.width <= size.viewport.width && size.root.height <= size.viewport.height,
          'interactive root still follows the available viewport during bootstrap',
        );
        assert.ok(
          size.shell.width <= size.viewport.width && size.shell.height <= size.viewport.height,
          'responsive shell must not replace the body preferred-size anchor',
        );
      } finally {
        await popup.setViewportSize({ width: 600, height: 590 });
      }
      await assertWindowFits(popup);
      await expect(
        popup.getByRole('searchbox', { name: '搜索扩展', exact: true }),
      ).toBeInViewport();
      await expect(popup.getByRole('article').first()).toBeInViewport();
    },
  );
  await check('real popup tabs, dimensions and self protection', async () => {
    await expect(popup.getByRole('tab', { name: /^扩展(?:\s*\d+)?$/ })).toBeVisible();
    await expect(popup.getByRole('tab', { name: /^场景(?:\s*\d+)?$/ })).toBeVisible();
    await expect(popup.getByRole('tab', { name: '工具', exact: true })).toBeVisible();
    report.htmlPopupDimensions = await assertWindowFits(popup);
    await item(popup, '栖 · 扩展管理器')
      .getByRole('button', { name: '查看 栖 · 扩展管理器 详情', exact: true })
      .click();
    const selfDetail = popup.getByRole('dialog', { name: '栖 · 扩展管理器', exact: true });
    await expect(selfDetail.getByRole('button', { name: '卸载扩展', exact: true })).toBeDisabled();
    await closeDialog(popup);
  });

  await check(
    'native fixture enable toggle works inside popup and synchronizes management page',
    async () => {
      await item(popup, fixtureName)
        .getByRole('switch', { name: `停用 ${fixtureName}`, exact: true })
        .click();
      await enabled(controller, fixture.id, false);
      await item(popup, fixtureName)
        .getByRole('switch', { name: `启用 ${fixtureName}`, exact: true })
        .click();
      await enabled(controller, fixture.id, true);
      await expect(
        controller.getByRole('switch', { name: `停用 ${fixtureName}`, exact: true }),
      ).toHaveAttribute('aria-checked', 'true');
    },
  );

  await check(
    'popup creates group and persists detail favorite, group, note and permissions',
    async () => {
      await popup.getByRole('button', { name: '新建分组', exact: true }).click();
      let dialog = popup.getByRole('dialog');
      await dialog.getByLabel('分组名称', { exact: true }).fill('Popup E2E 分组');
      await dialog.getByRole('button', { name: /^(创建分组|保存分组)$/ }).click();
      await expect(dialog).toHaveCount(0);
      await popup.getByRole('button', { name: `查看 ${fixtureName} 详情`, exact: true }).click();
      dialog = popup.getByRole('dialog', { name: fixtureName, exact: true });
      await dialog
        .getByLabel('所属分组', { exact: true })
        .selectOption({ label: 'Popup E2E 分组' });
      await dialog.getByLabel('扩展备注', { exact: true }).fill('popup-only persistent note');
      await dialog.getByRole('button', { name: '收藏', exact: true }).click();
      await dialog.getByRole('button', { name: '保存更改', exact: true }).click();
      if (await popup.getByRole('dialog').count()) await closeDialog(popup);
      await popup.reload();
      await popup
        .getByRole('combobox', { name: '按分组筛选', exact: true })
        .selectOption({ label: 'Popup E2E 分组' });
      await expect(popup.getByRole('article')).toHaveCount(1);
      await popup.getByRole('button', { name: `查看 ${fixtureName} 详情`, exact: true }).click();
      dialog = popup.getByRole('dialog', { name: fixtureName, exact: true });
      await expect(dialog.getByLabel('扩展备注', { exact: true })).toHaveValue(
        'popup-only persistent note',
      );
      await expect(dialog.getByRole('button', { name: '取消收藏', exact: true })).toBeVisible();
      await expect(dialog.getByText(/^权限与访问范围/)).toBeVisible();
      await expect(dialog.getByText(/storage|存储本地数据/).first()).toBeVisible();
      const optionsOpened = context.waitForEvent('page');
      await dialog.getByRole('button', { name: '扩展设置', exact: true }).click();
      const options = await optionsOpened;
      await expect(options).toHaveURL(`chrome-extension://${fixture.id}/options.html`);
      await expect(
        options.getByRole('heading', { name: 'Qii Test Fixture Options', exact: true }),
      ).toBeVisible();
      await options.close();
      const browserDetailsOpened = context.waitForEvent('page');
      await dialog.getByRole('button', { name: '浏览器详情', exact: true }).click();
      const browserDetails = await browserDetailsOpened;
      await expect(browserDetails).toHaveURL(
        new RegExp(`^chrome://extensions/\\?id=${fixture.id}$`),
      );
      await browserDetails.close();
      await closeDialog(popup);
      await popup.getByRole('combobox', { name: '按分组筛选', exact: true }).selectOption('all');
    },
  );

  await check('popup batch preview applies native changes with per-item results', async () => {
    await popup.getByRole('button', { name: '批量管理', exact: true }).click();
    await popup.getByRole('checkbox', { name: `选择 ${fixtureName}`, exact: true }).check();
    await popup.getByRole('button', { name: '移动分组', exact: true }).click();
    let move = popup.getByRole('dialog', { name: '移动分组', exact: true });
    await move.getByLabel('目标分组', { exact: true }).selectOption({ label: '未分组' });
    await move.getByRole('button', { name: '确认移动', exact: true }).click();
    await expect(move).toHaveCount(0);
    await enabled(controller, fixture.id, true);
    await popup
      .getByRole('combobox', { name: '按分组筛选', exact: true })
      .selectOption({ label: 'Popup E2E 分组' });
    await expect(popup.getByRole('article')).toHaveCount(0);
    await popup.getByRole('combobox', { name: '按分组筛选', exact: true }).selectOption('all');
    if (await popup.getByRole('button', { name: '批量管理', exact: true }).count())
      await popup.getByRole('button', { name: '批量管理', exact: true }).click();
    await popup.getByRole('checkbox', { name: `选择 ${fixtureName}`, exact: true }).check();
    await popup.getByRole('button', { name: '停用所选', exact: true }).click();
    const preview = popup.getByRole('dialog', { name: '批量停用', exact: true });
    await expect(preview).toContainText(fixtureName);
    await enabled(controller, fixture.id, true);
    await preview.getByRole('button', { name: '确认执行', exact: true }).click();
    await enabled(controller, fixture.id, false);
    await expect(popup.getByRole('dialog')).toContainText(/1\s*已完成/);
    await closeDialog(popup);
    if (await popup.getByRole('button', { name: '结束批量', exact: true }).count())
      await popup.getByRole('button', { name: '结束批量', exact: true }).click();
    await item(popup, fixtureName)
      .getByRole('switch', { name: `启用 ${fixtureName}`, exact: true })
      .click();
    await enabled(controller, fixture.id, true);
  });

  await check('popup creates, edits, previews, applies and deletes scenes', async () => {
    await popup.getByRole('tab', { name: /^场景(?:\s*\d+)?$/ }).click();
    await popup.getByRole('button', { name: '新建场景', exact: true }).click();
    let dialog = popup.getByRole('dialog', { name: '新建场景', exact: true });
    await dialog.getByLabel('场景名称', { exact: true }).fill('Popup E2E 场景');
    await dialog.getByLabel('场景说明', { exact: true }).fill('关闭隔离fixture。');
    await dialog.getByRole('checkbox', { name: `场景管理 ${fixtureName}`, exact: true }).check();
    await dialog.getByRole('button', { name: `场景中停用 ${fixtureName}`, exact: true }).click();
    await dialog.getByRole('button', { name: '保存场景', exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await popup.getByRole('button', { name: '编辑场景 Popup E2E 场景', exact: true }).click();
    dialog = popup.getByRole('dialog', { name: '编辑场景', exact: true });
    await dialog.getByLabel('场景说明', { exact: true }).fill('已在popup修改说明。');
    await dialog.getByRole('button', { name: '保存场景', exact: true }).click();
    await popup.getByRole('button', { name: '切换场景 Popup E2E 场景', exact: true }).click();
    dialog = popup.getByRole('dialog');
    await expect(dialog).toContainText(fixtureName);
    await enabled(controller, fixture.id, true);
    await dialog.getByRole('button', { name: /^(确认切换|确认执行)$/ }).click();
    await enabled(controller, fixture.id, false);
    await expect(popup.getByRole('dialog')).toContainText(/1\s*已完成/);
    await closeDialog(popup);
    await popup.getByRole('button', { name: '删除场景 Popup E2E 场景', exact: true }).click();
    await popup.getByRole('dialog').getByRole('button', { name: '确认删除', exact: true }).click();
    await expect(
      popup.getByRole('button', { name: '切换场景 Popup E2E 场景', exact: true }),
    ).toHaveCount(0);
    await extensions(popup);
    await item(popup, fixtureName)
      .getByRole('switch', { name: `启用 ${fixtureName}`, exact: true })
      .click();
    await enabled(controller, fixture.id, true);
  });

  await check(
    'popup exports and imports configuration without applying inventory states',
    async () => {
      await popup.getByRole('tab', { name: '工具', exact: true }).click();
      const downloading = popup.waitForEvent('download');
      await popup.getByRole('button', { name: '导出配置', exact: true }).click();
      const download = await downloading;
      const backupPath = path.join(artifacts, 'popup-export.json');
      await download.saveAs(backupPath);
      const backup = JSON.parse(await readFile(backupPath, 'utf8'));
      assert.ok(backup.inventory.some((entry) => entry.id === fixture.id));
      backup.inventory.find((entry) => entry.id === fixture.id).enabled = false;
      backup.data.meta[fixture.id].note = 'imported-from-popup';
      await popup.getByLabel('导入配置文件', { exact: true }).setInputFiles({
        name: 'popup-backup.json',
        mimeType: 'application/json',
        buffer: Buffer.from(JSON.stringify(backup)),
      });
      const dialog = popup.getByRole('dialog');
      await expect(dialog).toContainText(/不会.*启停/);
      await dialog.getByRole('button', { name: '合并导入', exact: true }).click();
      await expect(popup.getByRole('dialog')).toHaveCount(0);
      await enabled(controller, fixture.id, true);
      await extensions(popup);
      await popup.getByRole('button', { name: `查看 ${fixtureName} 详情`, exact: true }).click();
      await expect(popup.getByRole('dialog').getByLabel('扩展备注', { exact: true })).toHaveValue(
        'imported-from-popup',
      );
      await closeDialog(popup);
    },
  );

  await check('popup native API errors never fall back to demonstration inventory', async () => {
    const failed = await context.newPage();
    currentPage = failed;
    await failed.setViewportSize({ width: 600, height: 590 });
    await failed.addInitScript(() => {
      chrome.management.getAll = () =>
        Promise.reject(new Error('Popup E2E native management failure'));
    });
    await failed.goto(`${base}/popup.html`);
    await expect(failed.getByRole('alert')).toContainText('Popup E2E native management failure');
    await expect(
      failed.getByRole('button', { name: '查看 uBlock Origin Lite 详情', exact: true }),
    ).toHaveCount(0);
    await expect(failed.getByText(/预览模式|交互演示/)).toHaveCount(0);
    await failed.close();
    currentPage = popup;
  });

  const demoBase = await staticServer();
  const demo = await context.newPage();
  currentPage = demo;
  await demo.setViewportSize({ width: 600, height: 590 });
  await demo.goto(`${demoBase}/popup.html`);
  await expect(item(demo, 'uBlock Origin Lite')).toBeVisible();
  await check('demo icon grid fits popup, has five columns and inner scroll', async () => {
    await expect(demo.getByText(/预览模式|演示/).first()).toBeVisible();
    await expect(demo.getByRole('article')).toHaveCount(16);
    await assertWindowFits(demo);
    const boxes = await demo.getByRole('article').evaluateAll((elements) =>
      elements.slice(0, 6).map((element) => {
        const r = element.getBoundingClientRect();
        return { x: r.x, y: r.y };
      }),
    );
    assert.equal(
      new Set(boxes.slice(0, 5).map((box) => Math.round(box.y))).size,
      1,
      'first five extensions share a grid row',
    );
    assert.ok(boxes[5].y > boxes[0].y, 'sixth extension begins a new row');
    await screenshot(demo, 'popup-grid.png');
  });

  await check('popup search, favorites and group filters have useful empty states', async () => {
    const search = demo.getByRole('searchbox', { name: '搜索扩展', exact: true });
    await search.fill('Dark Reader');
    await expect(demo.getByRole('article')).toHaveCount(1);
    await expect(item(demo, 'Dark Reader')).toBeVisible();
    await search.fill('no-extension-matches-this-qii-e2e');
    await expect(demo.getByText(/没有找到匹配/)).toBeVisible();
    await search.fill('');
    await demo.getByRole('button', { name: /^收藏/ }).click();
    await expect(demo.getByRole('article')).toHaveCount(4);
    await demo.getByRole('button', { name: /^全部/ }).click();
    await demo
      .getByRole('combobox', { name: '按分组筛选', exact: true })
      .selectOption({ label: '开发工具' });
    await expect(demo.getByRole('article')).toHaveCount(5);
    await demo.getByRole('combobox', { name: '按分组筛选', exact: true }).selectOption('all');
  });

  await check('popup list and compact density persist, retaining internal scrolling', async () => {
    await demo.getByRole('button', { name: '列表视图', exact: true }).click();
    await expect(demo.getByRole('button', { name: '列表视图', exact: true })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await assertWindowFits(demo);
    await screenshot(demo, 'popup-list.png');
    await demo.reload();
    await expect(demo.getByRole('button', { name: '列表视图', exact: true })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await demo.getByRole('button', { name: '图标视图', exact: true }).click();
    await expect(demo.getByRole('button', { name: '图标视图', exact: true })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    const comfortableHeight = await demo
      .getByRole('article')
      .first()
      .evaluate((element) => element.getBoundingClientRect().height);
    await demo.getByRole('button', { name: '紧凑密度', exact: true }).click();
    await expect(demo.getByRole('button', { name: '紧凑密度', exact: true })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    const compactHeight = await demo
      .getByRole('article')
      .first()
      .evaluate((element) => element.getBoundingClientRect().height);
    assert.ok(compactHeight < comfortableHeight, 'compact density should reduce tile height');
    await screenshot(demo, 'popup-compact.png');
    await demo.reload();
    await expect(demo.getByRole('button', { name: '紧凑密度', exact: true })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
  });

  await check(
    'popup detail, scenes and dark theme remain within native popup dimensions',
    async () => {
      await demo.getByRole('button', { name: '查看 沉浸式翻译 详情', exact: true }).click();
      await expect(demo.getByRole('dialog', { name: '沉浸式翻译', exact: true })).toBeVisible();
      await assertWindowFits(demo);
      await screenshot(demo, 'popup-detail.png');
      await closeDialog(demo);
      await demo.getByRole('tab', { name: /^场景(?:\s*\d+)?$/ }).click();
      await expect(
        demo.getByRole('button', { name: '切换场景 工作模式', exact: true }),
      ).toBeVisible();
      await assertWindowFits(demo);
      await screenshot(demo, 'popup-scenes.png');
      await demo.getByRole('tab', { name: '工具', exact: true }).click();
      await demo.getByRole('button', { name: '深色', exact: true }).click();
      await expect(demo.locator('html')).toHaveAttribute('data-theme', 'dark');
      await extensions(demo);
      await screenshot(demo, 'popup-dark.png');
      await demo.reload();
      await expect(demo.locator('html')).toHaveAttribute('data-theme', 'dark');
    },
  );

  await check(
    'batch selection preserves neutral borders and mouse/keyboard focus differ',
    async () => {
      const target = item(demo, 'Dark Reader');
      await demo.getByRole('button', { name: '批量管理', exact: true }).click();
      const before = await target.evaluate((element) => {
        const s = getComputedStyle(element);
        return {
          border: [s.borderTopColor, s.borderRightColor, s.borderBottomColor, s.borderLeftColor],
          widths: [s.borderTopWidth, s.borderRightWidth, s.borderBottomWidth, s.borderLeftWidth],
          shadow: s.boxShadow,
        };
      });
      await demo.getByRole('checkbox', { name: '选择 Dark Reader', exact: true }).check();
      const after = await target.evaluate((element) => {
        const s = getComputedStyle(element);
        return {
          border: [s.borderTopColor, s.borderRightColor, s.borderBottomColor, s.borderLeftColor],
          widths: [s.borderTopWidth, s.borderRightWidth, s.borderBottomWidth, s.borderLeftWidth],
          shadow: s.boxShadow,
        };
      });
      assert.deepEqual(
        after,
        before,
        'selection must not add saturated borders, side accents or outer shadows',
      );
      await demo.getByRole('button', { name: '结束批量', exact: true }).click();
      const viewButton = demo.getByRole('button', { name: '列表视图', exact: true });
      await viewButton.click();
      const clicked = await viewButton.evaluate((element) => {
        const s = getComputedStyle(element);
        return {
          focusVisible: element.matches(':focus-visible'),
          outlineStyle: s.outlineStyle,
          outlineWidth: s.outlineWidth,
        };
      });
      assert.equal(
        clicked.focusVisible,
        false,
        'mouse clicking must not produce a keyboard focus ring',
      );
      assert.ok(clicked.outlineStyle === 'none' || clicked.outlineWidth === '0px');
      await demo.keyboard.press('Tab');
      const keyboardFocus = await demo.evaluate(() => {
        const element = document.activeElement;
        const s = getComputedStyle(element);
        return {
          tag: element.tagName,
          focusVisible: element.matches(':focus-visible'),
          textDecoration: s.textDecorationLine,
          shadow: s.boxShadow,
          outlineStyle: s.outlineStyle,
          outlineWidth: s.outlineWidth,
        };
      });
      assert.equal(
        keyboardFocus.focusVisible,
        true,
        'keyboard navigation must remain visibly identifiable',
      );
      assert.ok(
        keyboardFocus.textDecoration.includes('underline') ||
          keyboardFocus.shadow !== 'none' ||
          (keyboardFocus.outlineStyle !== 'none' && keyboardFocus.outlineWidth !== '0px'),
        `missing keyboard focus feedback: ${JSON.stringify(keyboardFocus)}`,
      );
    },
  );

  await check(
    'narrow browser popup keeps its shell, close control and footer visible',
    async () => {
      await demo.setViewportSize({ width: 466, height: 510 });
      const measured = await demo.evaluate(() => {
        const rect = (element) => {
          const r = element.getBoundingClientRect();
          return {
            x: r.x,
            y: r.y,
            width: r.width,
            height: r.height,
            right: r.right,
            bottom: r.bottom,
          };
        };
        return {
          shell: rect(document.querySelector('main')),
          footer: rect(document.querySelector('footer')),
          close: rect(document.querySelector('button[aria-label="关闭扩展面板"]')),
          viewport: { width: innerWidth, height: innerHeight },
          preferredDocumentSize: {
            width: document.documentElement.scrollWidth,
            height: document.documentElement.scrollHeight,
          },
        };
      });
      report.narrowPopup = measured;
      assert.ok(measured.shell.width <= 466 && measured.shell.height <= 510);
      assert.ok(
        measured.footer.x >= 0 && measured.footer.right <= 466 && measured.footer.bottom <= 510,
      );
      assert.ok(
        measured.close.x >= 0 && measured.close.right <= 466 && measured.close.bottom <= 510,
      );
      await demo.screenshot({
        path: path.join(artifacts, 'popup-narrow.png'),
        fullPage: false,
        animations: 'disabled',
      });
    },
  );

  await check('no unhandled JavaScript exceptions in popup workflows', async () => {
    assert.deepEqual(errors, []);
  });
  report.passed = true;
  report.notes = [
    'All native fixture operations used real chrome.management in an isolated profile.',
    'Rich interactions and screenshots used popup.html at 600x590; no user browser profile or external extensions were touched.',
    'Native toolbar action opening and closing is reported separately from the HTML page interactions.',
    'Real native forest and Elysia action views must reach at least 580x560 in this normal-size browser; viewport lower bounds and visible first-row/search geometry prevent collapsed-window tests from passing on DOM existence alone.',
    'The original reported Edge auto-sizing collapse is not claimed as reproduced when this isolated headless Chromium already reports a full-size action view; native API checks and the sizing regression assertions are reported separately from that platform-specific observation.',
    'The 48x50 bootstrap check uses a regular extension HTML page to assert a fixed preferred-size body and a responsive inner root; it is a direct regression test for the sizing dependency, not a claimed reproduction of Edge window creation.',
    'Operating-system mouse focus loss and branded Chrome/Edge behavior are not claimed as manually tested.',
  ];
  console.log(`Completed ${checks.length} popup integration checks.`);
} catch (error) {
  report.passed = false;
  report.failure = error instanceof Error ? error.stack : String(error);
  console.error(report.failure);
  if (currentPage && !currentPage.isClosed())
    await screenshot(currentPage, 'popup-failure.png').catch(() => {});
  process.exitCode = 1;
} finally {
  await context?.close().catch(() => {});
  if (server) await new Promise((resolve) => server.close(resolve));
  if (profile) {
    const relative = path.relative(artifacts, path.resolve(profile));
    if (relative && !relative.startsWith('..') && !path.isAbsolute(relative))
      await rm(profile, { force: true, recursive: true }).catch(() => {});
  }
  await mkdir(artifacts, { recursive: true });
  await writeFile(path.join(artifacts, 'popup-e2e-report.json'), JSON.stringify(report, null, 2));
}
