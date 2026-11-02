import type {
  Backlink,
  BacklinkReport,
  BacklinksRequest,
  GraphRequest,
  LinkGraph,
  LinkIndex,
  WorkspaceSummary,
} from '../../shared/contracts';
import type { WorkspacePathGuard } from '../security/workspace-paths';
import { buildLinkGraph } from './links/graph-builder';
import { buildLinkIndex, type BuiltLinkIndex } from './links/index-builder';
import { planRename, type RenamePlan, type RenamePlanDocument } from './links/rename-plan';
import type { LinkIndexWarning, ParsedWikiLink } from './links/types';
import { parseMarkdownNote } from './links/wiki-parser';
import { readNoteMarkdown, scanWorkspaceNotes, type ScannedNoteFile } from './links/workspace-notes';

/**
 * The part of `WorkspaceService` this service needs. Keeping it narrow lets
 * tests supply a real path guard without constructing Electron windows.
 */
export interface LinkWorkspaceSource {
  require(): { summary: WorkspaceSummary; guard: WorkspacePathGuard };
}

interface CachedNote {
  path: string;
  mtimeMs: number;
  size: number;
  title: string;
  links: ParsedWikiLink[];
}

interface IndexCache {
  root: string;
  notes: Map<string, CachedNote>;
  built: BuiltLinkIndex;
}

/**
 * Wiki-link index, backlinks and graph data.
 *
 * All three are derived from one scan of real workspace notes. The index is
 * cached together with each file's `mtimeMs`/`size`: on the next request the
 * workspace is re-enumerated and only changed files are re-read and re-parsed.
 * `invalidate()`/`invalidatePaths()` let the document layer force a rebuild
 * after saves, renames and watcher events.
 */
export class LinkService {
  private cache: IndexCache | null = null;
  private readonly dirtyPaths = new Set<string>();
  private inflight: Promise<BuiltLinkIndex> | null = null;
  private generation = 0;

  constructor(private readonly workspace: LinkWorkspaceSource) {}

  async index(): Promise<LinkIndex> {
    return (await this.ensureBuilt()).index;
  }

  /** Drops all cached state and returns a freshly built index. */
  async rebuild(): Promise<LinkIndex> {
    this.invalidate();
    return this.index();
  }

  /** Marks the whole index stale. Call after any workspace-wide change. */
  invalidate(): void {
    this.cache = null;
    this.dirtyPaths.clear();
    this.generation += 1;
  }

  /** Marks individual notes stale while keeping unrelated parse results. */
  invalidatePaths(paths: readonly string[]): void {
    for (const path of paths) this.dirtyPaths.add(path);
    this.generation += 1;
  }

  async backlinks(request: BacklinksRequest): Promise<BacklinkReport> {
    const { guard } = this.workspace.require();
    await guard.resolveNew(request.path);

    const built = await this.ensureBuilt();
    const byPath = new Map(built.documents.map((document) => [document.path, document]));
    const counts = new Map<string, number>();
    const ambiguousSources = new Set<string>();

    for (const link of built.links) {
      if (link.sourcePath === request.path) continue;
      if (link.resolvedPath === request.path) {
        counts.set(link.sourcePath, (counts.get(link.sourcePath) ?? 0) + 1);
      }
      if (link.resolution === 'ambiguous' && link.candidates.includes(request.path)) {
        ambiguousSources.add(link.sourcePath);
      }
    }

    const backlinks: Backlink[] = [...counts.entries()]
      .map(([sourcePath, occurrences]) => ({
        sourcePath,
        sourceTitle: byPath.get(sourcePath)?.title ?? sourcePath,
        occurrences,
      }))
      .sort(
        (left, right) =>
          right.occurrences - left.occurrences || comparePaths(left.sourcePath, right.sourcePath),
      );

    return {
      targetPath: request.path,
      backlinks,
      ambiguousSources: [...ambiguousSources].sort(comparePaths),
    };
  }

  async graph(request: GraphRequest): Promise<LinkGraph> {
    const { guard } = this.workspace.require();
    if (request.focusPath !== null) {
      await guard.resolveNew(request.focusPath);
    }
    const built = await this.ensureBuilt();
    return buildLinkGraph(built.links, built.documents, {
      focusPath: request.focusPath,
      depth: request.depth,
      generatedAt: new Date().toISOString(),
    });
  }

  /**
   * Computes (but does not perform) a cross-file rename impact plan.
   *
   * The integration layer owns the file move and the atomic writes; this
   * method only reads the workspace and delegates to the pure `planRename`.
   */
  async renamePlan(fromPath: string, toPath: string): Promise<RenamePlan> {
    const { guard } = this.workspace.require();
    await guard.resolveExisting(fromPath);
    await guard.resolveNew(toPath);

    const scan = await scanWorkspaceNotes(guard.root);
    const documents: RenamePlanDocument[] = [];
    for (const file of scan.notes) {
      const markdown = await readNoteMarkdown(guard.root, file.path);
      if (markdown !== null) documents.push({ path: file.path, markdown });
    }
    return planRename({ documents, fromPath, toPath });
  }

  private async ensureBuilt(): Promise<BuiltLinkIndex> {
    if (!this.inflight) {
      this.inflight = this.build().finally(() => {
        this.inflight = null;
      });
    }
    return this.inflight;
  }

  private async build(): Promise<BuiltLinkIndex> {
    const generation = this.generation;
    const { guard } = this.workspace.require();
    const root = guard.root;
    const scan = await scanWorkspaceNotes(root);
    const warnings: LinkIndexWarning[] = scan.skipped.map((entry) => ({
      path: entry.path,
      message: entry.reason,
    }));

    const previous =
      this.cache !== null && this.cache.root === root
        ? this.cache.notes
        : new Map<string, CachedNote>();
    const notes = new Map<string, CachedNote>();
    const pendingReads: ScannedNoteFile[] = [];

    for (const file of scan.notes) {
      const cached = previous.get(file.path);
      const unchanged =
        cached !== undefined &&
        cached.mtimeMs === file.mtimeMs &&
        cached.size === file.size &&
        !this.dirtyPaths.has(file.path);
      if (unchanged && cached) notes.set(file.path, cached);
      else pendingReads.push(file);
    }

    for (const file of pendingReads) {
      const markdown = await readNoteMarkdown(root, file.path);
      if (markdown === null) {
        warnings.push({ path: file.path, message: 'unreadable' });
        continue;
      }
      const parsed = parseMarkdownNote(file.path, markdown);
      notes.set(file.path, {
        path: file.path,
        mtimeMs: file.mtimeMs,
        size: file.size,
        title: parsed.title,
        links: parsed.links,
      });
    }

    this.dirtyPaths.clear();

    const built = buildLinkIndex(
      root,
      [...notes.values()].map((note) => ({
        path: note.path,
        title: note.title,
        links: note.links,
      })),
      new Date().toISOString(),
      warnings,
    );

    // A build that overlapped an invalidation must not become the cache.
    if (generation === this.generation) {
      this.cache = { root, notes, built };
    }
    return built;
  }
}

function comparePaths(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
