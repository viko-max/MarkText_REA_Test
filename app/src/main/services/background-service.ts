/**
 * Native wallpaper import.
 *
 * The renderer can never hand over a path: the user picks the file in a native
 * open dialog and the renderer only receives a canonical base64 data URI plus
 * the sniffed media type. The absolute path never leaves this module and is
 * never persisted in the theme configuration.
 */

import type { BrowserWindow } from 'electron';
import { dialog } from 'electron';
import { readFile, stat } from 'node:fs/promises';
import type { ChooseBackgroundResult, ImageMediaType } from '../../shared/contracts';
import { MAX_IMAGE_BYTES } from '../../shared/validation';
import { AppError } from '../errors';
import { sha256Hex } from './atomic-write';
import { mediaTypeMatchesExtension, SAFE_MEDIA_TYPES, sniffImage } from './image-sniff';

/** Formats a wallpaper may use; GIF and SVG are deliberately excluded. */
const WALLPAPER_MEDIA_TYPES: readonly ImageMediaType[] = ['image/png', 'image/jpeg', 'image/webp'];

const WALLPAPER_FILTERS = [
  { name: '图片', extensions: ['png', 'jpg', 'jpeg', 'webp'] },
];

export interface BackgroundHost {
  getWindow(): BrowserWindow | null;
}

export interface BackgroundServiceOptions {
  /** Upper bound for the picked file, checked by stat and by byte length. */
  maxWallpaperBytes?: number;
}

export class BackgroundService {
  private readonly maxBytes: number;

  constructor(
    private readonly host: BackgroundHost,
    options: BackgroundServiceOptions = {},
  ) {
    this.maxBytes = options.maxWallpaperBytes ?? MAX_IMAGE_BYTES;
  }

  async choose(): Promise<ChooseBackgroundResult> {
    const window = this.host.getWindow();
    const options = {
      title: '选择壁纸图片',
      buttonLabel: '使用这张图片',
      properties: ['openFile'] as Array<'openFile'>,
      filters: WALLPAPER_FILTERS,
    };
    const result = window
      ? await dialog.showOpenDialog(window, options)
      : await dialog.showOpenDialog(options);

    const selected = result.filePaths[0];
    if (result.canceled || !selected) return { cancelled: true, wallpaper: null };

    const stats = await stat(selected);
    if (!stats.isFile()) {
      throw new AppError('invalid_path', '壁纸必须是一个文件');
    }
    if (stats.size > this.maxBytes) {
      throw new AppError('too_large', '壁纸图片超过大小上限', {
        bytes: stats.size,
        maxBytes: this.maxBytes,
      });
    }

    const bytes = await readFile(selected);
    if (bytes.byteLength === 0) {
      throw new AppError('invalid_request', '壁纸图片内容为空');
    }
    if (bytes.byteLength > this.maxBytes) {
      throw new AppError('too_large', '壁纸图片超过大小上限', {
        bytes: bytes.byteLength,
        maxBytes: this.maxBytes,
      });
    }

    const sniffed = sniffImage(bytes);
    if (sniffed === null) {
      throw new AppError('invalid_request', '这不是受支持的图片格式（仅支持 PNG/JPEG/WebP）');
    }
    if (!SAFE_MEDIA_TYPES.includes(sniffed.mediaType)) {
      throw new AppError('forbidden', '不允许使用这种图片格式作为壁纸', {
        mediaType: sniffed.mediaType,
        reason: 'unsafe',
      });
    }
    if (!WALLPAPER_MEDIA_TYPES.includes(sniffed.mediaType)) {
      throw new AppError('invalid_request', '壁纸只支持 PNG/JPEG/WebP', {
        mediaType: sniffed.mediaType,
      });
    }
    if (!mediaTypeMatchesExtension(sniffed.mediaType, selected)) {
      throw new AppError('invalid_request', '文件扩展名与实际图片格式不一致', {
        mediaType: sniffed.mediaType,
      });
    }

    return {
      cancelled: false,
      wallpaper: {
        dataUri: `data:${sniffed.mediaType};base64,${bytes.toString('base64')}`,
        mediaType: sniffed.mediaType,
        bytes: bytes.byteLength,
        sha256: sha256Hex(bytes),
      },
    };
  }
}
