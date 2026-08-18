import { describe, expect, it } from 'vitest';
import type { FlowDefinition } from './flow.js';
import { flowRequiredHardware, hardwareForEncoder, tdarrWorkerType } from './worker-class.js';

describe('tdarrWorkerType', () => {
  it('projects our class/hardware split onto the flat string plugins read', () => {
    expect(tdarrWorkerType({ workerClass: 'transcode', hardwareType: 'cpu' })).toBe('transcodecpu');
    expect(tdarrWorkerType({ workerClass: 'transcode', hardwareType: 'nvenc' })).toBe(
      'transcodegpu',
    );
    expect(tdarrWorkerType({ workerClass: 'transcode', hardwareType: 'qsv' })).toBe('transcodegpu');
    expect(tdarrWorkerType({ workerClass: 'health', hardwareType: 'cpu' })).toBe('healthcheckcpu');
    expect(tdarrWorkerType({ workerClass: 'health', hardwareType: 'vaapi' })).toBe(
      'healthcheckgpu',
    );
  });

  it('pins the full class x hardware compatibility matrix, not just one representative case', () => {
    expect(tdarrWorkerType({ workerClass: 'transcode', hardwareType: 'cpu' })).toBe('transcodecpu');
    expect(tdarrWorkerType({ workerClass: 'transcode', hardwareType: 'nvenc' })).toBe(
      'transcodegpu',
    );
    expect(tdarrWorkerType({ workerClass: 'transcode', hardwareType: 'qsv' })).toBe('transcodegpu');
    expect(tdarrWorkerType({ workerClass: 'transcode', hardwareType: 'vaapi' })).toBe(
      'transcodegpu',
    );
    expect(tdarrWorkerType({ workerClass: 'transcode', hardwareType: 'videotoolbox' })).toBe(
      'transcodegpu',
    );
    expect(tdarrWorkerType({ workerClass: 'transcode', hardwareType: 'amf' })).toBe('transcodegpu');
    expect(tdarrWorkerType({ workerClass: 'health', hardwareType: 'cpu' })).toBe('healthcheckcpu');
    expect(tdarrWorkerType({ workerClass: 'health', hardwareType: 'nvenc' })).toBe(
      'healthcheckgpu',
    );
    expect(tdarrWorkerType({ workerClass: 'health', hardwareType: 'qsv' })).toBe('healthcheckgpu');
    expect(tdarrWorkerType({ workerClass: 'health', hardwareType: 'vaapi' })).toBe(
      'healthcheckgpu',
    );
    expect(tdarrWorkerType({ workerClass: 'health', hardwareType: 'videotoolbox' })).toBe(
      'healthcheckgpu',
    );
    expect(tdarrWorkerType({ workerClass: 'health', hardwareType: 'amf' })).toBe('healthcheckgpu');
  });
});

describe('hardwareForEncoder', () => {
  it('maps encoder suffixes onto hardware families and defaults to cpu', () => {
    expect(hardwareForEncoder('hevc_nvenc')).toBe('nvenc');
    expect(hardwareForEncoder('h264_qsv')).toBe('qsv');
    expect(hardwareForEncoder('hevc_vaapi')).toBe('vaapi');
    expect(hardwareForEncoder('hevc_videotoolbox')).toBe('videotoolbox');
    expect(hardwareForEncoder('h264_amf')).toBe('amf');
    expect(hardwareForEncoder('libx265')).toBe('cpu');
    expect(hardwareForEncoder('')).toBe('cpu');
  });
});

describe('flowRequiredHardware', () => {
  const flowWith = (inputs: Record<string, unknown>): FlowDefinition => ({
    nodes: [
      { id: 'a', pluginId: 'trawlarr:start', pluginVersion: '1', inputs: {} },
      { id: 'b', pluginId: 'trawlarr:setVideoEncoder', pluginVersion: '1', inputs },
    ],
    edges: [{ fromNodeId: 'a', outputNumber: 1, toNodeId: 'b' }],
  });

  it('is empty for a flow that never names a hardware encoder', () => {
    expect(flowRequiredHardware(flowWith({ encoder: 'libx265' }))).toEqual([]);
  });

  it('names the hardware a flow requires, without duplicates', () => {
    const flow = flowWith({ encoder: 'hevc_nvenc' });
    flow.nodes.push({
      id: 'c',
      pluginId: 'trawlarr:setVideoEncoder',
      pluginVersion: '1',
      inputs: { encoder: 'hevc_nvenc' },
    });
    expect(flowRequiredHardware(flow)).toEqual(['nvenc']);
  });

  it('ignores inputs that are not encoder names, so an arbitrary string cannot invent a requirement', () => {
    expect(flowRequiredHardware(flowWith({ tooltip: 'use nvenc if you can' }))).toEqual([]);
  });

  it('reads any input key ending in "Encoder", not just the literal "encoder"', () => {
    expect(flowRequiredHardware(flowWith({ videoEncoder: 'h264_qsv' }))).toEqual(['qsv']);
  });

  it('orders multiple required hardware types by HARDWARE_TYPES order, regardless of node order', () => {
    const flow = flowWith({ encoder: 'h264_qsv' });
    flow.nodes.push({
      id: 'c',
      pluginId: 'trawlarr:setVideoEncoder',
      pluginVersion: '1',
      inputs: { encoder: 'hevc_nvenc' },
    });
    // HARDWARE_TYPES is ['cpu', 'nvenc', 'qsv', ...], so nvenc must sort
    // before qsv even though the qsv-requiring node appears first.
    expect(flowRequiredHardware(flow)).toEqual(['nvenc', 'qsv']);
  });
});
