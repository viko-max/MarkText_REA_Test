import { describe, expect, it, vi } from 'vitest';
import { resolve } from 'node:path';

vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getAppPath: () => 'C:/virtual/app',
    getPath: () => 'C:/virtual/app',
    setPath: () => undefined,
  },
}));

import { selectRuntimeRoot } from '../src/main/runtime-paths';

describe('selectRuntimeRoot', () => {
  it('defaults to <app>/.runtime when the env var is absent or blank', () => {
    const appDir = 'C:/virtual/app';
    expect(selectRuntimeRoot(undefined, appDir)).toEqual({
      root: resolve(appDir, '.runtime'),
      source: 'default',
    });
    expect(selectRuntimeRoot('   ', appDir)).toEqual({
      root: resolve(appDir, '.runtime'),
      source: 'default',
    });
  });

  it('honours an absolute MARKDOWN_LITE_USER_DATA value', () => {
    expect(selectRuntimeRoot(' D:/mdl-data ', 'C:/virtual/app')).toEqual({
      root: resolve('D:/mdl-data'),
      source: 'env',
    });
  });

  it('resolves a relative override against the application directory', () => {
    expect(selectRuntimeRoot('runtime-data', 'C:/virtual/app')).toEqual({
      root: resolve('C:/virtual/app', 'runtime-data'),
      source: 'env',
    });
  });
});
