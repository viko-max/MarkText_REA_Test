import { app } from 'electron';
import { mkdirSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import type { RuntimeDataSource } from '../shared/contracts';

export const RUNTIME_DIR_ENV = 'MARKDOWN_LITE_USER_DATA';
export const DEFAULT_RUNTIME_DIR_NAME = '.runtime';

export interface RuntimePaths {
  root: string;
  source: RuntimeDataSource;
  userData: string;
  sessionData: string;
  logs: string;
  crashDumps: string;
  temp: string;
  state: string;
}

export interface RuntimeRootSelection {
  root: string;
  source: RuntimeDataSource;
}

/**
 * Pick the runtime root without touching Electron state, so it can be tested.
 *
 * `MARKDOWN_LITE_USER_DATA` wins; a relative value is resolved against the
 * application directory. Otherwise `<app dir>/.runtime` is used, which keeps
 * every write inside the project during development.
 */
export function selectRuntimeRoot(envValue: string | undefined, appDir: string): RuntimeRootSelection {
  const trimmed = envValue?.trim();
  if (trimmed) {
    return {
      root: isAbsolute(trimmed) ? resolve(trimmed) : resolve(appDir, trimmed),
      source: 'env',
    };
  }
  return { root: join(appDir, DEFAULT_RUNTIME_DIR_NAME), source: 'default' };
}

function ensureDirectory(path: string): string {
  mkdirSync(path, { recursive: true });
  return path;
}

/**
 * Redirect every Electron data location into the workspace before the app is
 * ready. Nothing is written to `%APPDATA%`, `%LOCALAPPDATA%` or the home dir.
 */
export function configureRuntimePaths(): RuntimePaths {
  const appDir = app.isPackaged ? dirname(app.getPath('exe')) : app.getAppPath();
  const selection = selectRuntimeRoot(process.env[RUNTIME_DIR_ENV], appDir);
  const root = ensureDirectory(selection.root);

  const paths: RuntimePaths = {
    root,
    source: selection.source,
    userData: ensureDirectory(join(root, 'user-data')),
    sessionData: ensureDirectory(join(root, 'session-data')),
    logs: ensureDirectory(join(root, 'logs')),
    crashDumps: ensureDirectory(join(root, 'crash-dumps')),
    temp: ensureDirectory(join(root, 'temp')),
    state: ensureDirectory(join(root, 'state')),
  };

  app.setPath('userData', paths.userData);
  app.setPath('sessionData', paths.sessionData);
  app.setPath('logs', paths.logs);
  app.setPath('crashDumps', paths.crashDumps);
  app.setPath('temp', paths.temp);

  process.env.TEMP = paths.temp;
  process.env.TMP = paths.temp;

  return paths;
}
