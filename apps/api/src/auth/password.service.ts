import { randomBytes } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import argon2 from 'argon2';

/**
 * Password hashing and temporary password generation (SPEC §5).
 *
 * Uses argon2id with the library's recommended parameters, so hashes stay
 * current as the library raises its defaults; {@link needsRehash} lets login
 * upgrade old hashes transparently.
 */
@Injectable()
export class PasswordService {
  /**
   * A real hash of a random value, verified against when the account does
   * not exist so failed logins take the same time either way and do not
   * reveal which emails are registered.
   */
  private dummyHash?: Promise<string>;

  /**
   * Hashes a password with argon2id.
   *
   * @param password Plain-text password.
   * @returns The encoded hash, including its parameters and salt.
   */
  hash(password: string): Promise<string> {
    return argon2.hash(password, { type: argon2.argon2id });
  }

  /**
   * Checks a password against a stored hash. A malformed hash counts as a
   * mismatch rather than an error.
   *
   * @param hash Stored hash.
   * @param password Candidate password.
   * @returns True if they match.
   */
  async verify(hash: string, password: string): Promise<boolean> {
    try {
      return await argon2.verify(hash, password);
    } catch {
      return false;
    }
  }

  /**
   * Spends the same effort as {@link verify} without a real account, to keep
   * response timing uniform.
   *
   * @param password The submitted password.
   * @returns Always resolves to false.
   */
  async verifyDummy(password: string): Promise<false> {
    this.dummyHash ??= this.hash(randomBytes(32).toString('base64url'));
    await this.verify(await this.dummyHash, password);
    return false;
  }

  /**
   * Reports whether a stored hash uses weaker parameters than the current
   * defaults.
   *
   * @param hash Stored hash.
   * @returns True if it should be re-hashed.
   */
  needsRehash(hash: string): boolean {
    try {
      return argon2.needsRehash(hash);
    } catch {
      return true;
    }
  }

  /**
   * Generates a random temporary password: 18 random bytes as base64url,
   * giving 24 characters (above the 12-character minimum) and 144 bits of
   * entropy.
   *
   * @returns The new password; show it once and never store it in plain text.
   */
  generateTemporary(): string {
    return randomBytes(18).toString('base64url');
  }
}
