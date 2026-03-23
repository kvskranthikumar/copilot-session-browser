import {
  Session,
  SessionWithMessages,
  Message,
  FilterOptions,
  SortField,
  SortOrder,
  SessionListItem,
} from '../models/types';

/**
 * In-memory session index.
 * Provides CRUD, incremental upsert, search/filter/sort, and
 * O(1) lookup by session id.
 */
export class IndexService {
  private sessions = new Map<string, SessionWithMessages>();
  private dirty = false;

  // ── Ingestion ──────────────────────────────────────────────────────────────

  /** Upsert a batch of sessions (by id). Returns counts added/updated. */
  upsertAll(incoming: SessionWithMessages[]): { added: number; updated: number } {
    let added = 0;
    let updated = 0;
    for (const s of incoming) {
      if (this.sessions.has(s.id)) {
        updated++;
      } else {
        added++;
      }
      this.sessions.set(s.id, s);
    }
    if (added + updated > 0) {
      this.dirty = true;
    }
    return { added, updated };
  }

  /** Replace the entire index */
  replaceAll(incoming: SessionWithMessages[]): void {
    this.sessions.clear();
    for (const s of incoming) {
      this.sessions.set(s.id, s);
    }
    this.dirty = true;
  }

  /** Remove sessions whose source file matches (used on refresh) */
  evictByFilePath(filePath: string): number {
    let removed = 0;
    for (const [id, s] of this.sessions) {
      if (s.filePath === filePath || s.filePath.startsWith(`imported:${filePath}`)) {
        this.sessions.delete(id);
        removed++;
      }
    }
    if (removed > 0) {
      this.dirty = true;
    }
    return removed;
  }

  clear(): void {
    this.sessions.clear();
    this.dirty = true;
  }

  // ── Query ──────────────────────────────────────────────────────────────────

  getById(id: string): SessionWithMessages | undefined {
    return this.sessions.get(id);
  }

  getAll(): SessionWithMessages[] {
    return Array.from(this.sessions.values());
  }

  count(): number {
    return this.sessions.size;
  }

  isDirty(): boolean {
    return this.dirty;
  }

  markClean(): void {
    this.dirty = false;
  }

  /**
   * Search, filter, and sort sessions.
   * All options are optional; without options returns everything sorted by
   * updatedAt desc.
   */
  query(
    filter: FilterOptions = {},
    sortField: SortField = 'updatedAt',
    sortOrder: SortOrder = 'desc',
  ): SessionWithMessages[] {
    let results = Array.from(this.sessions.values());

    // Text search
    if (filter.query && filter.query.trim().length > 0) {
      const q = filter.query.toLowerCase().trim();
      results = results.filter(s => {
        if (s.title.toLowerCase().includes(q)) {
          return true;
        }
        if (s.workspaceContext?.toLowerCase().includes(q)) {
          return true;
        }
        if (s.tags.some(t => t.toLowerCase().includes(q))) {
          return true;
        }
        // Check first few message contents (limit to avoid scanning thousands of chars)
        return s.messages.slice(0, 10).some(m =>
          m.markdownContent.toLowerCase().includes(q),
        );
      });
    }

    // Date filter
    if (filter.dateFrom) {
      const from = filter.dateFrom.getTime();
      results = results.filter(s => s.createdAt.getTime() >= from);
    }
    if (filter.dateTo) {
      const to = filter.dateTo.getTime();
      results = results.filter(s => s.createdAt.getTime() <= to);
    }

    // Tag filter
    if (filter.tags && filter.tags.length > 0) {
      const tags = filter.tags.map(t => t.toLowerCase());
      results = results.filter(s =>
        tags.every(t => s.tags.map(st => st.toLowerCase()).includes(t)),
      );
    }

    // Workspace filter
    if (filter.workspaceContext) {
      const wc = filter.workspaceContext.toLowerCase();
      results = results.filter(s =>
        s.workspaceContext?.toLowerCase().includes(wc),
      );
    }

    // Sort
    results.sort((a, b) => {
      let valA: string | number;
      let valB: string | number;

      switch (sortField) {
        case 'title':
          valA = a.title.toLowerCase();
          valB = b.title.toLowerCase();
          break;
        case 'createdAt':
          valA = a.createdAt.getTime();
          valB = b.createdAt.getTime();
          break;
        case 'messageCount':
          valA = a.messageCount;
          valB = b.messageCount;
          break;
        case 'updatedAt':
        default:
          valA = a.updatedAt.getTime();
          valB = b.updatedAt.getTime();
          break;
      }

      if (valA < valB) {
        return sortOrder === 'asc' ? -1 : 1;
      }
      if (valA > valB) {
        return sortOrder === 'asc' ? 1 : -1;
      }
      return 0;
    });

    return results;
  }

  /** Return all unique tags across all sessions */
  allTags(): string[] {
    const tagSet = new Set<string>();
    for (const s of this.sessions.values()) {
      for (const t of s.tags) {
        tagSet.add(t);
      }
    }
    return Array.from(tagSet).sort();
  }

  /** Return all unique workspace contexts */
  allWorkspaces(): string[] {
    const ws = new Set<string>();
    for (const s of this.sessions.values()) {
      if (s.workspaceContext) {
        ws.add(s.workspaceContext);
      }
    }
    return Array.from(ws).sort();
  }

  // ── Serialisation helpers ──────────────────────────────────────────────────

  /** Lightweight list items for webview rendering (no messages) */
  toListItems(sessions: Session[]): SessionListItem[] {
    return sessions.map(s => ({
      id: s.id,
      title: s.title,
      createdAt: s.createdAt.toISOString(),
      updatedAt: s.updatedAt.toISOString(),
      workspaceContext: s.workspaceContext,
      tags: s.tags,
      messageCount: s.messageCount,
      schemaVersion: s.schemaVersion,
    }));
  }

  /** Add a tag to a session */
  addTag(sessionId: string, tag: string): boolean {
    const s = this.sessions.get(sessionId);
    if (!s) {
      return false;
    }
    if (!s.tags.includes(tag)) {
      s.tags.push(tag);
      this.dirty = true;
    }
    return true;
  }

  /** Remove a tag from a session */
  removeTag(sessionId: string, tag: string): boolean {
    const s = this.sessions.get(sessionId);
    if (!s) {
      return false;
    }
    const idx = s.tags.indexOf(tag);
    if (idx !== -1) {
      s.tags.splice(idx, 1);
      this.dirty = true;
    }
    return true;
  }

  /** Get messages for a session */
  getMessages(sessionId: string): Message[] {
    return this.sessions.get(sessionId)?.messages ?? [];
  }
}
