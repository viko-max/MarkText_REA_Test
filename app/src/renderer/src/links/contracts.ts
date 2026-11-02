/**
 * Renderer-side views of the link contracts.
 *
 * `candidates` and `warnings` are additive fields the main process includes in
 * the serialised index; they are optional here so the renderer still works
 * against the plain `LinkIndex` shape.
 */

import type { LinkIndex, WikiLink, WorkspaceRelativePath } from '../../../shared/contracts';

export interface WikiLinkView extends WikiLink {
  candidates?: WorkspaceRelativePath[];
}

export interface LinkIndexWarningView {
  path: WorkspaceRelativePath | null;
  message: string;
}

export interface LinkIndexView extends Omit<LinkIndex, 'links'> {
  links: WikiLinkView[];
  warnings?: LinkIndexWarningView[];
}
