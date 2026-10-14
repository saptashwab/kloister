import { mkdir, mkdtemp, readdir, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { ErrorCode } from '@kloister/shared';
import { makeConfig } from '../../test/support/fakes.js';
import { ApiException } from '../common/api-exception.js';
import { FileStoreService } from './file-store.service.js';
import {
  cleanFileName,
  contentDisposition,
  isInlineImageType,
  sniffFont,
  sniffType,
} from './file-types.js';

/** Minimal file heads of each recognised type. */
const HEADS = {
  png: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13],
  jpeg: [0xff, 0xd8, 0xff, 0xe0, 0, 16],
  gif: [...Buffer.from('GIF89a'), 1, 0],
  webp: [...Buffer.from('RIFF'), 0, 0, 0, 0, ...Buffer.from('WEBPVP8 ')],
  pdf: [...Buffer.from('%PDF-1.7\n')],
};

describe('sniffType (SPEC §5: checked by content, never SVG)', () => {
  it('recognises PNG, JPEG, GIF, WebP and PDF by their first bytes', () => {
    expect(sniffType(Uint8Array.from(HEADS.png))).toBe('image/png');
    expect(sniffType(Uint8Array.from(HEADS.jpeg))).toBe('image/jpeg');
    expect(sniffType(Uint8Array.from(HEADS.gif))).toBe('image/gif');
    expect(sniffType(Uint8Array.from(HEADS.webp))).toBe('image/webp');
    expect(sniffType(Uint8Array.from(HEADS.pdf))).toBe('application/pdf');
  });

  it('never recognises SVG, HTML or a renamed text file', () => {
    expect(sniffType(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg">'))).toBeNull();
    expect(sniffType(Buffer.from('<?xml version="1.0"?><svg/>'))).toBeNull();
    expect(sniffType(Buffer.from('<html><script>'))).toBeNull();
    expect(sniffType(Buffer.from('RIFF\0\0\0\0WAVE'))).toBeNull();
    expect(sniffType(Uint8Array.from([0x89, 0x50]))).toBeNull();
  });

  it('only lets the four image types be inline images', () => {
    expect(isInlineImageType('image/webp')).toBe(true);
    expect(isInlineImageType('application/pdf')).toBe(false);
    expect(isInlineImageType('image/svg+xml')).toBe(false);
    expect(isInlineImageType(null)).toBe(false);
  });
});

describe('sniffFont (docs/DESIGN.md §6: fonts checked by content)', () => {
  it('recognises WOFF2, WOFF, TrueType and OpenType', () => {
    expect(sniffFont(Buffer.from('wOF2rest'))).toBe('font/woff2');
    expect(sniffFont(Buffer.from('wOFFrest'))).toBe('font/woff');
    expect(sniffFont(Uint8Array.from([0, 1, 0, 0, 0, 12]))).toBe('font/ttf');
    expect(sniffFont(Buffer.from('true-rest'))).toBe('font/ttf');
    expect(sniffFont(Buffer.from('OTTOrest'))).toBe('font/otf');
  });

  it('refuses images, collections, SVG fonts and text', () => {
    expect(sniffFont(Uint8Array.from(HEADS.png))).toBeNull();
    expect(sniffFont(Buffer.from('ttcfrest'))).toBeNull();
    expect(sniffFont(Buffer.from('<svg><font'))).toBeNull();
    expect(sniffFont(Buffer.from('@font-face {'))).toBeNull();
    expect(sniffFont(Uint8Array.from([0, 1]))).toBeNull();
  });
});

describe('cleanFileName', () => {
  it('decodes the header and keeps only the last path segment', () => {
    expect(cleanFileName(encodeURIComponent('Prüfbericht März.pdf'), 255)).toBe(
      'Prüfbericht März.pdf',
    );
    expect(cleanFileName(encodeURIComponent('../../etc/passwd'), 255)).toBe('passwd');
    expect(cleanFileName(encodeURIComponent('C:\\temp\\a.txt'), 255)).toBe('a.txt');
  });

  it('removes control characters, shortens and never returns an empty name', () => {
    expect(cleanFileName(encodeURIComponent('a\u0000b\nc.txt'), 255)).toBe('abc.txt');
    // A right-to-left override would make this name read as "invoiceexe.pdf".
    expect(cleanFileName(encodeURIComponent('invoice‮fdp.exe'), 255)).toBe('invoicefdp.exe');
    expect(cleanFileName('x'.repeat(300), 255)).toHaveLength(255);
    expect(cleanFileName(undefined, 255)).toBe('file');
    expect(cleanFileName('..', 255)).toBe('file');
    expect(cleanFileName('%E0%A4%A', 255)).toBe('%E0%A4%A');
  });
});

describe('contentDisposition', () => {
  it('gives an ASCII fallback and the full UTF-8 name', () => {
    expect(contentDisposition('attachment', 'Bericht "März".pdf')).toBe(
      `attachment; filename="Bericht _M_rz_.pdf"; filename*=UTF-8''Bericht%20%22M%C3%A4rz%22.pdf`,
    );
  });
});

describe('FileStoreService', () => {
  let dir: string;
  let store: FileStoreService;
  const PROJECT = '33333333-3333-4333-8333-333333333333';

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'kloister-store-'));
    store = new FileStoreService(makeConfig({ attachmentsDir: dir }));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('streams an upload in, hashing it, and keeps it under its project', async () => {
    const body = Buffer.concat([Buffer.from(HEADS.png), Buffer.alloc(1000, 7)]);
    const file = await store.receive(Readable.from([body.subarray(0, 5), body.subarray(5)]), 2000);
    expect(file.sizeBytes).toBe(body.length);
    expect(sniffType(file.head)).toBe('image/png');
    expect(file.sha256).toMatch(/^[0-9a-f]{64}$/);
    await store.keep(file, PROJECT, 'stored-name');
    expect(await readFile(join(dir, PROJECT, 'stored-name'))).toEqual(body);
    expect(await readdir(join(dir, '.incoming'))).toEqual([]);
  });

  it('refuses files over the limit with 413 and leaves nothing behind', async () => {
    const error = await store
      .receive(Readable.from([Buffer.alloc(600), Buffer.alloc(600)]), 1000)
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiException);
    expect((error as ApiException).getStatus()).toBe(413);
    expect(((error as ApiException).getResponse() as { code: string }).code).toBe(
      ErrorCode.FILE_TOO_LARGE,
    );
    expect(await readdir(join(dir, '.incoming'))).toEqual([]);
  });

  it('refuses empty files', async () => {
    await expect(store.receive(Readable.from([]), 1000)).rejects.toBeInstanceOf(ApiException);
    expect(await readdir(join(dir, '.incoming'))).toEqual([]);
  });

  it('sweeps abandoned uploads out of the incoming folder, sparing recent ones', async () => {
    await mkdir(join(dir, '.incoming'), { recursive: true });
    await writeFile(join(dir, '.incoming', 'old'), 'x');
    await writeFile(join(dir, '.incoming', 'new'), 'y');
    const hourAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
    await utimes(join(dir, '.incoming', 'old'), hourAgo, hourAgo);
    expect(await store.sweepIncoming(60 * 60 * 1000)).toBe(1);
    expect(await readdir(join(dir, '.incoming'))).toEqual(['new']);
  });

  it('opens kept files, answers 404 for missing ones and removes files quietly', async () => {
    const file = await store.receive(Readable.from([Buffer.from('hello')]), 100);
    await store.keep(file, PROJECT, 'a');
    const chunks: Buffer[] = [];
    for await (const chunk of await store.open(PROJECT, 'a')) chunks.push(chunk as Buffer);
    expect(Buffer.concat(chunks).toString()).toBe('hello');
    await store.remove([
      { projectId: PROJECT, storedName: 'a' },
      { projectId: PROJECT, storedName: 'gone' },
    ]);
    await expect(store.open(PROJECT, 'a')).rejects.toBeInstanceOf(ApiException);
  });
});
