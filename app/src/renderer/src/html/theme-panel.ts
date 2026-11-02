/**
 * Theme and layout panel.
 *
 * Every control is bounded by the same rules as `shared/validation.ts`: a
 * change is only reported through `onChange` after `validateThemeConfig` /
 * `validateLayoutConfig` accepted the complete candidate object. Invalid input
 * therefore never reaches the render workspace or persisted state, and the
 * control snaps back to the last accepted value.
 */

import type {
  LayoutConfig,
  SidebarLayout,
  ThemeConfig,
  ThemeMode,
  WallpaperConfig,
  WallpaperPosition,
  WallpaperSize,
} from '../../../shared/contracts';
import { DEFAULT_WALLPAPER } from '../../../shared/defaults';
import { normalizeLayout, normalizeTheme, WALLPAPER_POSITIONS, WALLPAPER_SIZES } from '../render/theme';
import { validateLayoutConfig, validateThemeConfig } from '../../../shared/validation';

export type ThemePanelChangeKind = 'theme' | 'layout';

export interface ThemePanelChange {
  theme: ThemeConfig;
  layout: LayoutConfig;
  changed: ThemePanelChangeKind;
}

export interface ThemePanelOptions {
  theme: ThemeConfig;
  layout: LayoutConfig;
  /**
   * Opens the native picker and resolves with the chosen data URI, or `null`
   * when the user cancelled or the import failed (the old wallpaper is kept).
   */
  onChooseWallpaper(): Promise<WallpaperConfig['dataUri'] | null>;
  onChange(change: ThemePanelChange): void;
}

export interface ThemePanelController {
  readonly element: HTMLElement;
  getTheme(): ThemeConfig;
  getLayout(): LayoutConfig;
  setTheme(theme: ThemeConfig): void;
  setLayout(layout: LayoutConfig): void;
  destroy(): void;
}

export type CustomVariablesParse =
  | { ok: true; variables: Record<string, string> }
  | { ok: false; message: string };

const CUSTOM_VARIABLE_KEY = /^--mdl-[a-z0-9-]{1,64}$/;
const MAX_CUSTOM_VARIABLE_VALUE = 200;

/** `input[type=color]` only accepts `#rrggbb`; theme values may be shorter. */
export function toColorInputValue(value: string): string {
  const match = /^#([0-9a-f]{3,8})$/i.exec(value.trim());
  if (!match) return '#000000';
  let hex = (match[1] ?? '').toLowerCase();
  if (hex.length === 3 || hex.length === 4) {
    hex = hex
      .slice(0, 3)
      .split('')
      .map((character) => `${character}${character}`)
      .join('');
  } else if (hex.length === 8) {
    hex = hex.slice(0, 6);
  }
  return `#${hex}`;
}

/** One `--mdl-name: value` pair per line; unknown keys or empty values fail. */
export function parseCustomVariables(text: string): CustomVariablesParse {
  const variables: Record<string, string> = {};
  const lines = text.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = (lines[index] ?? '').trim();
    if (line.length === 0) continue;

    const colon = line.indexOf(':');
    if (colon <= 0) {
      return { ok: false, message: `第 ${index + 1} 行需要写成「--mdl-名称: 值」` };
    }
    const key = line.slice(0, colon).trim();
    const value = line.slice(colon + 1).trim();
    if (!CUSTOM_VARIABLE_KEY.test(key)) {
      return {
        ok: false,
        message: `第 ${index + 1} 行的变量名必须以 --mdl- 开头，只能使用小写字母、数字或连字符`,
      };
    }
    if (value.length === 0 || value.length > MAX_CUSTOM_VARIABLE_VALUE) {
      return { ok: false, message: `第 ${index + 1} 行的值长度必须在 1–${MAX_CUSTOM_VARIABLE_VALUE} 之间` };
    }
    variables[key] = value;
  }
  return { ok: true, variables };
}

export function formatCustomVariables(variables: Record<string, string>): string {
  return Object.entries(variables)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([key, value]) => `${key}: ${value}`)
    .join('\n');
}

