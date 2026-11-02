/**
 * End-to-end behaviour cases E1–E8 from docs/plans/2026-11-02-e2e-orders.md.
 *
 * Every case runs against a fresh fixture copy with its own runtime directory.
 * The suite exercises the real production build (`npm run build`) through the
 * packaged Electron entry; it never imports renderer internals or writes
 * application state directly.
 */

import { expect, test } from '@playwright/test';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import {
  APP_ROOT,
  executeCase,
  waitFor,
  waitForFile,
  waitForFileContains,
  type CaseContext,
} from './support/harness';
import {
  activeTab,
  activeTabState,
  activeTabTitle,
  clickGraphNode,
  clickModalButton,
  editorText,
  fileTreeItem,
  fillModalField,
  focusEditor,
  frameThemeSnapshot,
  graphSnapshot,
  openHtmlFile,
  openMarkdownFile,
  previewFrame,
  setThemeCheckbox,
  setThemeColour,
  setThemeNumber,
  setThemeSelect,
  statusMessage,
  submitModal,
  waitForPreviewText,
} from './support/app-ui';

test.describe.configure({ timeout: 180_000 });

const HOME_NOTES = '首页.md';
const NESTED_NOTE = '目录/笔记.md';
const FIXTURE_PIXEL = path.resolve(APP_ROOT, '..', 'fixtures', 'notes-demo', 'assets', 'pixel.png');

