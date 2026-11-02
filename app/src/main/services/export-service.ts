/**
 * HTML export.
 *
 * Rendering happens in the renderer only: this service receives the complete
 * document produced by `MarkdownRenderPipeline` and writes it atomically. It
 * chooses the destination with the native save dialog, refuses to overwrite the
 * source Markdown, and echoes the render signature and dependency report so the
 * renderer can tell "unexported changes" from "file written".
 */

import { dialog } from 'electron';
import type { ExportHtmlRequest, ExportHtmlResult } from '../../shared/contracts';
import { AppError } from '../errors';
import { prepareExportTarget } from './export-target';
import { writeHtmlAtomically, type HtmlWriter } from './export-writer';
import type { WorkspaceService } from './workspace-service';

/** Mirrors `MAX_HTML_CHARS` from the IPC validators; kept local to the service. */
export const MAX_EXPORT_HTML_CHARS = 128_000_000;

/** Details key used by the renderer to treat this failure as a user cancel. */
export const EXPORT_CANCELLED_REASON = 'cancelled';

export interface SaveHtmlDialogOptions {
  title: string;
  defaultPath: string;
  sourcePath: string;
}

export interface SaveHtmlDialogResult {
  cancelled: boolean;
  filePath: string | null;
}

export interface SaveHtmlDialogPort {
  show(options: SaveHtmlDialogOptions): Promise<SaveHtmlDialogResult>;
}

/** Native save dialog; the only source of the export destination. */
export class ElectronSaveHtmlDialog implements SaveHtmlDialogPort {
  async show(options: SaveHtmlDialogOptions): Promise<SaveHtmlDialogResult> {
    const result = await dialog.showSaveDialog({
      title: options.title,
      defaultPath: options.defaultPath,
      filters: [{ name: 'HTML', extensions: ['html', 'htm'] }],
      properties: ['showOverwriteConfirmation', 'createDirectory'],
    });
    return { cancelled: result.canceled, filePath: result.filePath ?? null };
  }
}

/**
 * Cancellation is represented as a `conflict` failure because the frozen shared
 * `ExportHtmlResult` has no `cancelled` field. `details.reason` carries the exact
 * meaning and `performHtmlExport` in the renderer maps it to `cancelled`.
 */
export function exportCancelled(): AppError {
  return new AppError('conflict', 'HTML export was cancelled', {
    reason: EXPORT_CANCELLED_REASON,
    cancelled: true,
  });
}

export interface ExportServiceOptions {
  dialog?: SaveHtmlDialogPort;
  writer?: HtmlWriter;
}

export class ExportService {
  private readonly dialog: SaveHtmlDialogPort;
  private readonly writer: HtmlWriter;

  constructor(
    private readonly workspace: WorkspaceService,
    options: ExportServiceOptions = {},
  ) {
    this.dialog = options.dialog ?? new ElectronSaveHtmlDialog();
    this.writer = options.writer ?? writeHtmlAtomically;
  }

  async html(request: ExportHtmlRequest): Promise<ExportHtmlResult> {
    const { guard } = this.workspace.require();
    const sourcePath = await guard.resolveExisting(request.documentPath);

    if (typeof request.html !== 'string' || request.html.length === 0) {
      throw new AppError('invalid_request', 'export html must not be empty');
    }
    if (request.html.length > MAX_EXPORT_HTML_CHARS) {
      throw new AppError('invalid_request', `export html exceeds ${MAX_EXPORT_HTML_CHARS} characters`);
    }

    const choice = await this.dialog.show({
      title: '导出 HTML',
      defaultPath: request.suggestedFileName,
      sourcePath,
    });
    if (choice.cancelled || choice.filePath === null) {
      throw exportCancelled();
    }

    const target = await prepareExportTarget({ chosenPath: choice.filePath, sourcePath });
    const bytes = await this.writer(target, request.html);

    return {
      writtenPath: target,
      bytes,
      signature: request.signature,
      dependencies: request.dependencies,
    };
  }
}
