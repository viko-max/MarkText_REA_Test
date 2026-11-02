/**
 * Image resource resolution for the render pipeline.
 *
 * The pipeline never touches the filesystem itself. A resolver (in practice a
 * thin adapter over the future `window.markdownLite.images.read` IPC method)
 * returns base64 bytes, and everything is validated here against an explicit
 * allowlist: media type, magic bytes, declared byte length, size limit and SVG
 * safety. Nothing is silently dropped — an unresolvable or rejected reference
 * stays in the document as a visible marker and appears in the dependency
 * report.
 */

import type { ExportDependencyReport, ExternalAssetDependency, ImageMediaType } from '../../../shared/contracts';
import { isWorkspaceRelativePath, workspaceExtname } from '../../../shared/paths';
import type { IpcResult } from '../../../shared/ipc';
import { base64ByteLength, bytesToLatin1, decodeBase64 } from './base64';
import { isExternalUrl, sanitizeUrl } from './escape';
import type {
  ImageResourceData,
  ImageResourceResolver,
  ImageStatus,
  RenderAssetRecord,
  RenderWarning,
  ResolvedImage,
} from './types';

export const ALLOWED_IMAGE_MEDIA_TYPES: readonly ImageMediaType[] = [
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'image/svg+xml',
];

/** Default ceiling for a single embedded image (8 MiB). */
export const DEFAULT_MAX_IMAGE_BYTES = 8 * 1024 * 1024;

const EXTENSION_MEDIA_TYPES: Record<string, ImageMediaType> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
};

const SCHEME_PATTERN = /^([a-z][a-z0-9+.-]*):/i;

export type ImageSourceKind = 'remote' | 'inline' | 'local' | 'unsafe';

export interface ImageSourceClassification {
  kind: ImageSourceKind;
  path: string | null;
  url: string | null;
  reason: string | null;
}

// ---------------------------------------------------------------------------
// Classification and workspace path normalisation
// ---------------------------------------------------------------------------

