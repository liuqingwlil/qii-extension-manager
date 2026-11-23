import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, expect as playwrightExpect } from '@playwright/test';

const expect = playwrightExpect.configure({ timeout: 12_000 });
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'dist');
const output = path.join(root, 'test-results');
const fixturePath = path.join(root, 'tests', 'fixtures', 'test-extension');
const extraFixturePath = path.join(root, 'tests', 'fixtures', 'restore-extra');
const fixtureName = 'Qii Test Fixture';
const extraFixtureName = 'Qii Restore Extra Fixture';
const checks = [];
const errors = [];
const report = {
  mode: 'Isolated real MV3 manager and two native toggle fixtures; 36 synthetic inventory rows are appended only in this test renderer to measure a realistically scrollable list',
  brandedChromeOrEdgeTested: false,
  checks,
  layouts: [],
};
let context;
let profile;
let page;
let controller;
let fixtureId;
let extraFixtureId;

async function check(name, run) {
  await run();
  checks.push({ name, passed: true });
  console.log(`PASS ${name}`);
}
function fixture(name = fixtureName) {
  return page.getByRole('article').filter({
    has: page.getByRole('button', { name: `查看 ${name} 详情`, exact: true }),
  });
}
async function screenshot(name) {
  await page.screenshot({ path: path.join(output, name), fullPage: false, animations: 'disabled' });
}
async function measure(label) {
  const result = await page.evaluate(() => {
    const rect = (element) => {
      const r = element.getBoundingClientRect();
      return { x: r.x, y: r.y, width: r.width, height: r.height, right: r.right, bottom: r.bottom };
    };
    const list = document.querySelector('.extension-list');
    const clip = list.getBoundingClientRect();
    const cards = [...list.querySelectorAll('article')].map(rect);
    return {
      viewport: { width: innerWidth, height: innerHeight },
      shell: rect(document.querySelector('.popup-shell')),
      root: rect(document.querySelector('#root')),
      header: rect(document.querySelector('.popup-header')),
      list: rect(list),
      footer: rect(document.querySelector('.popup-footer')),
      listHorizontalOverflow: list.scrollWidth - list.clientWidth,
      outerOverflowHidden: [document.documentElement, document.body].every(
        (element) => getComputedStyle(element).overflow === 'hidden',
      ),
      scrollTop: list.scrollTop,
      completeCards: cards.filter((r) => r.y >= clip.y - 0.5 && r.bottom <= clip.bottom + 0.5)
        .length,
      cards,
      documentOverflow: {
        x: document.documentElement.scrollWidth - innerWidth,
        y: document.documentElement.scrollHeight - innerHeight,
      },
      portrait: (() => {
        const element = document.querySelector('.elysia-portrait');
        return element
          ? { ...rect(element), decoded: element.complete && element.naturalWidth > 0 }
          : null;
      })(),
    };
  });
  assert.ok(
    result.shell.width <= result.viewport.width && result.shell.height <= result.viewport.height,
  );
  // The body deliberately requests a fixed intrinsic native-popup size. When the browser
  // clamps its viewport, all interactive surfaces must fit and outer scrollbars stay hidden.
  for (const surface of [result.root, result.header, result.list, result.footer]) {
    assert.ok(
      surface.x >= 0 &&
        surface.y >= 0 &&
        surface.right <= result.viewport.width + 0.5 &&
        surface.bottom <= result.viewport.height + 0.5,
      'visible interactive surfaces must fit the actual viewport',
    );
  }
  assert.ok(result.outerOverflowHidden, 'only inner content should scroll');
  assert.ok(result.listHorizontalOverflow <= 0, 'the working list must not overflow horizontally');
  assert.ok(result.list.height > 180, 'working list must retain useful space');
  report.layouts.push({ label, ...result });
  return result;
}
async function scrollFixtureToMiddle() {
  await fixture().evaluate((element) => {
    const list = element.closest('.extension-list');
    const a = element.getBoundingClientRect();
    const b = list.getBoundingClientRect();
    list.scrollTop += a.y - b.y - (b.height - a.height) / 2;
  });
  await expect(fixture().getByRole('switch')).toBeInViewport();
}
async function beginStabilityProbe() {
  await fixture().evaluate((card) => {
    const list = card.closest('.extension-list');
    const control = card.querySelector('[role="switch"]');
    const icon = card.querySelector('.extension-icon');
    const image = icon.querySelector('img');
    const state = {
      card,
      list,
      control,
      icon,
      image,
      frames: [],
      removed: 0,
      started: performance.now(),
    };
    const read = () => {
      const r = card.getBoundingClientRect();
      const s = control.getBoundingClientRect();
      const liveCard = [...document.querySelectorAll('article')].find(
        (element) =>
          element.querySelector('button[title="扩展详情"]')?.getAttribute('aria-label') ===
          '查看 Qii Test Fixture 详情',
      );
      state.frames.push({
        t: performance.now() - state.started,
        scrollTop: list.scrollTop,
        listTop: list.getBoundingClientRect().y,
        listHeight: list.getBoundingClientRect().height,
        y: r.y,
        height: r.height,
        switchY: s.y,
        switchHeight: s.height,
        sameCard: liveCard === card && card.isConnected,
        sameIcon: card.querySelector('.extension-icon') === icon,
        sameImage: icon.querySelector('img') === image,
        imageDecoded: !image || (image.complete && image.naturalWidth > 0),
      });
    };
    state.observer = new MutationObserver((records) => {
      for (const record of records)
        for (const node of record.removedNodes)
          if (node === card || (node.nodeType === 1 && node.contains(card))) state.removed++;
    });
    state.observer.observe(list, { childList: true, subtree: true });
    read();
    state.timer = setInterval(read, 16);
    window.__popupStabilityProbe = state;
  });
}
async function finishStabilityProbe(label) {
  const probe = await page.evaluate(() => {
    const state = window.__popupStabilityProbe;
    clearInterval(state.timer);
    state.observer.disconnect();
    return { frames: state.frames, removed: state.removed };
  });
  assert.ok(probe.frames.length >= 12, 'probe must include pending and settled frames');
  assert.equal(probe.removed, 0, 'toggle must not unmount the card');
  const first = probe.frames[0];
  for (const key of [
    'scrollTop',
    'listTop',
    'listHeight',
    'y',
    'height',
    'switchY',
    'switchHeight',
  ]) {
    const delta = Math.max(...probe.frames.map((frame) => Math.abs(frame[key] - first[key])));
    assert.ok(delta <= 1, `${label}: ${key} moved by ${delta}px`);
  }
  assert.ok(
    probe.frames.every(
      (frame) => frame.sameCard && frame.sameIcon && frame.sameImage && frame.imageDecoded,
    ),
    'card/icon/image identity and decoded state must survive refreshes',
  );
  report[label] = probe;
}
async function actualEnabled(id = fixtureId) {
  return controller.evaluate(async (target) => (await chrome.management.get(target)).enabled, id);
}

