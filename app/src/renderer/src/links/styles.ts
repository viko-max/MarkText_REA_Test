/**
 * Scoped styles for the link components.
 *
 * The components are mounted into an existing renderer, so styles are injected
 * once into `<head>` instead of being added to the app-wide stylesheet. Every
 * class is prefixed with `mdl-` and colours fall back to the app's variables.
 */

const STYLE_ID = 'mdl-link-styles';

const STYLE_TEXT = `
.mdl-wikilink {
  color: var(--mdl-link-color, #2f6fed);
  text-decoration: none;
  border-radius: 3px;
  cursor: pointer;
}
.mdl-wikilink:hover { text-decoration: underline; }
.mdl-wikilink--resolved { color: var(--mdl-link-color, #2f6fed); }
.mdl-wikilink--ambiguous {
  color: var(--mdl-link-warning, #b45309);
  border-bottom: 1px dashed currentColor;
}
.mdl-wikilink--missing {
  color: var(--mdl-link-missing, #b91c1c);
  text-decoration: underline wavy currentColor;
}

.mdl-link-popover {
  position: fixed;
  z-index: 1200;
  min-width: 220px;
  max-width: 380px;
  padding: 8px;
  border-radius: 8px;
  border: 1px solid var(--mdl-link-border, #d7dce3);
  background: var(--mdl-link-surface, #ffffff);
  color: var(--mdl-link-text, #1f2933);
  box-shadow: 0 12px 32px rgba(15, 23, 42, 0.18);
  font-size: 13px;
  line-height: 1.45;
}
.mdl-link-popover-title {
  margin: 0 0 6px;
  font-size: 12px;
  font-weight: 600;
  color: var(--mdl-link-muted, #52606d);
}
.mdl-link-popover-hint {
  margin: 4px 0 0;
  font-size: 12px;
  color: var(--mdl-link-muted, #52606d);
}
.mdl-link-popover-list {
  list-style: none;
  margin: 0;
  padding: 0;
  max-height: 240px;
  overflow: auto;
}
.mdl-link-popover-option {
  display: block;
  width: 100%;
  padding: 6px 8px;
  border: 0;
  border-radius: 6px;
  background: transparent;
  text-align: left;
  color: inherit;
  font: inherit;
  cursor: pointer;
}
.mdl-link-popover-option:hover,
.mdl-link-popover-option:focus-visible {
  background: var(--mdl-link-hover, #eef3ff);
  outline: none;
}

.mdl-completion {
  position: fixed;
  z-index: 1201;
  min-width: 220px;
  max-width: 420px;
  margin: 0;
  padding: 4px;
  list-style: none;
  border-radius: 8px;
  border: 1px solid var(--mdl-link-border, #d7dce3);
  background: var(--mdl-link-surface, #ffffff);
  color: var(--mdl-link-text, #1f2933);
  box-shadow: 0 12px 32px rgba(15, 23, 42, 0.18);
  font-size: 13px;
}
.mdl-completion-item {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 6px 8px;
  border-radius: 6px;
  cursor: pointer;
}
.mdl-completion-item[aria-selected='true'] {
  background: var(--mdl-link-hover, #eef3ff);
}
.mdl-completion-title { font-weight: 600; }
.mdl-completion-detail {
  font-size: 12px;
  color: var(--mdl-link-muted, #52606d);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.mdl-backlinks {
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-width: 0;
  color: inherit;
}
.mdl-backlinks-header {
  display: flex;
  align-items: baseline;
  gap: 8px;
}
.mdl-backlinks-title {
  margin: 0;
  font-size: 13px;
  font-weight: 600;
}
.mdl-backlinks-count {
  font-size: 12px;
  color: var(--mdl-link-muted, #52606d);
}
.mdl-backlinks-body { min-width: 0; }
.mdl-backlinks-empty,
.mdl-backlinks-error {
  margin: 0;
  font-size: 12px;
  color: var(--mdl-link-muted, #52606d);
}
.mdl-backlinks-error { color: var(--mdl-link-missing, #b91c1c); }
.mdl-backlink-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.mdl-backlink {
  display: grid;
  grid-template-columns: 1fr auto;
  gap: 2px 8px;
  width: 100%;
  padding: 6px 8px;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: inherit;
  font: inherit;
  text-align: left;
  cursor: pointer;
}
.mdl-backlink:hover,
.mdl-backlink:focus-visible {
  background: var(--mdl-link-hover, #eef3ff);
  outline: none;
}
.mdl-backlink-title { font-weight: 600; overflow: hidden; text-overflow: ellipsis; }
.mdl-backlink-path {
  grid-column: 1 / 2;
  font-size: 11px;
  color: var(--mdl-link-muted, #52606d);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.mdl-backlink-count {
  grid-row: 1 / 3;
  grid-column: 2 / 3;
  align-self: center;
  font-size: 11px;
  color: var(--mdl-link-muted, #52606d);
}
.mdl-backlinks-ambiguous {
  margin-top: 10px;
  padding-top: 8px;
  border-top: 1px dashed var(--mdl-link-border, #d7dce3);
}
.mdl-backlinks-ambiguous-title {
  margin: 0 0 4px;
  font-size: 12px;
  color: var(--mdl-link-warning, #b45309);
}

.mdl-graph {
  display: flex;
  flex-direction: column;
  gap: 6px;
  min-height: 220px;
  color: inherit;
}
.mdl-graph-toolbar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  font-size: 12px;
}
.mdl-graph-label { font-weight: 600; }
.mdl-graph-button,
.mdl-graph-select {
  border: 1px solid var(--mdl-link-border, #d7dce3);
  border-radius: 6px;
  background: var(--mdl-link-surface, #ffffff);
  color: inherit;
  font: inherit;
  padding: 2px 8px;
}
.mdl-graph-button { cursor: pointer; }
.mdl-graph-button[aria-pressed='true'] {
  background: var(--mdl-link-hover, #eef3ff);
  border-color: var(--mdl-link-color, #2f6fed);
}
.mdl-graph-status { color: var(--mdl-link-muted, #52606d); margin-left: auto; }
.mdl-graph-canvas {
  flex: 1 1 auto;
  min-height: 220px;
  border: 1px solid var(--mdl-link-border, #d7dce3);
  border-radius: 8px;
  background:
    radial-gradient(circle at 1px 1px, rgba(82, 96, 109, 0.16) 1px, transparent 0) 0 0 / 18px 18px,
    var(--mdl-link-graph-bg, #fbfcfe);
}
.mdl-graph-hint {
  margin: 0;
  font-size: 11px;
  color: var(--mdl-link-muted, #52606d);
}

@media (prefers-color-scheme: dark) {
  .mdl-link-popover,
  .mdl-completion,
  .mdl-graph-button,
  .mdl-graph-select {
    --mdl-link-surface: #1f2733;
    --mdl-link-text: #e6edf3;
    --mdl-link-muted: #9aa7b4;
    --mdl-link-border: #33404d;
    --mdl-link-hover: #2a3644;
  }
  .mdl-graph-canvas {
    --mdl-link-graph-bg: #171e27;
  }
}
`;

/** Injects the link stylesheet once per document. */
export function ensureLinkStyles(doc: Document = document): void {
  if (doc.getElementById(STYLE_ID)) return;
  const style = doc.createElement('style');
  style.id = STYLE_ID;
  style.textContent = STYLE_TEXT;
  doc.head.appendChild(style);
}

export const LINK_CLASSES = {
  wikiLink: 'mdl-wikilink',
  resolved: 'mdl-wikilink--resolved',
  ambiguous: 'mdl-wikilink--ambiguous',
  missing: 'mdl-wikilink--missing',
  completion: 'mdl-completion',
  completionItem: 'mdl-completion-item',
  popover: 'mdl-link-popover',
} as const;
