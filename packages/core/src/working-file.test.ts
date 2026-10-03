import { describe, expect, it } from 'vitest';
import { WORKING_FILE_PREFIX, isWorkingFileName } from './working-file.js';

describe('isWorkingFileName', () => {
  it('recognises the scratch files a replacement writes beside the media', () => {
    expect(isWorkingFileName(`${WORKING_FILE_PREFIX}replace-520ab0c8.mkv`)).toBe(true);
    expect(isWorkingFileName(`${WORKING_FILE_PREFIX}reserve-Movie (2002).mkv`)).toBe(true);
  });

  it('leaves media alone, including names that merely mention trawlarr', () => {
    expect(isWorkingFileName('Movie (2002).mkv')).toBe(false);
    expect(isWorkingFileName('trawlarr-replace-notes.mkv')).toBe(false);
    expect(isWorkingFileName('.hidden.mkv')).toBe(false);
  });

  it('does not match the reserved directory itself, which is pruned by path instead', () => {
    expect(isWorkingFileName('.trawlarr')).toBe(false);
  });
});
