/// <reference lib="dom" />
/**
 * Shared Markdown → HTML pipeline tests.
 *
 * These exercise the real marked + DOMPurify pipeline under jsdom. jsdom@26
 * ships no type declarations and the test project must not gain new
 * dependencies, so it is loaded through `createRequire` with a local shape; the
 * `lib="dom"` reference gives the test file the DOM types of the jsdom document
 * it drives (the node tsconfig for `src/main` stays DOM-free).
 */

import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import { buildExportHtmlRequest } from '../src/renderer/src/html/export-request';
import { MarkdownRenderPipeline } from '../src/renderer/src/render/markdown-render-pipeline';
import { createDomPurifySanitizer } from '../src/renderer/src/render/sanitize';
import type {
  ImageResourceData,
  ImageResourceResolver,
  WikiLinkResolver,
} from '../src/renderer/src/render/types';
import type { ImageMediaType } from '../src/shared/contracts';
import { DEFAULT_LAYOUT, DEFAULT_THEME } from '../src/shared/defaults';

interface JsdomInstance {
  window: Window & typeof globalThis;
}

const { JSDOM } = createRequire(import.meta.url)('jsdom') as {
  JSDOM: new (html?: string) => JsdomInstance;
};

const dom = new JSDOM('<!doctype html><html><body></body></html>');
const sanitize = createDomPurifySanitizer(dom.window);
const pipeline = new MarkdownRenderPipeline({ sanitize });

function parseBody(html: string): Document {
  return new JSDOM(`<!doctype html><html><body>${html}</body></html>`).window.document;
}

const PNG = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
]);

function imagePayload(path: string, bytes: Buffer, mediaType: ImageMediaType): ImageResourceData {
  return {
    path,
    mediaType,
    dataBase64: bytes.toString('base64'),
    sha256: createHash('sha256').update(bytes).digest('hex'),
    bytes: bytes.length,
  };
}

const BASE_INPUT = {
  documentPath: '笔记/示例.md',
  theme: DEFAULT_THEME,
  layout: DEFAULT_LAYOUT,
};

