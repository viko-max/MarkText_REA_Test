/**
 * Cytoscape relationship graph.
 *
 * The view only draws what the main-process graph returns: real notes and real
 * `[[wikilinks]]` (unresolved targets appear as missing-style nodes). It adds
 * the interaction layer: pan, zoom, node selection, click-to-open and a
 * current-note neighbourhood filter backed by `graph({ focusPath, depth })`.
 */

import cytoscape from 'cytoscape';
import type { LinkGraph, LinkGraphNode } from '../../../shared/contracts';
import { LinkStore } from './link-store';
import { ensureLinkStyles } from './styles';

export interface GraphViewOptions {
  store: LinkStore;
  onOpenNote?: (path: string) => void;
  onSelectNode?: (nodeId: string, kind: LinkGraphNode['kind']) => void;
  /** Used by the toolbar when no focus is set yet. */
  getActiveNote?: () => string | null;
  focusPath?: string | null;
  depth?: number;
  minHeightPx?: number;
}

export interface GraphViewController {
  element: HTMLElement;
  setFocus(path: string | null): Promise<void>;
  setDepth(depth: number): Promise<void>;
  refresh(): Promise<void>;
  getFocus(): string | null;
  /** Currently selected node id (workspace path or unresolved target). */
  getSelection(): string | null;
  destroy(): void;
}

const MAX_DEPTH = 4;

const GRAPH_STYLE: cytoscape.StylesheetJson = [
  {
    selector: 'node',
    style: {
      'background-color': '#5b8def',
      'background-opacity': 0.9,
      width: 26,
      height: 26,
      label: 'data(label)',
      color: '#1f2933',
      'font-size': 11,
      'font-weight': 500,
      'text-valign': 'bottom',
      'text-halign': 'center',
      'text-margin-y': 6,
      'text-outline-color': '#ffffff',
      'text-outline-width': 2,
      'overlay-opacity': 0,
    },
  },
  {
    selector: 'node[kind = "missing"]',
    style: {
      'background-color': '#cbd5e1',
      'background-opacity': 0.7,
      'border-width': 1.5,
      'border-style': 'dashed',
      'border-color': '#94a3b8',
      color: '#64748b',
      shape: 'round-rectangle',
    },
  },
  {
    selector: 'node:selected',
    style: {
      'background-color': '#f59e0b',
      'border-width': 3,
      'border-color': '#b45309',
    },
  },
  {
    selector: 'edge',
    style: {
      width: 1.3,
      'line-color': '#94a3b8',
      'target-arrow-color': '#94a3b8',
      'target-arrow-shape': 'triangle',
      'arrow-scale': 0.8,
      'curve-style': 'bezier',
    },
  },
  {
    selector: 'edge[resolution = "missing"], edge[resolution = "ambiguous"]',
    style: {
      'line-style': 'dashed',
      'line-color': '#cbd5e1',
      'target-arrow-color': '#cbd5e1',
    },
  },
  {
    selector: 'edge[count > 1]',
    style: {
      width: 2.4,
    },
  },
];

function nodeElementId(node: { id: string; kind: LinkGraphNode['kind'] }): string {
  return `${node.kind === 'note' ? 'note' : 'missing'}:${node.id}`;
}

