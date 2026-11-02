import { describe, expect, it } from 'vitest';
import { createDefaultWorkspaceUiState, DEFAULT_THEME, DEFAULT_LAYOUT } from '../src/shared/defaults';
import {
  validateBacklinksRequest,
  validateExportHtmlRequest,
  validateGetWorkspaceTreeRequest,
  validateGraphRequest,
  validateLayoutConfig,
  validateReadDocumentRequest,
  validateRenameDocumentRequest,
  validateSaveDocumentRequest,
  validateSaveImageRequest,
  validateThemeConfig,
  validateWorkspaceUiState,
} from '../src/shared/validation';

const HASH = 'a'.repeat(64);

function expectOk<T>(result: { ok: true; value: T } | { ok: false; message: string }): T {
  expect(result.ok, result.ok ? '' : result.message).toBe(true);
  if (!result.ok) throw new Error(result.message);
  return result.value;
}

function expectFail(result: { ok: true; value: unknown } | { ok: false; message: string }): string {
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error('expected validation to fail');
  return result.message;
}

describe('document request validation', () => {
  it('accepts a workspace-relative read request', () => {
    expect(expectOk(validateReadDocumentRequest({ path: 'notes/周报.md' }))).toEqual({
      path: 'notes/周报.md',
    });
  });

  it('rejects absolute, traversal and malformed read paths', () => {
    expectFail(validateReadDocumentRequest({ path: 'C:/notes/a.md' }));
    expectFail(validateReadDocumentRequest({ path: '../a.md' }));
    expectFail(validateReadDocumentRequest({ path: '/a.md' }));
    expectFail(validateReadDocumentRequest({ path: 7 }));
    expectFail(validateReadDocumentRequest(null));
  });

  it('accepts a save request with a SHA-256 base hash', () => {
    const value = expectOk(
      validateSaveDocumentRequest({
        documentId: 'doc-1',
        path: 'notes/a.md',
        markdown: '# 标题\n',
        baseHash: HASH,
      }),
    );
    expect(value.baseHash).toBe(HASH);
  });

  it('rejects saves without a valid base hash or with non-Markdown paths', () => {
    expectFail(
      validateSaveDocumentRequest({
        documentId: 'doc-1',
        path: 'notes/a.md',
        markdown: '',
        baseHash: 'not-a-hash',
      }),
    );
    expectFail(
      validateSaveDocumentRequest({
        documentId: 'doc-1',
        path: 'notes/a.txt',
        markdown: '',
        baseHash: HASH,
      }),
    );
    expectFail(
      validateSaveDocumentRequest({
        documentId: '',
        path: 'notes/a.md',
        markdown: '',
        baseHash: HASH,
      }),
    );
  });

  it('rejects a rename onto the same path, including case changes', () => {
    expectFail(
      validateRenameDocumentRequest({
        documentId: 'doc-1',
        fromPath: 'notes/A.md',
        toPath: 'notes/a.md',
        updateReferences: true,
      }),
    );
    expect(
      expectOk(
        validateRenameDocumentRequest({
          documentId: 'doc-1',
          fromPath: 'notes/a.md',
          toPath: 'notes/b.md',
          updateReferences: true,
        }),
      ).toPath,
    ).toBe('notes/b.md');
  });
});

describe('workspace tree and graph requests', () => {
  it('allows the root directory and bounded depth', () => {
    expect(expectOk(validateGetWorkspaceTreeRequest({ path: '', depth: 2 }))).toEqual({
      path: '',
      depth: 2,
    });
    expectFail(validateGetWorkspaceTreeRequest({ path: '', depth: 99 }));
    expectFail(validateGetWorkspaceTreeRequest({ path: '../', depth: 1 }));
  });

  it('validates backlink and graph requests', () => {
    expect(expectOk(validateBacklinksRequest({ path: 'notes/a.md' })).path).toBe('notes/a.md');
    expect(expectOk(validateGraphRequest({ focusPath: null, depth: 1 })).focusPath).toBeNull();
    expectFail(validateGraphRequest({ focusPath: 'notes/a.txt', depth: 1 }));
    expectFail(validateGraphRequest({ focusPath: null, depth: -1 }));
  });
});

