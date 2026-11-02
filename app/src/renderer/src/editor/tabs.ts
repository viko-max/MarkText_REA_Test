/**
 * Tab order and per-tab presentation state.
 *
 * The host keeps one `DocumentSession` per tab; this store only answers
 * "which tabs exist, which is active, and what should the UI show". Keeping it
 * separate makes multi-tab behaviour testable without CodeMirror.
 */

import type { WorkspaceRelativePath } from '../../../shared/contracts';
import { workspaceBasename, workspacePathKey } from '../../../shared/paths';
import type { EditorTabInfo } from './model-types';

export interface AddTabResult {
  id: string;
  /** Set when a tab for the same path already existed. */
  existingId?: string;
}

export class EditorTabs {
  private readonly order: string[] = [];
  private readonly records = new Map<string, EditorTabInfo>();
  private readonly byPath = new Map<string, string>();
  private active: string | null = null;

  get activeId(): string | null {
    return this.active;
  }

  get size(): number {
    return this.order.length;
  }

  add(tab: EditorTabInfo): AddTabResult {
    const key = workspacePathKey(tab.path);
    const existingId = this.byPath.get(key);
    if (existingId !== undefined) return { id: existingId, existingId };

    const record: EditorTabInfo = { ...tab, title: tab.title || workspaceBasename(tab.path) };
    this.records.set(record.id, record);
    this.order.push(record.id);
    this.byPath.set(key, record.id);
    if (this.active === null) this.active = record.id;
    return { id: record.id };
  }

  activate(id: string): boolean {
    if (!this.records.has(id)) return false;
    this.active = id;
    return true;
  }

  /** Remove a tab; returns the next active id (or null when empty). */
  remove(id: string): string | null {
    const record = this.records.get(id);
    if (!record) return this.active;
    this.records.delete(id);
    this.byPath.delete(workspacePathKey(record.path));
    const index = this.order.indexOf(id);
    if (index >= 0) this.order.splice(index, 1);

    if (this.active !== id) return this.active;
    const neighbour = this.order[index] ?? this.order[index - 1] ?? null;
    this.active = neighbour;
    return this.active;
  }

  update(id: string, patch: Partial<Omit<EditorTabInfo, 'id' | 'path'>>): boolean {
    const record = this.records.get(id);
    if (!record) return false;
    this.records.set(id, { ...record, ...patch });
    return true;
  }

  replace(tab: EditorTabInfo): void {
    if (!this.records.has(tab.id)) {
      this.add(tab);
      return;
    }
    this.records.set(tab.id, { ...tab });
  }

  get(id: string): EditorTabInfo | undefined {
    return this.records.get(id);
  }

  findByPath(path: WorkspaceRelativePath): EditorTabInfo | undefined {
    const id = this.byPath.get(workspacePathKey(path));
    return id === undefined ? undefined : this.records.get(id);
  }

  getActive(): EditorTabInfo | undefined {
    return this.active === null ? undefined : this.records.get(this.active);
  }

  list(): EditorTabInfo[] {
    return this.order
      .map((id) => this.records.get(id))
      .filter((tab): tab is EditorTabInfo => tab !== undefined);
  }
}
