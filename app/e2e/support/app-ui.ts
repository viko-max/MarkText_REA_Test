/**
 * Thin, test-only UI helpers for Markdown Lite Studio.
 *
 * These helpers only read the DOM, click/fill real controls and inspect the
 * renderer's own iframe. They never reach into product internals or write
 * application state directly.
 */

import { expect, type Locator, type Page } from '@playwright/test';
import { waitFor } from './harness';

export const PREVIEW_FRAME = '#preview-host iframe';

export function fileTreeItem(page: Page, relativePath: string): Locator {
  return page.locator(`#file-tree button.tree-file[data-path="${relativePath}"]`);
}

export function activeTab(page: Page): Locator {
  return page.locator('#document-tabs li.doc-tab[data-active="true"]');
}

export function activeTabTitle(page: Page): Locator {
  return activeTab(page).locator('.doc-tab-title');
}

export async function openMarkdownFile(page: Page, relativePath: string): Promise<void> {
  const title = relativePath.split('/').pop() ?? relativePath;
  await fileTreeItem(page, relativePath).click();
  await expect(activeTabTitle(page)).toHaveText(title);
  await expect(page.locator('#editor-host .cm-content')).toBeVisible();
  await expect(activeTab(page)).toHaveAttribute('data-state', /clean|dirty|saving/);
}

export async function openHtmlFile(page: Page, relativePath: string): Promise<void> {
  const title = relativePath.split('/').pop() ?? relativePath;
  await fileTreeItem(page, relativePath).click();
  await expect(activeTabTitle(page)).toHaveText(title);
  await expect(page.locator('.mdl-html-workspace[data-kind="html-file"]')).toBeVisible();
}

export function previewFrame(page: Page) {
  return page.frameLocator(PREVIEW_FRAME);
}

export async function editorText(page: Page): Promise<string> {
  return page.locator('#editor-host .cm-content').innerText();
}

export async function focusEditor(page: Page): Promise<void> {
  await page.locator('#editor-host .cm-content').click();
}

export async function activeTabState(page: Page): Promise<string | null> {
  return activeTab(page).getAttribute('data-state');
}

export async function statusMessage(page: Page): Promise<string> {
  return (await page.locator('#status-message').textContent()) ?? '';
}

export async function activeDocumentStatus(page: Page): Promise<string> {
  return (await page.locator('#status-document').textContent()) ?? '';
}

export async function fillModalField(page: Page, field: string, value: string): Promise<void> {
  const input = page.locator(`.modal input[data-field="${field}"]`);
  await input.fill(value);
}

export async function submitModal(page: Page): Promise<void> {
  await page.locator('.modal button[data-primary="true"]').click();
  await expect(page.locator('.modal')).toHaveCount(0);
}

export async function clickModalButton(page: Page, label: string): Promise<void> {
  await page.locator('.modal button', { hasText: label }).click();
}

export async function setThemeNumber(page: Page, field: string, value: number): Promise<void> {
  const input = page.locator(`#theme-panel-host input[data-field="${field}"]`);
  await input.fill(String(value));
  await input.press('Tab');
}

export async function setThemeText(page: Page, field: string, value: string): Promise<void> {
  const input = page.locator(`#theme-panel-host input[data-field="${field}"]`);
  await input.fill(value);
  await input.press('Tab');
}

export async function setThemeColour(page: Page, field: string, value: string): Promise<void> {
  await page.locator(`#theme-panel-host input[data-field="${field}"]`).evaluate((element, next) => {
    const input = element as HTMLInputElement;
    input.value = String(next);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  }, value);
}

export async function setThemeCheckbox(page: Page, field: string, checked: boolean): Promise<void> {
  await page.locator(`#theme-panel-host input[data-field="${field}"]`).setChecked(checked);
}

export async function setThemeSelect(page: Page, field: string, value: string): Promise<void> {
  await page.locator(`#theme-panel-host select[data-field="${field}"]`).selectOption(value);
}

export interface FrameThemeSnapshot {
  bodyWidth: string;
  fontSize: string;
  lineHeight: string;
  background: string;
  sidebarWidth: string;
  title: string | null;
  sidebarPosition: string | null;
  outlineVisibility: string | null;
  outlinePosition: string | null;
  mode: string | null;
}

