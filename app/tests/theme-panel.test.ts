/// <reference lib="dom" />
/**
 * Theme/layout panel: bounds, validation and change reporting.
 *
 * jsdom is loaded through `createRequire` with a local shape because it ships no
 * type declarations and no dependency may be added.
 */

import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import { DEFAULT_LAYOUT, DEFAULT_THEME } from '../src/shared/defaults';
import { validateThemeConfig } from '../src/shared/validation';
import {
  formatCustomVariables,
  mountThemePanel,
  parseCustomVariables,
  toColorInputValue,
} from '../src/renderer/src/html/theme-panel';
import type { ThemePanelChange } from '../src/renderer/src/html/theme-panel';
import { WALLPAPER_DATA_URI } from './wallpaper-fixtures';

interface JsdomInstance {
  window: Window & typeof globalThis;
}

const { JSDOM } = createRequire(import.meta.url)('jsdom') as {
  JSDOM: new (html?: string) => JsdomInstance;
};

interface SetupOptions {
  /** Resolves the fake native picker; `null` means "cancelled". */
  choose?: () => Promise<string | null>;
}

async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function setup(options: SetupOptions = {}) {
  const dom = new JSDOM('<!doctype html><html><body></body></html>');
  const doc = dom.window.document;
  const container = doc.createElement('div');
  doc.body.append(container);

  const changes: ThemePanelChange[] = [];
  const chooser = { calls: 0 };
  const controller = mountThemePanel(container, {
    theme: { ...DEFAULT_THEME, customVariables: {} },
    layout: {
      sidebar: { ...DEFAULT_LAYOUT.sidebar },
      outline: { ...DEFAULT_LAYOUT.outline },
      title: { ...DEFAULT_LAYOUT.title },
    },
    onChooseWallpaper: async () => {
      chooser.calls += 1;
      return options.choose ? options.choose() : null;
    },
    onChange: (change) => changes.push(change),
  });

  function field<T extends HTMLElement>(name: string): T {
    const element = container.querySelector<T>(`[data-field="${name}"]`);
    if (!element) throw new Error(`missing control ${name}`);
    return element;
  }

  function action(name: string): HTMLButtonElement {
    const element = container.querySelector<HTMLButtonElement>(`[data-action="${name}"]`);
    if (!element) throw new Error(`missing action ${name}`);
    return element;
  }

  function fire(element: HTMLElement, type = 'change'): void {
    element.dispatchEvent(new dom.window.Event(type));
  }

  function errorText(): string {
    const error = container.querySelector<HTMLElement>('.mdl-theme-panel-error');
    return error && !error.hidden ? (error.textContent ?? '') : '';
  }

  return {
    dom,
    doc,
    container,
    controller,
    changes,
    chooser,
    field,
    action,
    fire,
    errorText,
  };
}

