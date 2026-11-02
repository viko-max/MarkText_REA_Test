/**
 * Magic-byte image sniffing shared by resource and wallpaper import.
 *
 * Only the bytes decide the format; the file name or a renderer-declared media
 * type can never upgrade a payload. SVG is detected so callers can refuse it
 * explicitly instead of treating it as "unknown".
 */

import type { ImageMediaType } from '../../shared/contracts';

export interface SniffedImage {
  mediaType: ImageMediaType;
  extension: 'png' | 'jpg' | 'gif' | 'webp' | 'svg';
}

/** Formats that cannot carry script and are safe to store in a workspace. */
export const SAFE_MEDIA_TYPES: readonly ImageMediaType[] = [
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
];

export const EXTENSIONS_BY_MEDIA_TYPE: Record<string, string[]> = {
  'image/png': ['.png'],
  'image/jpeg': ['.jpg', '.jpeg'],
  'image/gif': ['.gif'],
  'image/webp': ['.webp'],
};

function startsWith(bytes: Buffer, signature: readonly number[], offset = 0): boolean {
  if (bytes.length < offset + signature.length) return false;
  for (let index = 0; index < signature.length; index += 1) {
    if (bytes[offset + index] !== signature[index]) return false;
  }
  return true;
}

function ascii(bytes: Buffer, offset: number, length: number): string {
  return bytes.subarray(offset, offset + length).toString('latin1');
}

function looksLikeSvg(bytes: Buffer): boolean {
  const head = bytes.subarray(0, 1024).toString('utf8').replace(/^\uFEFF/, '').trimStart();
  return head.startsWith('<') && /<svg[\s>]/i.test(head);
}

export function sniffImage(bytes: Buffer): SniffedImage | null {
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    return { mediaType: 'image/png', extension: 'png' };
  }
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) {
    return { mediaType: 'image/jpeg', extension: 'jpg' };
  }
  const gifHeader = ascii(bytes, 0, 6);
  if (gifHeader === 'GIF87a' || gifHeader === 'GIF89a') {
    return { mediaType: 'image/gif', extension: 'gif' };
  }
  if (ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 4) === 'WEBP') {
    return { mediaType: 'image/webp', extension: 'webp' };
  }
  if (looksLikeSvg(bytes)) {
    return { mediaType: 'image/svg+xml', extension: 'svg' };
  }
  return null;
}

/** True when the file name's extension is one of the sniffed type's extensions. */
export function mediaTypeMatchesExtension(mediaType: ImageMediaType, fileName: string): boolean {
  const match = /\.[^./\\]+$/.exec(fileName);
  if (match === null) return false;
  const allowed = EXTENSIONS_BY_MEDIA_TYPE[mediaType];
  return allowed !== undefined && allowed.includes(match[0].toLowerCase());
}
