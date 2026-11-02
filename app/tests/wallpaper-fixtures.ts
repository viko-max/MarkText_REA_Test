/**
 * Wallpaper fixtures shared by the unit tests.
 *
 * The bytes come from the checked-in `fixtures/notes-demo/assets/pixel.png`, so
 * the data URI is a real canonical base64 PNG rather than a hand-written literal.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { ThemeConfig } from '../src/shared/contracts';

const PNG_PATH = fileURLToPath(
  new URL('../../fixtures/notes-demo/assets/pixel.png', import.meta.url),
);

export const WALLPAPER_PNG_BYTES = readFileSync(PNG_PATH);

export const WALLPAPER_BASE64 = WALLPAPER_PNG_BYTES.toString('base64');

export const WALLPAPER_DATA_URI = `data:image/png;base64,${WALLPAPER_BASE64}`;

/** A theme exactly as it was persisted before wallpapers existed. */
export function legacyTheme(theme: ThemeConfig): Omit<ThemeConfig, 'wallpaper'> {
  const { wallpaper: _discarded, ...legacy } = theme;
  return legacy;
}
