/**
 * Full-app light/dark/system modes and custom wallpaper.
 *
 * The cases drive the real renderer, preload bridge, main-process services and
 * the preview iframe. Only the two native dialogs are stubbed (open for the
 * wallpaper file, save for the export destination), exactly like the existing
 * theme/export case. Screenshots `theme-light.png`, `theme-dark.png` and
 * `theme-wallpaper.png` are written into the case result directory.
 */

import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import {
  executeCase,
  waitFor,
  waitForFileContains,
  type CaseContext,
} from './support/harness';
import { openMarkdownFile, previewFrame, setThemeSelect } from './support/app-ui';
import { wallpaperPng } from './support/wallpaper-png';

const HOME_NOTES = '首页.md';
const LIGHT_PANEL = 'rgb(255, 255, 255)';
const DARK_PANEL = 'rgb(32, 33, 38)';

interface ShellThemeSnapshot {
  dataTheme: string | null;
  rootTheme: string | null;
  colorScheme: string;
  panelBackground: string;
  appBackground: string;
}

function shellTheme(page: Page): Promise<ShellThemeSnapshot> {
  return page.evaluate(() => {
    const app = document.getElementById('app');
    const topbar = document.querySelector('.topbar');
    if (app === null || topbar === null) throw new Error('shell is not mounted');
    const root = document.documentElement;
    return {
      dataTheme: app.getAttribute('data-theme'),
      rootTheme: root.getAttribute('data-theme'),
      colorScheme: getComputedStyle(root).colorScheme,
      panelBackground: getComputedStyle(topbar).backgroundColor,
      appBackground: getComputedStyle(app).backgroundColor,
    };
  });
}

function wallpaperVariables(page: Page): Promise<Record<string, string>> {
  return page.evaluate(() => {
    const app = document.getElementById('app');
    if (app === null) throw new Error('shell is not mounted');
    const style = getComputedStyle(app);
    const before = getComputedStyle(app, '::before');
    return {
      image: style.getPropertyValue('--wallpaper-image').trim(),
      opacity: style.getPropertyValue('--wallpaper-opacity').trim(),
      blur: style.getPropertyValue('--wallpaper-blur').trim(),
      size: style.getPropertyValue('--wallpaper-size').trim(),
      position: style.getPropertyValue('--wallpaper-position').trim(),
      layerImage: before.backgroundImage,
      layerOpacity: before.opacity,
      layerFilter: before.filter,
      hasWallpaperClass: app.classList.contains('has-wallpaper'),
    };
  });
}

function frameWallpaperVariables(page: Page): Promise<Record<string, string>> {
  return previewFrame(page)
    .locator('html')
    .evaluate((element) => {
      const style = getComputedStyle(element);
      const shell = element.querySelector('.mdl-shell');
      const layer = shell === null ? null : getComputedStyle(shell, '::before');
      return {
        image: style.getPropertyValue('--mdl-wallpaper-image').trim(),
        opacity: style.getPropertyValue('--mdl-wallpaper-opacity').trim(),
        blur: style.getPropertyValue('--mdl-wallpaper-blur').trim(),
        size: style.getPropertyValue('--mdl-wallpaper-size').trim(),
        position: style.getPropertyValue('--mdl-wallpaper-position').trim(),
        layerImage: layer === null ? '' : layer.backgroundImage,
      };
    });
}

async function captureNamed(context: CaseContext, name: string): Promise<string> {
  const page = context.page;
  if (page === null) throw new Error('application is not running');
  const file = path.join(context.dir, `${name}.png`);
  await page.screenshot({ path: file });
  context.artifacts[name] = file;
  return file;
}

function stateFiles(context: CaseContext): string[] {
  const root = path.join(context.runtimeDir, 'state');
  const found: string[] = [];
  const walk = (dir: string): void => {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const next = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(next);
      else if (entry.name.endsWith('.json')) found.push(next);
    }
  };
  walk(root);
  return found;
}

