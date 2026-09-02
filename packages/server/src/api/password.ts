import * as argon2 from 'argon2';

/**
 * Argon2id, this project's ONE way to store a password.
 *
 * Argon2id (the mode `argon2.hash` defaults to) resists both the GPU-parallel
 * cracking a fast hash invites and the side-channel leakage of pure Argon2i,
 * which is why it is the algorithm the Password Hashing Competition and RFC
 * 9106 recommend for a mixed threat model. The library's default cost
 * parameters are used rather than hand-tuned ones: they are re-reviewed with
 * every release for the hardware attackers actually have, and a value this
 * codebase chose once at a moment in time would only ever go stale.
 *
 * The hash STRING (argon2's own encoded format — algorithm, version, cost
 * parameters and salt, all inline) is what gets stored, never a bare digest:
 * it is what lets `verify` check a password against a hash produced with
 * parameters that have since changed, and what lets a future migration bump
 * the cost without a schema change.
 */
export const hashPassword = async (password: string): Promise<string> =>
  await argon2.hash(password);

/**
 * Checks a plaintext password against a stored hash.
 *
 * Never throws on a WRONG password — only on a hash string this build's
 * argon2 cannot even parse, which a caller should treat as a real failure,
 * not "the password didn't match".
 */
export const verifyPassword = async (input: { password: string; hash: string }): Promise<boolean> =>
  await argon2.verify(input.hash, input.password);
