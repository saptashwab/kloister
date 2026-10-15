import { Readable, Writable } from 'node:stream';
import JSZip from 'jszip';
import { completedArchive } from './snapshot-stream.js';

describe('completed offline archive', () => {
  it('consumes lazy binary sources and produces a complete readable ZIP before returning', async () => {
    const zip = new JSZip();
    let opened = false;
    zip.file(
      'safe/file.txt',
      Readable.from(
        (function* () {
          opened = true;
          yield Buffer.from('offline content');
        })(),
      ),
    );
    const stream = await completedArchive(zip);
    expect(opened).toBe(true);
    const chunks: Buffer[] = [];
    for await (const chunk of stream) chunks.push(chunk as Buffer);
    const result = await JSZip.loadAsync(Buffer.concat(chunks));
    expect(await result.file('safe/file.txt')?.async('string')).toBe('offline content');
  });
  it('fails generation on a missing/corrupt file before returning a successful download stream', async () => {
    const zip = new JSZip();
    zip.file(
      'safe/file.txt',
      Readable.from(
        (function* () {
          yield Buffer.from('partial');
          throw new Error('file changed');
        })(),
      ),
    );
    await expect(completedArchive(zip)).rejects.toThrow('file changed');
  });
  it('closes lazy file sources and finalizes their generators on output-storage failure', async () => {
    const zip = new JSZip();
    let finalized = false;
    let started = false;
    const source = Readable.from(
      (function* () {
        try {
          started = true;
          for (let index = 0; index < 100; index++) yield Buffer.alloc(64 * 1024, index);
        } finally {
          finalized = true;
        }
      })(),
    );
    zip.file('large.dat', source);
    await expect(
      completedArchive(
        zip,
        [source],
        () =>
          new Writable({
            write(_chunk, _encoding, callback) {
              callback(started ? new Error('disk full') : undefined);
            },
          }),
      ),
    ).rejects.toThrow('disk full');
    expect(source.destroyed).toBe(true);
    expect(finalized).toBe(true);
  });
});
