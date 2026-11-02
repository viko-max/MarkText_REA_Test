/**
 * Builds the `LinkGraph` consumed by Cytoscape.
 *
 * Nodes are either real note files or pseudo nodes for links that do not
 * resolve to exactly one note (`missing` / `ambiguous`). No node or edge is
 * invented: every element exists because a real note file or a real parsed
 * `[[wikilink]]` produced it.
 *
 * Self-references (a note linking to itself) are not drawn as edges and are
 * not counted as inbound links, because they are not backlinks.
 */

import type {
  LinkDocumentSummary,
  LinkGraph,
  LinkGraphEdge,
  LinkGraphNode,
  LinkResolution,
} from '../../../shared/contracts';
import { targetPathKey } from './resolver';
import type { ResolvedWikiLink } from './types';

export interface GraphBuildOptions {
  focusPath: string | null;
  depth: number;
  generatedAt: string;
}

interface EdgeAccumulator {
  source: string;
  target: string;
  count: number;
  resolution: LinkResolution;
}

function comparePaths(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function buildLinkGraph(
  links: readonly ResolvedWikiLink[],
  documents: readonly LinkDocumentSummary[],
  options: GraphBuildOptions,
): LinkGraph {
  const nodes = new Map<string, LinkGraphNode>();
  for (const document of documents) {
    nodes.set(document.path, {
      id: document.path,
      label: document.title.length > 0 ? document.title : document.path,
      kind: 'note',
      inDegree: 0,
      outDegree: 0,
    });
  }

  const missingLabels = new Map<string, string>();
  const edges = new Map<string, EdgeAccumulator>();

  for (const link of links) {
    let targetId: string;
    let resolution: LinkResolution;
    if (link.resolution === 'resolved' && link.resolvedPath !== null) {
      targetId = link.resolvedPath;
      resolution = 'resolved';
    } else {
      targetId = targetPathKey(link.target);
      resolution = link.resolution;
      if (targetId.length === 0) continue;
      if (!missingLabels.has(targetId)) {
        const label = link.target.trim();
        missingLabels.set(targetId, label.length > 0 ? label : targetId);
      }
      if (!nodes.has(targetId)) {
        nodes.set(targetId, {
          id: targetId,
          label: missingLabels.get(targetId) ?? targetId,
          kind: 'missing',
          inDegree: 0,
          outDegree: 0,
        });
      }
    }

    if (targetId === link.sourcePath) continue;
    if (!nodes.has(targetId)) continue; // resolved target must be a scanned note

    const key = `${link.sourcePath}|${targetId}`;
    const existing = edges.get(key);
    if (existing) {
      existing.count += 1;
    } else {
      edges.set(key, {
        source: link.sourcePath,
        target: targetId,
        count: 1,
        resolution,
      });
    }
  }

  let visibleNodes = [...nodes.values()];
  let visibleEdges = [...edges.values()];

  if (options.focusPath !== null) {
    if (!nodes.has(options.focusPath)) {
      return {
        generatedAt: options.generatedAt,
        focusPath: options.focusPath,
        nodes: [],
        edges: [],
      };
    }
    const visited = expandNeighbourhood(options.focusPath, visibleEdges, options.depth);
    visibleNodes = visibleNodes.filter((node) => visited.has(node.id));
    visibleEdges = visibleEdges.filter(
      (edge) => visited.has(edge.source) && visited.has(edge.target),
    );
  }

  const nodeById = new Map(visibleNodes.map((node) => [node.id, node]));
  for (const edge of visibleEdges) {
    const source = nodeById.get(edge.source);
    const target = nodeById.get(edge.target);
    if (source) source.outDegree += 1;
    if (target) target.inDegree += 1;
  }

  const graphEdges: LinkGraphEdge[] = visibleEdges
    .map((edge) => ({
      id: `${edge.source}|${edge.target}`,
      source: edge.source,
      target: edge.target,
      count: edge.count,
      resolution: edge.resolution,
    }))
    .sort((left, right) => comparePaths(left.id, right.id));

  return {
    generatedAt: options.generatedAt,
    focusPath: options.focusPath,
    nodes: visibleNodes.sort((left, right) => comparePaths(left.id, right.id)),
    edges: graphEdges,
  };
}

/** Breadth-first expansion over undirected adjacency, limited by `depth`. */
function expandNeighbourhood(
  focusPath: string,
  edges: readonly EdgeAccumulator[],
  depth: number,
): Set<string> {
  const adjacency = new Map<string, Set<string>>();
  const connect = (from: string, to: string): void => {
    const existing = adjacency.get(from);
    if (existing) existing.add(to);
    else adjacency.set(from, new Set([to]));
  };
  for (const edge of edges) {
    connect(edge.source, edge.target);
    connect(edge.target, edge.source);
  }

  const visited = new Set<string>([focusPath]);
  let frontier: string[] = [focusPath];
  for (let step = 0; step < Math.max(0, depth); step += 1) {
    const next: string[] = [];
    for (const node of frontier) {
      for (const neighbour of adjacency.get(node) ?? []) {
        if (visited.has(neighbour)) continue;
        visited.add(neighbour);
        next.push(neighbour);
      }
    }
    if (next.length === 0) break;
    frontier = next;
  }
  return visited;
}
