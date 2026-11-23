import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, expect as playwrightExpect } from '@playwright/test';

const expect = playwrightExpect.configure({ timeout: 12_000 });
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'dist');
const output = path.join(root, 'test-results');
const checks = [];
const errors = [];
const remoteRequests = [];
const assetResponses = [];
const report = {
  mode: 'Local HTTP demonstration in a fresh Chromium context; native APIs remain covered by existing MV3 integration tests',
  brandedChromeOrEdgeTested: false,
  checks,
  layouts: [],
};
let browser;
let context;
let server;
let origin;
let page;

async function check(name, run) {
  await run();
  checks.push({ name, passed: true });
  console.log(`PASS ${name}`);
}
function tile(name) {
  return page
    .getByRole('article')
    .filter({ has: page.getByRole('button', { name: `查看 ${name} 详情`, exact: true }) });
}
async function tab(name) {
  await page.getByRole('tab', { name: new RegExp(`^${name}(?:\\s*\\d+)?$`) }).click();
}
async function screenshot(name) {
  await page.screenshot({ path: path.join(output, name), fullPage: false, animations: 'disabled' });
}
function intersects(a, b) {
  return (
    Math.max(0, Math.min(a.right, b.right) - Math.max(a.x, b.x)) *
    Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.y, b.y))
  );
}
function alpha(color) {
  if (color.startsWith('rgba(')) return Number(color.slice(5, -1).split(',')[3]);
  const slash = color.match(/\/\s*([\d.]+)/);
  return slash ? Number(slash[1]) : 1;
}

async function measureArtwork(label) {
  await expect(page.locator('.elysia-header-art')).toBeVisible();
  const measurement = await page.evaluate(() => {
    const rect = (element) => {
      const r = element.getBoundingClientRect();
      return { x: r.x, y: r.y, width: r.width, height: r.height, right: r.right, bottom: r.bottom };
    };
    const header = document.querySelector('.popup-header');
    const art = document.querySelector('.elysia-header-art');
    const portrait = document.querySelector('.elysia-portrait');
    const ambient = document.querySelector('.elysia-ambient');
    const base = document.querySelector('.popup-base');
    const headerStyle = getComputedStyle(header);
    const decorative = [art, ambient, document.querySelector('.elysia-header-caption')];
    return {
      viewport: { width: innerWidth, height: innerHeight },
      shell: rect(document.querySelector('.popup-shell')),
      header: rect(header),
      art: rect(art),
      portrait: rect(portrait),
      close: rect(document.querySelector('button[aria-label="关闭扩展面板"]')),
      overflow: { x: headerStyle.overflowX, y: headerStyle.overflowY },
      artIsInsideHeader: header.contains(art),
      clearRegions: ['.main-tabs', '.search-wrap', '.extension-list'].flatMap((selector) => {
        const element = document.querySelector(selector);
        return element ? [{ selector, ...rect(element) }] : [];
      }),
      layers: { base: getComputedStyle(base).zIndex, ambient: getComputedStyle(ambient).zIndex },
      decorative: decorative.map((element) => ({
        className: element.className,
        ariaHidden: element.getAttribute('aria-hidden'),
        pointerEvents: [element, ...element.querySelectorAll('*')].map(
          (child) => getComputedStyle(child).pointerEvents,
        ),
        focusableCount: element.querySelectorAll(
          'a[href],button,input,select,textarea,[tabindex]:not([tabindex="-1"])',
        ).length,
      })),
      cards: [...document.querySelectorAll('.extension-tile')].map((element) => {
        const s = getComputedStyle(element);
        return { background: s.backgroundColor, opacity: s.opacity };
      }),
      motifBackgrounds: [
        getComputedStyle(ambient).backgroundImage,
        getComputedStyle(ambient, '::before').backgroundImage,
        getComputedStyle(ambient, '::after').backgroundImage,
      ],
    };
  });
  assert.ok(
    measurement.shell.width <= measurement.viewport.width &&
      measurement.shell.height <= measurement.viewport.height,
    'popup shell must fit its viewport',
  );
  assert.ok(
    measurement.portrait.width > 100 && measurement.portrait.height > 100,
    'portrait must be materially larger than an avatar',
  );
  assert.ok(measurement.artIsInsideHeader);
  assert.ok(
    ['hidden', 'clip'].includes(measurement.overflow.x) &&
      ['hidden', 'clip'].includes(measurement.overflow.y),
    'header must clip illustration paint',
  );
  const visibleWidth =
    Math.min(measurement.portrait.right, measurement.header.right) -
    Math.max(measurement.portrait.x, measurement.header.x);
  const visibleHeight =
    Math.min(measurement.portrait.bottom, measurement.header.bottom) -
    Math.max(measurement.portrait.y, measurement.header.y);
  assert.ok(
    visibleWidth > 100 && visibleHeight >= 60,
    'a recognizably sized portrait must remain inside the clipped header',
  );
  for (const region of measurement.clearRegions)
    assert.ok(
      intersects(measurement.header, region) <= 0.5,
      `header paint region overlaps ${region.selector}`,
    );
  assert.ok(
    measurement.close.x >= 0 &&
      measurement.close.y >= 0 &&
      measurement.close.right <= measurement.viewport.width &&
      measurement.close.bottom <= measurement.header.bottom,
    'close control must stay in the visible header',
  );
  assert.ok(
    Number(measurement.layers.base) > Number(measurement.layers.ambient),
    'interactive base must be a higher layer than ambient decoration',
  );
  for (const decorative of measurement.decorative) {
    assert.equal(decorative.ariaHidden, 'true');
    assert.ok(
      decorative.pointerEvents.every((value) => value === 'none'),
      `decoration must not catch pointer input: ${decorative.className}`,
    );
    assert.equal(decorative.focusableCount, 0, 'decoration must not create tab stops');
  }
  for (const card of measurement.cards) {
    assert.equal(alpha(card.background), 1, 'extension cards must have opaque backgrounds');
    assert.equal(Number(card.opacity), 1, 'the entire extension card must not be translucent');
  }
  report.layouts.push({ label, ...measurement });
  return measurement;
}

