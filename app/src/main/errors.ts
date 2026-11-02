import type { IpcErrorCode } from '../shared/ipc';

/** Error that carries a stable IPC error code back to the renderer. */
export class AppError extends Error {
  readonly code: IpcErrorCode;
  readonly details?: Record<string, unknown>;

  constructor(code: IpcErrorCode, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.details = details;
  }
}

export function notImplemented(operation: string): AppError {
  return new AppError('not_implemented', `${operation} is not implemented yet`, { operation });
}
