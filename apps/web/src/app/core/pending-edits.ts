import { signal } from '@angular/core';

/** One item's edits waiting for the server (v1.4.1). */
interface Pending<T> {
  /** The newest copy without the waiting edits: the server's or someone else's. */
  base: T;
  /** The waiting edits by token, oldest first, with the field each names. */
  patches: Map<number, { patch: Partial<T>; tag: string }>;
  /** The copy shown: the base with every waiting edit on top. */
  draft: T;
}

/**
 * Edits that show at once while the server saves them (v1.4.1, DESIGN §9.2):
 * the new value is shown in a pending style straight away; when the save
 * fails, or a confirmation is cancelled, the item goes back to its last
 * known copy. Copies that arrive meanwhile, from the save itself or from
 * someone else, become the new base and the waiting edits stay on top, so
 * neither side's change is lost silently.
 *
 * Store-agnostic: the project store and the My work calendar each wrap
 * their own item list with one.
 */
export class PendingEdits<T extends { id: string }> {
  /** Item ids with waiting edits, each with the fields (tags) they name. */
  readonly pending = signal<ReadonlyMap<string, ReadonlySet<string>>>(new Map());

  private readonly items = new Map<string, Pending<T>>();
  private tokens = 0;

  /**
   * Wraps a store's item list.
   *
   * @param read Reads the store's current copy of an item.
   * @param write Writes a copy to the store.
   */
  constructor(
    private readonly read: (id: string) => T | undefined,
    private readonly write: (item: T) => void,
  ) {}

  /**
   * Whether an item, or one of its fields, has an edit waiting.
   *
   * @param id Item id.
   * @param tag A field; any field when omitted.
   * @returns True while waiting.
   */
  has(id: string, tag?: string): boolean {
    const tags = this.pending().get(id);
    return tags !== undefined && (tag === undefined || tags.has(tag));
  }

  /**
   * The newest copy without the waiting edits, for plans that must start
   * from what is saved.
   *
   * @param id Item id.
   * @returns The saved copy while edits wait, else undefined.
   */
  base(id: string): T | undefined {
    return this.items.get(id)?.base;
  }

  /**
   * Passes a copy arriving for the store through the waiting edits: it
   * becomes the base, and the copy to store keeps the edits on top.
   *
   * @param item The arriving copy.
   * @returns The copy to store.
   */
  incoming(item: T): T {
    const entry = this.items.get(item.id);
    if (entry === undefined) return item;
    entry.base = item;
    entry.draft = this.merge(entry);
    return entry.draft;
  }

  /**
   * Shows an edit at once and runs its save. When the save throws, or
   * finishes without the server's copy replacing the shown one (a cancelled
   * confirmation, nothing changed), the item shows its newest base again.
   *
   * @param id Item id.
   * @param patch The fields the edit changes.
   * @param tag The field it names, for the pending style.
   * @param save Saves it; should store the server's copy.
   * @returns The save's result; rethrows its error after restoring.
   */
  async run<R>(id: string, patch: Partial<T>, tag: string, save: () => Promise<R>): Promise<R> {
    const current = this.read(id);
    if (current === undefined) return save();
    const token = ++this.tokens;
    const entry = this.items.get(id) ?? { base: current, patches: new Map(), draft: current };
    entry.patches.set(token, { patch, tag });
    entry.draft = this.merge(entry);
    this.items.set(id, entry);
    this.write(entry.draft);
    this.publish();
    try {
      return await save();
    } finally {
      this.finish(id, token);
    }
  }

  /**
   * Ends one waiting edit: the item shows its base with any other waiting
   * edits, unless the store no longer shows the draft (a reload replaced it
   * with fresh data, or the item is gone).
   *
   * @param id Item id.
   * @param token The edit.
   */
  private finish(id: string, token: number): void {
    const entry = this.items.get(id);
    if (entry === undefined) return;
    const shown = this.read(id);
    entry.patches.delete(token);
    if (entry.patches.size === 0) this.items.delete(id);
    if (shown === entry.draft) {
      entry.draft = this.merge(entry);
      this.write(entry.draft);
    }
    this.publish();
  }

  /**
   * The base with every waiting edit on top, oldest first.
   *
   * @param entry The item's edits.
   * @returns The copy to show.
   */
  private merge(entry: Pending<T>): T {
    if (entry.patches.size === 0) return entry.base;
    let draft = { ...entry.base };
    for (const { patch } of entry.patches.values()) draft = { ...draft, ...patch };
    return draft;
  }

  /** Updates {@link pending}. */
  private publish(): void {
    this.pending.set(
      new Map(
        [...this.items].map(([id, entry]) => [
          id,
          new Set([...entry.patches.values()].map((p) => p.tag)),
        ]),
      ),
    );
  }
}