describe('image validation', () => {
  it('accepts a supported image payload', () => {
    const value = expectOk(
      validateSaveImageRequest({
        documentPath: 'notes/a.md',
        fileName: 'pasted-image.png',
        mediaType: 'image/png',
        dataBase64: 'iVBORw0KGgo=',
      }),
    );
    expect(value.mediaType).toBe('image/png');
  });

  it('rejects unsafe names, unsupported types and malformed base64', () => {
    expectFail(
      validateSaveImageRequest({
        documentPath: 'notes/a.md',
        fileName: '../escape.png',
        mediaType: 'image/png',
        dataBase64: 'AAAA',
      }),
    );
    expectFail(
      validateSaveImageRequest({
        documentPath: 'notes/a.md',
        fileName: 'image.bmp',
        mediaType: 'image/png',
        dataBase64: 'AAAA',
      }),
    );
    expectFail(
      validateSaveImageRequest({
        documentPath: 'notes/a.md',
        fileName: 'image.png',
        mediaType: 'image/bmp',
        dataBase64: 'AAAA',
      }),
    );
    expectFail(
      validateSaveImageRequest({
        documentPath: 'notes/a.md',
        fileName: 'image.png',
        mediaType: 'image/png',
        dataBase64: 'AAA',
      }),
    );
  });
});

describe('export validation', () => {
  const dependencies = { embeddedLocalAssets: [], externalAssets: [], missingAssets: [] };

  it('accepts a rendered HTML export request', () => {
    const value = expectOk(
      validateExportHtmlRequest({
        documentPath: 'notes/a.md',
        suggestedFileName: 'a.html',
        html: '<p>hello</p>',
        signature: 'sig-1',
        dependencies,
      }),
    );
    expect(value.dependencies.externalAssets).toEqual([]);
  });

  it('rejects non-HTML targets and incomplete dependency reports', () => {
    expectFail(
      validateExportHtmlRequest({
        documentPath: 'notes/a.md',
        suggestedFileName: 'a.txt',
        html: '<p>hello</p>',
        signature: 'sig-1',
        dependencies,
      }),
    );
    expectFail(
      validateExportHtmlRequest({
        documentPath: 'notes/a.md',
        suggestedFileName: '../a.html',
        html: '<p>hello</p>',
        signature: 'sig-1',
        dependencies,
      }),
    );
    expectFail(
      validateExportHtmlRequest({
        documentPath: 'notes/a.md',
        suggestedFileName: 'a.html',
        html: '',
        signature: 'sig-1',
        dependencies,
      }),
    );
    expectFail(
      validateExportHtmlRequest({
        documentPath: 'notes/a.md',
        suggestedFileName: 'a.html',
        html: '<p>hello</p>',
        signature: 'sig-1',
      }),
    );
  });
});

describe('theme, layout and persisted state', () => {
  it('accepts the default theme and layout', () => {
    expect(expectOk(validateThemeConfig(DEFAULT_THEME)).mode).toBe('system');
    expect(expectOk(validateLayoutConfig(DEFAULT_LAYOUT)).sidebar.position).toBe('left');
  });

  it('rejects out-of-range values and unsafe custom variables', () => {
    expectFail(validateThemeConfig({ ...DEFAULT_THEME, fontSizePx: 4 }));
    expectFail(validateThemeConfig({ ...DEFAULT_THEME, foreground: 'red; background: url(x)' }));
    expectFail(
      validateThemeConfig({
        ...DEFAULT_THEME,
        customVariables: { 'background-image': 'url(https://evil.example/x.png)' },
      }),
    );
    expectFail(
      validateThemeConfig({
        ...DEFAULT_THEME,
        customVariables: { '--mdl-accent': 'red; background: blue' },
      }),
    );
  });

  it('round-trips the default persisted state', () => {
    const state = createDefaultWorkspaceUiState('C:/workspace');
    const parsed = expectOk(validateWorkspaceUiState(state));
    expect(parsed.version).toBe(1);
    expect(parsed.workspaceRootPath).toBe('C:/workspace');
    expect(parsed.openDocuments).toEqual([]);
    expect(parsed.theme.customVariables).toEqual({});
  });

  it('accepts a split view mode in the persisted document views', () => {
    const state = createDefaultWorkspaceUiState('C:/workspace');
    const parsed = expectOk(
      validateWorkspaceUiState({
        ...state,
        openDocuments: ['notes/a.md'],
        activeDocument: 'notes/a.md',
        documentViews: {
          'notes/a.md': { selection: null, scrollTop: 0, viewMode: 'split' },
        },
      }),
    );
    expect(parsed.documentViews['notes/a.md']?.viewMode).toBe('split');
    expectFail(
      validateWorkspaceUiState({
        ...state,
        documentViews: {
          'notes/a.md': { selection: null, scrollTop: 0, viewMode: 'graph' },
        },
      }),
    );
  });

  it('rejects unsupported state versions and non-Markdown open documents', () => {
    const state = createDefaultWorkspaceUiState(null);
    expectFail(validateWorkspaceUiState({ ...state, version: 2 }));
    expectFail(validateWorkspaceUiState({ ...state, openDocuments: ['notes/a.txt'] }));
    expectFail(validateWorkspaceUiState({ ...state, activeDocument: 'a.txt' }));
    expectFail(validateWorkspaceUiState({ ...state, theme: { ...state.theme, mode: 'sepia' } }));
  });
});
