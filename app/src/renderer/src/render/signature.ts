/**
 * Content signature for "unexported changes" tracking.
 *
 * The signature covers the Markdown source, the normalised theme and layout, and
 * the resolved resource identities (path, size, hash, status). It is stored in
 * the exported document as `<meta name="mdl-signature">` and compared with the
 * current render to decide whether the file on disk still matches the editor.
 */

import type { LayoutConfig, ThemeConfig } from '../../../shared/contracts';
import { sha256Hex } from './hash';
import { normalizeLayout, normalizeTheme } from './theme';
import type { RenderAssetRecord } from './types';

export interface SignatureInput {
  documentPath: string;
  markdown: string;
  theme: ThemeConfig;
  layout: LayoutConfig;
  assets: readonly RenderAssetRecord[];
}

function sortedVariables(variables: Record<string, string>): Array<[string, string]> {
  return Object.entries(variables).sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
}

export function computeRenderSignature(input: SignatureInput): string {
  const theme = normalizeTheme(input.theme);
  const layout = normalizeLayout(input.layout);
  const wallpaperDigest =
    theme.wallpaper.dataUri === null ? null : `sha256:${sha256Hex(theme.wallpaper.dataUri)}`;
  const payload = {
    version: 1,
    documentPath: input.documentPath,
    markdown: input.markdown,
    theme: {
      mode: theme.mode,
      bodyWidthPx: theme.bodyWidthPx,
      fontFamily: theme.fontFamily,
      fontSizePx: theme.fontSizePx,
      lineHeight: theme.lineHeight,
      codeFontFamily: theme.codeFontFamily,
      foreground: theme.foreground,
      background: theme.background,
      accent: theme.accent,
      headingScale: theme.headingScale,
      customVariables: sortedVariables(theme.customVariables),
      wallpaper: {
        dataUri: wallpaperDigest,
        opacity: theme.wallpaper.opacity,
        blurPx: theme.wallpaper.blurPx,
        size: theme.wallpaper.size,
        position: theme.wallpaper.position,
      },
    },
    layout: {
      sidebar: { visible: layout.sidebar.visible, position: layout.sidebar.position, widthPx: layout.sidebar.widthPx },
      outline: { visible: layout.outline.visible, position: layout.outline.position },
      title: { visible: layout.title.visible },
    },
    resources: input.assets.map((asset) => ({
      href: asset.href,
      status: asset.status,
      path: asset.path,
      reason: asset.reason,
      mediaType: asset.mediaType,
      bytes: asset.bytes,
      sha256: asset.sha256,
    })),
  };
  return `sha256:${sha256Hex(JSON.stringify(payload))}`;
}