describe('theme panel controls', () => {
  it('bounds every numeric control like the shared validation', () => {
    const { field } = setup();
    const bodyWidth = field<HTMLInputElement>('bodyWidthPx');
    expect(bodyWidth.min).toBe('320');
    expect(bodyWidth.max).toBe('2400');

    const fontSize = field<HTMLInputElement>('fontSizePx');
    expect(fontSize.min).toBe('10');
    expect(fontSize.max).toBe('48');

    const lineHeight = field<HTMLInputElement>('lineHeight');
    expect(lineHeight.min).toBe('1');
    expect(lineHeight.max).toBe('3');

    const headingScale = field<HTMLInputElement>('headingScale');
    expect(headingScale.min).toBe('1');
    expect(headingScale.max).toBe('2');

    const sidebarWidth = field<HTMLInputElement>('sidebar.widthPx');
    expect(sidebarWidth.min).toBe('160');
    expect(sidebarWidth.max).toBe('640');
  });

  it('keeps out-of-range values away from onChange and reverts them', () => {
    const { field, fire, changes, errorText } = setup();
    const bodyWidth = field<HTMLInputElement>('bodyWidthPx');

    bodyWidth.value = '5000';
    fire(bodyWidth);

    expect(changes).toHaveLength(0);
    expect(bodyWidth.value).toBe(String(DEFAULT_THEME.bodyWidthPx));
    expect(errorText()).toContain('2400');
  });

  it('reports a valid theme change with the validated object', () => {
    const { field, fire, changes, controller } = setup();
    const bodyWidth = field<HTMLInputElement>('bodyWidthPx');

    bodyWidth.value = '720';
    fire(bodyWidth);

    expect(changes).toHaveLength(1);
    expect(changes[0]?.changed).toBe('theme');
    expect(changes[0]?.theme.bodyWidthPx).toBe(720);
    expect(changes[0]?.layout).toEqual(controller.getLayout());
  });

  it('rejects an empty font family', () => {
    const { field, fire, changes } = setup();
    const fontFamily = field<HTMLInputElement>('fontFamily');

    fontFamily.value = '   ';
    fire(fontFamily);

    expect(changes).toHaveLength(0);
    expect(fontFamily.value).toBe(DEFAULT_THEME.fontFamily);
  });

  it('reports colour changes and normalises shorthand values for the picker', () => {
    const { field, fire, changes } = setup();
    const foreground = field<HTMLInputElement>('foreground');
    expect(foreground.value).toBe('#1f2328');

    foreground.value = '#123456';
    fire(foreground, 'input');

    expect(changes).toHaveLength(1);
    expect(changes[0]?.theme.foreground).toBe('#123456');
  });

  it('accepts only --mdl- custom variables', () => {
    const { field, fire, changes, controller } = setup();
    const variables = field<HTMLTextAreaElement>('customVariables');

    variables.value = '--mdl-accent: #ff0000\n--mdl-gap: 8px';
    fire(variables);

    expect(changes).toHaveLength(1);
    expect(changes[0]?.theme.customVariables).toEqual({
      '--mdl-accent': '#ff0000',
      '--mdl-gap': '8px',
    });

    variables.value = 'background: red';
    fire(variables);

    expect(changes).toHaveLength(1);
    expect(controller.getTheme().customVariables).toEqual({
      '--mdl-accent': '#ff0000',
      '--mdl-gap': '8px',
    });
    expect(variables.value).toContain('--mdl-accent: #ff0000');
  });

  it('reports layout changes separately', () => {
    const { field, fire, changes } = setup();

    const sidebarWidth = field<HTMLInputElement>('sidebar.widthPx');
    sidebarWidth.value = '320';
    fire(sidebarWidth);
    expect(changes.at(-1)?.changed).toBe('layout');
    expect(changes.at(-1)?.layout.sidebar.widthPx).toBe(320);

    const outlinePosition = field<HTMLSelectElement>('outline.position');
    outlinePosition.value = 'left';
    fire(outlinePosition);
    expect(changes.at(-1)?.layout.outline.position).toBe('left');

    sidebarWidth.value = '900';
    fire(sidebarWidth);
    expect(changes).toHaveLength(2);
    expect(sidebarWidth.value).toBe('320');
  });

  it('rejects invalid custom variable text without notifying', () => {
    const { field, fire, changes, errorText } = setup();
    const variables = field<HTMLTextAreaElement>('customVariables');

    variables.value = '--mdl-accent #ff0000';
    fire(variables);

    expect(changes).toHaveLength(0);
    expect(errorText()).toContain('第 1 行');
  });
});

describe('theme panel pure helpers', () => {
  it('normalises colours for input[type=color]', () => {
    expect(toColorInputValue('#fff')).toBe('#ffffff');
    expect(toColorInputValue('#abc')).toBe('#aabbcc');
    expect(toColorInputValue('#11223344')).toBe('#112233');
    expect(toColorInputValue('not-a-colour')).toBe('#000000');
  });

  it('parses and formats custom variables', () => {
    const parsed = parseCustomVariables('--mdl-accent: #ff0000\n\n--mdl-gap:8px');
    expect(parsed).toEqual({
      ok: true,
      variables: { '--mdl-accent': '#ff0000', '--mdl-gap': '8px' },
    });
    expect(parseCustomVariables('--mdl-: 1').ok).toBe(false);
    expect(parseCustomVariables('--MDL-x: 1').ok).toBe(false);
    expect(formatCustomVariables({ '--mdl-b': '2', '--mdl-a': '1' })).toBe('--mdl-a: 1\n--mdl-b: 2');
  });
});

