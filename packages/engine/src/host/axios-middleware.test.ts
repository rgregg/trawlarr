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

  it('tolerates a leading slash on the endpoint', async () => {
    const { call, probeFile } = make();
    await call('/api/v2/scan-individual-file', { file: { _id: '/media/a.mkv' } });
    expect(probeFile).toHaveBeenCalledWith('/media/a.mkv');
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
