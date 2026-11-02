/**
 * Backlinks panel for the currently active note.
 *
 * The panel is a self-contained mount: it creates its root element inside the
 * supplied host, renders resolved backlinks with occurrence counts, and lists
 * sources whose same-name links are ambiguous.
 */

import type { BacklinkReport } from '../../../shared/contracts';
import { LinkStore } from './link-store';
import { ensureLinkStyles } from './styles';

export interface BacklinksPanelOptions {
  store: LinkStore;
  onOpenNote?: (path: string) => void;
  heading?: string;
}

export interface BacklinksPanelController {
  element: HTMLElement;
  /** Loads and renders backlinks for `path`; `null` shows the idle state. */
  setActiveNote(path: string | null): Promise<void>;
  refresh(): Promise<void>;
  destroy(): void;
}

export function mountBacklinksPanel(
  host: HTMLElement,
  options: BacklinksPanelOptions,
): BacklinksPanelController {
  const doc = host.ownerDocument;
  ensureLinkStyles(doc);

  const root = doc.createElement('section');
  root.className = 'mdl-backlinks';
  root.setAttribute('aria-label', options.heading ?? '反链');

  const header = doc.createElement('header');
  header.className = 'mdl-backlinks-header';
  const heading = doc.createElement('h2');
  heading.className = 'mdl-backlinks-title';
  heading.textContent = options.heading ?? '反链';
  const count = doc.createElement('span');
  count.className = 'mdl-backlinks-count';
  header.append(heading, count);

  const body = doc.createElement('div');
  body.className = 'mdl-backlinks-body';
  body.setAttribute('aria-live', 'polite');
  root.append(header, body);
  host.appendChild(root);

  let activePath: string | null = null;
  let requestToken = 0;

  function idle(): void {
    count.textContent = '';
    body.replaceChildren(message('选择一篇笔记查看反链。'));
  }

  function message(text: string, className = 'mdl-backlinks-empty'): HTMLParagraphElement {
    const paragraph = doc.createElement('p');
    paragraph.className = className;
    paragraph.textContent = text;
    return paragraph;
  }

  function renderError(error: unknown): void {
    count.textContent = '';
    const detail = error instanceof Error ? error.message : String(error);
    body.replaceChildren(message(`无法加载反链：${detail}`, 'mdl-backlinks-error'));
  }

  function renderReport(report: BacklinkReport): void {
    count.textContent =
      report.backlinks.length > 0 ? `${report.backlinks.length} 处` : '';
    body.replaceChildren();

    if (report.backlinks.length === 0) {
      body.append(message('没有其他笔记链接到这里。'));
    } else {
      const list = doc.createElement('ul');
      list.className = 'mdl-backlink-list';
      for (const backlink of report.backlinks) {
        const item = doc.createElement('li');
        const button = doc.createElement('button');
        button.type = 'button';
        button.className = 'mdl-backlink';
        button.dataset.path = backlink.sourcePath;

        const title = doc.createElement('span');
        title.className = 'mdl-backlink-title';
        title.textContent = backlink.sourceTitle;

        const path = doc.createElement('span');
        path.className = 'mdl-backlink-path';
        path.textContent = backlink.sourcePath;

        const occurrences = doc.createElement('span');
        occurrences.className = 'mdl-backlink-count';
        occurrences.textContent = `×${backlink.occurrences}`;

        button.append(title, path, occurrences);
        button.addEventListener('click', () => options.onOpenNote?.(backlink.sourcePath));
        item.append(button);
        list.append(item);
      }
      body.append(list);
    }

    if (report.ambiguousSources.length > 0) {
      const section = doc.createElement('div');
      section.className = 'mdl-backlinks-ambiguous';
      const title = doc.createElement('p');
      title.className = 'mdl-backlinks-ambiguous-title';
      title.textContent = '同名引用（无法确定指向）';
      section.append(title);

      const list = doc.createElement('ul');
      list.className = 'mdl-backlink-list';
      for (const path of report.ambiguousSources) {
        const item = doc.createElement('li');
        const button = doc.createElement('button');
        button.type = 'button';
        button.className = 'mdl-backlink';
        button.dataset.path = path;

        const name = doc.createElement('span');
        name.className = 'mdl-backlink-title';
        name.textContent = path;

        const hint = doc.createElement('span');
        hint.className = 'mdl-backlink-path';
        hint.textContent = '查看来源笔记';

        button.append(name, hint);
        button.addEventListener('click', () => options.onOpenNote?.(path));
        item.append(button);
        list.append(item);
      }
      section.append(list);
      body.append(section);
    }
  }

  async function refresh(): Promise<void> {
    const path = activePath;
    if (path === null) {
      idle();
      return;
    }
    const token = (requestToken += 1);
    body.replaceChildren(message('正在加载反链…'));
    count.textContent = '';
    try {
      const report = await options.store.getBacklinks(path);
      if (token !== requestToken || activePath !== path) return;
      renderReport(report);
    } catch (error) {
      if (token !== requestToken || activePath !== path) return;
      renderError(error);
    }
  }

  idle();

  return {
    element: root,
    async setActiveNote(path) {
      activePath = path;
      await refresh();
    },
    refresh,
    destroy() {
      requestToken += 1;
      root.remove();
    },
  };
}
