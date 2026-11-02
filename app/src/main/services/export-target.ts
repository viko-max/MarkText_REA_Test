/**
 * Export target policy for the main process.
 *
 * The renderer never supplies an absolute path: the destination comes from the
 * native save dialog. These checks make sure the chosen file is HTML, that it
 * never shadows the source Markdown document, and that both the directory and
 * any existing target resolve to what the dialog showed.
 */

import { realpath, stat } from 'node:fs/promises';
import { dirname, extname, isAbsolute, resolve } from 'node:path';
import { AppError } from '../errors';

export const HTML_EXPORT_EXTENSIONS = ['.html', '.htm'] as const;

export interface PrepareExportTargetInput {
  /** Absolute path returned by the save dialog. */
  chosenPath: string;
  /** Canonical absolute path of the source Markdown document. */
  sourcePath: string;
}

function isNotFound(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error.code === 'ENOENT' || error.code === 'ENOTDIR')
  );
}

function samePath(left: string, right: string): boolean {
  return process.platform === 'win32'
    ? left.toLowerCase() === right.toLowerCase()
    : left === right;
}

/** Appends `.html` when the dialog returned a bare name; rejects other suffixes. */
export function ensureHtmlExtension(targetPath: string): string {
  const extension = extname(targetPath).toLowerCase();
  if (extension === '') return `${targetPath}.html`;
  if (!(HTML_EXPORT_EXTENSIONS as readonly string[]).includes(extension)) {
    throw new AppError('invalid_request', `export target must end with .html or .htm (got "${extension}")`);
  }
  return targetPath;
}

/**
 * Validates the dialog result and returns the absolute path to write.
 * Errors are ordered: shape → source shadowing → extension → directory → target.
 */
export async function prepareExportTarget(input: PrepareExportTargetInput): Promise<string> {
  const chosen = input.chosenPath.trim();
  if (chosen.length === 0) {
    throw new AppError('invalid_request', 'export target path is empty');
  }
  if (!isAbsolute(chosen)) {
    throw new AppError('invalid_request', 'export target must be an absolute path');
  }

  let sourceCanonical: string;
  try {
    sourceCanonical = await realpath(input.sourcePath);
  } catch (error) {
    if (isNotFound(error)) throw new AppError('not_found', 'source document does not exist');
    throw error;
  }

  const candidate = resolve(chosen);
  if (samePath(candidate, input.sourcePath) || samePath(candidate, sourceCanonical)) {
    throw new AppError('forbidden', 'refusing to overwrite the source Markdown document');
  }

  const target = ensureHtmlExtension(candidate);
  if (samePath(target, input.sourcePath) || samePath(target, sourceCanonical)) {
    throw new AppError('forbidden', 'refusing to overwrite the source Markdown document');
  }

  const directory = dirname(target);
  let directoryStats;
  try {
    directoryStats = await stat(directory);
  } catch (error) {
    if (isNotFound(error)) throw new AppError('not_found', 'export directory does not exist');
    throw error;
  }
  if (!directoryStats.isDirectory()) {
    throw new AppError('invalid_path', 'export target directory is not a directory');
  }

  let targetStats = null;
  try {
    targetStats = await stat(target);
  } catch (error) {
    if (!isNotFound(error)) throw error;
  }
  if (targetStats?.isDirectory()) {
    throw new AppError('invalid_path', 'export target is a directory');
  }
  if (targetStats) {
    const canonicalTarget = await realpath(target);
    if (samePath(canonicalTarget, sourceCanonical) || samePath(canonicalTarget, input.sourcePath)) {
      throw new AppError('forbidden', 'refusing to overwrite the source Markdown document');
    }
  }

  return target;
}
