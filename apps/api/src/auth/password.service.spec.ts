import { PASSWORD_MIN_LENGTH } from '@kloister/shared';
import { PasswordService } from './password.service.js';

describe('PasswordService', () => {
  const service = new PasswordService();

  it('hashes with argon2id and verifies', async () => {
    const hash = await service.hash('correct horse battery');
    expect(hash.startsWith('$argon2id$')).toBe(true);
    await expect(service.verify(hash, 'correct horse battery')).resolves.toBe(true);
    await expect(service.verify(hash, 'wrong')).resolves.toBe(false);
    expect(service.needsRehash(hash)).toBe(false);
  });

  it('treats a malformed hash as a mismatch', async () => {
    await expect(service.verify('not-a-hash', 'x')).resolves.toBe(false);
    expect(service.needsRehash('not-a-hash')).toBe(true);
  });

  it('verifyDummy always fails', async () => {
    await expect(service.verifyDummy('anything')).resolves.toBe(false);
  });

  it('generates long, unique, URL-safe temporary passwords', () => {
    const a = service.generateTemporary();
    const b = service.generateTemporary();
    expect(a).not.toBe(b);
    expect(a.length).toBeGreaterThanOrEqual(PASSWORD_MIN_LENGTH);
    expect(a).toMatch(/^[A-Za-z0-9_-]+$/);
  });
});