test('T1 explicit light, dark and system modes on the whole shell', async () => {
  await executeCase('T1-theme-modes', {}, async (context) => {
    await context.launchApp();
    const page = context.page;
    if (page === null) throw new Error('window did not open');

    await openMarkdownFile(page, HOME_NOTES);
    await page.locator('#toggle-theme-panel').click();
    await expect(page.locator('#theme-panel-host')).toBeVisible();

    await context.step('light theme keeps the whole shell light under a dark OS', async () => {
      await page.emulateMedia({ colorScheme: 'dark' });
      await setThemeSelect(page, 'mode', 'light');
      await waitFor(
        async () => (await shellTheme(page)).panelBackground === LIGHT_PANEL,
        10_000,
        100,
        'the shell to switch to the light palette',
      );
      const snapshot = await shellTheme(page);
      expect(snapshot.dataTheme).toBe('light');
      expect(snapshot.rootTheme).toBe('light');
      expect(snapshot.colorScheme).toBe('light');
      expect(snapshot.panelBackground).toBe(LIGHT_PANEL);
      expect(snapshot.appBackground).toBe('rgb(245, 245, 242)');
      expect(await page.evaluate(() => matchMedia('(prefers-color-scheme: dark)').matches)).toBe(true);
      await captureNamed(context, 'theme-light');
    });

    await context.step('dark theme is dark even when the OS asks for light', async () => {
      await page.emulateMedia({ colorScheme: 'light' });
      await setThemeSelect(page, 'mode', 'dark');
      await waitFor(
        async () => (await shellTheme(page)).panelBackground === DARK_PANEL,
        10_000,
        100,
        'the shell to switch to the dark palette',
      );
      const snapshot = await shellTheme(page);
      expect(snapshot.dataTheme).toBe('dark');
      expect(snapshot.colorScheme).toBe('dark');
      expect(snapshot.panelBackground).toBe(DARK_PANEL);
      expect(snapshot.appBackground).toBe('rgb(23, 24, 27)');
      await captureNamed(context, 'theme-dark');
    });

    await context.step('system mode follows the OS preference live', async () => {
      await setThemeSelect(page, 'mode', 'system');
      const snapshot = await shellTheme(page);
      expect(snapshot.dataTheme).toBe('system');
      expect(snapshot.colorScheme).toBe('light dark');

      await page.emulateMedia({ colorScheme: 'dark' });
      await waitFor(
        async () => (await shellTheme(page)).panelBackground === DARK_PANEL,
        10_000,
        100,
        'system mode to follow the dark OS setting',
      );

      await page.emulateMedia({ colorScheme: 'light' });
      await waitFor(
        async () => (await shellTheme(page)).panelBackground === LIGHT_PANEL,
        10_000,
        100,
        'system mode to follow the light OS setting',
      );
    });

    await context.step('the preview frame uses the same mode as the shell', async () => {
      await setThemeSelect(page, 'mode', 'dark');
      await waitFor(
        async () => {
          const background = await previewFrame(page)
            .locator('html')
            .evaluate((element) => getComputedStyle(element).getPropertyValue('--mdl-bg').trim());
          return background.length > 0 && background !== '#ffffff';
        },
        10_000,
        150,
        'the preview palette to follow the theme mode',
      );
      const attributes = await previewFrame(page)
        .locator('html')
        .evaluate((element) => element.getAttribute('data-mdl-mode'));
      expect(attributes).toBe('dark');
    });
  });
});

