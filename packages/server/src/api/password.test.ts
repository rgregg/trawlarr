import { describe, expect, it } from 'vitest';
import { hashPassword, verifyPassword } from './password.js';

describe('hashPassword/verifyPassword', () => {
  it('round-trips a correct password', async () => {
    const hash = await hashPassword('correct horse battery staple');
    expect(await verifyPassword({ password: 'correct horse battery staple', hash })).toBe(true);
  });

  it('rejects a wrong password', async () => {
    const hash = await hashPassword('correct horse battery staple');
    expect(await verifyPassword({ password: 'wrong', hash })).toBe(false);
  });

  it('never stores the plaintext in the hash', async () => {
    const hash = await hashPassword('sekrit-value');
    expect(hash).not.toContain('sekrit-value');
  });

  it('produces a different hash for the same password each time (unique salt)', async () => {
    const a = await hashPassword('same-password');
    const b = await hashPassword('same-password');
    expect(a).not.toBe(b);
  });
});
