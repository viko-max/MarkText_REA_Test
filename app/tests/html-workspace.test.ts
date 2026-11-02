/// <reference lib="dom" />
/**
 * `HtmlWorkspaceController` behaviour under jsdom.
 *
 * jsdom@26 ships no type declarations and no new dependency may be added, so it
 * is loaded through `createRequire` with a local shape. The `lib="dom"`
 * reference gives this test file the DOM types of the document it drives; the
 * node tsconfig for `src/main` remains DOM-free.
 */

import { createRequire } from 'node:module';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createHtmlWorkspace,
  type HtmlWorkspaceController,
} from '../src/renderer/src/html/html-workspace';
import type { HtmlExportRequester } from '../src/renderer/src/html/export-request';
import { MarkdownRenderPipeline } from '../src/renderer/src/render/markdown-render-pipeline';
import { createDomPurifySanitizer } from '../src/renderer/src/render/sanitize';
import type { ExportHtmlRequest } from '../src/shared/contracts';
import { ipcFail, ipcOk } from '../src/shared/ipc';
import { DEFAULT_LAYOUT, DEFAULT_THEME } from '../src/shared/defaults';

interface JsdomInstance {
  window: Window & typeof globalThis;
}

const { JSDOM } = createRequire(import.meta.url)('jsdom') as {
  JSDOM: new (html?: string) => JsdomInstance;
};

const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>');
const doc = dom.window.document;
const pipeline = new MarkdownRenderPipeline({ sanitize: createDomPurifySanitizer(dom.window) });

const mounted: HtmlWorkspaceController[] = [];

function mount(options: { exporter?: HtmlExportRequester | null } = {}): HtmlWorkspaceController {
  const container = doc.createElement('div');
  doc.body.append(container);
  const controller = createHtmlWorkspace({
    theme: DEFAULT_THEME,
    layout: DEFAULT_LAYOUT,
    pipeline,
    ownerDocument: doc,
    scope: {},
    exporter: options.exporter ?? null,
  }).mount(container);
  mounted.push(controller);
  return controller;
}

function iframeOf(controller: HtmlWorkspaceController): HTMLIFrameElement | null {
  return controller.element.querySelector('iframe');
}

afterEach(() => {
  for (const controller of mounted.splice(0)) controller.destroy();
  doc.body.replaceChildren();
});

describe('HtmlWorkspaceController', () => {
  it('renders a document into iframe.srcdoc and tracks its signature', async () => {
    const controller = mount();
    const result = await controller.setDocument({
      path: '笔记/首页.md',
      markdown: '# 首页\n\n中文正文',
    });

    expect(result).not.toBeNull();
    expect(iframeOf(controller)?.getAttribute('srcdoc')).toBe(result?.html);
    expect(controller.getState().documentPath).toBe('笔记/首页.md');
    expect(controller.getState().signature).toBe(result?.signature);
    expect(controller.getState().kind).toBe('markdown');
    expect(controller.getState().hasUnexportedChanges).toBe(true);
  });

  it('marks unexported changes after setMarkdown until an export completes', async () => {
    const controller = mount();
    const first = await controller.setDocument({ path: 'a.md', markdown: '# A' });
    expect(first).not.toBeNull();
    controller.markExported(first?.signature ?? '');

    expect(controller.getState().hasUnexportedChanges).toBe(false);
    expect(controller.getState().exportLabel).toBe('已导出');

    const changed = await controller.setMarkdown('# A\n\n新增内容');
    expect(changed?.signature).not.toBe(first?.signature);
    expect(controller.getState().hasUnexportedChanges).toBe(true);
    expect(controller.getState().exportLabel).toBe('有未导出修改');
  });

  it('updates exportedSignature only after a successful export', async () => {
    const requests: ExportHtmlRequest[] = [];
    const exporter: HtmlExportRequester = async (request) => {
      requests.push(request);
      return ipcOk({
        writtenPath: 'C:/exports/首页.html',
        bytes: 2048,
        signature: request.signature,
        dependencies: request.dependencies,
      });
    };
    const controller = mount({ exporter });
    await controller.setDocument({ path: '笔记/首页.md', markdown: '# 首页' });
    const signature = controller.getState().signature;
    expect(controller.getState().exportedSignature).toBeNull();

    const outcome = await controller.exportHtml();
    expect(outcome.status).toBe('written');
    expect(controller.getState().exportedSignature).toBe(signature);
    expect(controller.getState().hasUnexportedChanges).toBe(false);

    // Preview, export request and the pipeline share one RenderResult.html.
    expect(requests).toHaveLength(1);
    expect(requests[0]?.html).toBe(controller.getResult()?.html);
    expect(requests[0]?.html).toBe(iframeOf(controller)?.getAttribute('srcdoc'));

    await controller.setMarkdown('# 首页 v2');
    controller.setExporter(async () => ipcFail('internal_error', '磁盘写入失败'));
    const failed = await controller.exportHtml();
    expect(failed.status).toBe('failed');
    expect(controller.getState().exportedSignature).toBe(signature);
    expect(controller.getState().hasUnexportedChanges).toBe(true);
  });

  it('opens an HTML file in source and preview modes and refuses Markdown export while showing it', async () => {
    const controller = mount();
    await controller.setDocument({ path: '笔记/首页.md', markdown: '# 首页' });

    const html = '<!doctype html><html><head><title>静态</title></head><body><p>静态页面</p></body></html>';
    controller.openHtmlFile({ path: '导出/页面.html', html });

    const state = controller.getState();
    expect(state.kind).toBe('html-file');
    expect(state.documentPath).toBe('导出/页面.html');
    expect(controller.element.dataset.kind).toBe('html-file');
    expect(controller.element.dataset.view).toBe('preview');
    expect(iframeOf(controller)?.getAttribute('srcdoc')).toContain('Content-Security-Policy');
    expect(iframeOf(controller)?.getAttribute('srcdoc')).toContain('静态页面');
    expect(controller.element.querySelector('.mdl-html-source')?.textContent).toContain('静态页面');

    controller.setViewMode('source');
    expect(controller.element.dataset.view).toBe('source');
    expect(controller.getState().viewMode).toBe('source');

    controller.setViewMode('preview');
    expect(controller.element.dataset.view).toBe('preview');

    const outcome = await controller.exportHtml();
    expect(outcome.status).toBe('failed');
    if (outcome.status !== 'failed') throw new Error('expected the export to fail');
    expect(outcome.error.code).toBe('invalid_request');
  });
});
