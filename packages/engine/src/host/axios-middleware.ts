import type { PluginDeps } from '@trawlarr/plugin-api';

export class UnsupportedHostEndpointError extends Error {
  readonly endpoint: string;

  constructor(endpoint: string, detail: string) {
    super(`Unsupported host endpoint "${endpoint}". ${detail}`);
    this.name = 'UnsupportedHostEndpointError';
    this.endpoint = endpoint;
  }
}

export const SUPPORTED_ENDPOINTS = new Set(['api/v2/scan-individual-file']);

/** Endpoints we know about and deliberately do not implement, with the reason. */
const KNOWN_UNSUPPORTED = new Map([
  [
    'api/v2/read-plugin',
    'Trawlarr does not support Tdarr classic plugins, and this endpoint exists only ' +
      'to serve the classic-plugin bridge.',
  ],
]);

const normalise = (endpoint: string): string => endpoint.replace(/^\/+/, '');

/**
 * Backs deps.axiosMiddleware.
 *
 * Trawlarr is not a reimplementation of Tdarr's server API, so this is an
 * allowlist rather than a proxy. Anything outside it fails with the endpoint
 * named, in both the thrown error and the job log — a named incompatibility
 * is a five-minute fix, an empty response is a bug hunt.
 */
export const createAxiosMiddleware =
  (input: {
    probeFile: (path: string) => Promise<unknown>;
    log: (text: string) => void;
  }): PluginDeps['axiosMiddleware'] =>
  async (endpoint, data) => {
    const name = normalise(endpoint);

    if (!SUPPORTED_ENDPOINTS.has(name)) {
      const detail =
        KNOWN_UNSUPPORTED.get(name) ??
        `Supported endpoints: ${[...SUPPORTED_ENDPOINTS].join(', ')}.`;
      input.log(`Plugin called unsupported host endpoint "${name}". ${detail}`);
      throw new UnsupportedHostEndpointError(name, detail);
    }

    const file = data.file as { _id?: unknown } | undefined;
    if (typeof file?._id !== 'string') {
      throw new Error(`${name} requires data.file._id to be a file path.`);
    }
    return input.probeFile(file._id);
  };
