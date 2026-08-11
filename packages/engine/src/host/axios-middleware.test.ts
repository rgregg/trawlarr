import { describe, expect, it, vi } from 'vitest';
import {
  SUPPORTED_ENDPOINTS,
  UnsupportedHostEndpointError,
  createAxiosMiddleware,
} from './axios-middleware.js';

const make = (probeFile = vi.fn().mockResolvedValue({ streams: [] })) => {
  const log = vi.fn();
  return { call: createAxiosMiddleware({ probeFile, log }), probeFile, log };
};

describe('createAxiosMiddleware', () => {
  it('supports scan-individual-file, the one endpoint plugins reach for', async () => {
    expect(SUPPORTED_ENDPOINTS.has('api/v2/scan-individual-file')).toBe(true);
    const { call, probeFile } = make();
    await call('api/v2/scan-individual-file', { file: { _id: '/media/movie.mkv' } });
    expect(probeFile).toHaveBeenCalledWith('/media/movie.mkv');
  });

  // Plugins spell the same endpoint several ways. Every one of these is the
  // supported endpoint, and reporting any of them as unsupported would be this
  // component failing at the one thing it exists to do.
  it.each([
    ['a leading slash', '/api/v2/scan-individual-file'],
    ['repeated leading slashes', '//api/v2/scan-individual-file'],
    ['a trailing slash', 'api/v2/scan-individual-file/'],
    ['both slashes', '/api/v2/scan-individual-file/'],
    ['a query string', 'api/v2/scan-individual-file?cacheBust=1'],
    ['a query string after a trailing slash', '/api/v2/scan-individual-file/?a=1&b=2'],
    ['a fragment', 'api/v2/scan-individual-file#frag'],
    ['mixed case', '/API/v2/Scan-Individual-File'],
  ])('tolerates %s', async (_label, endpoint) => {
    const { call, probeFile } = make();
    await call(endpoint, { file: { _id: '/media/a.mkv' } });
    expect(probeFile).toHaveBeenCalledWith('/media/a.mkv');
  });

  it('recognises a known-unsupported endpoint through the same normalisation', async () => {
    const { call } = make();
    await expect(call('/api/v2/read-plugin/?x=1', {})).rejects.toThrow(/classic plugins/i);
  });

  it('still rejects a genuinely different endpoint', async () => {
    const { call } = make();
    await expect(call('/api/v2/scan-individual-file/extra', {})).rejects.toThrow(
      UnsupportedHostEndpointError,
    );
  });

  it('rejects an unsupported endpoint by name, so the fix is obvious', async () => {
    const { call, log } = make();
    await expect(call('api/v2/read-plugin', {})).rejects.toThrow(UnsupportedHostEndpointError);
    await expect(call('api/v2/read-plugin', {})).rejects.toThrow(/api\/v2\/read-plugin/);
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/read-plugin/));
  });

  it('mentions that classic plugins are unsupported when the bridge endpoint is called', async () => {
    const { call } = make();
    await expect(call('api/v2/read-plugin', {})).rejects.toThrow(/classic plugins/i);
  });

  it('rejects a malformed scan request rather than probing nothing', async () => {
    const { call } = make();
    await expect(call('api/v2/scan-individual-file', {})).rejects.toThrow(/file\._id/);
  });
});
