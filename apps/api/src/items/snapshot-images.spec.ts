import { inlineSources, rewriteImages } from './snapshot-images.js';

describe('authorized image rewriting', () => {
  it('preserves ordinary image-looking text and links without requesting a file', () => {
    const html =
      '<p>Example: /images/00000000-0000-0000-0000-000000000001</p><a href="https://example.org/images/00000000-0000-0000-0000-000000000001">reference</a>';
    expect(inlineSources(html)).toEqual([]);
    expect(
      rewriteImages(html, () => {
        throw new Error('not an image');
      }),
    ).toBe(html);
  });
  it('rewrites only actual image attributes, retaining text, formatting and alternative text', () => {
    const html =
      '<p><strong>Image</strong> original-path <img src="original-path" alt="Proof" /></p>';
    expect(inlineSources(html)).toEqual(['original-path']);
    expect(rewriteImages(html, () => 'files/image.gif')).toBe(
      '<p><strong>Image</strong> original-path <img src="files/image.gif" alt="Proof" /></p>',
    );
  });
});
