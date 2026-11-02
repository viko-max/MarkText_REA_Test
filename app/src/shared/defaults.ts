import type { LayoutConfig, ThemeConfig, WallpaperConfig, WorkspaceUiState } from './contracts';
import { WORKSPACE_STATE_VERSION } from './contracts';

export const DEFAULT_WALLPAPER: WallpaperConfig = {
  dataUri: null,
  opacity: 0.35,
  blurPx: 0,
  size: 'cover',
  position: 'center',
};

export const DEFAULT_THEME: ThemeConfig = {
  mode: 'system',
  bodyWidthPx: 860,
  fontFamily: '"Segoe UI", "Microsoft YaHei", system-ui, sans-serif',
  fontSizePx: 16,
  lineHeight: 1.7,
  codeFontFamily: '"Cascadia Code", Consolas, "Courier New", monospace',
  foreground: '#1f2328',
  background: '#ffffff',
  accent: '#2f6feb',
  headingScale: 1.25,
  customVariables: {},
  wallpaper: { ...DEFAULT_WALLPAPER },
};

export const DEFAULT_LAYOUT: LayoutConfig = {
  sidebar: { visible: true, position: 'left', widthPx: 260 },
  outline: { visible: true, position: 'right' },
  title: { visible: true },
};

/** A theme whose nested objects are safe to mutate without touching the default. */
export function createDefaultTheme(): ThemeConfig {
  return { ...DEFAULT_THEME, customVariables: {}, wallpaper: { ...DEFAULT_WALLPAPER } };
}

export function createDefaultWorkspaceUiState(
  workspaceRootPath: string | null,
  now: string = new Date().toISOString(),
): WorkspaceUiState {
  return {
    version: WORKSPACE_STATE_VERSION,
    workspaceRootPath,
    openDocuments: [],
    activeDocument: null,
    theme: createDefaultTheme(),
    layout: {
      sidebar: { ...DEFAULT_LAYOUT.sidebar },
      outline: { ...DEFAULT_LAYOUT.outline },
      title: { ...DEFAULT_LAYOUT.title },
    },
    documentViews: {},
    updatedAt: now,
  };
}