test('T2 wallpaper import, preview parity, export, clear and restart', async () => {
  await executeCase('T2-theme-wallpaper', {}, async (context) => {
    const wallpaperSource = path.join(mkdtempSync(path.join(context.dir, 'picked-')), 'wallpaper.png');
    writeFileSync(wallpaperSource, wallpaperPng());

    await context.launchApp();
    const page = context.page;
    if (page === null) throw new Error('window did not open');

    await openMarkdownFile(page, HOME_NOTES);
    await page.locator('#toggle-theme-panel').click();
    await expect(page.locator('#theme-panel-host')).toBeVisible();
    await setThemeSelect(page, 'mode', 'light');

    await context.step('the native picker result drives the shell wallpaper layer', async () => {
      await context.stubOpenDialog(wallpaperSource);
      await page.locator('#theme-panel-host [data-action="choose-wallpaper"]').click();

      await waitFor(
        async () => {
          const variables = await wallpaperVariables(page);
          return variables.image.startsWith('url("data:image/png;base64,');
        },
        15_000,
        150,
        'the app shell to publish the wallpaper data URI',
      );

      const variables = await wallpaperVariables(page);
      expect(variables.image.startsWith('url("data:image/png;base64,')).toBe(true);
      expect(variables.layerImage.startsWith('url("data:image/png;base64,')).toBe(true);
      expect(variables.hasWallpaperClass).toBe(true);
      expect(variables.opacity).toBe('0.35');
      expect(variables.blur).toBe('0px');
      expect(variables.size).toBe('cover');
      expect(variables.position).toBe('center');

      const decoded = await page.evaluate(async () => {
        const app = document.getElementById('app');
        const raw = app === null ? '' : getComputedStyle(app).getPropertyValue('--wallpaper-image');
        const match = /url\("(.+)"\)/.exec(raw.trim());
        if (match === null) return { width: 0, height: 0 };
        const image = new Image();
        image.src = match[1] ?? '';
        await image.decode();
        return { width: image.naturalWidth, height: image.naturalHeight };
      });
      expect(decoded).toEqual({ width: 192, height: 120 });
    });

    await context.step('opacity, blur, size and position reach the layer', async () => {
      const opacity = page.locator('#theme-panel-host input[data-field="wallpaper.opacity"]');
      await opacity.evaluate((element) => {
        const input = element as HTMLInputElement;
        input.value = '0.55';
        input.dispatchEvent(new Event('input', { bubbles: true }));
      });
      const blur = page.locator('#theme-panel-host input[data-field="wallpaper.blurPx"]');
      await blur.evaluate((element) => {
        const input = element as HTMLInputElement;
        input.value = '4';
        input.dispatchEvent(new Event('input', { bubbles: true }));
      });
      await page.locator('#theme-panel-host select[data-field="wallpaper.size"]').selectOption('contain');
      await page.locator('#theme-panel-host select[data-field="wallpaper.position"]').selectOption('top');

      await waitFor(
        async () => {
          const variables = await wallpaperVariables(page);
          return (
            variables.opacity === '0.55' &&
            variables.blur === '4px' &&
            variables.size === 'contain' &&
            variables.position === 'top'
          );
        },
        15_000,
        150,
        'wallpaper settings to reach the layer',
      );

      const frame = await frameWallpaperVariables(page);
      expect(frame.opacity).toBe('0.55');
      expect(frame.blur).toBe('4px');
      expect(frame.size).toBe('contain');
      expect(frame.position).toBe('top');
    });

    await context.step('the preview iframe carries the same data URI', async () => {
      await waitFor(
        async () => (await frameWallpaperVariables(page)).image.startsWith('url("data:image/png;base64,'),
        15_000,
        150,
        'the preview frame to apply the wallpaper',
      );
      const shell = await wallpaperVariables(page);
      const frame = await frameWallpaperVariables(page);
      expect(frame.image).toBe(shell.image);
      expect(frame.layerImage.startsWith('url("data:image/png;base64,')).toBe(true);
      await captureNamed(context, 'theme-wallpaper');
    });

    const exportPath = context.workspacePath('壁纸导出.html');

    await context.step('the exported HTML is identical to the preview and carries the wallpaper', async () => {
      await context.stubSaveDialog(exportPath);
      await page.locator('#export-html').click();
      await waitForFileContains(exportPath, 'name="mdl-signature"', 20_000);

      const exported = readFileSync(exportPath, 'utf8');
      const srcdoc = await page.locator('#preview-host iframe').getAttribute('srcdoc');
      expect(srcdoc).not.toBeNull();
      expect(exported).toBe(srcdoc);
      expect(exported).toContain('--mdl-wallpaper-image: url("data:image/png;base64,');
      expect(exported).toContain('--mdl-wallpaper-opacity: 0.55;');
      expect(exported).toContain('--mdl-wallpaper-blur: 4px;');
      expect(exported).toContain('--mdl-wallpaper-size: contain;');
      expect(exported).toContain('--mdl-wallpaper-position: top;');
      expect(exported).toContain('.mdl-shell::before');
      expect(exported).not.toMatch(/<script\b/i);
      context.note(`exported wallpaper HTML: ${exportPath}`);
    });

    await context.step('the persisted state keeps the data URI but never the picked path', async () => {
      let payload = '';
      await waitFor(
        () => {
          for (const file of stateFiles(context)) {
            const text = readFileSync(file, 'utf8');
            if (text.includes('data:image/png;base64,')) {
              payload = text;
              return true;
            }
          }
          return false;
        },
        15_000,
        200,
        'the wallpaper to be persisted in the UI state',
      );

      expect(payload).toContain('"wallpaper"');
      expect(payload).toContain('"opacity": 0.55');
      expect(payload).toContain('"size": "contain"');
      expect(payload).not.toContain(wallpaperSource);
      expect(payload).not.toContain('picked-');
    });

    await context.step('clearing the wallpaper restores the plain colour', async () => {
      await page.locator('#theme-panel-host [data-action="clear-wallpaper"]').click();
      await waitFor(
        async () => {
          const variables = await wallpaperVariables(page);
          const frame = await frameWallpaperVariables(page);
          return variables.image === 'none' && frame.image === 'none';
        },
        15_000,
        150,
        'the wallpaper to be removed from the shell and the frame',
      );

      const variables = await wallpaperVariables(page);
      expect(variables.hasWallpaperClass).toBe(false);
      expect(variables.layerImage).toBe('none');
      const srcdoc = await page.locator('#preview-host iframe').getAttribute('srcdoc');
      expect(srcdoc ?? '').toContain('--mdl-wallpaper-image: none;');
      expect(srcdoc ?? '').not.toContain('--mdl-wallpaper-image: url("data:image/png;base64,');
    });

    await context.step('wallpaper and mode survive a restart', async () => {
      await context.stubOpenDialog(wallpaperSource);
      await page.locator('#theme-panel-host [data-action="choose-wallpaper"]').click();
      await waitFor(
        async () => (await wallpaperVariables(page)).image.startsWith('url("data:image/png;base64,'),
        15_000,
        150,
        'the wallpaper to be re-applied before the restart',
      );
      await setThemeSelect(page, 'mode', 'dark');
      await expect(page.locator('#app')).toHaveAttribute('data-theme', 'dark');

      await waitFor(
        () =>
          stateFiles(context).some((file) => readFileSync(file, 'utf8').includes('"mode": "dark"')),
        15_000,
        200,
        'the dark mode to be persisted before the restart',
      );

      await context.relaunchApp();
      const restarted = context.page;
      if (restarted === null) throw new Error('window did not reopen');

      await expect(restarted.locator('#workspace-shell')).toBeVisible();
      await openMarkdownFile(restarted, HOME_NOTES);
      await waitFor(
        async () => {
          const snapshot = await shellTheme(restarted);
          const variables = await wallpaperVariables(restarted);
          return (
            snapshot.dataTheme === 'dark' &&
            variables.image.startsWith('url("data:image/png;base64,')
          );
        },
        20_000,
        200,
        'the restored theme mode and wallpaper',
      );

      const snapshot = await shellTheme(restarted);
      const variables = await wallpaperVariables(restarted);
      expect(snapshot.panelBackground).toBe(DARK_PANEL);
      expect(variables.size).toBe('contain');
      expect(variables.opacity).toBe('0.55');

      await waitFor(
        async () => (await frameWallpaperVariables(restarted)).image.startsWith('url("data:image/png;base64,'),
        20_000,
        200,
        'the restored preview wallpaper',
      );
    });
  });
});