function marker(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}`;
}

async function pasteFixturePng(page: import('@playwright/test').Page, editorSelector: string): Promise<void> {
  const base64 = readFileSync(FIXTURE_PIXEL).toString('base64');
  await page.locator(editorSelector).click();
  await page.evaluate(
    ({ data, selector }) => {
      const binary = atob(data);
      const bytes = new Uint8Array(binary.length);
      for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
      const file = new File([bytes], 'pixel.png', { type: 'image/png' });
      const transfer = new DataTransfer();
      transfer.items.add(file);
      const target = document.querySelector(selector);
      if (!(target instanceof HTMLElement)) throw new Error(`missing paste target ${selector}`);
      const event = new ClipboardEvent('paste', {
        clipboardData: transfer,
        bubbles: true,
        cancelable: true,
      });
      target.dispatchEvent(event);
    },
    { data: base64, selector: editorSelector },
  );
}

async function waitForEditorText(page: import('@playwright/test').Page, text: string, timeout = 10_000) {
  await waitFor(
    async () => (await editorText(page)).includes(text),
    timeout,
    100,
    `editor text to contain ${JSON.stringify(text)}`,
  );
}

async function apiGraph(
  page: import('@playwright/test').Page,
  focusPath: string,
): Promise<{ nodes: Array<{ id: string; kind: string }>; edges: Array<{ source: string; target: string; resolution: string }> }> {
  return page.evaluate(async (focus) => {
    const api = (
      window as unknown as {
        markdownLite: {
          links: {
            graph: (request: unknown) => Promise<{
              ok: boolean;
              value?: {
                nodes: Array<{ id: string; kind: string }>;
                edges: Array<{ source: string; target: string; resolution: string }>;
              };
            }>;
          };
        };
      }
    ).markdownLite;
    const result = await api.links.graph({ focusPath: focus, depth: 1 });
    if (!result.ok || !result.value) throw new Error('links.graph failed');
    return result.value;
  }, focusPath);
}

test('E1 startup and real file tree', async () => {
  await executeCase(
    'E1-startup-and-file-tree',
    { allowedConsoleErrors: [/Content Security Policy/i, /Refused to execute/i, /sandbox/i] },
    async (context: CaseContext) => {
      await context.launchApp();
      const page = context.page!;

      await context.step('window title is Markdown Lite Studio', async () => {
        await expect(page).toHaveTitle('Markdown Lite Studio');
      });

      await context.step('workspace is restored automatically', async () => {
        await expect(page.locator('#app')).toHaveClass(/has-workspace/);
        await expect(page.locator('#workspace-shell')).toBeVisible();
        await expect(page.locator('#workspace-name')).toHaveText(
          path.basename(context.workspaceAbsolute),
        );
        await expect(page.locator('#welcome')).toBeHidden();
      });

      await context.step('file tree lists every fixture note', async () => {
        for (const relative of [
          HOME_NOTES,
          NESTED_NOTE,
          'a/同名.md',
          'b/同名.md',
          '已有页面.html',
        ]) {
          await expect(fileTreeItem(page, relative)).toBeVisible();
        }
        await expect(fileTreeItem(page, '已有页面.html')).toHaveAttribute('data-kind', 'html');
      });

      await context.step('existing HTML file previews its static content', async () => {
        await openHtmlFile(page, '已有页面.html');
        const frame = previewFrame(page);
        await expect(frame.locator('h1.existing-page')).toHaveText('已有 HTML 页面');
        await expect(frame.locator('#existing-paragraph')).toContainText('静态内容');
      });

      await context.step('scripts inside the HTML file never execute', async () => {
        const frame = previewFrame(page);
        const state = await frame.locator('body').evaluate((body) => ({
          executed: (body as HTMLElement).dataset.scriptExecuted ?? null,
          title: document.title,
        }));
        expect(state.executed).toBeNull();
        expect(state.title).toBe('已有页面静态标题');
        context.note('已有页面.html contains a script that never ran inside the sandboxed srcdoc preview');
      });

      await context.step('source tab shows the original HTML text', async () => {
        await page.locator('.mdl-html-tab', { hasText: '源码' }).click();
        await expect(page.locator('.mdl-html-workspace')).toHaveAttribute('data-view', 'source');
        await expect(page.locator('.mdl-html-source')).toBeVisible();
        const source = (await page.locator('.mdl-html-source code').textContent()) ?? '';
        expect(source).toContain('<h1 class="existing-page">');
        expect(source).toContain('document.body.dataset.scriptExecuted');
        await context.capture('html-source');
      });

      await context.step('startup timings were recorded', async () => {
        expect(context.startup).toHaveLength(1);
        expect(context.startup[0]!.firstWindowMs).toBeGreaterThan(0);
        expect(context.startup[0]!.shellVisibleMs).toBeGreaterThan(
          context.startup[0]!.firstWindowMs,
        );
      });
    },
  );
});

test('E2 Chinese editing, preview, undo/redo and find', async () => {
  await executeCase('E2-editing-preview-undo-find', {}, async (context) => {
    await context.launchApp();
    const page = context.page!;
    const text = marker('E2独立标记');
    const autoText = marker('E2自动保存标记');

    await context.step('home note opens in the CodeMirror editor', async () => {
      await openMarkdownFile(page, HOME_NOTES);
      await expect(page.locator('#editor-host .cm-content')).toBeVisible();
      await expect(activeTabTitle(page)).toHaveText('首页.md');
    });

    await context.step('preview renders headings, tasks, table, code and image', async () => {
      const frame = previewFrame(page);
      await expect(frame.locator('.mdl-content h1')).toContainText('首页');
      await expect(frame.locator('.mdl-content h2')).toContainText('功能清单');
      await expect(frame.locator('.mdl-content input[type="checkbox"]')).toHaveCount(3);
      await expect(frame.locator('.mdl-content table th')).toHaveCount(2);
      await expect(frame.locator('.mdl-content table th').first()).toContainText('项目');
      await expect(frame.locator('.mdl-content pre.mdl-code-block code')).toContainText(
        '你好，Markdown',
      );
      await expect(frame.locator('.mdl-content img.mdl-image')).toHaveAttribute(
        'src',
        /^data:image\/png;base64,/,
      );
    });

    await context.step('inserting Chinese text updates the preview within 1.5s', async () => {
      await focusEditor(page);
      await page.keyboard.press('Control+End');
      await page.keyboard.insertText(`\n\n${text}`);
      await waitForPreviewText(page, text, 1_500);
    });

    await context.step('undo removes the marker', async () => {
      await expect(page.locator('#editor-host .cm-content')).toContainText(text);
      await page.keyboard.press('Control+z');
      await waitFor(
        async () => !(await editorText(page)).includes(text),
        3_000,
        100,
        'editor marker to disappear after undo',
      );
      await expect(previewFrame(page).locator('.mdl-content')).not.toContainText(text, {
        timeout: 1_500,
      });
    });

    await context.step('Ctrl+Shift+Z restores the marker', async () => {
      await page.keyboard.press('Control+Shift+z');
      await waitFor(
        async () => (await editorText(page)).includes(text),
        3_000,
        100,
        'editor marker to return after Ctrl+Shift+Z redo',
      );
      await waitForPreviewText(page, text, 1_500);
      context.note('Windows 风格的 Ctrl+Shift+Z 触发重做，预览同步恢复');
    });

    await context.step('caret and selection still work after undo/redo', async () => {
      await focusEditor(page);
      await page.keyboard.press('Control+End');
      await page.keyboard.press('Shift+ArrowLeft');
      const selectionLength = await page.evaluate(
        () => (window.getSelection()?.toString() ?? '').length,
      );
      expect(selectionLength).toBeGreaterThan(0);
      const tail = marker('E2光标');
      await page.keyboard.insertText(tail);
      await expect(page.locator('#editor-host .cm-content')).toContainText(tail);
      await page.keyboard.press('Control+z');
    });

    await context.step('search UI finds 首页 in the document', async () => {
      await page.locator('#find-in-document').click();
      const panel = page.locator('.cm-search');
      await expect(panel).toBeVisible();
      const field = panel.locator('input[name="search"]');
      await field.fill('首页');
      await field.press('End');
      await expect(page.locator('.cm-searchMatch').first()).toBeVisible({ timeout: 5_000 });
      await page.keyboard.press('Escape');
    });

    await context.step('manual save writes Chinese text to disk and clears dirty state', async () => {
      await focusEditor(page);
      await page.keyboard.press('Control+s');
      await waitForFileContains(context.workspacePath(HOME_NOTES), text);
      await expect(activeTab(page)).toHaveAttribute('data-state', 'clean', { timeout: 10_000 });
      await expect(page.locator('#status-document')).toContainText('已保存');
    });

    await context.step('autosave is on by default and writes without Ctrl+S', async () => {
      await expect(page.locator('#toggle-autosave')).toHaveAttribute('aria-pressed', 'true');
      await expect(page.locator('#toggle-autosave')).toContainText('自动保存：开');
      await focusEditor(page);
      await page.keyboard.press('Control+End');
      await page.keyboard.insertText(`\n\n${autoText}`);
      await waitForFileContains(context.workspacePath(HOME_NOTES), autoText, 8_000);
    });

    await context.capture('after-autosave');
  });
});

test('E3 new note, backlinks, graph and rename', async () => {
  await executeCase('E3-new-note-backlinks-graph-rename', {}, async (context) => {
    await context.launchApp();
    const page = context.page!;

    await context.step('new note modal creates 目录/新建.md on disk', async () => {
      await openMarkdownFile(page, HOME_NOTES);
      await page.locator('#new-note').click();
      await expect(page.locator('.modal')).toBeVisible();
      await fillModalField(page, 'directory', '目录');
      await fillModalField(page, 'fileName', '新建.md');
      await submitModal(page);
      await waitForFile(context.workspacePath('目录/新建.md'));
      await expect(activeTabTitle(page)).toHaveText('新建.md');
      await expect(activeTab(page)).toHaveAttribute('data-state', /clean|dirty/);
    });

    await context.step('editing and saving the new note updates the file', async () => {
      await focusEditor(page);
      await page.keyboard.insertText('# 新建');
      await page.keyboard.press('Enter');
      await page.keyboard.press('Enter');
      await page.keyboard.insertText('[[首页]]');
      await page.keyboard.press('Control+s');
      const content = await waitForFileContains(
        context.workspacePath('目录/新建.md'),
        '[[首页]]',
      );
      expect(content).toContain('# 新建');
    });

    await context.step('backlinks panel shows 新建.md as a source for 首页', async () => {
      await openMarkdownFile(page, HOME_NOTES);
      const backlink = page.locator('#backlinks-host .mdl-backlink[data-path="目录/新建.md"]');
      await expect(backlink).toBeVisible({ timeout: 10_000 });
      await expect(backlink).toContainText('目录/新建.md');
      await context.capture('backlinks');
    });

    await context.step('graph contains real 首页.md/新建.md nodes and their edge', async () => {
      await page.locator('#toggle-graph').click();
      await expect(page.locator('#main-area')).toHaveAttribute('data-view', 'graph');
      await expect(page.locator('#toggle-graph')).toHaveAttribute('aria-pressed', 'true');
      const snapshot = await waitForGraphWithNodes(page, ['首页.md', '目录/新建.md']);
      expect(snapshot.nodes.map((node) => node.id)).toContain('目录/新建.md');
      expect(snapshot.nodes.map((node) => node.id)).toContain(HOME_NOTES);
      expect(
        snapshot.edges.some(
          (edge) =>
            edge.source === '目录/新建.md' &&
            edge.target === HOME_NOTES &&
            edge.resolution === 'resolved',
        ),
      ).toBe(true);
      context.note(`graph nodes: ${snapshot.nodes.map((node) => node.id).join(', ')}`);
    });

    await context.step('graph nodes equal the real link index and invent nothing', async () => {
      const expected = await apiGraph(page, HOME_NOTES);
      const snapshot = await waitForGraphWithNodes(page, expected.nodes.map((node) => node.id));
      const actualIds = [...snapshot.nodes.map((node) => node.id)].sort();
      const expectedIds = [...expected.nodes.map((node) => node.id)].sort();
      expect(actualIds).toEqual(expectedIds);
      const actualEdges = snapshot.edges
        .map((edge) => `${edge.source}->${edge.target}:${edge.resolution}`)
        .sort();
      const expectedEdges = expected.edges
        .map((edge) => `${edge.source}->${edge.target}:${edge.resolution}`)
        .sort();
      expect(actualEdges).toEqual(expectedEdges);
      await context.capture('graph');
    });

    await context.step('clicking a graph node opens the matching note', async () => {
      await clickGraphNode(page, '目录/新建.md');
      await expect(activeTabTitle(page)).toHaveText('新建.md', { timeout: 10_000 });
      await expect(page.locator('#editor-host .cm-content')).toContainText('# 新建');
      await page.locator('#toggle-graph').click();
      await expect(page.locator('#main-area')).not.toHaveAttribute('data-view', 'graph');
    });

    await context.step('renaming updates the resolvable link and leaves the unrelated one alone', async () => {
      await openMarkdownFile(page, NESTED_NOTE);
      await page.locator('#rename-document').click();
      await expect(page.locator('.modal')).toBeVisible();
      await expect(page.locator('.modal input[data-field="directory"]')).toHaveValue('目录');
      await fillModalField(page, 'fileName', '改名.md');
      await submitModal(page);
      await waitForFile(context.workspacePath('目录/改名.md'));
      await waitFor(() => !existsSync(context.workspacePath(NESTED_NOTE)), 5_000);

      const home = readFileSync(context.workspacePath(HOME_NOTES), 'utf8');
      expect(home).toContain('[[目录/改名]]');
      expect(home).not.toContain('[[目录/笔记]]');
      // `[[同名]]` never resolved to the renamed note, so it must stay byte-identical
      // and must not be reported as a skipped ambiguous reference.
      expect(home).toContain('[[同名]]');

      const status = await statusMessage(page);
      expect(status).toContain('目录/改名.md');
      expect(status).toMatch(/更新 [1-9]\d* 个文件中的 [1-9]\d* 处引用/);
      expect(status).not.toContain('同名歧义');
      context.note(`rename status: ${status}`);
    });

    await context.step('the renamed note opens from the refreshed tree in split view', async () => {
      await fileTreeItem(page, '目录/改名.md').click();
      await expect(activeTabTitle(page)).toHaveText('改名.md');
      await expect(previewFrame(page).locator('.mdl-content')).toContainText('目录笔记');
      await expect(page.locator('#main-area')).toHaveAttribute('data-view', 'split');
      await expect(page.locator('#view-split')).toHaveAttribute('aria-pressed', 'true');
      await context.capture('renamed-note');
    });
  });
});

async function waitForGraphWithNodes(
  page: import('@playwright/test').Page,
  ids: readonly string[],
): Promise<Awaited<ReturnType<typeof graphSnapshot>>> {
  let snapshot = await graphSnapshot(page);
  await waitFor(
    async () => {
      snapshot = await graphSnapshot(page);
      return ids.every((id) => snapshot.nodes.some((node) => node.id === id));
    },
    10_000,
    150,
    `graph nodes ${ids.join(', ')}`,
  );
  return snapshot;
}

test('E4 pasted image asset, nested relative path and restart', async () => {
  await executeCase('E4-paste-image-and-restart', {}, async (context) => {
    await context.launchApp();
    const page = context.page!;
    const pixel = readFileSync(FIXTURE_PIXEL);
    const sha = createHash('sha256').update(pixel).digest('hex');
    const assetName = `${sha}.png`;

    await context.step('pasting a PNG into the root note creates a hashed asset', async () => {
      await openMarkdownFile(page, HOME_NOTES);
      await pasteFixturePng(page, '#editor-host .cm-content');
      await waitForEditorText(page, `assets/${assetName}`, 15_000);
      await waitForFile(context.workspacePath(`assets/${assetName}`), 10_000);
      const written = readFileSync(context.workspacePath(`assets/${assetName}`));
      expect(written.equals(pixel)).toBe(true);
      const text = await editorText(page);
      expect(text).toContain(`![](assets/${assetName})`);
      await page.keyboard.press('Control+s');
      await waitForFileContains(context.workspacePath(HOME_NOTES), `assets/${assetName}`);
      context.note(`root insertion uses assets/${assetName}`);
    });

    await context.step('pasting into a nested note uses ../assets', async () => {
      await openMarkdownFile(page, NESTED_NOTE);
      await pasteFixturePng(page, '#editor-host .cm-content');
      await waitForEditorText(page, `../assets/${assetName}`, 15_000);
      const text = await editorText(page);
      expect(text).toContain(`../assets/${assetName}`);
      expect(text).not.toContain(`](assets/${assetName})`);
      await page.keyboard.press('Control+s');
      await waitForFileContains(context.workspacePath(NESTED_NOTE), `../assets/${assetName}`);
      context.note(`nested insertion uses ../assets/${assetName}`);
      await context.capture('pasted-nested');
    });

    await context.step('restarting the same runtime still renders real image data', async () => {
      await page.waitForTimeout(900);
      const restartMarker = marker('E4重启');
      await focusEditor(page);
      await page.keyboard.press('Control+End');
      await page.keyboard.insertText(`\n\n${restartMarker}`);
      await page.keyboard.press('Control+s');
      await waitForFileContains(context.workspacePath(NESTED_NOTE), restartMarker);
      await page.waitForTimeout(700);

      await context.relaunchApp();
      const restarted = context.page!;
      await expect(restarted.locator('#workspace-shell')).toBeVisible();
      await expect(activeTabTitle(restarted)).toHaveText('笔记.md');
      const frame = previewFrame(restarted);
      const image = frame.locator('.mdl-content img.mdl-image').first();
      await expect(image).toBeVisible({ timeout: 10_000 });
      const src = await image.getAttribute('src');
      expect(src).toMatch(/^data:image\/png;base64,/);
      expect(src ?? '').not.toMatch(/^blob:/);
      expect((await editorText(restarted)).includes(restartMarker)).toBe(true);
      expect(existsSync(context.workspacePath(`assets/${assetName}`))).toBe(true);
      const viewMode = await restarted.locator('#main-area').getAttribute('data-view');
      context.note(`restart restored main-area view mode: ${viewMode}`);
      context.note('restarted preview uses a persistent data URI rather than a blob URL');
      await context.capture('after-restart');
    });
  });
});

test('E5 theme, layout, HTML preview and export', async () => {
  await executeCase('E5-theme-layout-export', {}, async (context) => {
    writeFileSync(
      context.workspacePath('导出.html'),
      '<!doctype html><html><body><p>export placeholder</p></body></html>\n',
    );

    await context.launchApp();
    const page = context.page!;
    const exportPath = context.workspacePath('导出.html');

    await context.step('theme panel changes drive preview CSS variables', async () => {
      await openMarkdownFile(page, HOME_NOTES);
      await page.locator('#toggle-theme-panel').click();
      await expect(page.locator('#theme-panel-host')).toBeVisible();

      await setThemeSelect(page, 'mode', 'light');
      await setThemeNumber(page, 'bodyWidthPx', 760);
      await setThemeNumber(page, 'fontSizePx', 19);
      await setThemeNumber(page, 'lineHeight', 1.85);
      await setThemeColour(page, 'background', '#fff8e1');
      await setThemeCheckbox(page, 'title.visible', false);
      await setThemeCheckbox(page, 'outline.visible', false);
      await setThemeSelect(page, 'sidebar.position', 'right');
      await setThemeNumber(page, 'sidebar.widthPx', 320);

      await waitFor(
        async () => {
          const snapshot = await frameThemeSnapshot(page);
          return (
            snapshot.bodyWidth === '760px' &&
            snapshot.fontSize === '19px' &&
            snapshot.lineHeight === '1.85' &&
            snapshot.background === '#fff8e1' &&
            snapshot.sidebarWidth === '320px' &&
            snapshot.title === 'hidden' &&
            snapshot.outlineVisibility === 'hidden' &&
            snapshot.sidebarPosition === 'right' &&
            snapshot.mode === 'light'
          );
        },
        15_000,
        200,
        'preview theme variables to update',
      );

      const snapshot = await frameThemeSnapshot(page);
      expect(snapshot).toMatchObject({
        bodyWidth: '760px',
        fontSize: '19px',
        lineHeight: '1.85',
        background: '#fff8e1',
        sidebarWidth: '320px',
        title: 'hidden',
        outlineVisibility: 'hidden',
        sidebarPosition: 'right',
        mode: 'light',
      });
    });

    await context.step('root layout follows sidebar and outline configuration', async () => {
      await expect(page.locator('#app')).toHaveClass(/layout-sidebar-right/);
      await expect(page.locator('#app')).toHaveClass(/layout-outline-hidden/);
      await expect(page.locator('#app')).not.toHaveClass(/layout-sidebar-hidden/);
      const sidebarWidth = await page
        .locator('#app')
        .evaluate((element) => (element as HTMLElement).style.getPropertyValue('--sidebar-width'));
      expect(sidebarWidth).toBe('320px');
      const box = await page.locator('#sidebar').boundingBox();
      expect(Math.round(box?.width ?? 0)).toBe(320);
      await context.capture('theme-layout');
    });

    await context.step('export writes a real single-file HTML document', async () => {
      await context.stubSaveDialog(exportPath);
      await page.locator('#export-html').click();
      await waitForFileContains(exportPath, 'name="mdl-signature"', 20_000);
      const html = readFileSync(exportPath, 'utf8');
      expect(html).toContain('<!doctype html>');
      expect(html).toContain('name="generator" content="Markdown Lite Studio"');
      expect(html).not.toMatch(/<script\b/i);
      expect(html).toContain('<img class="mdl-image" src="data:image/png;base64,');
      expect(html).toContain('--mdl-body-width: 760px');
      expect(html).toContain('--mdl-font-size: 19px');
      await expect(page.locator('.mdl-html-badge')).toHaveText('已导出', { timeout: 10_000 });
    });

    await context.step('exported bytes equal the preview srcdoc', async () => {
      const srcdoc = await page.locator('#preview-host iframe').getAttribute('srcdoc');
      const exported = readFileSync(exportPath, 'utf8');
      expect(srcdoc).not.toBeNull();
      expect(exported).toBe(srcdoc);
      context.note('exported file is byte-identical to the in-app iframe srcdoc');
    });

    await context.step('editing marks unexported changes and a second export clears it', async () => {
      const exportMarker = marker('E5导出标记');
      await focusEditor(page);
      await page.keyboard.press('Control+End');
      await page.keyboard.insertText(`\n\n${exportMarker}`);
      await expect(page.locator('.mdl-html-badge')).toHaveText('有未导出修改', { timeout: 5_000 });
      await page.locator('#export-html').click();
      await expect(page.locator('.mdl-html-badge')).toHaveText('已导出', { timeout: 20_000 });
      await waitForFileContains(exportPath, exportMarker, 20_000);
      await context.capture('exported');
    });

    await context.step('the exported HTML can be previewed and inspected in the app', async () => {
      await openHtmlFile(page, '导出.html');
      const frame = previewFrame(page);
      await expect(frame.locator('.mdl-doc-title')).toHaveText('首页');
      await expect(frame.locator('.mdl-content h1')).toContainText('首页');
      await page.locator('.mdl-html-tab', { hasText: '源码' }).click();
      const source = (await page.locator('.mdl-html-source code').textContent()) ?? '';
      expect(source).toContain('<!doctype html>');
      expect(source).toContain('name="mdl-signature"');
      expect(source).toContain('导出标记');
      expect(source).not.toMatch(/<script\b/i);
      await context.capture('reopened-export');
    });
  });
});

test('E6 external changes, missing links and save failures', async () => {
  await executeCase('E6-external-changes-and-failures', {
    allowedMainErrors: [/unhandled handler error[\s\S]*EPERM/],
  }, async (context) => {
    const readonlyNote = '只读.md';
    writeFileSync(context.workspacePath(readonlyNote), '# 只读测试\n\n用于验证保存失败。\n');

    await context.launchApp();
    const page = context.page!;

    await context.step('missing wiki link is marked and does not create a file', async () => {
      await openMarkdownFile(page, HOME_NOTES);
      const frame = previewFrame(page);
      const missing = frame.locator('.mdl-wikilink[data-mdl-wikilink="missing"]');
      await expect(missing).toHaveAttribute('data-mdl-target', '不存在');
      await expect(
        frame.locator('.mdl-wikilink[data-mdl-wikilink="ambiguous"][data-mdl-target="同名"]'),
      ).toBeVisible();
      await missing.click();
      await page.waitForTimeout(600);
      expect(existsSync(context.workspacePath('不存在.md'))).toBe(false);
      expect(await activeTabTitle(page).textContent()).toBe('首页.md');
    });

    await context.step('graph marks the missing target and clicking it opens nothing', async () => {
      await page.locator('#toggle-graph').click();
      await expect(page.locator('#main-area')).toHaveAttribute('data-view', 'graph');
      const snapshot = await waitForGraphWithNodes(page, ['不存在']);
      const missingNode = snapshot.nodes.find((node) => node.id === '不存在');
      expect(missingNode?.kind).toBe('missing');
      await clickGraphNode(page, '不存在');
      await page.waitForTimeout(600);
      expect(existsSync(context.workspacePath('不存在.md'))).toBe(false);
      expect(await activeTabTitle(page).textContent()).toBe('首页.md');
      await context.capture('missing-in-graph');
      await page.locator('#toggle-graph').click();
    });

    await context.step('external write raises a conflict and blocks manual save', async () => {
      const localMarker = marker('E6本地');
      const externalText = `# 首页\n\n外部写入内容 ${marker('EXT')}\n`;
      await focusEditor(page);
      await page.keyboard.press('Control+End');
      await page.keyboard.insertText(`\n\n${localMarker}`);
      await expect(activeTab(page)).toHaveAttribute('data-state', 'dirty');

      writeFileSync(context.workspacePath(HOME_NOTES), externalText);
      await expect(page.locator('#status-action')).toBeVisible({ timeout: 10_000 });
      await expect(page.locator('#status-action')).toContainText('磁盘已变更');
      await expect(activeTab(page)).toHaveAttribute('data-state', 'conflict');

      await focusEditor(page);
      await page.keyboard.press('Control+s');
      await page.waitForTimeout(500);
      expect(readFileSync(context.workspacePath(HOME_NOTES), 'utf8')).toBe(externalText);
      await expect(activeTab(page)).toHaveAttribute('data-state', 'conflict');
      context.note(`conflict status after manual save: ${await statusMessage(page)}`);

      await page.waitForTimeout(2_500);
      expect(readFileSync(context.workspacePath(HOME_NOTES), 'utf8')).toBe(externalText);
      context.note('manual save and the autosave window both left the external text untouched');
    });

    await context.step('reload confirmation imports the external text', async () => {
      await page.locator('#status-action').click();
      await expect(page.locator('.modal')).toBeVisible();
      await clickModalButton(page, '重新加载');
      await waitForEditorText(page, '外部写入内容', 10_000);
      await expect(activeTab(page)).toHaveAttribute('data-state', 'clean');
      await expect(page.locator('#status-action')).toBeHidden();
    });

    await context.step('external deletion marks the document missing and blocks saving', async () => {
      unlinkSync(context.workspacePath(HOME_NOTES));
      await expect(page.locator('#status-action')).toContainText('文件缺失', { timeout: 10_000 });
      await expect(activeTab(page)).toHaveAttribute('data-state', 'missing');
      await focusEditor(page);
      await page.keyboard.press('Control+s');
      await page.waitForTimeout(500);
      expect(existsSync(context.workspacePath(HOME_NOTES))).toBe(false);
      await expect(activeTab(page)).toHaveAttribute('data-state', 'missing');
      context.note(`missing status after manual save: ${await statusMessage(page)}`);
    });

    await context.step('a read-only target reports a clear save failure', async () => {
      await openMarkdownFile(page, readonlyNote);
      const saveMarker = marker('E6只读');
      await focusEditor(page);
      await page.keyboard.press('Control+End');
      await page.keyboard.insertText(`\n\n${saveMarker}`);
      chmodSync(context.workspacePath(readonlyNote), 0o444);
      await page.keyboard.press('Control+s');
      await expect(page.locator('#status-message')).toHaveAttribute('data-kind', 'error', {
        timeout: 10_000,
      });
      await expect(page.locator('#status-message')).toContainText('保存失败');
      const onDisk = readFileSync(context.workspacePath(readonlyNote), 'utf8');
      expect(onDisk).not.toContain(saveMarker);
      expect(await activeTabState(page)).not.toBe('clean');
      context.note(`save failure status: ${await statusMessage(page)}`);
      chmodSync(context.workspacePath(readonlyNote), 0o666);
      await context.capture('save-failure');
    });
  });
});

