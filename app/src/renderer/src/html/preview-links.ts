/**
 * Wiki-link projection for the HTML preview.
 *
 * The shared render pipeline owns tokenisation and markup; this module only
 * projects the real link index onto that markup. A resolved link gets a
 * document-relative `href` and, after rendering, `data-wikilink-target` so the
 * preview can delegate a click. Ambiguous and missing targets keep their state
 * attribute and never receive a target that could be opened.
 */

import type { LinkIndexView } from '../links/contracts';
import { describeNotePaths, lookupWikiTarget } from '../links/lookup';
import type { WikiLinkResolution, WikiLinkToken } from '../render/types';

/** POSIX path of `targetPath` relative to the folder of `fromDocumentPath`. */
export function relativeWorkspaceHref(fromDocumentPath: string, targetPath: string): string {
  const from = fromDocumentPath.split('/').slice(0, -1);
  const to = targetPath.split('/');
  let common = 0;
  while (common < from.length && common < to.length) {
    const left = from[common] ?? '';
    const right = to[common] ?? '';
    if (left.toLowerCase() !== right.toLowerCase()) break;
    common += 1;
  }
  const segments = [...Array.from({ length: from.length - common }, () => '..'), ...to.slice(common)];
  return segments.map((segment) => encodeURIComponent(segment)).join('/');
}

/** Resolves one wiki token against an already-loaded link index. */
export function resolveWikiLinkFromIndex(
  index: LinkIndexView,
  documentPath: string,
  link: WikiLinkToken,
): WikiLinkResolution {
  const notes = describeNotePaths(index.documents.map((document) => document.path));
  const lookup = lookupWikiTarget(link.target, notes);

  if (lookup.resolution === 'resolved' && lookup.resolvedPath !== null) {
    return {
      state: 'resolved',
      href: relativeWorkspaceHref(documentPath, lookup.resolvedPath),
      title: lookup.resolvedPath,
    };
  }
  if (lookup.resolution === 'ambiguous') {
    return {
      state: 'ambiguous',
      href: null,
      title: `同名笔记：${lookup.candidates.join('、')}`,
    };
  }
  return { state: 'missing', href: null, title: `未找到笔记：${link.target}` };
}

/**
 * Copies `data-mdl-target` to `data-wikilink-target` for resolved links only.
 * Runs on the rendered preview document, after sanitisation, and returns how
 * many links became clickable.
 */
export function applyWikilinkTargets(root: ParentNode): number {
  const elements = root.querySelectorAll<HTMLElement>('[data-mdl-wikilink]');
  let applied = 0;
  for (const element of elements) {
    const state = element.dataset.mdlWikilink ?? '';
    const target = (element.dataset.mdlTarget ?? '').trim();
    const openable = state === 'resolved' && target.length > 0 && element.tagName === 'A';
    if (openable) {
      element.setAttribute('data-wikilink-target', target);
      applied += 1;
    } else {
      element.removeAttribute('data-wikilink-target');
    }
  }
  return applied;
}