/** Reads computed CSS variables and document data attributes inside the preview. */
export async function frameThemeSnapshot(page: Page): Promise<FrameThemeSnapshot> {
  const html = previewFrame(page).locator('html');
  return html.evaluate((element) => {
    const style = getComputedStyle(element);
    const root = element as HTMLElement;
    return {
      bodyWidth: style.getPropertyValue('--mdl-body-width').trim(),
      fontSize: style.getPropertyValue('--mdl-font-size').trim(),
      lineHeight: style.getPropertyValue('--mdl-line-height').trim(),
      background: style.getPropertyValue('--mdl-bg').trim(),
      sidebarWidth: style.getPropertyValue('--mdl-sidebar-width').trim(),
      title: root.getAttribute('data-mdl-title'),
      sidebarPosition: root.getAttribute('data-mdl-sidebar-position'),
      outlineVisibility: root.getAttribute('data-mdl-outline'),
      outlinePosition: root.getAttribute('data-mdl-outline-position'),
      mode: root.getAttribute('data-mdl-mode'),
    };
  });
}

export interface GraphNodeSnapshot {
  id: string;
  label: string;
  kind: string;
}

export interface GraphEdgeSnapshot {
  source: string;
  target: string;
  resolution: string;
  count: number;
}

export interface GraphSnapshot {
  nodes: GraphNodeSnapshot[];
  edges: GraphEdgeSnapshot[];
  status: string;
}

function stripNodePrefix(value: string): string {
  const colon = value.indexOf(':');
  return value.startsWith('note:') || value.startsWith('missing:') ? value.slice(colon + 1) : value;
}

/** Reads the live Cytoscape instance the graph view registered on its container. */
export async function graphSnapshot(page: Page): Promise<GraphSnapshot> {
  await page.waitForFunction(() => {
    const canvas = document.querySelector('.mdl-graph-canvas') as
      | (HTMLElement & { _cyreg?: { cy?: unknown } })
      | null;
    return Boolean(canvas?._cyreg?.cy);
  });
  return page.evaluate(() => {
    const canvas = document.querySelector('.mdl-graph-canvas') as unknown as {
      _cyreg: {
        cy: {
          nodes: () => Array<{ data: (key: string) => unknown }>;
          edges: () => Array<{ data: (key: string) => unknown }>;
        };
      };
    };
    const cy = canvas._cyreg.cy;
    const strip = (value: string): string =>
      value.startsWith('note:') || value.startsWith('missing:')
        ? value.slice(value.indexOf(':') + 1)
        : value;
    return {
      nodes: cy.nodes().map((node) => ({
        id: strip(String(node.data('path'))),
        label: String(node.data('label')),
        kind: String(node.data('kind')),
      })),
      edges: cy.edges().map((edge) => ({
        source: strip(String(edge.data('source'))),
        target: strip(String(edge.data('target'))),
        resolution: String(edge.data('resolution')),
        count: Number(edge.data('count')),
      })),
      status: document.querySelector('.mdl-graph-status')?.textContent ?? '',
    };
  });
}

/**
 * Clicks a node at its rendered position. Cytoscape renders on a canvas, so
 * this is the only way to exercise the real tap handler.
 */
export async function clickGraphNode(page: Page, path: string): Promise<void> {
  const point = await page.evaluate((nodePath) => {
    const canvas = document.querySelector('.mdl-graph-canvas') as unknown as {
      getBoundingClientRect: () => DOMRect;
      _cyreg: {
        cy: {
          nodes: () => Array<{
            data: (key: string) => unknown;
            renderedPosition: () => { x: number; y: number };
          }>;
        };
      };
    };
    const cy = canvas._cyreg.cy;
    const node = cy.nodes().find((entry) => String(entry.data('path')) === nodePath);
    if (!node) return null;
    const rect = canvas.getBoundingClientRect();
    const position = node.renderedPosition();
    return { x: rect.x + position.x, y: rect.y + position.y };
  }, path);
  if (point === null) throw new Error(`graph node not found: ${path}`);
  await page.mouse.click(point.x, point.y);
}

export async function waitForGraphNode(page: Page, path: string, timeoutMs = 10_000): Promise<void> {
  await waitFor(
    async () => {
      const snapshot = await graphSnapshot(page);
      return snapshot.nodes.some((node) => node.id === path);
    },
    timeoutMs,
    150,
    `graph node ${path}`,
  );
}

export async function waitForPreviewText(page: Page, text: string, timeoutMs = 1_500): Promise<void> {
  await expect(previewFrame(page).locator('.mdl-content')).toContainText(text, { timeout: timeoutMs });
}
