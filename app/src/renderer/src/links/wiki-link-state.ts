/**
 * Applies resolved / ambiguous / missing styling to rendered wiki links.
 *
 * The shared HTML render pipeline only needs to mark links with
 * `data-wikilink-target="<target>"`; this function adds the state classes used
 * by `styles.ts`. It never rewrites link text or hrefs.
 */

import type { LinkIndexView } from './contracts';
import { describeNotePaths, lookupWikiTarget } from './lookup';
import { LINK_CLASSES } from './styles';

const STATE_CLASSES = [LINK_CLASSES.resolved, LINK_CLASSES.ambiguous, LINK_CLASSES.missing];

export function applyWikiLinkStates(container: ParentNode, index: LinkIndexView): void {
  const notes = describeNotePaths(index.documents.map((document) => document.path));
  const elements = container.querySelectorAll<HTMLElement>('[data-wikilink-target]');
  for (const element of elements) {
    const target = element.dataset.wikilinkTarget ?? element.textContent ?? '';
    if (target.trim().length === 0) continue;
    const lookup = lookupWikiTarget(target, notes);

    element.classList.remove(...STATE_CLASSES);
    element.classList.add(LINK_CLASSES.wikiLink, stateClass(lookup.resolution));
    element.dataset.wikilinkResolution = lookup.resolution;

    if (lookup.resolvedPath !== null) {
      element.dataset.wikilinkResolved = lookup.resolvedPath;
      element.setAttribute('title', lookup.resolvedPath);
    } else {
      delete element.dataset.wikilinkResolved;
      element.setAttribute(
        'title',
        lookup.resolution === 'ambiguous'
          ? `同名笔记：${lookup.candidates.join('、')}`
          : `未找到笔记：${target}`,
      );
    }
  }
}

export function stateClass(resolution: 'resolved' | 'ambiguous' | 'missing'): string {
  if (resolution === 'resolved') return LINK_CLASSES.resolved;
  if (resolution === 'ambiguous') return LINK_CLASSES.ambiguous;
  return LINK_CLASSES.missing;
}
