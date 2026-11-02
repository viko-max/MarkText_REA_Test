/**
 * Export wiring for the HTML workspace.
 *
 * The renderer never writes files: it builds the `ExportHtmlRequest` from the
 * pipeline result and calls `window.markdownLite.export.html`. This module keeps
 * that mapping (including the "user cancelled the save dialog" case) in one
 * place so tests can exercise it without Electron.
 */

import type {
  ExportDependencyReport,
  ExportHtmlRequest,
  ExportHtmlResult,
} from '../../../shared/contracts';
import type { IpcFailure, IpcResult } from '../../../shared/ipc';
import { workspaceStem } from '../../../shared/paths';
import type { RenderResult } from '../render/types';

/** Reason carried in `IpcFailure.details` when the save dialog was dismissed. */
export const EXPORT_CANCELLED_REASON = 'cancelled';

const INVALID_FILE_NAME = /[\\/:*?"<>|]/g;

/** Plain `.html` file name suggested in the native save dialog. */
export function suggestHtmlFileName(documentPath: string | null): string {
  const fallback = 'document.html';
  if (!documentPath) return fallback;
  let stem: string;
  try {
    stem = workspaceStem(documentPath);
  } catch {
    return fallback;
  }
  const safe = stem.replace(INVALID_FILE_NAME, '-').replace(/^\.+/, '').trim();
  return safe.length > 0 ? `${safe}.html` : fallback;
}

function cloneDependencyReport(dependencies: ExportDependencyReport): ExportDependencyReport {
  return {
    embeddedLocalAssets: [...dependencies.embeddedLocalAssets],
    missingAssets: [...dependencies.missingAssets],
    externalAssets: dependencies.externalAssets.map((asset) => ({ ...asset })),
  };
}

/** Builds the IPC payload from a pipeline result; nothing is re-rendered. */
export function buildExportHtmlRequest(
  result: RenderResult,
  options: { documentPath: string; suggestedFileName?: string },
): ExportHtmlRequest {
  return {
    documentPath: options.documentPath,
    suggestedFileName: options.suggestedFileName ?? suggestHtmlFileName(options.documentPath),
    html: result.html,
    signature: result.signature,
    dependencies: cloneDependencyReport(result.dependencies),
  };
}

export type HtmlExportRequester = (request: ExportHtmlRequest) => Promise<IpcResult<ExportHtmlResult>>;

export type HtmlExportOutcome =
  | { status: 'written'; result: ExportHtmlResult }
  | { status: 'cancelled' }
  | { status: 'failed'; error: IpcFailure };

export function isExportCancellation(failure: IpcFailure): boolean {
  const details = failure.details ?? {};
  return details.reason === EXPORT_CANCELLED_REASON || details.cancelled === true;
}

/** Runs one export call and normalises success, cancellation and failure. */
export async function performHtmlExport(
  requester: HtmlExportRequester,
  request: ExportHtmlRequest,
): Promise<HtmlExportOutcome> {
  try {
    const response = await requester(request);
    if (response.ok) return { status: 'written', result: response.value };
    if (isExportCancellation(response.error)) return { status: 'cancelled' };
    return { status: 'failed', error: response.error };
  } catch (error) {
    return {
      status: 'failed',
      error: {
        code: 'internal_error',
        message: error instanceof Error ? error.message : String(error),
      },
    };
  }
}

export interface ExportApiShape {
  export: { html(request: ExportHtmlRequest): Promise<IpcResult<ExportHtmlResult>> };
}

/** Reads `window.markdownLite.export.html` without assuming the global exists. */
export function findExportApi(scope: unknown = globalThis): ExportApiShape | null {
  if (typeof scope !== 'object' || scope === null) return null;
  const api = (scope as { markdownLite?: { export?: { html?: unknown } } }).markdownLite;
  const html = api?.export?.html;
  if (typeof html !== 'function') return null;
  return {
    export: {
      html: (request) =>
        (html as (value: ExportHtmlRequest) => Promise<IpcResult<ExportHtmlResult>>).call(api?.export, request),
    },
  };
}

export function createIpcHtmlExportRequester(api: ExportApiShape | null): HtmlExportRequester | null {
  if (!api) return null;
  return (request) => api.export.html(request);
}

// ---------------------------------------------------------------------------
// Status helpers shared by the workspace chrome
// ---------------------------------------------------------------------------

export interface ExportSignatureState {
  hasUnexportedChanges: boolean;
  label: string;
}

/** Compares the current render signature with the last written export. */
export function deriveExportState(
  signature: string | null,
  exportedSignature: string | null,
): ExportSignatureState {
  if (!signature) return { hasUnexportedChanges: false, label: '未导出' };
  if (exportedSignature === signature) return { hasUnexportedChanges: false, label: '已导出' };
  return { hasUnexportedChanges: true, label: '有未导出修改' };
}

/** One-line dependency summary for the status bar. */
export function describeDependencySummary(dependencies: ExportDependencyReport): string {
  const parts: string[] = [];
  if (dependencies.embeddedLocalAssets.length > 0) {
    parts.push(`嵌入 ${dependencies.embeddedLocalAssets.length} 个本地资源`);
  }
  const remote = dependencies.externalAssets.filter((asset) => asset.reason === 'remote').length;
  if (remote > 0) parts.push(`${remote} 个远程资源`);
  const rejected = dependencies.externalAssets.filter(
    (asset) => asset.reason === 'unsafe' || asset.reason === 'too_large',
  ).length;
  if (rejected > 0) parts.push(`${rejected} 个被拒绝的资源`);
  if (dependencies.missingAssets.length > 0) parts.push(`缺失 ${dependencies.missingAssets.length} 个资源`);
  return parts.length > 0 ? parts.join('；') : '无外部依赖';
}
