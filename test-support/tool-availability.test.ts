import { describe, expect, it } from 'vitest';
import { ToolCheckFailedError, toolAvailableSync } from './tool-availability.js';

/**
 * The check that decides whether a suite runs at all. Getting this wrong is
 * silent by construction — a skipped suite is green — so its two failure
 * modes are pinned here.
 */

const failWith = (error: Partial<NodeJS.ErrnoException> & { status?: number }) => () => {
  throw Object.assign(new Error('spawn failed'), error);
};

describe('toolAvailableSync', () => {
  it('reports a tool that runs', () => {
    expect(toolAvailableSync('ffmpeg', () => Buffer.from(''))).toBe(true);
  });

  it('reports ENOENT as "not installed" — the one case a skip is honest', () => {
    expect(toolAvailableSync('ffmpeg', failWith({ code: 'ENOENT' }))).toBe(false);
  });

  it('THROWS when the check itself failed, rather than converting it into a skip', () => {
    // Resource exhaustion under a concurrent test run: the tool may well be
    // installed, and answering "false" turns an unreliable check into a
    // false green on the phase's headline suite.
    for (const code of ['EAGAIN', 'EMFILE', 'ENOMEM', 'EACCES']) {
      expect(() => toolAvailableSync('ffmpeg', failWith({ code }))).toThrow(ToolCheckFailedError);
    }
    // A tool that exists but exits non-zero (a broken build, a wrapper
    // script that failed) is also not "absent".
    expect(() => toolAvailableSync('ffmpeg', failWith({ status: 1 }))).toThrow(
      ToolCheckFailedError,
    );
  });

  it('names the tool and the underlying reason, so the failure is diagnosable', () => {
    try {
      toolAvailableSync('ffprobe', failWith({ code: 'EAGAIN' }));
      expect.unreachable('should have thrown');
    } catch (error) {
      expect((error as Error).message).toContain('ffprobe');
      expect((error as Error).message).toContain('EAGAIN');
      expect((error as Error).cause).toBeDefined();
    }
  });

  it('answers for the real ffmpeg on this machine without throwing', () => {
    // The production call site, exercised: either it is installed (true) or
    // genuinely absent (false) — but never an unexplained throw here.
    expect(typeof toolAvailableSync('ffmpeg')).toBe('boolean');
  });
});
