import { PendingEdits } from './pending-edits';

interface Row {
  id: string;
  title: string;
  status: string;
}

/**
 * A tiny store with pending edits over it.
 *
 * @returns The store's map, the edits and an upsert like the project store's.
 */
function setup() {
  const rows = new Map<string, Row>([['a', { id: 'a', title: 'Old', status: 'OPEN' }]]);
  const edits = new PendingEdits<Row>(
    (id) => rows.get(id),
    (row) => rows.set(row.id, row),
  );
  const upsert = (row: Row) => rows.set(row.id, edits.incoming(row));
  return { rows, edits, upsert };
}

describe('PendingEdits (v1.4.1)', () => {
  it('shows an edit at once and keeps the saved copy afterwards', async () => {
    const { rows, edits, upsert } = setup();
    let finish!: () => void;
    const saving = edits.run('a', { title: 'New' }, 'title', async () => {
      await new Promise<void>((resolve) => (finish = resolve));
      upsert({ id: 'a', title: 'New', status: 'OPEN' });
    });
    expect(rows.get('a')?.title).toBe('New');
    expect(edits.has('a', 'title')).toBe(true);
    expect(edits.has('a', 'status')).toBe(false);
    expect(edits.base('a')?.title).toBe('Old');
    finish();
    await saving;
    expect(rows.get('a')).toEqual({ id: 'a', title: 'New', status: 'OPEN' });
    expect(edits.has('a')).toBe(false);
  });

  it('goes back when the save fails or ends without the server copy', async () => {
    const { rows, edits } = setup();
    await expect(
      edits.run('a', { title: 'New' }, 'title', () => Promise.reject(new Error('refused'))),
    ).rejects.toThrow('refused');
    expect(rows.get('a')?.title).toBe('Old');
    // A cancelled confirmation stores nothing.
    await edits.run('a', { title: 'New' }, 'title', () => Promise.resolve(null));
    expect(rows.get('a')?.title).toBe('Old');
    expect(edits.pending().size).toBe(0);
  });

  it('keeps a change from someone else that arrived meanwhile, with the edit on top', async () => {
    const { rows, edits, upsert } = setup();
    let fail!: (error: Error) => void;
    const saving = edits.run(
      'a',
      { title: 'New' },
      'title',
      () => new Promise<void>((_resolve, reject) => (fail = reject)),
    );
    upsert({ id: 'a', title: 'Old', status: 'DONE' });
    expect(rows.get('a')).toEqual({ id: 'a', title: 'New', status: 'DONE' });
    fail(new Error('refused'));
    await expect(saving).rejects.toThrow();
    // The rollback restores their change, not the copy from before the edit.
    expect(rows.get('a')).toEqual({ id: 'a', title: 'Old', status: 'DONE' });
  });

  it('keeps a second waiting edit when the first one finishes', async () => {
    const { rows, edits, upsert } = setup();
    let second!: () => void;
    const status = edits.run('a', { status: 'DONE' }, 'status', async () => {
      await new Promise<void>((resolve) => (second = resolve));
      upsert({ id: 'a', title: 'New', status: 'DONE' });
    });
    await edits.run('a', { title: 'New' }, 'title', () => {
      upsert({ id: 'a', title: 'New', status: 'OPEN' });
      return Promise.resolve();
    });
    expect(rows.get('a')).toEqual({ id: 'a', title: 'New', status: 'DONE' });
    expect(edits.has('a', 'status')).toBe(true);
    second();
    await status;
    expect(rows.get('a')).toEqual({ id: 'a', title: 'New', status: 'DONE' });
  });
});