test('E7 restart restores workspace, documents, theme and layout', async () => {
  await executeCase('E7-restart-restore', {}, async (context) => {
    await context.launchApp();
    let page = context.page!;
    const homeMarker = marker('E7首页');
    const nestedMarker = marker('E7目录');

    await context.step('two notes are edited and saved', async () => {
      await openMarkdownFile(page, HOME_NOTES);
      await focusEditor(page);
      await page.keyboard.press('Control+End');
      await page.keyboard.insertText(`\n\n${homeMarker}`);
      await page.keyboard.press('Control+s');
      await waitForFileContains(context.workspacePath(HOME_NOTES), homeMarker);

      await openMarkdownFile(page, NESTED_NOTE);
      await focusEditor(page);
      await page.keyboard.press('Control+End');
      await page.keyboard.insertText(`\n\n${nestedMarker}`);
      await page.keyboard.press('Control+s');
      await waitForFileContains(context.workspacePath(NESTED_NOTE), nestedMarker);
    });

    await context.step('theme and layout are changed through the panel', async () => {
      await page.locator('#toggle-theme-panel').click();
      await setThemeNumber(page, 'bodyWidthPx', 900);
      await setThemeColour(page, 'background', '#eef7ff');
      await setThemeSelect(page, 'sidebar.position', 'right');
      await setThemeNumber(page, 'sidebar.widthPx', 300);
      await setThemeCheckbox(page, 'outline.visible', false);
      await waitFor(
        async () => {
          const snapshot = await frameThemeSnapshot(page);
          return (
            snapshot.bodyWidth === '900px' &&
            snapshot.background === '#eef7ff' &&
            snapshot.sidebarPosition === 'right' &&
            snapshot.sidebarWidth === '300px' &&
            snapshot.outlineVisibility === 'hidden'
          );
        },
        15_000,
        200,
        'theme before restart',
      );
    });

    await context.step('active document is 目录/笔记.md before shutdown', async () => {
      await page.locator('#tab-open').click();
      await page
        .locator('#document-tabs li.doc-tab', { hasText: '笔记.md' })
        .locator('.doc-tab-main')
        .click();
      await expect(activeTabTitle(page)).toHaveText('笔记.md');
      await page.waitForTimeout(900);
    });

    await context.step('restart restores workspace, tabs and the active document', async () => {
      await context.relaunchApp();
      page = context.page!;
      await expect(page.locator('#workspace-shell')).toBeVisible();
      await expect(page.locator('#app')).toHaveClass(/has-workspace/);
      await expect(page.locator('#document-tabs li.doc-tab')).toHaveCount(2);
      await expect(activeTabTitle(page)).toHaveText('笔记.md');
      await expect(page.locator('#editor-host .cm-content')).toContainText(nestedMarker);
      await expect(page.locator('#editor-host .cm-content')).toContainText('目录笔记');
      const preview = previewFrame(page).locator('.mdl-content');
      await expect(preview).toContainText(nestedMarker);
      await expect(preview).toContainText('目录笔记');
      // Split is a first-class persisted view mode, not a preview fallback.
      await expect(page.locator('#main-area')).toHaveAttribute('data-view', 'split');
      await expect(page.locator('#view-split')).toHaveAttribute('aria-pressed', 'true');
    });

    await context.step('theme, layout and Chinese content survive the restart', async () => {
      const snapshot = await frameThemeSnapshot(page);
      expect(snapshot.bodyWidth).toBe('900px');
      expect(snapshot.background).toBe('#eef7ff');
      expect(snapshot.sidebarPosition).toBe('right');
      expect(snapshot.sidebarWidth).toBe('300px');
      expect(snapshot.outlineVisibility).toBe('hidden');
      await expect(page.locator('#app')).toHaveClass(/layout-sidebar-right/);
      await expect(page.locator('#app')).toHaveClass(/layout-outline-hidden/);

      await page.locator('#tab-open').click();
      await page
        .locator('#document-tabs li.doc-tab', { hasText: '首页.md' })
        .locator('.doc-tab-main')
        .click();
      await expect(activeTabTitle(page)).toHaveText('首页.md');
      await expect(page.locator('#editor-host .cm-content')).toContainText(homeMarker);
      await expect(previewFrame(page).locator('.mdl-content')).toContainText(homeMarker);
      await context.capture('restarted');
    });
  });
});