function decodePath(value: string): string | null {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

/**
 * Resolves an image reference relative to the document that contains it.
 *
 * Windows notes write relative links with a backslash (`assets\pixel.png`), so
 * the decoded reference is normalised to POSIX separators before segment
 * traversal. Normalisation covers only the separator: `classifyImageSource`
 * still rejects absolute references, a reference that starts with a separator
 * (root-relative or UNC) is rejected here, and `..` still cannot leave the
 * workspace root because traversal runs after the normalisation.
 *
 * Returns `{ path }` for a workspace-relative image, or `{ reason }` when the
 * reference is not one.
 */
export function resolveWorkspaceImagePath(
  documentPath: string,
  href: string,
): { path: string } | { reason: string } {
  const cut = href.search(/[?#]/);
  const withoutQuery = cut >= 0 ? href.slice(0, cut) : href;
  const decoded = decodePath(withoutQuery);
  if (decoded === null) return { reason: 'invalid_encoding' };
  const normalized = decoded.replace(/\\/g, '/');
  if (normalized.startsWith('/')) return { reason: 'absolute_path' };

  const base = documentPath.length > 0 ? documentPath.split('/').slice(0, -1) : [];
  const segments = [...base];
  for (const segment of normalized.split('/')) {
    if (segment.length === 0 || segment === '.') continue;
    if (segment === '..') {
      if (segments.length === 0) return { reason: 'outside_workspace' };
      segments.pop();
      continue;
    }
    segments.push(segment);
  }

  const path = segments.join('/');
  if (path.length === 0) return { reason: 'empty_path' };
  if (!isWorkspaceRelativePath(path)) return { reason: 'invalid_path' };
  return { path };
}

export function classifyImageSource(href: string, documentPath: string): ImageSourceClassification {
  const trimmed = href.trim();
  if (trimmed.length === 0) return { kind: 'unsafe', path: null, url: null, reason: 'empty_reference' };

  if (isExternalUrl(trimmed)) {
    return { kind: 'remote', path: null, url: trimmed, reason: null };
  }

  if (/^data:/i.test(trimmed)) {
    return sanitizeUrl(trimmed, 'image') !== null
      ? { kind: 'inline', path: null, url: trimmed, reason: null }
      : { kind: 'unsafe', path: null, url: trimmed, reason: 'unsupported_data_uri' };
  }

  const scheme = SCHEME_PATTERN.exec(trimmed);
  if (scheme) {
    return { kind: 'unsafe', path: null, url: trimmed, reason: `blocked_scheme:${(scheme[1] ?? '').toLowerCase()}` };
  }

  if (trimmed.startsWith('/') || trimmed.startsWith('\\\\') || /^[a-zA-Z]:[\\/]/.test(trimmed)) {
    return { kind: 'unsafe', path: null, url: trimmed, reason: 'absolute_path' };
  }

  const resolved = resolveWorkspaceImagePath(documentPath, trimmed);
  if ('reason' in resolved) {
    return { kind: 'unsafe', path: null, url: trimmed, reason: resolved.reason };
  }
  return { kind: 'local', path: resolved.path, url: null, reason: null };
}

// ---------------------------------------------------------------------------
// Payload validation
// ---------------------------------------------------------------------------

function asciiAt(bytes: Uint8Array, offset: number, text: string): boolean {
  if (bytes.length < offset + text.length) return false;
  for (let index = 0; index < text.length; index += 1) {
    if (bytes[offset + index] !== text.charCodeAt(index)) return false;
  }
  return true;
}

/** Detects the real image format from magic bytes / SVG text. */
export function sniffImageMediaType(bytes: Uint8Array): ImageMediaType | null {
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return 'image/png';
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (asciiAt(bytes, 0, 'GIF87a') || asciiAt(bytes, 0, 'GIF89a')) return 'image/gif';
  if (asciiAt(bytes, 0, 'RIFF') && asciiAt(bytes, 8, 'WEBP')) return 'image/webp';

  const head = bytesToLatin1(bytes.subarray(0, Math.min(bytes.length, 1024))).trimStart();
  const svgPattern = /^(?:<\?xml[\s\S]*?\?>\s*)?(?:<!--[\s\S]*?-->\s*)*(?:<!DOCTYPE[^>]*>\s*)?<svg[\s>]/i;
  if (svgPattern.test(head)) return 'image/svg+xml';
  return null;
}

const SVG_REJECTIONS: ReadonlyArray<readonly [RegExp, string]> = [
  [/<script[\s>]/, 'script_element'],
  [/<foreignobject[\s>]/, 'foreign_object'],
  [/\son[a-z]+\s*=/, 'event_handler_attribute'],
  [/javascript\s*:/, 'javascript_url'],
  [/<!entity/, 'entity_declaration'],
  [/<iframe[\s>]|<object[\s>]|<embed[\s>]/, 'embedded_element'],
  [/<\?xml-stylesheet/, 'xml_stylesheet'],
  [/(?:xlink:href|href)\s*=\s*["']?\s*(?:https?:)?\/\//, 'external_reference'],
  [/url\s*\(\s*["']?\s*(?:https?:)?\/\//, 'external_css_url'],
  [/data:text\/html/, 'html_data_uri'],
];

/** Returns the first unsafe construct in an SVG payload, or `null`. */
export function inspectSvgSafety(text: string): string | null {
  const lower = text.toLowerCase();
  for (const [pattern, reason] of SVG_REJECTIONS) {
    if (pattern.test(lower)) return reason;
  }
  return null;
}

export type ImageValidation =
  | { ok: true; dataUri: string }
  | { ok: false; status: 'unsafe' | 'too_large'; reason: string };

function normalizeMediaType(value: unknown): ImageMediaType | null {
  return ALLOWED_IMAGE_MEDIA_TYPES.includes(value as ImageMediaType) ? (value as ImageMediaType) : null;
}

/**
 * Validates one resolver response. `expectedPath` is the path the pipeline
 * asked for; a resolver may not answer with a different file.
 */
export function validateImagePayload(
  data: ImageResourceData,
  expectedPath: string,
  maxBytes: number = DEFAULT_MAX_IMAGE_BYTES,
): ImageValidation {
  const mediaType = normalizeMediaType(data.mediaType);
  if (!mediaType) return { ok: false, status: 'unsafe', reason: 'unsupported_media_type' };
  if (data.path !== expectedPath && data.path.toLowerCase() !== expectedPath.toLowerCase()) {
    return { ok: false, status: 'unsafe', reason: 'path_mismatch' };
  }
  if (typeof data.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(data.sha256)) {
    return { ok: false, status: 'unsafe', reason: 'invalid_sha256' };
  }
  if (!Number.isInteger(data.bytes) || data.bytes <= 0) {
    return { ok: false, status: 'unsafe', reason: 'invalid_byte_length' };
  }
  if (typeof data.dataBase64 !== 'string') {
    return { ok: false, status: 'unsafe', reason: 'invalid_base64' };
  }

  const declaredLength = base64ByteLength(data.dataBase64);
  if (declaredLength === null || declaredLength !== data.bytes) {
    return { ok: false, status: 'unsafe', reason: 'byte_length_mismatch' };
  }

  const extension = workspaceExtname(expectedPath);
  const expectedByExtension = EXTENSION_MEDIA_TYPES[extension];
  if (expectedByExtension && expectedByExtension !== mediaType) {
    return { ok: false, status: 'unsafe', reason: 'extension_media_type_mismatch' };
  }

  if (declaredLength > maxBytes) return { ok: false, status: 'too_large', reason: 'declared_size_limit' };

  const bytes = decodeBase64(data.dataBase64);
  if (bytes === null) return { ok: false, status: 'unsafe', reason: 'invalid_base64' };
  if (bytes.length > maxBytes) return { ok: false, status: 'too_large', reason: 'decoded_size_limit' };

  const sniffed = sniffImageMediaType(bytes);
  if (sniffed === null) return { ok: false, status: 'unsafe', reason: 'unknown_image_format' };
  if (sniffed !== mediaType) return { ok: false, status: 'unsafe', reason: 'media_type_mismatch' };

  if (mediaType === 'image/svg+xml') {
    const reason = inspectSvgSafety(bytesToLatin1(bytes));
    if (reason !== null) return { ok: false, status: 'unsafe', reason: `unsafe_svg:${reason}` };
  }

  return { ok: true, dataUri: `data:${mediaType};base64,${data.dataBase64}` };
}

/** Runtime parse of a resolver response; the IPC boundary is not trusted either. */
export function parseImageResourceData(value: unknown): ImageResourceData | null {
  if (typeof value !== 'object' || value === null) return null;
  const record = value as Record<string, unknown>;
  const { path, mediaType, dataBase64, sha256, bytes } = record;
  if (typeof path !== 'string' || typeof dataBase64 !== 'string' || typeof sha256 !== 'string') return null;
  if (typeof mediaType !== 'string' || typeof bytes !== 'number') return null;
  return { path, mediaType: mediaType as ImageMediaType, dataBase64, sha256, bytes };
}

// ---------------------------------------------------------------------------
// Resolver adapters
// ---------------------------------------------------------------------------

export interface ImagesReadBridge {
  read(request: { path: string; documentPath: string }): Promise<IpcResult<unknown>>;
}

/**
 * Reads `window.markdownLite.images.read` if the preload exposes it. The method
 * is not part of the frozen shared API yet, so absence is expected and simply
 * degrades to "missing" markers in the document.
 */
export function findImagesReadBridge(scope: unknown = globalThis): ImagesReadBridge | null {
  if (typeof scope !== 'object' || scope === null) return null;
  const api = (scope as { markdownLite?: { images?: { read?: unknown } } }).markdownLite;
  const read = api?.images?.read;
  if (typeof read !== 'function') return null;
  return {
    read: (request) =>
      (read as (value: { path: string; documentPath: string }) => Promise<IpcResult<unknown>>).call(
        api?.images,
        request,
      ),
  };
}

/** Turns the IPC bridge into a resolver; `null` when the method is absent. */
export function createIpcImageResourceResolver(bridge: ImagesReadBridge | null): ImageResourceResolver | null {
  if (!bridge) return null;
  return async (request) => {
    const result = await bridge.read({ path: request.path, documentPath: request.documentPath });
    if (!result.ok) return null;
    return parseImageResourceData(result.value);
  };
}

// ---------------------------------------------------------------------------
// Batch resolution
// ---------------------------------------------------------------------------

export interface ResolveImagesInput {
  hrefs: readonly string[];
  documentPath: string;
  resolver?: ImageResourceResolver | null;
  maxBytes?: number;
}

export interface ImageResolutionSummary {
  /** Keyed by the original Markdown href. */
  images: Map<string, ResolvedImage>;
  dependencies: ExportDependencyReport;
  assets: RenderAssetRecord[];
  warnings: RenderWarning[];
}

function emptyResolvedImage(href: string, status: ImageStatus, reason: string | null): ResolvedImage {
  return { href, status, dataUri: null, path: null, mediaType: null, bytes: null, sha256: null, reason };
}

function toAssetRecord(image: ResolvedImage): RenderAssetRecord {
  return {
    href: image.href,
    status: image.status,
    path: image.path,
    reason: image.reason,
    mediaType: image.mediaType,
    bytes: image.bytes,
    sha256: image.sha256,
  };
}

export async function resolveImageResources(input: ResolveImagesInput): Promise<ImageResolutionSummary> {
  const maxBytes = input.maxBytes ?? DEFAULT_MAX_IMAGE_BYTES;
  const resolver = input.resolver ?? null;
  const uniqueHrefs = [...new Set(input.hrefs)];
  const bySourceKey = new Map<string, Promise<ResolvedImage>>();
  const images = new Map<string, ResolvedImage>();

  const resolveOne = async (href: string): Promise<ResolvedImage> => {
    const classification = classifyImageSource(href, input.documentPath);

    if (classification.kind === 'remote') return emptyResolvedImage(href, 'external', 'remote');
    if (classification.kind === 'unsafe') return emptyResolvedImage(href, 'unsafe', classification.reason);

    if (classification.kind === 'inline') {
      const length = base64ByteLength(href.slice(href.indexOf(',') + 1));
      if (length !== null && length > maxBytes) return emptyResolvedImage(href, 'too_large', 'inline_size_limit');
      return { ...emptyResolvedImage(href, 'embedded', null), dataUri: href };
    }

    const path = classification.path;
    if (path === null) return emptyResolvedImage(href, 'unsafe', classification.reason ?? 'invalid_path');
    if (!resolver) return { ...emptyResolvedImage(href, 'missing', 'resolver_unavailable'), path };

    let response: ImageResourceData | null = null;
    try {
      response = await resolver({ path, documentPath: input.documentPath });
    } catch {
      return { ...emptyResolvedImage(href, 'unsafe', 'resolver_error'), path };
    }
    if (response === null) return { ...emptyResolvedImage(href, 'missing', 'not_found'), path };

    const validation = validateImagePayload(response, path, maxBytes);
    if (!validation.ok) {
      return {
        ...emptyResolvedImage(href, validation.status, validation.reason),
        path,
        mediaType: normalizeMediaType(response.mediaType),
        bytes: Number.isInteger(response.bytes) ? response.bytes : null,
      };
    }
    return {
      href,
      status: 'embedded',
      dataUri: validation.dataUri,
      path,
      mediaType: normalizeMediaType(response.mediaType),
      bytes: response.bytes,
      sha256: response.sha256,
      reason: null,
    };
  };

  for (const href of uniqueHrefs) {
    const classification = classifyImageSource(href, input.documentPath);
    const sourceKey =
      classification.kind === 'local' && classification.path
        ? `local:${classification.path.toLowerCase()}`
        : `${classification.kind}:${href}`;

    let pending = bySourceKey.get(sourceKey);
    if (!pending) {
      pending = resolveOne(href);
      bySourceKey.set(sourceKey, pending);
    }
    const resolved = await pending;
    images.set(href, resolved.href === href ? resolved : { ...resolved, href });
  }

  const embedded = new Set<string>();
  const missing = new Set<string>();
  const external = new Map<string, ExternalAssetDependency>();
  const warnings: RenderWarning[] = [];
  let resolverWarningAdded = false;

  for (const href of uniqueHrefs) {
    const image = images.get(href);
    if (!image) continue;

    if (image.status === 'embedded') {
      if (image.path) embedded.add(image.path);
      continue;
    }
    if (image.status === 'external') {
      external.set(`remote:${href}`, { url: href, reason: 'remote' });
      continue;
    }
    if (image.status === 'missing') {
      if (image.path) missing.add(image.path);
      else external.set(`missing:${href}`, { url: href, reason: 'missing' });
      if (image.reason === 'resolver_unavailable' && !resolverWarningAdded) {
        resolverWarningAdded = true;
        warnings.push({
          code: 'image_resolver_unavailable',
          message: '未配置图片解析器，本地图片会显示为缺失。',
          detail: null,
        });
      }
      warnings.push({
        code: 'image_missing',
        message: `图片缺失：${image.path ?? href}`,
        detail: image.reason,
      });
      continue;
    }

    external.set(`${image.status}:${href}`, { url: href, reason: image.status });
    warnings.push({
      code: image.status === 'too_large' ? 'image_too_large' : 'image_unsafe',
      message:
        image.status === 'too_large'
          ? `图片超出大小限制，未嵌入：${image.path ?? href}`
          : `图片被拒绝嵌入：${image.path ?? href}`,
      detail: image.reason,
    });
  }

  const assets = uniqueHrefs
    .map((href) => images.get(href))
    .filter((image): image is ResolvedImage => image !== undefined)
    .map(toAssetRecord)
    .sort((left, right) => (left.href < right.href ? -1 : left.href > right.href ? 1 : 0));

  return {
    images,
    assets,
    warnings,
    dependencies: {
      embeddedLocalAssets: [...embedded].sort(),
      missingAssets: [...missing].sort(),
      externalAssets: [...external.values()].sort((left, right) =>
        left.url === right.url ? left.reason.localeCompare(right.reason) : left.url.localeCompare(right.url),
      ),
    },
  };
}