describe('MarkdownRenderPipeline', () => {
  it('renders headings, task lists, quotes, tables, code blocks and Chinese text', async () => {
    const markdown = [
      '# 一级标题',
      '',
      '## 二级标题',
      '',
      '中文正文段落，包含标点：，。',
      '',
      '- [ ] 未完成待办',
      '- [x] 已完成待办',
      '',
      '> 引用内容',
      '',
      '| 列一 | 列二 |',
      '| --- | --- |',
      '| 甲 | 乙 |',
      '',
      '```js',
      'const answer = 42;',
      '```',
    ].join('\n');

    const result = await pipeline.render({ ...BASE_INPUT, markdown });
    const doc = parseBody(result.bodyHtml);

    expect(result.title).toBe('一级标题');
    expect(doc.querySelector('h1.mdl-heading')?.textContent).toContain('一级标题');
    expect(doc.querySelector('h2.mdl-heading')?.textContent).toContain('二级标题');
    expect(doc.body.textContent).toContain('中文正文段落，包含标点：，。');

    const boxes = doc.querySelectorAll('input[type="checkbox"]');
    expect(boxes).toHaveLength(2);
    expect(boxes[0]?.hasAttribute('checked')).toBe(false);
    expect(boxes[1]?.hasAttribute('checked')).toBe(true);

    expect(doc.querySelector('blockquote')?.textContent).toContain('引用内容');
    expect(doc.querySelectorAll('table tbody tr')).toHaveLength(1);
    expect(doc.querySelectorAll('table td')).toHaveLength(2);
    expect(doc.querySelector('pre.mdl-code-block code.language-js')?.textContent).toContain(
      'const answer = 42;',
    );
    expect(result.html).toContain('中文正文段落');
  });

  it('keeps [[示例]] outside wikilink tokens inside code and codespans', async () => {
    const resolveWikiLink: WikiLinkResolver = (link) => ({
      state: 'resolved',
      href: `notes/${link.target}.md`,
    });
    const withLinks = new MarkdownRenderPipeline({ sanitize, resolveWikiLink });
    const markdown = [
      '正文 [[示例]]',
      '',
      '行内 `[[示例]]`',
      '',
      '```md',
      '[[示例]]',
      '```',
    ].join('\n');

    const result = await withLinks.render({ ...BASE_INPUT, markdown });
    const doc = parseBody(result.bodyHtml);

    expect(result.bodyHtml.match(/data-mdl-wikilink=/g)).toHaveLength(1);
    const link = doc.querySelector('a[data-mdl-wikilink="resolved"]');
    expect(link?.getAttribute('href')).toBe('notes/示例.md');
    expect(link?.textContent).toBe('示例');

    const codes = [...doc.querySelectorAll('code')];
    expect(codes).toHaveLength(2);
    for (const code of codes) {
      expect(code.querySelector('[data-mdl-wikilink]')).toBeNull();
      expect(code.textContent).toBe('[[示例]]');
    }
  });

  it('escapes raw HTML and blocks scripts, event attributes and javascript: URLs', async () => {
    const markdown = [
      '<script>alert("script")</script>',
      '',
      '<img src="x" onerror="alert(\'onerror\')">',
      '',
      '[危险链接](javascript:alert(1))',
      '',
      '<b onclick="alert(2)">加粗</b>',
    ].join('\n');

    const result = await pipeline.render({ ...BASE_INPUT, markdown });
    const doc = parseBody(result.bodyHtml);

    expect(result.html).not.toContain('<script');
    expect(result.html).not.toContain('javascript:');
    expect(result.html).not.toContain('<img src="x"');
    expect(doc.querySelector('script')).toBeNull();
    expect(doc.querySelectorAll('a[href^="javascript:"]')).toHaveLength(0);

    for (const element of doc.querySelectorAll('*')) {
      const eventAttributes = [...element.attributes].filter((attribute) =>
        attribute.name.toLowerCase().startsWith('on'),
      );
      expect(eventAttributes).toEqual([]);
    }

    // Raw HTML is shown as text, never parsed.
    expect(result.bodyHtml).toContain('&lt;img');
    expect(doc.body.textContent).toContain('<img src="x"');
    expect(result.warnings.map((warning) => warning.code)).toContain('blocked_link');
    expect(doc.querySelector('.mdl-link-blocked')?.textContent).toBe('危险链接');
  });

  it('embeds local images, lists external ones, marks missing and rejects SVG and oversized assets', async () => {
    const big = Buffer.concat([PNG, Buffer.alloc(196, 0x01)]);
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>', 'utf8');
    const resolveImage: ImageResourceResolver = (request) => {
      if (request.path === 'images/ok.png') return imagePayload(request.path, PNG, 'image/png');
      if (request.path === 'images/big.png') return imagePayload(request.path, big, 'image/png');
      if (request.path === 'images/bad.svg') return imagePayload(request.path, svg, 'image/svg+xml');
      return null;
    };
    const withImages = new MarkdownRenderPipeline({ sanitize, resolveImage, maxImageBytes: 128 });
    const markdown = [
      '![本地](images/ok.png)',
      '',
      '![远程](https://example.com/a.png)',
      '',
      '![缺失](images/missing.png)',
      '',
      '![SVG](images/bad.svg)',
      '',
      '![太大](images/big.png)',
    ].join('\n');

    const result = await withImages.render({
      ...BASE_INPUT,
      documentPath: '示例.md',
      markdown,
    });
    const doc = parseBody(result.bodyHtml);

    const embedded = doc.querySelector('img[data-mdl-image="embedded"]');
    expect(embedded?.getAttribute('src')).toBe(`data:image/png;base64,${PNG.toString('base64')}`);
    expect(result.dependencies.embeddedLocalAssets).toEqual(['images/ok.png']);

    const external = doc.querySelector('img[data-mdl-image="external"]');
    expect(external?.getAttribute('src')).toBe('https://example.com/a.png');
    expect(result.dependencies.externalAssets).toContainEqual({
      url: 'https://example.com/a.png',
      reason: 'remote',
    });

    expect(doc.querySelector('[data-mdl-image="missing"]')).not.toBeNull();
    expect(result.dependencies.missingAssets).toEqual(['images/missing.png']);
    expect(result.warnings.map((warning) => warning.code)).toContain('image_missing');

    expect(doc.querySelector('[data-mdl-image="unsafe"]')).not.toBeNull();
    expect(result.bodyHtml).not.toContain('data:image/svg+xml');
    expect(result.warnings.map((warning) => warning.code)).toContain('image_unsafe');

    expect(doc.querySelector('[data-mdl-image="too_large"]')).not.toBeNull();
    expect(result.warnings.map((warning) => warning.code)).toContain('image_too_large');
  });

  it('produces a stable signature and changes it only when theme, layout or resources change', async () => {
    const resolveImage: ImageResourceResolver = (request) =>
      imagePayload(request.path, PNG, 'image/png');
    const withImages = new MarkdownRenderPipeline({ sanitize, resolveImage });
    const input = { ...BASE_INPUT, markdown: '# 标题\n\n正文 ![图](images/ok.png)' };

    const first = await withImages.render(input);
    const second = await withImages.render(input);
    expect(second.signature).toBe(first.signature);
    expect(second.html).toBe(first.html);

    const themed = await withImages.render({
      ...input,
      theme: { ...DEFAULT_THEME, accent: '#ff0000' },
    });
    expect(themed.signature).not.toBe(first.signature);

    const reflowed = await withImages.render({
      ...input,
      layout: { ...DEFAULT_LAYOUT, sidebar: { ...DEFAULT_LAYOUT.sidebar, widthPx: 320 } },
    });
    expect(reflowed.signature).not.toBe(first.signature);
  });

  it('lets preview and export consume the same RenderResult.html', async () => {
    const result = await pipeline.render({ ...BASE_INPUT, markdown: '# 首页\n\n预览与导出共用' });
    const request = buildExportHtmlRequest(result, { documentPath: BASE_INPUT.documentPath });

    expect(request.html).toBe(result.html);
    expect(request.signature).toBe(result.signature);
    expect(request.suggestedFileName).toBe('示例.html');
    expect(request.dependencies).toEqual(result.dependencies);
    expect(request.dependencies).not.toBe(result.dependencies);
  });
});
