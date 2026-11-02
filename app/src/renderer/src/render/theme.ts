/**
 * Theme and layout to CSS.
 *
 * One function produces the single stylesheet used by the in-app preview and by
 * the exported file. Theme values are normalised first: numbers are clamped,
 * colours must be hex, font stacks and the controlled `--mdl-*` custom
 * variables are filtered so a theme can never inject extra CSS rules.
 */

import type {
  LayoutConfig,
  ThemeConfig,
  ThemeMode,
  WallpaperConfig,
  WallpaperPosition,
  WallpaperSize,
} from '../../../shared/contracts';
import { DEFAULT_LAYOUT, DEFAULT_THEME, DEFAULT_WALLPAPER } from '../../../shared/defaults';
import { isWallpaperDataUri } from '../../../shared/validation';

export const CUSTOM_VARIABLE_PATTERN = /^--mdl-[a-z0-9-]{1,64}$/;
export const OUTLINE_WIDTH_PX = 220;

const HEX_COLOR = /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
const UNSAFE_CSS = /[<>{};@\\]/;
const EXTERNAL_CSS = /url\s*\(|expression\s*\(|javascript\s*:/i;

export interface NormalizedTheme extends ThemeConfig {}

function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

function clampInteger(value: unknown, min: number, max: number, fallback: number): number {
  return Math.round(clampNumber(value, min, max, fallback));
}

function expandHexColor(value: string): string | null {
  const trimmed = value.trim();
  if (!HEX_COLOR.test(trimmed)) return null;
  let hex = trimmed.slice(1).toLowerCase();
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

function normalizeColor(value: unknown, fallback: string): string {
  return typeof value === 'string' ? (expandHexColor(value) ?? fallback) : fallback;
}

function sanitizeFontFamily(value: unknown, fallback: string): string {
  if (typeof value !== 'string') return fallback;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > 200) return fallback;
  if (UNSAFE_CSS.test(trimmed) || EXTERNAL_CSS.test(trimmed)) return fallback;
  if (/[\u0000-\u001f\u007f]/.test(trimmed)) return fallback;
  return trimmed;
}

/** A controlled custom property value, or `null` when it must be ignored. */
export function sanitizeCustomVariableValue(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > 200) return null;
  if (UNSAFE_CSS.test(trimmed) || EXTERNAL_CSS.test(trimmed)) return null;
  if (/[\u0000-\u001f\u007f]/.test(trimmed)) return null;
  return trimmed;
}

export function normalizeCustomVariables(variables: unknown): Record<string, string> {
  if (typeof variables !== 'object' || variables === null || Array.isArray(variables)) return {};
  const normalized: Record<string, string> = {};
  for (const [key, value] of Object.entries(variables)) {
    if (!CUSTOM_VARIABLE_PATTERN.test(key)) continue;
    const safe = sanitizeCustomVariableValue(value);
    if (safe !== null) normalized[key] = safe;
  }
  return normalized;
}

function normalizeMode(value: unknown): ThemeMode {
  return value === 'light' || value === 'dark' || value === 'system' ? value : DEFAULT_THEME.mode;
}

export const WALLPAPER_SIZES: readonly WallpaperSize[] = ['cover', 'contain', 'repeat'];

export const WALLPAPER_POSITIONS: readonly WallpaperPosition[] = [
  'center',
  'top',
  'bottom',
  'left',
  'right',
];

function normalizeWallpaperSize(value: unknown): WallpaperSize {
  return WALLPAPER_SIZES.includes(value as WallpaperSize)
    ? (value as WallpaperSize)
    : DEFAULT_WALLPAPER.size;
}

function normalizeWallpaperPosition(value: unknown): WallpaperPosition {
  return WALLPAPER_POSITIONS.includes(value as WallpaperPosition)
    ? (value as WallpaperPosition)
    : DEFAULT_WALLPAPER.position;
}

/** Clamps every field; an unusable data URI collapses to "no wallpaper". */
export function normalizeWallpaper(wallpaper?: Partial<WallpaperConfig> | null): WallpaperConfig {
  const source = (wallpaper ?? {}) as Partial<WallpaperConfig>;
  return {
    dataUri: isWallpaperDataUri(source.dataUri) ? source.dataUri : null,
    opacity: Math.round(clampNumber(source.opacity, 0, 1, DEFAULT_WALLPAPER.opacity) * 100) / 100,
    blurPx: Math.round(clampNumber(source.blurPx, 0, 20, DEFAULT_WALLPAPER.blurPx) * 10) / 10,
    size: normalizeWallpaperSize(source.size),
    position: normalizeWallpaperPosition(source.position),
  };
}

export function normalizeTheme(theme?: ThemeConfig | null): NormalizedTheme {
  const source = theme ?? DEFAULT_THEME;
  return {
    mode: normalizeMode(source.mode),
    bodyWidthPx: clampInteger(source.bodyWidthPx, 320, 2400, DEFAULT_THEME.bodyWidthPx),
    fontFamily: sanitizeFontFamily(source.fontFamily, DEFAULT_THEME.fontFamily),
    fontSizePx: clampInteger(source.fontSizePx, 10, 48, DEFAULT_THEME.fontSizePx),
    lineHeight: Math.round(clampNumber(source.lineHeight, 1, 3, DEFAULT_THEME.lineHeight) * 100) / 100,
    codeFontFamily: sanitizeFontFamily(source.codeFontFamily, DEFAULT_THEME.codeFontFamily),
    foreground: normalizeColor(source.foreground, DEFAULT_THEME.foreground),
    background: normalizeColor(source.background, DEFAULT_THEME.background),
    accent: normalizeColor(source.accent, DEFAULT_THEME.accent),
    headingScale: Math.round(clampNumber(source.headingScale, 1, 2, DEFAULT_THEME.headingScale) * 100) / 100,
    customVariables: normalizeCustomVariables(source.customVariables),
    wallpaper: normalizeWallpaper(source.wallpaper),
  };
}

export function normalizeLayout(layout?: LayoutConfig | null): LayoutConfig {
  const source = (layout ?? DEFAULT_LAYOUT) as Partial<LayoutConfig> | null;
  const side = (value: unknown): 'left' | 'right' => (value === 'right' ? 'right' : 'left');
  return {
    sidebar: {
      visible: Boolean(source?.sidebar?.visible ?? DEFAULT_LAYOUT.sidebar.visible),
      position: side(source?.sidebar?.position ?? DEFAULT_LAYOUT.sidebar.position),
      widthPx: clampInteger(source?.sidebar?.widthPx, 160, 640, DEFAULT_LAYOUT.sidebar.widthPx),
    },
    outline: {
      visible: Boolean(source?.outline?.visible ?? DEFAULT_LAYOUT.outline.visible),
      position: side(source?.outline?.position ?? DEFAULT_LAYOUT.outline.position),
    },
    title: {
      visible: Boolean(source?.title?.visible ?? DEFAULT_LAYOUT.title.visible),
    },
  };
}

// ---------------------------------------------------------------------------
// Colour helpers
// ---------------------------------------------------------------------------

interface Rgb {
  r: number;
  g: number;
  b: number;
}

function parseHexColor(value: string): Rgb | null {
  const expanded = expandHexColor(value);
  if (expanded === null) return null;
  return {
    r: Number.parseInt(expanded.slice(1, 3), 16),
    g: Number.parseInt(expanded.slice(3, 5), 16),
    b: Number.parseInt(expanded.slice(5, 7), 16),
  };
}

function toHex(value: number): string {
  return Math.min(255, Math.max(0, Math.round(value)))
    .toString(16)
    .padStart(2, '0');
}

function rgbToHex(rgb: Rgb): string {
  return `#${toHex(rgb.r)}${toHex(rgb.g)}${toHex(rgb.b)}`;
}

function mix(from: Rgb, to: Rgb, weight: number): Rgb {
  const ratio = Math.min(1, Math.max(0, weight));
  return {
    r: from.r + (to.r - from.r) * ratio,
    g: from.g + (to.g - from.g) * ratio,
    b: from.b + (to.b - from.b) * ratio,
  };
}

function channelLuminance(channel: number): number {
  const value = channel / 255;
  return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
}

function relativeLuminance(rgb: Rgb): number {
  return 0.2126 * channelLuminance(rgb.r) + 0.7152 * channelLuminance(rgb.g) + 0.0722 * channelLuminance(rgb.b);
}

function rgbToHsl(rgb: Rgb): { h: number; s: number; l: number } {
  const r = rgb.r / 255;
  const g = rgb.g / 255;
  const b = rgb.b / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const lightness = (max + min) / 2;
  if (max === min) return { h: 0, s: 0, l: lightness };

  const delta = max - min;
  const saturation = lightness > 0.5 ? delta / (2 - max - min) : delta / (max + min);
  let hue: number;
  if (max === r) hue = ((g - b) / delta + (g < b ? 6 : 0)) / 6;
  else if (max === g) hue = ((b - r) / delta + 2) / 6;
  else hue = ((r - g) / delta + 4) / 6;
  return { h: hue, s: saturation, l: lightness };
}

function hslToRgb(hue: number, saturation: number, lightness: number): Rgb {
  if (saturation === 0) {
    const value = lightness * 255;
    return { r: value, g: value, b: value };
  }
  const q = lightness < 0.5 ? lightness * (1 + saturation) : lightness + saturation - lightness * saturation;
  const p = 2 * lightness - q;
  const convert = (t: number): number => {
    let value = t;
    if (value < 0) value += 1;
    if (value > 1) value -= 1;
    if (value < 1 / 6) return p + (q - p) * 6 * value;
    if (value < 1 / 2) return q;
    if (value < 2 / 3) return p + (q - p) * (2 / 3 - value) * 6;
    return p;
  };
  return {
    r: convert(hue + 1 / 3) * 255,
    g: convert(hue) * 255,
    b: convert(hue - 1 / 3) * 255,
  };
}

function withLightness(rgb: Rgb, lightness: number): Rgb {
  const hsl = rgbToHsl(rgb);
  return hslToRgb(hsl.h, hsl.s, Math.min(1, Math.max(0, lightness)));
}

// ---------------------------------------------------------------------------
// Palette
// ---------------------------------------------------------------------------

interface Palette {
  bg: Rgb;
  fg: Rgb;
  muted: Rgb;
  surface: Rgb;
  surfaceStrong: Rgb;
  border: Rgb;
  codeBg: Rgb;
  codeInlineBg: Rgb;
  accent: Rgb;
  danger: Rgb;
  dangerBg: Rgb;
  warning: Rgb;
  warningBg: Rgb;
}

interface PaletteWeights {
  surface: number;
  surfaceStrong: number;
  border: number;
  muted: number;
  codeBg: number;
  codeInlineBg: number;
}

const LIGHT_WEIGHTS: PaletteWeights = {
  surface: 0.04,
  surfaceStrong: 0.08,
  border: 0.14,
  muted: 0.45,
  codeBg: 0.05,
  codeInlineBg: 0.07,
};

const DARK_WEIGHTS: PaletteWeights = {
  surface: 0.08,
  surfaceStrong: 0.13,
  border: 0.22,
  muted: 0.32,
  codeBg: 0.11,
  codeInlineBg: 0.15,
};

function buildPalette(theme: NormalizedTheme, mode: 'light' | 'dark'): Palette {
  const configuredBg = parseHexColor(theme.background) ?? parseHexColor(DEFAULT_THEME.background) ?? { r: 255, g: 255, b: 255 };
  const configuredFg = parseHexColor(theme.foreground) ?? parseHexColor(DEFAULT_THEME.foreground) ?? { r: 31, g: 35, b: 40 };
  const accent = parseHexColor(theme.accent) ?? parseHexColor(DEFAULT_THEME.accent) ?? { r: 47, g: 111, b: 235 };

  const bg =
    mode === 'dark' && relativeLuminance(configuredBg) > 0.35 ? withLightness(configuredBg, 0.12) : configuredBg;
  const fg = mode === 'dark' && relativeLuminance(configuredFg) < 0.4 ? withLightness(configuredFg, 0.9) : configuredFg;
  const weights = mode === 'dark' ? DARK_WEIGHTS : LIGHT_WEIGHTS;

  const dangerBase = mode === 'dark' ? { r: 255, g: 138, b: 128 } : { r: 198, g: 40, b: 40 };
  const warningBase = mode === 'dark' ? { r: 240, g: 196, b: 121 } : { r: 183, g: 121, b: 31 };

  return {
    bg,
    fg,
    muted: mix(fg, bg, weights.muted),
    surface: mix(bg, fg, weights.surface),
    surfaceStrong: mix(bg, fg, weights.surfaceStrong),
    border: mix(bg, fg, weights.border),
    codeBg: mix(bg, fg, weights.codeBg),
    codeInlineBg: mix(bg, fg, weights.codeInlineBg),
    accent,
    danger: dangerBase,
    dangerBg: mix(bg, dangerBase, mode === 'dark' ? 0.16 : 0.06),
    warning: warningBase,
    warningBg: mix(bg, warningBase, mode === 'dark' ? 0.16 : 0.07),
  };
}

function paletteVariables(palette: Palette): string[] {
  return [
    `--mdl-bg: ${rgbToHex(palette.bg)};`,
    `--mdl-fg: ${rgbToHex(palette.fg)};`,
    `--mdl-fg-muted: ${rgbToHex(palette.muted)};`,
    `--mdl-surface: ${rgbToHex(palette.surface)};`,
    `--mdl-surface-strong: ${rgbToHex(palette.surfaceStrong)};`,
    `--mdl-border: ${rgbToHex(palette.border)};`,
    `--mdl-code-bg: ${rgbToHex(palette.codeBg)};`,
    `--mdl-code-inline-bg: ${rgbToHex(palette.codeInlineBg)};`,
    `--mdl-accent: ${rgbToHex(palette.accent)};`,
    `--mdl-selection: rgba(${Math.round(palette.accent.r)}, ${Math.round(palette.accent.g)}, ${Math.round(palette.accent.b)}, 0.22);`,
    `--mdl-danger: ${rgbToHex(palette.danger)};`,
    `--mdl-danger-bg: ${rgbToHex(palette.dangerBg)};`,
    `--mdl-warning: ${rgbToHex(palette.warning)};`,
    `--mdl-warning-bg: ${rgbToHex(palette.warningBg)};`,
  ];
}

function layoutVariables(theme: NormalizedTheme, layout: LayoutConfig): string[] {
  return [
    `--mdl-body-width: ${theme.bodyWidthPx}px;`,
    `--mdl-font-family: ${theme.fontFamily};`,
    `--mdl-code-font-family: ${theme.codeFontFamily};`,
    `--mdl-font-size: ${theme.fontSizePx}px;`,
    `--mdl-line-height: ${theme.lineHeight};`,
    `--mdl-heading-scale: ${theme.headingScale};`,
    `--mdl-sidebar-width: ${layout.sidebar.widthPx}px;`,
    `--mdl-outline-width: ${OUTLINE_WIDTH_PX}px;`,
    '--mdl-gap: 2rem;',
    '--mdl-page-padding: clamp(16px, 4vw, 48px);',
    '--mdl-shell-width: calc(var(--mdl-body-width) + 560px);',
  ];
}

/** Wallpaper layers share these names in the app shell, preview and export. */
function wallpaperVariables(wallpaper: WallpaperConfig): string[] {
  const repeating = wallpaper.size === 'repeat';
  return [
    `--mdl-wallpaper-image: ${wallpaper.dataUri === null ? 'none' : `url("${wallpaper.dataUri}")`};`,
    `--mdl-wallpaper-opacity: ${wallpaper.opacity};`,
    `--mdl-wallpaper-blur: ${wallpaper.blurPx}px;`,
    `--mdl-wallpaper-size: ${repeating ? 'auto' : wallpaper.size};`,
    `--mdl-wallpaper-position: ${wallpaper.position};`,
    `--mdl-wallpaper-repeat: ${repeating ? 'repeat' : 'no-repeat'};`,
  ];
}

const BASE_CSS = `*,
*::before,
*::after {
  box-sizing: border-box;
}

html {
  background: var(--mdl-bg);
}

body {
  margin: 0;
  min-height: 100vh;
  background: var(--mdl-bg);
  color: var(--mdl-fg);
  font-family: var(--mdl-font-family);
  font-size: var(--mdl-font-size);
  line-height: var(--mdl-line-height);
  -webkit-font-smoothing: antialiased;
  text-rendering: optimizeLegibility;
}

::selection {
  background: var(--mdl-selection);
}

.mdl-shell {
  position: relative;
  isolation: isolate;
  display: flex;
  align-items: flex-start;
  gap: var(--mdl-gap);
  max-width: var(--mdl-shell-width);
  margin: 0 auto;
  padding: var(--mdl-page-padding);
}

.mdl-shell::before {
  content: '';
  position: fixed;
  inset: 0;
  z-index: 0;
  pointer-events: none;
  background-image: var(--mdl-wallpaper-image, none);
  background-position: var(--mdl-wallpaper-position, center);
  background-size: var(--mdl-wallpaper-size, cover);
  background-repeat: var(--mdl-wallpaper-repeat, no-repeat);
  opacity: var(--mdl-wallpaper-opacity, 0);
  filter: blur(var(--mdl-wallpaper-blur, 0px));
}

.mdl-shell > * {
  position: relative;
  z-index: 1;
}

.mdl-main {
  order: 3;
  flex: 1 1 auto;
  min-width: 0;
  max-width: var(--mdl-body-width);
  margin-inline: auto;
}

.mdl-sidebar {
  order: 1;
  flex: 0 0 var(--mdl-sidebar-width);
  width: var(--mdl-sidebar-width);
  max-height: calc(100vh - 2 * var(--mdl-page-padding));
  position: sticky;
  top: var(--mdl-page-padding);
  overflow: auto;
  padding: 0.25rem 1rem 0.25rem 0;
  border-right: 1px solid var(--mdl-border);
  color: var(--mdl-fg-muted);
  font-size: 0.85em;
}

html[data-mdl-sidebar='hidden'] .mdl-sidebar {
  display: none;
}

html[data-mdl-sidebar-position='right'] .mdl-sidebar {
  order: 4;
  padding: 0.25rem 0 0.25rem 1rem;
  border-right: 0;
  border-left: 1px solid var(--mdl-border);
}

.mdl-outline {
  order: 4;
  flex: 0 0 var(--mdl-outline-width);
  width: var(--mdl-outline-width);
  max-height: calc(100vh - 2 * var(--mdl-page-padding));
  position: sticky;
  top: var(--mdl-page-padding);
  overflow: auto;
  padding: 0.25rem 0 0.25rem 1rem;
  border-left: 1px solid var(--mdl-border);
  color: var(--mdl-fg-muted);
  font-size: 0.85em;
}

html[data-mdl-outline='hidden'] .mdl-outline {
  display: none;
}

html[data-mdl-outline-position='left'] .mdl-outline {
  order: 2;
  padding: 0.25rem 1rem 0.25rem 0;
  border-left: 0;
  border-right: 1px solid var(--mdl-border);
}

.mdl-sidebar-heading,
.mdl-outline-heading {
  margin: 0 0 0.6rem;
  font-size: 0.75rem;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--mdl-fg-muted);
}

.mdl-sidebar-path {
  margin: 0;
  font-family: var(--mdl-code-font-family);
  font-size: 0.85em;
  overflow-wrap: anywhere;
}

.mdl-outline-list {
  margin: 0;
  padding: 0;
  list-style: none;
}

.mdl-outline-item {
  margin: 0.15rem 0;
  overflow-wrap: anywhere;
}

.mdl-outline-item[data-depth='2'] {
  padding-left: 0.75rem;
}

.mdl-outline-item[data-depth='3'] {
  padding-left: 1.5rem;
}

.mdl-outline-item[data-depth='4'] {
  padding-left: 2.25rem;
}

.mdl-outline-item[data-depth='5'] {
  padding-left: 3rem;
}

.mdl-outline-item[data-depth='6'] {
  padding-left: 3.75rem;
}

.mdl-outline-item a {
  color: inherit;
  text-decoration: none;
}

.mdl-outline-item a:hover {
  color: var(--mdl-accent);
}

.mdl-outline-empty {
  margin: 0;
}

.mdl-titleblock {
  margin: 0 0 2rem;
  padding-bottom: 1rem;
  border-bottom: 1px solid var(--mdl-border);
}

html[data-mdl-title='hidden'] .mdl-titleblock {
  display: none;
}

.mdl-doc-title {
  margin: 0 0 0.4rem;
  font-size: calc(2em * var(--mdl-heading-scale));
  line-height: 1.2;
  overflow-wrap: anywhere;
}

.mdl-doc-path {
  margin: 0;
  color: var(--mdl-fg-muted);
  font-family: var(--mdl-code-font-family);
  font-size: 0.8em;
  overflow-wrap: anywhere;
}

.mdl-content {
  overflow-wrap: break-word;
}

.mdl-content > :first-child {
  margin-top: 0;
}

.mdl-content p {
  margin: 0 0 1em;
}

.mdl-content h1,
.mdl-content h2,
.mdl-content h3,
.mdl-content h4,
.mdl-content h5,
.mdl-content h6 {
  margin: 1.8em 0 0.65em;
  line-height: 1.25;
  font-weight: 650;
  scroll-margin-top: 1rem;
}

.mdl-content h1 {
  font-size: calc(1.9em * var(--mdl-heading-scale));
}

.mdl-content h2 {
  font-size: calc(1.55em * var(--mdl-heading-scale));
}

.mdl-content h3 {
  font-size: calc(1.3em * var(--mdl-heading-scale));
}

.mdl-content h4 {
  font-size: calc(1.12em * var(--mdl-heading-scale));
}

.mdl-content h5 {
  font-size: calc(1em * var(--mdl-heading-scale));
}

.mdl-content h6 {
  font-size: calc(0.92em * var(--mdl-heading-scale));
}

.mdl-heading-anchor {
  margin-left: 0.35em;
  font-size: 0.75em;
  font-weight: 400;
  color: var(--mdl-fg-muted);
  text-decoration: none;
  opacity: 0;
  transition: opacity 0.15s ease;
}

.mdl-heading:hover .mdl-heading-anchor,
.mdl-heading-anchor:focus {
  opacity: 0.8;
}

.mdl-content ul,
.mdl-content ol {
  margin: 0 0 1em;
  padding-left: 1.6em;
}

.mdl-content li {
  margin: 0.25em 0;
}

.mdl-content li > ul,
.mdl-content li > ol {
  margin: 0.25em 0;
}

.mdl-content input[type='checkbox'] {
  margin: 0 0.5em 0 0;
  vertical-align: middle;
  accent-color: var(--mdl-accent);
}

.mdl-content li:has(> input[type='checkbox']) {
  list-style: none;
  margin-left: -1.35em;
}

.mdl-content blockquote {
  margin: 1.2em 0;
  padding: 0.2em 1em;
  border-left: 3px solid var(--mdl-accent);
  background: var(--mdl-surface);
  color: var(--mdl-fg-muted);
}

.mdl-content blockquote > :last-child {
  margin-bottom: 0;
}

.mdl-content hr {
  margin: 2em 0;
  border: 0;
  border-top: 1px solid var(--mdl-border);
}

.mdl-content a {
  color: var(--mdl-accent);
  text-decoration: underline;
  text-decoration-thickness: 1px;
  text-underline-offset: 0.18em;
}

.mdl-content a:hover {
  text-decoration-thickness: 2px;
}

.mdl-link-blocked {
  color: var(--mdl-fg-muted);
  text-decoration: line-through;
}

.mdl-content code {
  font-family: var(--mdl-code-font-family);
  font-size: 0.9em;
  background: var(--mdl-code-inline-bg);
  border-radius: 4px;
  padding: 0.12em 0.35em;
}

.mdl-content pre {
  margin: 0 0 1.2em;
  padding: 0.9rem 1rem;
  overflow: auto;
  background: var(--mdl-code-bg);
  border: 1px solid var(--mdl-border);
  border-radius: 8px;
  line-height: 1.55;
}

.mdl-content pre code {
  padding: 0;
  background: none;
  font-size: 0.92em;
  border-radius: 0;
}

.mdl-content table {
  display: block;
  width: 100%;
  max-width: 100%;
  overflow-x: auto;
  margin: 1.2em 0;
  border-collapse: collapse;
  font-size: 0.95em;
}

.mdl-content th,
.mdl-content td {
  padding: 0.45em 0.7em;
  border: 1px solid var(--mdl-border);
  text-align: left;
  vertical-align: top;
}

.mdl-content thead th {
  background: var(--mdl-surface-strong);
  font-weight: 650;
}

.mdl-content tbody tr:nth-child(even) {
  background: var(--mdl-surface);
}

.mdl-content img {
  max-width: 100%;
  height: auto;
  border-radius: 6px;
}

.mdl-image-missing {
  display: inline-flex;
  flex-direction: column;
  gap: 0.15em;
  padding: 0.4em 0.6em;
  border: 1px dashed var(--mdl-danger);
  border-radius: 6px;
  background: var(--mdl-danger-bg);
  color: var(--mdl-danger);
  font-size: 0.9em;
}

.mdl-image-missing-detail {
  font-size: 0.85em;
  opacity: 0.85;
}

.mdl-wikilink {
  text-decoration: underline dotted;
  text-underline-offset: 0.2em;
}

.mdl-wikilink-missing {
  color: var(--mdl-danger);
}

.mdl-wikilink-ambiguous {
  color: var(--mdl-warning);
}

.mdl-wikilink-unresolved {
  color: var(--mdl-fg-muted);
}

@media (max-width: 900px) {
  .mdl-shell {
    display: block;
  }

  .mdl-sidebar,
  .mdl-outline {
    position: static;
    flex: 0 0 auto;
    width: auto;
    max-height: none;
    margin: 0 0 1.5rem;
    padding: 0;
    border: 0;
  }
}

@media print {
  .mdl-shell {
    display: block;
    max-width: none;
    padding: 0;
  }

  .mdl-sidebar,
  .mdl-outline {
    display: none !important;
  }

  .mdl-main {
    max-width: none;
  }

  .mdl-content a {
    color: inherit;
  }

  .mdl-heading-anchor {
    display: none;
  }
}`;

/** Builds the one stylesheet shared by preview and export. */
export function buildThemeCss(theme?: ThemeConfig | null, layout?: LayoutConfig | null): string {
  const normalizedTheme = normalizeTheme(theme);
  const normalizedLayout = normalizeLayout(layout);
  const mode = normalizedTheme.mode;
  const paletteMode: 'light' | 'dark' = mode === 'dark' ? 'dark' : 'light';
  const baseVariables = paletteVariables(buildPalette(normalizedTheme, paletteMode));
  const customVariables = Object.entries(normalizedTheme.customVariables)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([key, value]) => `${key}: ${value};`);

  const colorScheme = mode === 'dark' ? 'dark' : mode === 'light' ? 'light' : 'light dark';
  const rootBlock = [
    ':root {',
    `  color-scheme: ${colorScheme};`,
    ...baseVariables.map((line) => `  ${line}`),
    ...layoutVariables(normalizedTheme, normalizedLayout).map((line) => `  ${line}`),
    ...wallpaperVariables(normalizedTheme.wallpaper).map((line) => `  ${line}`),
    ...customVariables.map((line) => `  ${line}`),
    '}',
  ].join('\n');

  const blocks = [rootBlock];

  if (mode === 'system') {
    const darkVariables = paletteVariables(buildPalette(normalizedTheme, 'dark'));
    blocks.push(
      [
        '@media (prefers-color-scheme: dark) {',
        '  :root {',
        ...darkVariables.map((line) => `    ${line}`),
        '  }',
        '}',
      ].join('\n'),
    );
  }

  blocks.push(BASE_CSS);
  return blocks.join('\n\n');
}
