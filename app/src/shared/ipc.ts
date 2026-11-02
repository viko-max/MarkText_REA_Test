/**
 * The complete, fixed IPC channel registry.
 *
 * Every channel is explicit and typed. There is deliberately no generic
 * `send`/`invoke`/`on` bridge: the preload script maps each channel to one
 * method of the `window.markdownLite` API.
 */

export const IPC_CHANNELS = {
  appInfo: 'app:info',

  workspaceOpen: 'workspace:open',
  /** Reopens the last workspace recorded in persisted state; no payload. */
  workspaceRestore: 'workspace:restore',
  workspaceTree: 'workspace:tree',
  workspaceClose: 'workspace:close',

  documentRead: 'document:read',
  documentCreate: 'document:create',
  documentSave: 'document:save',
  documentSaveCopy: 'document:copy',
  documentReload: 'document:reload',
  documentRename: 'document:rename',
  /** Main -> renderer push for external file changes. */
  documentExternalChange: 'document:external',

  imageSave: 'image:save',
  imageRead: 'image:read',

  /** Native wallpaper picker; no payload, no renderer-supplied path. */
  backgroundChoose: 'background:choose',

  exportHtml: 'export:html',

  stateLoad: 'state:load',
  stateSave: 'state:save',

  linksIndex: 'links:index',
  linksBacklinks: 'links:backlinks',
  linksGraph: 'links:graph',
} as const;

export type IpcChannel = (typeof IPC_CHANNELS)[keyof typeof IPC_CHANNELS];

export const IPC_CHANNEL_LIST: readonly IpcChannel[] = Object.freeze(Object.values(IPC_CHANNELS));

export type IpcErrorCode =
  | 'invalid_request'
  | 'invalid_path'
  | 'outside_workspace'
  | 'no_workspace'
  | 'not_found'
  | 'conflict'
  | 'too_large'
  | 'permission_denied'
  | 'forbidden'
  | 'not_implemented'
  | 'internal_error';

export interface IpcFailure {
  code: IpcErrorCode;
  message: string;
  /** Structured, non-secret details such as a conflicting field name. */
  details?: Record<string, unknown>;
}

export type IpcResult<T> = { ok: true; value: T } | { ok: false; error: IpcFailure };

export function ipcOk<T>(value: T): IpcResult<T> {
  return { ok: true, value };
}

export function ipcFail(
  code: IpcErrorCode,
  message: string,
  details?: Record<string, unknown>,
): IpcResult<never> {
  return details ? { ok: false, error: { code, message, details } } : { ok: false, error: { code, message } };
}
