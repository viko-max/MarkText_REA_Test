/**
 * Content-addressed image assets.
 *
 * Pasted bytes are sniffed from their magic numbers, hashed, and written to
 * `assets/<sha256>.<ext>` at the workspace root. Identical bytes reuse the
 * existing file (deduplication), and the returned path is always a POSIX
 * workspace-relative path. SVG is rejected: it can carry script and external
 * references, and the editor never needs to invent one.
 */

import { readFile, stat } from 'node:fs/promises';
import type {
  ImageAsset,
  ImageMediaType,
  ReadImageRequest,
  ReadImageResult,
  SaveImageRequest,
} from '../../shared/contracts';
import {
  isMarkdownPath,
  isWorkspaceRelativePath,
  joinWorkspacePath,
} from '../../shared/paths';
import { MAX_IMAGE_BYTES } from '../../shared/validation';
import { AppError } from '../errors';
import type { WorkspacePathGuard } from '../security/workspace-paths';
import {
  readFileBytes,
  sha256Hex,
  TargetExistsError,
  writeFileExclusive,
} from './atomic-write';
import {
  mediaTypeMatchesExtension,
  SAFE_MEDIA_TYPES,
  sniffImage,
} from './image-sniff';
import type { WorkspaceService } from './workspace-service';

export interface ResourceServiceOptions {
  maxImageBytes?: number;
}

function decodeBase64(value: string): Buffer {
  const bytes = Buffer.from(value, 'base64');
  if (bytes.byteLength === 0 || bytes.toString('base64') !== value) {
    throw new AppError('invalid_request', 'request.dataBase64 is not canonical base64');
  }
  return bytes;
}

function rejectUnsafe(mediaType: ImageMediaType): void {
  if (!SAFE_MEDIA_TYPES.includes(mediaType)) {
    throw new AppError('forbidden', 'SVG images are not accepted because they can carry script', {
      mediaType,
      reason: 'unsafe',
    });
  }
}

function assertMediaTypeMatchesExtension(
  mediaType: ImageMediaType,
  fileName: string,
): void {
  if (!isWorkspaceRelativePath(fileName)) {
    throw new AppError('invalid_request', 'image path must be a workspace-relative POSIX path', {
      fileName,
    });
  }
  if (!mediaTypeMatchesExtension(mediaType, fileName)) {
    throw new AppError('invalid_request', 'file extension does not match the image media type', {
      mediaType,
      fileName,
    });
  }
}

export class ResourceService {
  private readonly maxImageBytes: number;

  constructor(
    private readonly workspace: WorkspaceService,
    options: ResourceServiceOptions = {},
  ) {
    this.maxImageBytes = options.maxImageBytes ?? MAX_IMAGE_BYTES;
  }

  async save(request: SaveImageRequest): Promise<ImageAsset> {
    const { guard } = this.workspace.require();
    await this.assertMarkdownDocument(guard, request.documentPath);

    const bytes = decodeBase64(request.dataBase64);
    if (bytes.byteLength > this.maxImageBytes) {
      throw new AppError('too_large', 'image exceeds the maximum size', {
        bytes: bytes.byteLength,
        maxBytes: this.maxImageBytes,
      });
    }
    if (bytes.byteLength === 0) {
      throw new AppError('invalid_request', 'image payload is empty');
    }

    const sniffed = sniffImage(bytes);
    if (!sniffed) {
      throw new AppError('invalid_request', 'image payload is not a supported image format');
    }
    rejectUnsafe(sniffed.mediaType);
    if (sniffed.mediaType !== request.mediaType) {
      throw new AppError('invalid_request', 'declared media type does not match the image bytes', {
        declared: request.mediaType,
        detected: sniffed.mediaType,
      });
    }
    assertMediaTypeMatchesExtension(sniffed.mediaType, request.fileName);

    const sha256 = sha256Hex(bytes);
    const assetPath = joinWorkspacePath('assets', `${sha256}.${sniffed.extension}`);
    const absolute = await guard.resolveNew(assetPath);

    const duplicate = await this.writeOrReuse(absolute, bytes, sha256);

    return {
      path: assetPath,
      mediaType: sniffed.mediaType,
      sha256,
      bytes: bytes.byteLength,
      duplicate,
    };
  }

  async read(request: ReadImageRequest): Promise<ReadImageResult> {
    const { guard } = this.workspace.require();
    await this.assertMarkdownDocument(guard, request.documentPath);

    const absolute = await guard.resolveExisting(request.path);
    const stats = await stat(absolute);
    if (!stats.isFile()) {
      throw new AppError('invalid_path', 'image path is not a file', { path: request.path });
    }
    if (stats.size > this.maxImageBytes) {
      throw new AppError('too_large', 'image exceeds the maximum size', {
        path: request.path,
        bytes: stats.size,
        maxBytes: this.maxImageBytes,
      });
    }

    const bytes = await readFileBytes(absolute);
    if (bytes.byteLength > this.maxImageBytes) {
      throw new AppError('too_large', 'image exceeds the maximum size', {
        path: request.path,
        bytes: bytes.byteLength,
        maxBytes: this.maxImageBytes,
      });
    }

    const sniffed = sniffImage(bytes);
    if (!sniffed) {
      throw new AppError('invalid_request', 'file is not a supported image format', {
        path: request.path,
      });
    }
    rejectUnsafe(sniffed.mediaType);
    assertMediaTypeMatchesExtension(sniffed.mediaType, request.path);

    return {
      path: request.path,
      mediaType: sniffed.mediaType,
      dataBase64: bytes.toString('base64'),
      sha256: sha256Hex(bytes),
      bytes: bytes.byteLength,
    };
  }

  private async writeOrReuse(absolute: string, bytes: Buffer, sha256: string): Promise<boolean> {
    const existing = await stat(absolute).catch(() => null);
    if (existing) {
      await this.verifyExisting(absolute, sha256);
      return true;
    }

    try {
      await writeFileExclusive(absolute, bytes);
      return false;
    } catch (error) {
      if (!(error instanceof TargetExistsError)) throw error;
      await this.verifyExisting(absolute, sha256);
      return true;
    }
  }

  private async verifyExisting(absolute: string, sha256: string): Promise<void> {
    const existing = await readFile(absolute);
    if (sha256Hex(existing) !== sha256) {
      throw new AppError('conflict', 'asset path exists with different content', {
        sha256,
      });
    }
  }

  private async assertMarkdownDocument(
    guard: WorkspacePathGuard,
    documentPath: string,
  ): Promise<void> {
    if (!isMarkdownPath(documentPath)) {
      throw new AppError('invalid_path', 'images can only be attached to Markdown documents', {
        path: documentPath,
      });
    }
    const absolute = await guard.resolveExisting(documentPath);
    const stats = await stat(absolute);
    if (!stats.isFile()) {
      throw new AppError('invalid_path', 'document path is not a file', { path: documentPath });
    }
  }
}
