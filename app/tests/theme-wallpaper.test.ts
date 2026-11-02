/// <reference lib="dom" />
/**
 * Wallpaper configuration, normalisation and shared CSS.
 *
 * These tests cover the contract rules (old state stays valid, only base64
 * PNG/JPEG/GIF/WebP data URIs are accepted), the clamping in `normalizeTheme`,
 * and the single stylesheet both the preview iframe and the exported file use.
 */

import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import { buildExportHtmlRequest } from '../src/renderer/src/html/export-request';
import { MarkdownRenderPipeline } from '../src/renderer/src/render/markdown-render-pipeline';
import { createDomPurifySanitizer } from '../src/renderer/src/render/sanitize';
import { buildThemeCss, normalizeTheme, normalizeWallpaper } from '../src/renderer/src/render/theme';
import type { ThemeConfig } from '../src/shared/contracts';
import {
  createDefaultTheme,
  createDefaultWorkspaceUiState,
  DEFAULT_LAYOUT,
  DEFAULT_THEME,
  DEFAULT_WALLPAPER,
} from '../src/shared/defaults';
import {
  isWallpaperDataUri,
  MAX_WALLPAPER_DATA_URI_CHARS,
  validateThemeConfig,
  validateWorkspaceUiState,
} from '../src/shared/validation';
import { legacyTheme, WALLPAPER_DATA_URI } from './wallpaper-fixtures';

interface JsdomInstance {
  window: Window & typeof globalThis;
}

const { JSDOM } = createRequire(import.meta.url)('jsdom') as {
  JSDOM: new (html?: string) => JsdomInstance;
};

const dom = new JSDOM('<!doctype html><html><body></body></html>');
const pipeline = new MarkdownRenderPipeline({ sanitize: createDomPurifySanitizer(dom.window) });

function themeWith(patch: Partial<ThemeConfig['wallpaper']>): ThemeConfig {
  return { ...createDefaultTheme(), wallpaper: { ...DEFAULT_WALLPAPER, ...patch } };
}

describe('wallpaper configuration', () => {
  it('ships the documented defaults', () => {
    expect(DEFAULT_THEME.wallpaper).toEqual({
      dataUri: null,
      opacity: 0.35,
      blurPx: 0,
      size: 'cover',
      position: 'center',
    });
    expect(validateThemeConfig(DEFAULT_THEME).ok).toBe(true);
  });

  it('keeps a theme persisted before wallpapers existed valid', () => {
    const legacy = legacyTheme(DEFAULT_THEME);
    expect('wallpaper' in legacy).toBe(false);

    const result = validateThemeConfig(legacy);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.wallpaper).toEqual(DEFAULT_WALLPAPER);
    expect(result.value.mode).toBe('system');

    const state = createDefaultWorkspaceUiState('C:/workspace');
    const persisted = validateWorkspaceUiState({
      ...state,
      theme: { ...legacy, mode: 'dark' },
    });
    expect(persisted.ok).toBe(true);
    if (!persisted.ok) return;
    expect(persisted.value.theme.mode).toBe('dark');
    expect(persisted.value.theme.wallpaper).toEqual(DEFAULT_WALLPAPER);
  });

  it('accepts only canonical base64 raster data URIs', () => {
    expect(isWallpaperDataUri(WALLPAPER_DATA_URI)).toBe(true);
    expect(isWallpaperDataUri('data:image/jpeg;base64,/9j/4AAQ')).toBe(true);
    expect(validateThemeConfig(themeWith({ dataUri: WALLPAPER_DATA_URI })).ok).toBe(true);

    for (const rejected of [
      'data:image/svg+xml;base64,PHN2Zy8+',
      'data:text/html;base64,PHNjcmlwdD4=',
      'data:image/png;base64,',
      'data:image/png;base64,not base64',
      'data:image/png;base64,AAAAA',
      'javascript:alert(1)',
      'https://example.com/wallpaper.png',
      `data:image/png;base64,${'A'.repeat(MAX_WALLPAPER_DATA_URI_CHARS)}`,
    ]) {
      expect(isWallpaperDataUri(rejected)).toBe(false);
      expect(validateThemeConfig(themeWith({ dataUri: rejected })).ok).toBe(false);
    }
  });

  it('rejects out-of-range numbers and unknown enumerations', () => {
    expect(validateThemeConfig(themeWith({ opacity: 1.5 })).ok).toBe(false);
    expect(validateThemeConfig(themeWith({ opacity: -0.1 })).ok).toBe(false);
    expect(validateThemeConfig(themeWith({ blurPx: 21 })).ok).toBe(false);
    expect(validateThemeConfig(themeWith({ blurPx: -1 })).ok).toBe(false);
    expect(validateThemeConfig(themeWith({ size: 'stretch' as never })).ok).toBe(false);
    expect(validateThemeConfig(themeWith({ position: 'middle' as never })).ok).toBe(false);
    expect(validateThemeConfig(themeWith({ opacity: 0.5, blurPx: 8, size: 'repeat' })).ok).toBe(true);
  });

  it('clamps instead of failing when normalising', () => {
    const normalized = normalizeWallpaper({
      dataUri: 'data:image/svg+xml;base64,PHN2Zy8+',
      opacity: 4,
      blurPx: -6,
      size: 'stretch' as never,
      position: 'middle' as never,
    });
    expect(normalized).toEqual({
      dataUri: null,
      opacity: 1,
      blurPx: 0,
      size: 'cover',
      position: 'center',
    });

    expect(normalizeTheme(undefined).wallpaper).toEqual(DEFAULT_WALLPAPER);
    expect(normalizeTheme(themeWith({ opacity: 0.375 })).wallpaper.opacity).toBe(0.38);
  });

  it('deep-copies the wallpaper so default state cannot be mutated', () => {
    const first = createDefaultWorkspaceUiState('C:/one');
    const second = createDefaultWorkspaceUiState('C:/two');

    expect(first.theme.wallpaper).not.toBe(DEFAULT_THEME.wallpaper);
    expect(first.theme.wallpaper).not.toBe(second.theme.wallpaper);

    first.theme.wallpaper.dataUri = WALLPAPER_DATA_URI;
    first.theme.wallpaper.opacity = 0.9;

    expect(second.theme.wallpaper).toEqual(DEFAULT_WALLPAPER);
    expect(DEFAULT_THEME.wallpaper).toEqual(DEFAULT_WALLPAPER);
  });
});