test('E8 startup and resource measurements', async () => {
  await executeCase('E8-performance', {}, async (context) => {
    const perfDir = path.join(context.workspaceAbsolute, 'perf');
    mkdirSync(perfDir, { recursive: true });
    const docs: string[] = [];
    for (let index = 1; index <= 10; index += 1) {
      const name = `文档${String(index).padStart(2, '0')}.md`;
      writeFileSync(path.join(perfDir, name), `# 性能文档 ${index}\n\n用于资源观测的第 ${index} 篇短文。\n`);
      docs.push(`perf/${name}`);
    }

    await context.launchApp();
    const page = context.page!;

    await context.step('startup timings are recorded', async () => {
      expect(context.startup).toHaveLength(1);
      expect(context.startup[0]!.firstWindowMs).toBeGreaterThan(0);
      expect(context.startup[0]!.shellVisibleMs).toBeGreaterThanOrEqual(
        context.startup[0]!.firstWindowMs,
      );
    });

    await page.waitForTimeout(900);
    const afterStartup = await context.mainRss();
    expect(afterStartup).not.toBeNull();

    await context.step('ten small documents open through the real file tree', async () => {
      for (const relative of docs) {
        await openMarkdownFile(page, relative);
      }
      await expect(page.locator('#document-tabs li.doc-tab')).toHaveCount(10);
    });

    await page.waitForTimeout(900);
    const afterTenDocuments = await context.mainRss();
    expect(afterTenDocuments).not.toBeNull();

    await context.step('measurements are written to performance.json', async () => {
      const appInfo = await page.evaluate(async () => {
        const api = (
          window as unknown as {
            markdownLite: { app: { getInfo: () => Promise<{ ok: boolean; value?: unknown }> } };
          }
        ).markdownLite;
        const result = await api.app.getInfo();
        return result.ok ? result.value : null;
      });

      const startup = context.startup[0]!;
      const report = {
        generatedAt: new Date().toISOString(),
        application: appInfo,
        method: {
          startup:
            'performance.now() from electron.launch() to firstWindow and to #workspace-shell visible',
          rss: 'process.memoryUsage().rss read in the Electron main process after settling waits',
          documents: 'ten Markdown files created under the isolated workspace copy and opened via the file tree',
        },
        startup: {
          firstWindowMs: startup.firstWindowMs,
          workspaceShellVisibleMs: startup.shellVisibleMs,
        },
        rss: {
          afterStartup: afterStartup,
          afterTenDocuments: afterTenDocuments,
        },
        documentsOpened: 10,
        text: [
          `firstWindow: ${startup.firstWindowMs.toFixed(1)} ms`,
          `workspaceShellVisible: ${startup.shellVisibleMs.toFixed(1)} ms`,
          `rssAfterStartup: ${(afterStartup!.rss / 1024 / 1024).toFixed(2)} MiB`,
          `rssAfterTenDocuments: ${(afterTenDocuments!.rss / 1024 / 1024).toFixed(2)} MiB`,
        ].join('\n'),
      };

      const target = path.join(APP_ROOT, 'test-results', 'performance.json');
      writeFileSync(target, `${JSON.stringify(report, null, 2)}\n`);
      context.artifacts['performance.json'] = target;
      console.log(report.text);
      context.note(report.text);
    });
  });
});
