import { describe, expect, it } from 'vitest';
import { InPlaceOutputError, resolveEncodeTarget } from './encode-target.js';

const target = (path: string, outputPathFor: (p: string, c: string) => string) =>
  resolveEncodeTarget({ path, container: 'mkv', outputPathFor });

describe('resolveEncodeTarget', () => {
  it('writes to a scratch path alongside the final one', () => {
    const { writePath, finalPath } = target('/media/in.mp4', () => '/staging/in.mkv');
    expect(finalPath).toBe('/staging/in.mkv');
    expect(writePath).toMatch(/^\/staging\/in\.trawlarr-tmp-.+\.mkv$/);
    expect(writePath).not.toBe(finalPath);
  });

  it('never hands ffmpeg its own input as the write target', () => {
    const { writePath } = target('/media/in.mkv', () => '/staging/in.mkv');
    expect(writePath).not.toBe('/media/in.mkv');
  });

  it('refuses when the resolved final path is the input file', () => {
    // Spec §6.1: the engine never implicitly replaces a file. A convergent
    // flow whose output path computes back to the input is exactly how a
    // "transcode" quietly becomes a destructive overwrite, so it must fail
    // loudly instead of proceeding.
    expect(() => target('/media/in.mkv', (p) => p)).toThrow(InPlaceOutputError);
  });

  it('names the colliding path and points at the Replace Original File node', () => {
    try {
      target('/media/in.mkv', (p) => p);
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(InPlaceOutputError);
      expect((error as InPlaceOutputError).path).toBe('/media/in.mkv');
      expect((error as Error).message).toMatch(/\/media\/in\.mkv/);
      expect((error as Error).message).toMatch(/Replace Original File/i);
    }
  });

  it('still allows the legitimate case where the container changes the path', () => {
    const { finalPath } = resolveEncodeTarget({
      path: '/media/in.avi',
      container: 'mkv',
      outputPathFor: (p, c) => `${p.slice(0, p.lastIndexOf('.'))}.${c}`,
    });
    expect(finalPath).toBe('/media/in.mkv');
  });
});