describe('theme panel wallpaper controls', () => {
  it('bounds the wallpaper controls', () => {
    const { field, action } = setup();

    const opacity = field<HTMLInputElement>('wallpaper.opacity');
    expect(opacity.type).toBe('range');
    expect(opacity.min).toBe('0');
    expect(opacity.max).toBe('1');
    expect(opacity.step).toBe('0.05');
    expect(opacity.value).toBe('0.35');

    const blur = field<HTMLInputElement>('wallpaper.blurPx');
    expect(blur.min).toBe('0');
    expect(blur.max).toBe('20');

    const size = field<HTMLSelectElement>('wallpaper.size');
    expect([...size.options].map((option) => option.value)).toEqual(['cover', 'contain', 'repeat']);

    const position = field<HTMLSelectElement>('wallpaper.position');
    expect([...position.options].map((option) => option.value)).toEqual([
      'center',
      'top',
      'bottom',
      'left',
      'right',
    ]);

    expect(action('choose-wallpaper').textContent).toContain('选择');
    expect(action('clear-wallpaper').disabled).toBe(true);
  });

  it('stores a chosen data URI and shows the thumbnail', async () => {
    const { action, field, changes, controller, chooser } = setup({ choose: async () => WALLPAPER_DATA_URI });

    action('choose-wallpaper').click();
    await flush();

    expect(chooser.calls).toBe(1);
    expect(changes).toHaveLength(1);
    expect(changes[0]?.changed).toBe('theme');
    expect(changes[0]?.theme.wallpaper.dataUri).toBe(WALLPAPER_DATA_URI);
    expect(controller.getTheme().wallpaper.dataUri).toBe(WALLPAPER_DATA_URI);
    expect(validateThemeConfig(controller.getTheme()).ok).toBe(true);

    const preview = field<HTMLImageElement>('wallpaper.preview');
    expect(preview.hidden).toBe(false);
    expect(preview.getAttribute('src')).toBe(WALLPAPER_DATA_URI);
    expect(action('clear-wallpaper').disabled).toBe(false);
  });

  it('keeps the old wallpaper when the picker is cancelled', async () => {
    const { action, changes, controller } = setup({ choose: async () => null });

    action('choose-wallpaper').click();
    await flush();

    expect(changes).toHaveLength(0);
    expect(controller.getTheme().wallpaper.dataUri).toBeNull();
  });

  it('clears the image but keeps the other wallpaper settings', async () => {
    const { action, field, changes, controller, fire } = setup({ choose: async () => WALLPAPER_DATA_URI });

    const size = field<HTMLSelectElement>('wallpaper.size');
    size.value = 'contain';
    fire(size);
    const opacity = field<HTMLInputElement>('wallpaper.opacity');
    opacity.value = '0.8';
    fire(opacity, 'input');

    action('choose-wallpaper').click();
    await flush();
    expect(controller.getTheme().wallpaper.dataUri).toBe(WALLPAPER_DATA_URI);

    action('clear-wallpaper').click();

    expect(controller.getTheme().wallpaper.dataUri).toBeNull();
    expect(controller.getTheme().wallpaper.size).toBe('contain');
    expect(controller.getTheme().wallpaper.opacity).toBe(0.8);
    expect(changes.at(-1)?.theme.wallpaper).toMatchObject({ dataUri: null, size: 'contain', opacity: 0.8 });
    expect(field<HTMLImageElement>('wallpaper.preview').hidden).toBe(true);
    expect(action('clear-wallpaper').disabled).toBe(true);
  });

  it('reports opacity, blur, size and position changes with valid themes', async () => {
    const { action, field, changes, controller, fire } = setup({ choose: async () => WALLPAPER_DATA_URI });
    action('choose-wallpaper').click();
    await flush();

    const opacity = field<HTMLInputElement>('wallpaper.opacity');
    opacity.value = '0.65';
    fire(opacity, 'input');
    expect(changes.at(-1)?.theme.wallpaper.opacity).toBe(0.65);

    const blur = field<HTMLInputElement>('wallpaper.blurPx');
    blur.value = '12';
    fire(blur, 'input');
    expect(changes.at(-1)?.theme.wallpaper.blurPx).toBe(12);

    const size = field<HTMLSelectElement>('wallpaper.size');
    size.value = 'repeat';
    fire(size);
    expect(changes.at(-1)?.theme.wallpaper.size).toBe('repeat');

    const position = field<HTMLSelectElement>('wallpaper.position');
    position.value = 'top';
    fire(position);
    expect(changes.at(-1)?.theme.wallpaper.position).toBe('top');

    expect(controller.getTheme().wallpaper.dataUri).toBe(WALLPAPER_DATA_URI);
    for (const change of changes) {
      expect(validateThemeConfig(change.theme).ok).toBe(true);
    }
  });

  it('never publishes an out-of-range wallpaper value', () => {
    const { field, changes, fire } = setup();

    const blur = field<HTMLInputElement>('wallpaper.blurPx');
    blur.value = '99';
    fire(blur, 'input');

    for (const change of changes) {
      expect(validateThemeConfig(change.theme).ok).toBe(true);
      expect(change.theme.wallpaper.blurPx).toBeLessThanOrEqual(20);
    }
  });
});