function createElement<K extends keyof HTMLElementTagNameMap>(
  doc: Document,
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const element = doc.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

function createRow(doc: Document, label: string, control: HTMLElement): HTMLLabelElement {
  const row = doc.createElement('label');
  row.className = 'mdl-theme-row';
  const caption = createElement(doc, 'span', 'mdl-theme-label', label);
  row.append(caption, control);
  return row;
}

function createNumber(
  doc: Document,
  field: string,
  value: number,
  min: number,
  max: number,
  step: number,
): HTMLInputElement {
  const input = createElement(doc, 'input', 'mdl-theme-number');
  input.type = 'number';
  input.dataset.field = field;
  input.min = String(min);
  input.max = String(max);
  input.step = String(step);
  input.value = String(value);
  return input;
}

function createColour(doc: Document, field: string, value: string): HTMLInputElement {
  const input = createElement(doc, 'input', 'mdl-theme-colour');
  input.type = 'color';
  input.dataset.field = field;
  input.value = toColorInputValue(value);
  return input;
}

function createText(doc: Document, field: string, value: string): HTMLInputElement {
  const input = createElement(doc, 'input', 'mdl-theme-text');
  input.type = 'text';
  input.dataset.field = field;
  input.maxLength = 200;
  input.value = value;
  return input;
}

function createCheckbox(doc: Document, field: string, checked: boolean): HTMLInputElement {
  const input = createElement(doc, 'input', 'mdl-theme-checkbox');
  input.type = 'checkbox';
  input.dataset.field = field;
  input.checked = checked;
  return input;
}

function createSideSelect(doc: Document, field: string, value: 'left' | 'right'): HTMLSelectElement {
  const select = createElement(doc, 'select', 'mdl-theme-select');
  select.dataset.field = field;
  for (const side of ['left', 'right'] as const) {
    const option = doc.createElement('option');
    option.value = side;
    option.textContent = side === 'left' ? '左侧' : '右侧';
    select.append(option);
  }
  select.value = value;
  return select;
}

function createSelect(
  doc: Document,
  field: string,
  value: string,
  choices: ReadonlyArray<readonly [string, string]>,
): HTMLSelectElement {
  const select = createElement(doc, 'select', 'mdl-theme-select');
  select.dataset.field = field;
  for (const [optionValue, label] of choices) {
    const option = doc.createElement('option');
    option.value = optionValue;
    option.textContent = label;
    select.append(option);
  }
  select.value = value;
  return select;
}

function createRange(
  doc: Document,
  field: string,
  value: number,
  min: number,
  max: number,
  step: number,
): HTMLInputElement {
  const input = createElement(doc, 'input', 'mdl-theme-range');
  input.type = 'range';
  input.dataset.field = field;
  input.min = String(min);
  input.max = String(max);
  input.step = String(step);
  input.value = String(value);
  return input;
}

const WALLPAPER_SIZE_LABELS: ReadonlyArray<readonly [WallpaperSize, string]> = [
  ['cover', '填充（cover）'],
  ['contain', '完整（contain）'],
  ['repeat', '平铺（repeat）'],
];

const WALLPAPER_POSITION_LABELS: ReadonlyArray<readonly [WallpaperPosition, string]> = [
  ['center', '居中'],
  ['top', '顶部'],
  ['bottom', '底部'],
  ['left', '左侧'],
  ['right', '右侧'],
];

function isThemeMode(value: string): value is ThemeMode {
  return value === 'light' || value === 'dark' || value === 'system';
}

export function mountThemePanel(
  container: HTMLElement,
  options: ThemePanelOptions,
): ThemePanelController {
  const doc = container.ownerDocument;
  let theme = normalizeTheme(options.theme);
  let layout = normalizeLayout(options.layout);

  const root = createElement(doc, 'section', 'mdl-theme-panel');
  root.setAttribute('aria-label', '主题与布局');

  const header = createElement(doc, 'header', 'mdl-theme-panel-header');
  header.append(createElement(doc, 'h2', 'mdl-theme-panel-title', '主题与布局'));

  const error = createElement(doc, 'p', 'mdl-theme-panel-error');
  error.setAttribute('role', 'status');
  error.hidden = true;

  const body = createElement(doc, 'div', 'mdl-theme-panel-body');

  // -- theme ----------------------------------------------------------------

  const themeGroup = createElement(doc, 'fieldset', 'mdl-theme-group');
  themeGroup.append(createElement(doc, 'legend', undefined, '主题'));

  const modeSelect = createElement(doc, 'select', 'mdl-theme-select');
  modeSelect.dataset.field = 'mode';
  for (const [value, label] of [
    ['system', '跟随系统'],
    ['light', '浅色'],
    ['dark', '深色'],
  ] as const) {
    const option = doc.createElement('option');
    option.value = value;
    option.textContent = label;
    modeSelect.append(option);
  }

  const bodyWidthInput = createNumber(doc, 'bodyWidthPx', theme.bodyWidthPx, 320, 2400, 10);
  const fontFamilyInput = createText(doc, 'fontFamily', theme.fontFamily);
  const fontSizeInput = createNumber(doc, 'fontSizePx', theme.fontSizePx, 10, 48, 1);
  const lineHeightInput = createNumber(doc, 'lineHeight', theme.lineHeight, 1, 3, 0.05);
  const codeFontInput = createText(doc, 'codeFontFamily', theme.codeFontFamily);
  const foregroundInput = createColour(doc, 'foreground', theme.foreground);
  const backgroundInput = createColour(doc, 'background', theme.background);
  const accentInput = createColour(doc, 'accent', theme.accent);
  const headingScaleInput = createNumber(doc, 'headingScale', theme.headingScale, 1, 2, 0.05);

  themeGroup.append(
    createRow(doc, '模式', modeSelect),
    createRow(doc, '正文宽度 (px)', bodyWidthInput),
    createRow(doc, '正文字体', fontFamilyInput),
    createRow(doc, '字号 (px)', fontSizeInput),
    createRow(doc, '行高', lineHeightInput),
    createRow(doc, '代码字体', codeFontInput),
    createRow(doc, '前景色', foregroundInput),
    createRow(doc, '背景色', backgroundInput),
    createRow(doc, '强调色', accentInput),
    createRow(doc, '标题缩放', headingScaleInput),
  );

  // -- wallpaper ------------------------------------------------------------

  const wallpaperGroup = createElement(doc, 'fieldset', 'mdl-theme-group');
  wallpaperGroup.append(createElement(doc, 'legend', undefined, '自定义壁纸'));

  const wallpaperPreview = createElement(doc, 'img', 'mdl-theme-wallpaper-preview');
  wallpaperPreview.dataset.field = 'wallpaper.preview';
  wallpaperPreview.alt = '壁纸预览';
  wallpaperPreview.hidden = true;

  const wallpaperEmpty = createElement(doc, 'p', 'mdl-theme-hint', '尚未选择壁纸图片。');
  wallpaperEmpty.dataset.field = 'wallpaper.empty';

  const chooseWallpaperButton = createElement(doc, 'button', 'mdl-theme-action', '选择图片…');
  chooseWallpaperButton.type = 'button';
  chooseWallpaperButton.dataset.action = 'choose-wallpaper';

  const clearWallpaperButton = createElement(doc, 'button', 'mdl-theme-action', '清除壁纸');
  clearWallpaperButton.type = 'button';
  clearWallpaperButton.dataset.action = 'clear-wallpaper';

  const wallpaperActions = createElement(doc, 'div', 'mdl-theme-actions');
  wallpaperActions.append(chooseWallpaperButton, clearWallpaperButton);

  const wallpaperOpacity = createRange(doc, 'wallpaper.opacity', theme.wallpaper.opacity, 0, 1, 0.05);
  const wallpaperBlur = createRange(doc, 'wallpaper.blurPx', theme.wallpaper.blurPx, 0, 20, 1);
  const wallpaperSize = createSelect(doc, 'wallpaper.size', theme.wallpaper.size, WALLPAPER_SIZE_LABELS);
  const wallpaperPosition = createSelect(
    doc,
    'wallpaper.position',
    theme.wallpaper.position,
    WALLPAPER_POSITION_LABELS,
  );
  const wallpaperOpacityValue = createElement(doc, 'span', 'mdl-theme-value');
  const wallpaperBlurValue = createElement(doc, 'span', 'mdl-theme-value');

  const opacityRow = createRow(doc, '不透明度', wallpaperOpacity);
  opacityRow.append(wallpaperOpacityValue);
  const blurRow = createRow(doc, '模糊 (px)', wallpaperBlur);
  blurRow.append(wallpaperBlurValue);

  wallpaperGroup.append(
    wallpaperPreview,
    wallpaperEmpty,
    wallpaperActions,
    createRow(doc, '大小', wallpaperSize),
    createRow(doc, '位置', wallpaperPosition),
    opacityRow,
    blurRow,
  );

  // -- layout ---------------------------------------------------------------

  const layoutGroup = createElement(doc, 'fieldset', 'mdl-theme-group');
  layoutGroup.append(createElement(doc, 'legend', undefined, '布局'));

  const titleVisible = createCheckbox(doc, 'title.visible', layout.title.visible);
  const outlineVisible = createCheckbox(doc, 'outline.visible', layout.outline.visible);
  const outlinePosition = createSideSelect(doc, 'outline.position', layout.outline.position);
  const sidebarVisible = createCheckbox(doc, 'sidebar.visible', layout.sidebar.visible);
  const sidebarPosition = createSideSelect(doc, 'sidebar.position', layout.sidebar.position);
  const sidebarWidth = createNumber(doc, 'sidebar.widthPx', layout.sidebar.widthPx, 160, 640, 10);

  layoutGroup.append(
    createRow(doc, '显示文档标题', titleVisible),
    createRow(doc, '显示大纲', outlineVisible),
    createRow(doc, '大纲位置', outlinePosition),
    createRow(doc, '显示侧栏', sidebarVisible),
    createRow(doc, '侧栏位置', sidebarPosition),
    createRow(doc, '侧栏宽度 (px)', sidebarWidth),
  );

  // -- custom variables -----------------------------------------------------

  const variableGroup = createElement(doc, 'fieldset', 'mdl-theme-group');
  variableGroup.append(createElement(doc, 'legend', undefined, '自定义变量'));
  const variablesInput = createElement(doc, 'textarea', 'mdl-theme-variables');
  variablesInput.dataset.field = 'customVariables';
  variablesInput.rows = 4;
  variablesInput.spellcheck = false;
  const variablesHint = createElement(
    doc,
    'p',
    'mdl-theme-hint',
    '每行一个变量，必须使用 --mdl- 前缀，例如：--mdl-accent: #2f6feb',
  );
  variableGroup.append(variablesInput, variablesHint);

  body.append(themeGroup, wallpaperGroup, layoutGroup, variableGroup);
  root.append(header, error, body);
  container.append(root);

  // -- state plumbing -------------------------------------------------------

  function setError(message: string): void {
    error.textContent = message;
    error.hidden = message.length === 0;
  }

  function syncControls(): void {
    modeSelect.value = theme.mode;
    bodyWidthInput.value = String(theme.bodyWidthPx);
    fontFamilyInput.value = theme.fontFamily;
    fontSizeInput.value = String(theme.fontSizePx);
    lineHeightInput.value = String(theme.lineHeight);
    codeFontInput.value = theme.codeFontFamily;
    foregroundInput.value = toColorInputValue(theme.foreground);
    backgroundInput.value = toColorInputValue(theme.background);
    accentInput.value = toColorInputValue(theme.accent);
    headingScaleInput.value = String(theme.headingScale);
    titleVisible.checked = layout.title.visible;
    outlineVisible.checked = layout.outline.visible;
    outlinePosition.value = layout.outline.position;
    sidebarVisible.checked = layout.sidebar.visible;
    sidebarPosition.value = layout.sidebar.position;
    sidebarWidth.value = String(layout.sidebar.widthPx);
    variablesInput.value = formatCustomVariables(theme.customVariables);

    const wallpaper = theme.wallpaper ?? DEFAULT_WALLPAPER;
    const hasWallpaper = wallpaper.dataUri !== null;
    if (hasWallpaper) wallpaperPreview.src = wallpaper.dataUri ?? '';
    else wallpaperPreview.removeAttribute('src');
    wallpaperPreview.hidden = !hasWallpaper;
    wallpaperEmpty.hidden = hasWallpaper;
    clearWallpaperButton.disabled = !hasWallpaper;
    wallpaperOpacity.value = String(wallpaper.opacity);
    wallpaperBlur.value = String(wallpaper.blurPx);
    wallpaperSize.value = wallpaper.size;
    wallpaperPosition.value = wallpaper.position;
    wallpaperOpacityValue.textContent = wallpaper.opacity.toFixed(2);
    wallpaperBlurValue.textContent = String(wallpaper.blurPx);
  }

  function commitTheme(patch: Partial<ThemeConfig>): boolean {
    const candidate: ThemeConfig = { ...theme, ...patch };
    const result = validateThemeConfig(candidate);
    if (!result.ok) {
      setError(result.message);
      syncControls();
      return false;
    }
    theme = result.value;
    setError('');
    options.onChange({ theme, layout, changed: 'theme' });
    syncControls();
    return true;
  }

  function commitLayout(next: LayoutConfig): boolean {
    const result = validateLayoutConfig(next);
    if (!result.ok) {
      setError(result.message);
      syncControls();
      return false;
    }
    layout = result.value;
    setError('');
    options.onChange({ theme, layout, changed: 'layout' });
    syncControls();
    return true;
  }

  /** Every wallpaper edit goes through the same full-theme validation. */
  function commitWallpaper(patch: Partial<WallpaperConfig>): boolean {
    return commitTheme({ wallpaper: { ...theme.wallpaper, ...patch } });
  }

  async function chooseWallpaper(): Promise<void> {
    chooseWallpaperButton.disabled = true;
    try {
      const dataUri = await options.onChooseWallpaper();
      if (dataUri === null) {
        setError('');
        syncControls();
        return;
      }
      commitWallpaper({ dataUri });
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
      syncControls();
    } finally {
      chooseWallpaperButton.disabled = false;
    }
  }

  function currentSidebar(patch: Partial<SidebarLayout>): SidebarLayout {
    return {
      visible: patch.visible ?? layout.sidebar.visible,
      position: patch.position ?? layout.sidebar.position,
      widthPx: patch.widthPx ?? layout.sidebar.widthPx,
    };
  }

  // -- control wiring -------------------------------------------------------

  modeSelect.addEventListener('change', () => {
    if (!isThemeMode(modeSelect.value)) return;
    commitTheme({ mode: modeSelect.value });
  });

  bodyWidthInput.addEventListener('change', () => {
    const value = Number(bodyWidthInput.value);
    if (!Number.isInteger(value)) {
      setError('正文宽度必须是整数像素值');
      syncControls();
      return;
    }
    commitTheme({ bodyWidthPx: value });
  });

  fontFamilyInput.addEventListener('change', () => {
    const value = fontFamilyInput.value.trim();
    if (value.length === 0) {
      setError('正文字体不能为空');
      syncControls();
      return;
    }
    commitTheme({ fontFamily: value });
  });

  fontSizeInput.addEventListener('change', () => {
    const value = Number(fontSizeInput.value);
    if (!Number.isInteger(value)) {
      setError('字号必须是整数像素值');
      syncControls();
      return;
    }
    commitTheme({ fontSizePx: value });
  });

  lineHeightInput.addEventListener('change', () => {
    const value = Number(lineHeightInput.value);
    if (!Number.isFinite(value)) {
      setError('行高必须是数字');
      syncControls();
      return;
    }
    commitTheme({ lineHeight: value });
  });

  codeFontInput.addEventListener('change', () => {
    const value = codeFontInput.value.trim();
    if (value.length === 0) {
      setError('代码字体不能为空');
      syncControls();
      return;
    }
    commitTheme({ codeFontFamily: value });
  });

  foregroundInput.addEventListener('input', () => commitTheme({ foreground: foregroundInput.value }));
  backgroundInput.addEventListener('input', () =>
    commitTheme({ background: backgroundInput.value }),
  );
  accentInput.addEventListener('input', () => commitTheme({ accent: accentInput.value }));

  headingScaleInput.addEventListener('change', () => {
    const value = Number(headingScaleInput.value);
    if (!Number.isFinite(value)) {
      setError('标题缩放必须是数字');
      syncControls();
      return;
    }
    commitTheme({ headingScale: value });
  });

  titleVisible.addEventListener('change', () => {
    commitLayout({ ...layout, title: { visible: titleVisible.checked } });
  });

  outlineVisible.addEventListener('change', () => {
    commitLayout({
      ...layout,
      outline: { visible: outlineVisible.checked, position: layout.outline.position },
    });
  });

  outlinePosition.addEventListener('change', () => {
    const value = outlinePosition.value === 'right' ? 'right' : 'left';
    commitLayout({ ...layout, outline: { visible: layout.outline.visible, position: value } });
  });

  sidebarVisible.addEventListener('change', () => {
    commitLayout({
      ...layout,
      sidebar: currentSidebar({ visible: sidebarVisible.checked }),
    });
  });

  sidebarPosition.addEventListener('change', () => {
    commitLayout({
      ...layout,
      sidebar: currentSidebar({ position: sidebarPosition.value === 'right' ? 'right' : 'left' }),
    });
  });

  sidebarWidth.addEventListener('change', () => {
    const value = Number(sidebarWidth.value);
    if (!Number.isInteger(value)) {
      setError('侧栏宽度必须是整数像素值');
      syncControls();
      return;
    }
    commitLayout({ ...layout, sidebar: currentSidebar({ widthPx: value }) });
  });

  variablesInput.addEventListener('change', () => {
    const parsed = parseCustomVariables(variablesInput.value);
    if (!parsed.ok) {
      setError(parsed.message);
      syncControls();
      return;
    }
    commitTheme({ customVariables: parsed.variables });
  });

  chooseWallpaperButton.addEventListener('click', () => {
    void chooseWallpaper();
  });

  clearWallpaperButton.addEventListener('click', () => {
    commitWallpaper({ dataUri: null });
  });

  wallpaperOpacity.addEventListener('input', () => {
    commitWallpaper({ opacity: Number(wallpaperOpacity.value) });
  });

  wallpaperBlur.addEventListener('input', () => {
    commitWallpaper({ blurPx: Number(wallpaperBlur.value) });
  });

  wallpaperSize.addEventListener('change', () => {
    if (!WALLPAPER_SIZES.includes(wallpaperSize.value as WallpaperSize)) {
      syncControls();
      return;
    }
    commitWallpaper({ size: wallpaperSize.value as WallpaperSize });
  });

  wallpaperPosition.addEventListener('change', () => {
    if (!WALLPAPER_POSITIONS.includes(wallpaperPosition.value as WallpaperPosition)) {
      syncControls();
      return;
    }
    commitWallpaper({ position: wallpaperPosition.value as WallpaperPosition });
  });

  syncControls();

  return {
    element: root,
    getTheme: () => theme,
    getLayout: () => layout,
    setTheme(next: ThemeConfig) {
      theme = normalizeTheme(next);
      setError('');
      syncControls();
    },
    setLayout(next: LayoutConfig) {
      layout = normalizeLayout(next);
      setError('');
      syncControls();
    },
    destroy() {
      root.remove();
    },
  };
}