try {
  assert.ok(existsSync(path.join(dist, 'manifest.json')), 'Run npm run build before this test.');
  await mkdir(output, { recursive: true });
  profile = await mkdtemp(path.join(output, 'stability-profile-'));
  context = await chromium.launchPersistentContext(profile, {
    channel: 'chromium',
    headless: true,
    locale: 'zh-CN',
    viewport: { width: 600, height: 590 },
    args: [
      `--disable-extensions-except=${dist},${fixturePath},${extraFixturePath}`,
      `--load-extension=${dist},${fixturePath},${extraFixturePath}`,
    ],
  });
  context.setDefaultTimeout(12_000);
  context.on('page', (view) => view.on('pageerror', (error) => errors.push(error.message)));
  let worker = context.serviceWorkers().find((view) => view.url().endsWith('/background.js'));
  if (!worker)
    worker = await context.waitForEvent('serviceworker', {
      predicate: (view) => view.url().endsWith('/background.js'),
    });
  const base = `chrome-extension://${new URL(worker.url()).hostname}`;
  report.browserVersion = context.browser()?.version();
  controller = await context.newPage();
  await controller.goto(`${base}/index.html`);
  await expect(controller.getByRole('article').filter({ hasText: fixtureName })).toBeVisible();
  fixtureId = await controller.evaluate(
    async (name) => (await chrome.management.getAll()).find((item) => item.name === name).id,
    fixtureName,
  );
  extraFixtureId = await controller.evaluate(
    async (name) => (await chrome.management.getAll()).find((item) => item.name === name).id,
    extraFixtureName,
  );
  await controller.evaluate(async () => {
    const saved = (await chrome.storage.local.get('qii.data.v1'))['qii.data.v1'] ?? {
      schemaVersion: 1,
      groups: [],
      scenes: [],
      meta: {},
      activity: [],
      settings: { view: 'grid', confirmBulk: true },
    };
    saved.settings = {
      ...saved.settings,
      skin: 'elysia',
      theme: 'light',
      sort: 'name',
      popupView: 'grid',
      popupDensity: 'comfortable',
    };
    await chrome.storage.local.set({ 'qii.data.v1': saved });
  });
  page = await context.newPage();
  await page.addInitScript(
    ({ fixtureId, extraFixtureId }) => {
      const nativeGetAll = chrome.management.getAll.bind(chrome.management);
      const nativeSetEnabled = chrome.management.setEnabled.bind(chrome.management);
      window.__popupStability = {
        delay: 0,
        reject: false,
        nativeCalls: 0,
        getAllCalls: 0,
        getAllDelayOnce: 0,
        delayedSnapshot: null,
      };
      chrome.management.getAll = async () => {
        const rows = await nativeGetAll();
        const state = window.__popupStability;
        state.getAllCalls++;
        const delay = state.getAllDelayOnce;
        if (delay) {
          state.getAllDelayOnce = 0;
          state.delayedSnapshot = {
            target: rows.find((entry) => entry.id === fixtureId).enabled,
            returned: false,
          };
          await new Promise((resolve) => setTimeout(resolve, delay));
          state.delayedSnapshot.returned = true;
        }
        const source = rows.find((entry) => entry.id === fixtureId);
        const icon = [{ size: 48, url: chrome.runtime.getURL('icons/icon48.png') }];
        return [
          ...rows.map((entry) => (entry.id === fixtureId ? { ...entry, icons: icon } : entry)),
          ...Array.from({ length: 36 }, (_, index) => ({
            ...source,
            id: `stability-synthetic-${index}`,
            name: `${index < 18 ? 'A' : 'Z'}${String(index + 1).padStart(2, '0')} · 扩展清单布局示例`,
            description:
              'Synthetic renderer-only entry; no browser extension is installed or toggled for this row.',
            icons: icon,
          })),
        ];
      };
      chrome.management.setEnabled = (id, target) => {
        if (![fixtureId, extraFixtureId].includes(id))
          throw new Error('This stability test only permits its disposable native fixture.');
        const { delay, reject } = window.__popupStability;
        if (reject) return Promise.reject(new Error('Stability test: native toggle rejected'));
        window.__popupStability.nativeCalls++;
        // Invoke the real API synchronously so enabling retains the original user gesture.
        const pending = nativeSetEnabled(id, target);
        return pending.then(async () => {
          if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
        });
      };
    },
    { fixtureId, extraFixtureId },
  );
  await page.goto(`${base}/popup.html`);
  await expect(fixture()).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('data-skin', 'elysia');

  await check(
    'default Elysia layout fits at least 15 complete cards without covering controls',
    async () => {
      const layout = await measure('600x590 Elysia comfortable');
      assert.ok(layout.completeCards >= 15, `only ${layout.completeCards} complete cards`);
      assert.ok(
        layout.portrait?.decoded && layout.portrait.width > 100,
        'recognizable local character art must remain',
      );
      await screenshot('stability-default.png');
    },
  );

  await check('compact density fits at least 24 complete cards', async () => {
    await page.getByRole('button', { name: '紧凑密度', exact: true }).click();
    await expect(page.getByRole('button', { name: '紧凑密度', exact: true })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    const layout = await measure('600x590 Elysia compact');
    assert.ok(layout.completeCards >= 24, `only ${layout.completeCards} complete cards`);
    await screenshot('stability-compact.png');
  });

  await check('header folding increases list space and survives a popup reload', async () => {
    const before = await measure('600x590 compact before fold');
    const collapse = page.locator('.header-collapse-button');
    await collapse.click();
    await expect(collapse).toHaveAttribute('aria-expanded', 'false');
    const folded = await measure('600x590 compact folded');
    assert.ok(
      folded.list.height >= before.list.height + 25,
      'fold must meaningfully expand the list',
    );
    assert.ok(folded.completeCards >= before.completeCards, 'fold must not reduce visible cards');
    await screenshot('stability-collapsed.png');
    await page.reload();
    await expect(page.locator('.header-collapse-button')).toHaveAttribute('aria-expanded', 'false');
    await page.locator('.header-collapse-button').click();
    await expect(page.locator('.header-collapse-button')).toHaveAttribute('aria-expanded', 'true');
  });

  await check(
    'pending native toggle preserves scroll position, card geometry and decoded image nodes',
    async () => {
      // Use comfortable grid to cover the original, larger switch/card rendering too.
      const density = page.getByRole('button', { name: '紧凑密度', exact: true });
      if ((await density.getAttribute('aria-pressed')) === 'true') await density.click();
      await scrollFixtureToMiddle();
      await expect(fixture().locator('img')).toBeVisible();
      await expect
        .poll(() =>
          fixture()
            .locator('img')
            .evaluate((image) => image.complete && image.naturalWidth > 0),
        )
        .toBe(true);
      const before = await actualEnabled();
      await page.evaluate(() => {
        window.__popupStability.delay = 650;
      });
      await beginStabilityProbe();
      await fixture().getByRole('switch').click();
      await expect(fixture().getByRole('switch')).toBeDisabled();
      await expect.poll(actualEnabled).toBe(!before);
      await expect(fixture().getByRole('switch')).toBeEnabled();
      await page.waitForTimeout(200);
      await finishStabilityProbe('pendingToggle');
      await expect(fixture().getByRole('switch')).toHaveAttribute('aria-checked', String(!before));
      await screenshot('stability-toggle.png');
    },
  );

  await check(
    'success feedback stays in the footer without resizing the list and disappears automatically',
    async () => {
      const status = page.locator('.footer-notice[role="status"]');
      await expect(status).toBeVisible();
      assert.equal(
        await status.evaluate((element) => !!element.closest('.popup-footer')),
        true,
        'success feedback must stay in the already reserved footer',
      );
      await beginStabilityProbe();
      await expect(status).toHaveCount(0, { timeout: 7000 });
      await finishStabilityProbe('feedbackDismiss');
      await fixture().getByRole('switch').click();
      await expect(fixture().getByRole('switch')).toBeDisabled();
      await expect(fixture().getByRole('switch')).toBeEnabled();
      await expect(status).toBeVisible();
      await expect(status).toHaveCount(0, { timeout: 7000 });
    },
  );

  await check('native failure is visible without moving or unmounting the list', async () => {
    const before = await actualEnabled();
    await page.evaluate(() => {
      window.__popupStability.reject = true;
    });
    await beginStabilityProbe();
    await fixture().getByRole('switch').click();
    await expect(page.getByRole('alert')).toContainText('Stability test: native toggle rejected');
    await expect(fixture().getByRole('switch')).toBeEnabled();
    await page.waitForTimeout(250);
    await finishStabilityProbe('failedToggle');
    assert.equal(await actualEnabled(), before);
    await expect(fixture().getByRole('switch')).toHaveAttribute('aria-checked', String(before));
    await page.getByRole('button', { name: '关闭错误', exact: true }).click();
    await page.evaluate(() => {
      window.__popupStability.reject = false;
    });
  });

  await check(
    'an older delayed inventory snapshot never rolls back a completed toggle',
    async () => {
      const before = await actualEnabled();
      const otherBefore = await actualEnabled(extraFixtureId);
      await page.evaluate(() => {
        window.__popupStability.getAllDelayOnce = 1000;
        window.__popupStability.delayedSnapshot = null;
      });
      await controller.evaluate(
        async ({ id, target }) => chrome.management.setEnabled(id, target),
        { id: extraFixtureId, target: !otherBefore },
      );
      await expect
        .poll(() => page.evaluate(() => window.__popupStability.delayedSnapshot?.target))
        .toBe(before);
      await fixture()
        .getByRole('switch')
        .evaluate((button) => {
          window.__staleStateFrames = [];
          window.__staleStateTimer = setInterval(
            () => window.__staleStateFrames.push(button.getAttribute('aria-checked')),
            16,
          );
        });
      await fixture().getByRole('switch').click();
      await expect(fixture().getByRole('switch')).toBeDisabled();
      await expect(fixture().getByRole('switch')).toBeEnabled();
      await expect(fixture().getByRole('switch')).toHaveAttribute('aria-checked', String(!before));
      await expect
        .poll(() => page.evaluate(() => window.__popupStability.delayedSnapshot.returned))
        .toBe(true);
      await page.waitForTimeout(180);
      const frames = await page.evaluate(() => {
        clearInterval(window.__staleStateTimer);
        return window.__staleStateFrames;
      });
      const changed = frames.indexOf(String(!before));
      assert.ok(
        changed >= 0 && frames.slice(changed).every((value) => value === String(!before)),
        'stale getAll must never repaint the previous switch state',
      );
      assert.equal(await actualEnabled(), !before);
      report.staleSnapshot = { before, target: !before, frames };
    },
  );

  await check(
    'two simultaneous native toggles settle independently without redundant inventory reloads',
    async () => {
      const primary = fixture().getByRole('switch');
      const secondary = fixture(extraFixtureName).getByRole('switch');
      await scrollFixtureToMiddle();
      const before = [await actualEnabled(), await actualEnabled(extraFixtureId)];
      const callsBefore = await page.evaluate(() => ({
        native: window.__popupStability.nativeCalls,
        inventory: window.__popupStability.getAllCalls,
      }));
      await primary.click();
      await secondary.click();
      await expect(primary).toBeDisabled();
      await expect(secondary).toBeDisabled();
      await page.waitForTimeout(180);
      assert.equal(
        await page.evaluate(() => window.__popupStability.getAllCalls),
        callsBefore.inventory,
        'management and activity events must defer inventory reads while local toggles are pending',
      );
      await expect(primary).toBeEnabled();
      await expect(secondary).toBeEnabled();
      await expect(primary).toHaveAttribute('aria-checked', String(!before[0]));
      await expect(secondary).toHaveAttribute('aria-checked', String(!before[1]));
      assert.equal(await actualEnabled(), !before[0]);
      assert.equal(await actualEnabled(extraFixtureId), !before[1]);
      assert.equal(
        await page.evaluate(() => window.__popupStability.nativeCalls),
        callsBefore.native + 2,
      );
    },
  );

  await check(
    'dark and narrow layouts keep the list, switches and close controls usable',
    async () => {
      await page.getByRole('tab', { name: /^工具$/ }).click();
      await page.getByRole('button', { name: '深色', exact: true }).click();
      await page.getByRole('tab', { name: /^扩展(?:\s*\d+)?$/ }).click();
      for (const viewport of [
        { width: 466, height: 510 },
        { width: 420, height: 480 },
      ]) {
        await page.setViewportSize(viewport);
        await page.locator('.extension-list').evaluate((element) => element.scrollTo(0, 0));
        await measure(`${viewport.width}x${viewport.height} dark`);
        await expect(
          page.getByRole('button', { name: '关闭扩展面板', exact: true }),
        ).toBeInViewport();
        await expect(page.getByRole('article').getByRole('switch').first()).toBeInViewport();
      }
      await screenshot('stability-narrow.png');
      await page.setViewportSize({ width: 600, height: 590 });
      await page.getByRole('tab', { name: /^工具$/ }).click();
      await page.getByRole('radio', { name: '森林序曲', exact: true }).click();
      await page.getByRole('tab', { name: /^扩展(?:\s*\d+)?$/ }).click();
      const forest = await measure('600x590 forest comfortable');
      assert.ok(forest.completeCards >= 15);
      assert.deepEqual(errors, []);
    },
  );

  report.passed = true;
  report.nativeFixtureCalls = await page.evaluate(() => window.__popupStability.nativeCalls);
  console.log(`Completed ${checks.length} popup stability checks.`);
} catch (error) {
  report.passed = false;
  report.failure = error instanceof Error ? error.stack : String(error);
  console.error(report.failure);
  if (page && !page.isClosed()) await screenshot('stability-failure.png').catch(() => {});
  process.exitCode = 1;
} finally {
  await context?.close().catch(() => {});
  if (profile) {
    const relative = path.relative(output, path.resolve(profile));
    assert.ok(
      relative && !relative.startsWith('..') && !path.isAbsolute(relative),
      'temporary profile must remain inside test-results',
    );
    await rm(profile, { recursive: true, force: true }).catch(() => {});
  }
  await mkdir(output, { recursive: true });
  await writeFile(
    path.join(output, 'popup-stability-report.json'),
    JSON.stringify(report, null, 2),
  );
}