describe('wallpaper CSS', () => {
  it('keeps a plain colour document when no wallpaper is set', () => {
    const css = buildThemeCss(DEFAULT_THEME, DEFAULT_LAYOUT);
    expect(css).toContain('--mdl-wallpaper-image: none;');
    expect(css).toContain('--mdl-wallpaper-opacity: 0.35;');
    expect(css).not.toContain('data:image');
    expect(css).toContain('background: var(--mdl-bg);');
    expect(css).toContain('.mdl-shell::before');
  });

  it('publishes the data URI, alpha, blur, size and position', () => {
    const theme = themeWith({
      dataUri: WALLPAPER_DATA_URI,
      opacity: 0.4,
      blurPx: 6,
      size: 'contain',
      position: 'bottom',
    });
    const css = buildThemeCss(theme, DEFAULT_LAYOUT);

    expect(css).toContain(`--mdl-wallpaper-image: url("${WALLPAPER_DATA_URI}");`);
    expect(css).toContain('--mdl-wallpaper-opacity: 0.4;');
    expect(css).toContain('--mdl-wallpaper-blur: 6px;');
    expect(css).toContain('--mdl-wallpaper-size: contain;');
    expect(css).toContain('--mdl-wallpaper-position: bottom;');
    expect(css).toContain('--mdl-wallpaper-repeat: no-repeat;');
    expect(css).toContain('background-image: var(--mdl-wallpaper-image, none);');
    expect(css).toContain('filter: blur(var(--mdl-wallpaper-blur, 0px));');
  });

  it('maps the repeat size to an auto-sized repeating layer', () => {
    const css = buildThemeCss(themeWith({ dataUri: WALLPAPER_DATA_URI, size: 'repeat' }), DEFAULT_LAYOUT);
    expect(css).toContain('--mdl-wallpaper-size: auto;');
    expect(css).toContain('--mdl-wallpaper-repeat: repeat;');
  });

  it('produces the same stylesheet for the preview iframe and the export', async () => {
    const theme = themeWith({ dataUri: WALLPAPER_DATA_URI, opacity: 0.5, blurPx: 3, size: 'cover' });
    const result = await pipeline.render({
      markdown: '# 壁纸\n\n正文内容。\n',
      documentPath: '笔记/壁纸.md',
      title: null,
      theme,
      layout: DEFAULT_LAYOUT,
    });

    expect(cssOf(result.html)).toBe(buildThemeCss(theme, DEFAULT_LAYOUT));
    expect(result.html).toContain(WALLPAPER_DATA_URI);

    const request = buildExportHtmlRequest(result, { documentPath: '笔记/壁纸.md' });
    expect(request.html).toBe(result.html);
  });
});

function cssOf(html: string): string {
  const match = /<style>([\s\S]*?)<\/style>/.exec(html);
  if (match === null) throw new Error('rendered document has no <style> block');
  return (match[1] ?? '').trim();
}