export function mountGraphView(
  host: HTMLElement,
  options: GraphViewOptions,
): GraphViewController {
  const doc = host.ownerDocument;
  ensureLinkStyles(doc);

  const root = doc.createElement('section');
  root.className = 'mdl-graph';
  root.setAttribute('aria-label', '关系图谱');

  const toolbar = doc.createElement('div');
  toolbar.className = 'mdl-graph-toolbar';

  const label = doc.createElement('span');
  label.className = 'mdl-graph-label';
  label.textContent = '关系图谱';

  const focusButton = doc.createElement('button');
  focusButton.type = 'button';
  focusButton.className = 'mdl-graph-button';
  focusButton.textContent = '仅当前笔记';
  focusButton.setAttribute('aria-pressed', 'false');

  const depthLabel = doc.createElement('label');
  depthLabel.className = 'mdl-graph-label';
  depthLabel.textContent = '深度';
  const depthSelect = doc.createElement('select');
  depthSelect.className = 'mdl-graph-select';
  for (let depth = 0; depth <= MAX_DEPTH; depth += 1) {
    const option = doc.createElement('option');
    option.value = String(depth);
    option.textContent = String(depth);
    depthSelect.append(option);
  }
  depthSelect.value = String(options.depth ?? 1);
  depthLabel.append(depthSelect);

  const status = doc.createElement('span');
  status.className = 'mdl-graph-status';

  toolbar.append(label, focusButton, depthLabel, status);

  const canvas = doc.createElement('div');
  canvas.className = 'mdl-graph-canvas';
  if (options.minHeightPx !== undefined) {
    canvas.style.minHeight = `${options.minHeightPx}px`;
  }
  canvas.setAttribute('role', 'application');
  canvas.setAttribute('aria-label', '笔记关系图');

  const hint = doc.createElement('p');
  hint.className = 'mdl-graph-hint';
  hint.textContent = '拖动平移 · 滚轮缩放 · 点击节点打开笔记';

  root.append(toolbar, canvas, hint);
  host.appendChild(root);

  const cy = cytoscape({
    container: canvas,
    elements: [],
    style: GRAPH_STYLE,
    layout: { name: 'cose', animate: false, padding: 24 },
    minZoom: 0.15,
    maxZoom: 3,
    wheelSensitivity: 0.2,
    selectionType: 'single',
    boxSelectionEnabled: false,
    autoungrabify: false,
  });

  let focusPath: string | null = options.focusPath ?? null;
  let depth = Math.max(0, Math.min(options.depth ?? 1, MAX_DEPTH));
  let selectedId: string | null = null;
  let requestToken = 0;

  const resizeObserver =
    typeof ResizeObserver === 'undefined'
      ? null
      : new ResizeObserver(() => {
          cy.resize();
        });
  resizeObserver?.observe(canvas);

  function updateFocusButton(): void {
    const focused = focusPath !== null;
    focusButton.setAttribute('aria-pressed', String(focused));
    focusButton.textContent = focused ? '显示全部' : '仅当前笔记';
  }

  function renderGraph(graph: LinkGraph): void {
    const kinds = new Map(graph.nodes.map((node) => [node.id, node.kind]));

    const nodeElements: cytoscape.ElementDefinition[] = graph.nodes.map((node) => ({
      data: {
        id: nodeElementId(node),
        path: node.id,
        label: node.label,
        kind: node.kind,
        inDegree: node.inDegree,
        outDegree: node.outDegree,
      },
    }));

    const edgeElements: cytoscape.ElementDefinition[] = graph.edges.map((edge) => ({
      data: {
        id: `edge:${edge.id}`,
        source: nodeElementId({ id: edge.source, kind: 'note' }),
        target: nodeElementId({ id: edge.target, kind: kinds.get(edge.target) ?? 'note' }),
        count: edge.count,
        resolution: edge.resolution,
      },
    }));

    cy.elements().remove();
    cy.add([...nodeElements, ...edgeElements]);
    cy.layout({ name: 'cose', animate: false, padding: 24, randomize: true }).run();

    if (selectedId !== null) {
      const selected = cy
        .nodes()
        .filter((node) => String(node.data('path')) === selectedId);
      if (selected.nonempty()) selected.select();
      else selectedId = null;
    }
    cy.resize();
  }

  cy.on('tap', 'node', (event) => {
    const node = event.target as cytoscape.NodeSingular;
    const path = String(node.data('path') ?? '');
    const kind: LinkGraphNode['kind'] = node.data('kind') === 'missing' ? 'missing' : 'note';
    if (path.length === 0) return;
    selectedId = path;
    options.onSelectNode?.(path, kind);
    if (kind === 'note') options.onOpenNote?.(path);
  });

  async function refresh(): Promise<void> {
    const token = (requestToken += 1);
    status.textContent = '正在加载图谱…';
    try {
      const graph = await options.store.getGraph(focusPath, depth);
      if (token !== requestToken) return;
      renderGraph(graph);
      status.textContent =
        graph.nodes.length === 0
          ? '没有可显示的链接'
          : `${graph.nodes.length} 个节点 · ${graph.edges.length} 条链接`;
    } catch (error) {
      if (token !== requestToken) return;
      const detail = error instanceof Error ? error.message : String(error);
      status.textContent = `加载失败：${detail}`;
    }
  }

  focusButton.addEventListener('click', () => {
    if (focusPath !== null) {
      void setFocus(null);
      return;
    }
    const active = options.getActiveNote?.() ?? null;
    if (active !== null) void setFocus(active);
  });

  depthSelect.addEventListener('change', () => {
    const next = Number.parseInt(depthSelect.value, 10);
    void setDepth(Number.isFinite(next) ? next : 1);
  });

  async function setFocus(path: string | null): Promise<void> {
    focusPath = path;
    updateFocusButton();
    await refresh();
  }

  async function setDepth(next: number): Promise<void> {
    depth = Math.max(0, Math.min(Math.trunc(next), MAX_DEPTH));
    depthSelect.value = String(depth);
    if (focusPath !== null) await refresh();
  }

  updateFocusButton();
  void refresh();

  return {
    element: root,
    setFocus,
    setDepth,
    refresh,
    getFocus: () => focusPath,
    getSelection: () => selectedId,
    destroy() {
      requestToken += 1;
      resizeObserver?.disconnect();
      cy.destroy();
      root.remove();
    },
  };
}
