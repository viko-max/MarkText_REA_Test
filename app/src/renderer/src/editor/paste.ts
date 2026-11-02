/**
 * Pure helpers for pasted-image insertion.
 *
 * The editor takes over a paste only when the clipboard carries a PNG, JPEG,
 * GIF or WebP file. Everything here is DOM-free so the accepted formats, the
 * canonical base64 payload, the generated file name, the Markdown escape rules
 * and the document-relative path can be unit tested without CodeMirror.
 */

export const PASTED_IMAGE_MEDIA_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'] as const;

export type PastedImageMediaType = (typeof PASTED_IMAGE_MEDIA_TYPES)[number];

export const SVG_PASTE_MESSAGE =
  '不支持粘贴 SVG 图片：SVG 可以携带脚本与外部引用，请改用 PNG、JPEG、GIF 或 WebP。';

export interface PastedFileLike {
  readonly type?: string;
  readonly name?: string;
  readonly size?: number;
  arrayBuffer?(): Promise<ArrayBuffer>;
}

export type PastedImageDetection =
  | { kind: 'supported'; mediaType: PastedImageMediaType; file: PastedFileLike }
  | { kind: 'svg'; message: string }
  | { kind: 'none' };

const EXTENSION_MEDIA_TYPES: Record<string, PastedImageMediaType | 'image/svg+xml'> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
};

const MEDIA_TYPE_EXTENSIONS: Record<PastedImageMediaType, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
};

const BASE64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/** Media type declared by the file, falling back to its extension. */
export function pastedImageMediaType(file: PastedFileLike): string | null {
  const type = (file.type ?? '').trim().toLowerCase();
  if (type.startsWith('image/')) return type;

  const name = (file.name ?? '').trim().toLowerCase();
  const dot = name.lastIndexOf('.');
  if (dot < 0 || dot === name.length - 1) return null;
  return EXTENSION_MEDIA_TYPES[name.slice(dot + 1)] ?? null;
}

/**
 * Decides whether a paste belongs to the editor. The first supported image
 * wins; an SVG-only clipboard is reported so the user learns why nothing was
 * inserted; everything else is left to CodeMirror.
 */
export function detectPastedImage(files: readonly PastedFileLike[]): PastedImageDetection {
  let sawSvg = false;
  for (const file of files) {
    const mediaType = pastedImageMediaType(file);
    if (mediaType === 'image/svg+xml') {
      sawSvg = true;
      continue;
    }
    if (mediaType !== null && (PASTED_IMAGE_MEDIA_TYPES as readonly string[]).includes(mediaType)) {
      return { kind: 'supported', mediaType: mediaType as PastedImageMediaType, file };
    }
  }
  return sawSvg ? { kind: 'svg', message: SVG_PASTE_MESSAGE } : { kind: 'none' };
}

/** Standard padded base64 with no line breaks or data-URL prefix. */
export function encodeBase64(bytes: Uint8Array): string {
  let output = '';
  for (let index = 0; index < bytes.length; index += 3) {
    const first = bytes[index] ?? 0;
    const second = bytes[index + 1];
    const third = bytes[index + 2];
    const hasSecond = second !== undefined;
    const hasThird = third !== undefined;
    const combined = (first << 16) | ((second ?? 0) << 8) | (third ?? 0);
    output += BASE64_ALPHABET.charAt((combined >> 18) & 63);
    output += BASE64_ALPHABET.charAt((combined >> 12) & 63);
    output += hasSecond ? BASE64_ALPHABET.charAt((combined >> 6) & 63) : '=';
    output += hasThird ? BASE64_ALPHABET.charAt(combined & 63) : '=';
  }
  return output;
}

export function encodeBase64FromBuffer(buffer: ArrayBuffer): string {
  return encodeBase64(new Uint8Array(buffer));
}

function timestamp(now: Date): string {
  const pad = (value: number): string => String(value).padStart(2, '0');
  return [
    now.getFullYear(),
    pad(now.getMonth() + 1),
    pad(now.getDate()),
    '-',
    pad(now.getHours()),
    pad(now.getMinutes()),
    pad(now.getSeconds()),
  ].join('');
}

/** Plain file name sent to `images.save`; the asset path is content-addressed. */
export function pastedImageFileName(mediaType: PastedImageMediaType, now: Date): string {
  return `pasted-${timestamp(now)}.${MEDIA_TYPE_EXTENSIONS[mediaType]}`;
}

/** Percent-escapes the characters Markdown link destinations cannot carry. */
export function escapeMarkdownImagePath(path: string): string {
  return path
    .replace(/%/g, '%25')
    .replace(/ /g, '%20')
    .replace(/\(/g, '%28')
    .replace(/\)/g, '%29')
    .replace(/#/g, '%23')
    .replace(/\?/g, '%3F')
    .replace(/</g, '%3C')
    .replace(/>/g, '%3E');
}

/** POSIX path of `targetPath` as seen from the folder of `fromDocumentPath`. */
export function relativeWorkspacePath(fromDocumentPath: string, targetPath: string): string {
  const from = fromDocumentPath.split('/').slice(0, -1);
  const to = targetPath.split('/');
  let common = 0;
  while (common < from.length && common < to.length) {
    const left = from[common] ?? '';
    const right = to[common] ?? '';
    if (left.toLowerCase() !== right.toLowerCase()) break;
    common += 1;
  }
  const segments = [...Array.from({ length: from.length - common }, () => '..'), ...to.slice(common)];
  return segments.join('/');
}

/** `![](…)` for an asset path, relative to the document that references it. */
export function buildImageMarkdown(assetPath: string, documentPath: string): string {
  const relative = relativeWorkspacePath(documentPath, assetPath);
  return `![](${escapeMarkdownImagePath(relative)})`;
}