async function assertForegroundControl(locator, label) {
  await locator.scrollIntoViewIfNeeded();
  const hit = await locator.evaluate((element) => {
    const r = element.getBoundingClientRect();
    const x = r.x + r.width / 2,
      y = r.y + r.height / 2;
    const hits = document.elementsFromPoint(x, y);
    const receiver = element.closest('button,[role="switch"],a,input') || element;
    return {
      x,
      y,
      targetReceivesInput: !!hits[0] && (receiver === hits[0] || receiver.contains(hits[0])),
      decorativeHit: hits.some((hit) =>
        hit.closest('.elysia-header-art,.elysia-ambient,.elysia-header-caption'),
      ),
      firstTag: hits[0]?.tagName,
    };
  });
  assert.equal(hit.decorativeHit, false, `${label} must not hit artwork`);
  assert.equal(
    hit.targetReceivesInput,
    true,
    `${label} must remain in the foreground: ${JSON.stringify(hit)}`,
  );
  return hit;
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
    'Build the extension before running the artwork integration checks.',
  );
  await mkdir(output, { recursive: true });
  origin = await startServer();
  browser = await chromium.launch({ channel: 'chromium', headless: true });
  context = await browser.newContext({ viewport: { width: 600, height: 590 }, locale: 'zh-CN' });
  context.setDefaultTimeout(12_000);
  context.on('request', (request) => {
    if (/^https?:/.test(request.url()) && !request.url().startsWith(`${origin}/`))
      remoteRequests.push(request.url());
  });
  context.on('response', (response) => {
    if (response.url().includes('/skins/'))
      assetResponses.push({ url: response.url(), status: response.status() });
  });
  page = await context.newPage();
  page.on('pageerror', (error) => errors.push(error.message));
  report.browserVersion = browser.version();
  await page.goto(`${origin}/popup.html`);
  await expect(tile('uBlock Origin Lite')).toBeVisible();

  await check('forest skin has no Elysia portrait or ambient layers', async () => {
    await expect(
      page.locator('.elysia-header-art,.elysia-ambient,.elysia-header-caption'),
    ).toHaveCount(0);
    await expect(page.getByRole('article')).toHaveCount(16);
  });
  await tab('工具');
  await page.getByRole('radio', { name: '爱莉希雅', exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('data-skin', 'elysia');
  await tab('扩展');

  await check('Elysia portrait is large, decoded and clipped above the working area', async () => {
    const image = page.locator('img.elysia-portrait');
    await expect(image).toBeVisible();
    await expect
      .poll(() => image.evaluate((element) => element.complete && element.naturalWidth > 0))
      .toBe(true);
    report.portrait = await image.evaluate((element) => ({
      src: element.currentSrc,
      width: element.naturalWidth,
      height: element.naturalHeight,
      alt: element.alt,
      draggable: element.draggable,
    }));
    assert.ok(report.portrait.src.startsWith(`${origin}/skins/elysia.png`));
    assert.equal(report.portrait.alt, '');
    assert.equal(report.portrait.draggable, false);
    await measureArtwork('600x590 light grid');
    await screenshot('art-elysia-popup.png');
  });

  await check('extension icon, name, switch and close button remain above decoration', async () => {
    const first = page.getByRole('article').first();
    report.foreground = [
      await assertForegroundControl(first.locator('.extension-icon'), 'extension icon'),
      await assertForegroundControl(first.locator('.tile-name'), 'extension name'),
      await assertForegroundControl(first.getByRole('switch'), 'extension switch'),
      await assertForegroundControl(
        page.getByRole('button', { name: '关闭扩展面板', exact: true }),
        'close control',
      ),
    ];
    await page.getByRole('searchbox', { name: '搜索扩展', exact: true }).focus();
    for (let step = 0; step < 14; step++) {
      await page.keyboard.press('Tab');
      assert.equal(
        await page.evaluate(
          () =>
            !!document.activeElement.closest(
              '.elysia-header-art,.elysia-ambient,.elysia-header-caption',
            ),
        ),
        false,
      );
    }
  });

  await check(
    'list and compact layouts preserve opaque cards and a separate illustration area',
    async () => {
      await page.getByRole('button', { name: '列表视图', exact: true }).click();
      await expect(page.getByRole('button', { name: '列表视图', exact: true })).toHaveAttribute(
        'aria-pressed',
        'true',
      );
      await measureArtwork('600x590 light list');
      await screenshot('art-elysia-list.png');
      await page.getByRole('button', { name: '图标视图', exact: true }).click();
      await page.getByRole('button', { name: '紧凑密度', exact: true }).click();
      await expect(page.getByRole('button', { name: '紧凑密度', exact: true })).toHaveAttribute(
        'aria-pressed',
        'true',
      );
      await measureArtwork('600x590 light compact');
      await screenshot('art-elysia-compact.png');
    },
  );

  await check(
    'first and last scrollable extensions can still be toggled and restored',
    async () => {
      const switches = page.getByRole('article').getByRole('switch');
      for (const [position, control] of [
        ['first', switches.first()],
        ['last', switches.last()],
      ]) {
        await assertForegroundControl(control, `${position} extension switch`);
        const initial = await control.getAttribute('aria-checked');
        await control.click();
        await expect(control).toHaveAttribute(
          'aria-checked',
          initial === 'true' ? 'false' : 'true',
        );
        await control.click();
        await expect(control).toHaveAttribute('aria-checked', initial);
      }
      const scroll = await page.locator('.extension-list').evaluate((element) => ({
        top: element.scrollTop,
        height: element.clientHeight,
        content: element.scrollHeight,
      }));
      if (scroll.content > scroll.height + 1)
        assert.ok(
          scroll.top > 0,
          'overflowing last extension should be reached through the inner scroller',
        );
      else
        assert.equal(
          scroll.top,
          0,
          'a fully visible dense list should need no artificial scrolling',
        );
      await page.locator('.extension-list').evaluate((element) => element.scrollTo(0, 0));
    },
  );

  await check(
    'tool, scene and detail surfaces remain interactive below the illustration',
    async () => {
      await tab('工具');
      await expect(page.getByRole('radiogroup', { name: '界面皮肤', exact: true })).toBeVisible();
      await measureArtwork('600x590 tools');
      await tab('场景');
      await expect(page.getByRole('button', { name: '新建场景', exact: true })).toBeVisible();
      await measureArtwork('600x590 scenes');
      await tab('扩展');
      await page.getByRole('button', { name: '查看 沉浸式翻译 详情', exact: true }).click();
      const dialog = page.getByRole('dialog', { name: '沉浸式翻译', exact: true });
      await expect(dialog).toBeVisible();
      await assertForegroundControl(
        dialog.getByRole('button', { name: '关闭对话框', exact: true }),
        'detail dialog close',
      );
      const rect = await dialog.boundingBox();
      assert.ok(
        rect.x >= 0 && rect.y >= 0 && rect.x + rect.width <= 600 && rect.y + rect.height <= 590,
      );
      await page.keyboard.press('Escape');
      await expect(page.getByRole('dialog')).toHaveCount(0);
    },
  );

  await check(
    'dark mode and narrow viewports keep artwork clipped and controls reachable',
    async () => {
      await tab('工具');
      await page.getByRole('button', { name: '深色', exact: true }).click();
      await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
      await tab('扩展');
      await measureArtwork('600x590 dark compact');
      await screenshot('art-elysia-dark.png');
      for (const viewport of [
        { width: 466, height: 510 },
        { width: 420, height: 480 },
      ]) {
        await page.setViewportSize(viewport);
        await measureArtwork(`${viewport.width}x${viewport.height} dark compact`);
        await assertForegroundControl(
          page.getByRole('button', { name: '关闭扩展面板', exact: true }),
          'narrow close control',
        );
        await assertForegroundControl(
          page.getByRole('article').first().getByRole('switch'),
          'narrow first switch',
        );
        if (viewport.width === 420) await screenshot('art-elysia-narrow.png');
      }
    },
  );

  await check(
    'local SVG motifs and PNG assets load without remote requests or exceptions',
    async () => {
      const motifSources = report.layouts
        .flatMap((layout) => layout.motifBackgrounds)
        .filter((value) => value !== 'none');
      assert.ok(
        motifSources.some((value) => /\.svg|data:image\/svg\+xml/i.test(value)),
        'ambient decoration should use a local or embedded SVG motif',
      );
      assert.ok(assetResponses.some((asset) => asset.url.endsWith('/skins/elysia.png')));
      assert.ok(assetResponses.every((asset) => asset.status >= 200 && asset.status < 400));
      assert.deepEqual(remoteRequests, []);
      assert.deepEqual(errors, []);
      report.assets = assetResponses;
      await tab('工具');
      await page.getByRole('radio', { name: '森林序曲', exact: true }).click();
      await expect(page.locator('html')).toHaveAttribute('data-skin', 'forest');
      await expect(
        page.locator('.elysia-header-art,.elysia-ambient,.elysia-header-caption'),
      ).toHaveCount(0);
    },
  );

  report.passed = true;
  console.log(`Completed ${checks.length} skin artwork integration checks.`);
} catch (error) {
  report.passed = false;
  report.failure = error instanceof Error ? error.stack : String(error);
  console.error(report.failure);
  if (page && !page.isClosed()) await screenshot('art-failure.png').catch(() => {});
  process.exitCode = 1;
} finally {
  await context?.close().catch(() => {});
  await browser?.close().catch(() => {});
  if (server) await new Promise((resolve) => server.close(resolve));
  await mkdir(output, { recursive: true });
  await writeFile(path.join(output, 'skin-art-e2e-report.json'), JSON.stringify(report, null, 2));
}
