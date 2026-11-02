/**
 * HTML workspace barrel (preview frame, controller, export wiring).
 */

export {
  createHtmlWorkspace,
  exportStatusLabel,
  isHtmlFileView,
  isMarkdownView,
  mountHtmlWorkspace,
} from './html-workspace';
export type {
  HtmlDocumentKind,
  HtmlViewMode,
  HtmlWorkspaceController,
  HtmlWorkspaceDocument,
  HtmlWorkspaceOptions,
  HtmlWorkspaceState,
} from './html-workspace';

export {
  buildExportHtmlRequest,
  createIpcHtmlExportRequester,
  deriveExportState,
  describeDependencySummary,
  EXPORT_CANCELLED_REASON,
  findExportApi,
  isExportCancellation,
  performHtmlExport,
  suggestHtmlFileName,
} from './export-request';
export type {
  ExportApiShape,
  ExportSignatureState,
  HtmlExportOutcome,
  HtmlExportRequester,
} from './export-request';

export {
  createPreviewFrame,
  HTML_FILE_PREVIEW_CSP,
  PREVIEW_SANDBOX,
  withPreviewCsp,
} from './preview-frame';
export type { PreviewFrame, PreviewFrameOptions } from './preview-frame';
