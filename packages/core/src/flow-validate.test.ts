import { describe, expect, it } from 'vitest';
import type { FlowDefinition } from './flow.js';
import {
  assertFlowDefinitionValid,
  FlowValidationError,
  validateFlowDefinition,
  type FlowNodeCapabilityResolver,
} from './flow-validate.js';
import { flowDefinitionHash } from './signature.js';

/**
 * Capabilities keyed by plugin id, in the shape a real resolver produces from
 * `details()`. `unknown:*` resolves to null, which is how a validator sees a
 * community plugin that is not installed on the machine editing the flow.
 */
const CAPABILITIES: Record<string, { outputNumbers: number[]; isStartPlugin: boolean }> = {
  start: { outputNumbers: [1], isStartPlugin: true },
  checkVideoCodec: { outputNumbers: [1, 2], isStartPlugin: false },
  execute: { outputNumbers: [1, 2], isStartPlugin: false },
  replace: { outputNumbers: [1, 2], isStartPlugin: false },
};

const resolve: FlowNodeCapabilityResolver = (node) => CAPABILITIES[node.pluginId] ?? null;

const node = (id: string, pluginId: string) => ({
  id,
  pluginId,
  pluginVersion: '1.0.0',
  inputs: {},
});

const flow = (over: Partial<FlowDefinition> = {}): FlowDefinition => ({
  nodes: [node('start', 'start'), node('check', 'checkVideoCodec'), node('enc', 'execute')],
  edges: [
    { fromNodeId: 'start', outputNumber: 1, toNodeId: 'check' },
    { fromNodeId: 'check', outputNumber: 2, toNodeId: 'enc' },
  ],
  ...over,
});

const codesFor = (definition: FlowDefinition): string[] =>
  validateFlowDefinition(definition, resolve).map((problem) => problem.code);

describe('validateFlowDefinition', () => {
  it('accepts a well-formed flow', () => {
    expect(validateFlowDefinition(flow(), resolve)).toEqual([]);
  });

  it('rejects duplicate node ids, naming the id and every plugin that claims it', () => {
    const problems = validateFlowDefinition(
      flow({
        nodes: [node('start', 'start'), node('enc', 'execute'), node('enc', 'replace')],
        edges: [{ fromNodeId: 'start', outputNumber: 1, toNodeId: 'enc' }],
      }),
      resolve,
    );

    expect(problems.map((problem) => problem.code)).toEqual(['duplicate-node-id']);
    expect(problems[0]!.nodeId).toBe('enc');
    expect(problems[0]!.message).toContain('"enc"');
    expect(problems[0]!.message).toContain('execute');
    expect(problems[0]!.message).toContain('replace');
  });

  it('rejects an edge whose target node does not exist', () => {
    const problems = validateFlowDefinition(
      flow({ edges: [{ fromNodeId: 'start', outputNumber: 1, toNodeId: 'ghost' }] }),
      resolve,
    );
    expect(problems.map((problem) => problem.code)).toEqual(['edge-unknown-node']);
    expect(problems[0]!.message).toContain('"ghost"');
  });

  it('rejects an edge whose source node does not exist', () => {
    const problems = validateFlowDefinition(
      flow({
        edges: [
          { fromNodeId: 'start', outputNumber: 1, toNodeId: 'check' },
          { fromNodeId: 'ghost', outputNumber: 1, toNodeId: 'enc' },
        ],
      }),
      resolve,
    );
    expect(problems.map((problem) => problem.code)).toEqual(['edge-unknown-node']);
    expect(problems[0]!.message).toContain('"ghost"');
  });

  it('rejects an output number the source node does not declare', () => {
    const problems = validateFlowDefinition(
      flow({
        edges: [
          { fromNodeId: 'start', outputNumber: 1, toNodeId: 'check' },
          { fromNodeId: 'check', outputNumber: 3, toNodeId: 'enc' },
        ],
      }),
      resolve,
    );
    expect(problems.map((problem) => problem.code)).toEqual(['edge-undeclared-output']);
    expect(problems[0]!.message).toContain('output 3');
    expect(problems[0]!.message).toContain('1, 2');
  });

  it('rejects two edges leaving the same output, which array order alone would resolve', () => {
    const problems = validateFlowDefinition(
      flow({
        edges: [
          { fromNodeId: 'start', outputNumber: 1, toNodeId: 'check' },
          { fromNodeId: 'start', outputNumber: 1, toNodeId: 'enc' },
        ],
      }),
      resolve,
    );
    expect(problems.map((problem) => problem.code)).toEqual(['ambiguous-edge']);
    expect(problems[0]!.message).toContain('Output 1 of "start"');
  });

  it('rejects a flow with no start node, and one with no nodes at all', () => {
    expect(codesFor(flow({ nodes: [node('check', 'checkVideoCodec')], edges: [] }))).toEqual([
      'no-start-node',
    ]);
    expect(codesFor({ nodes: [], edges: [] })).toEqual(['no-nodes']);
  });

  it('rejects more than one start node', () => {
    const problems = validateFlowDefinition(
      flow({ nodes: [node('a', 'start'), node('b', 'start')], edges: [] }),
      resolve,
    );
    expect(problems.map((problem) => problem.code)).toEqual(['multiple-start-nodes']);
    expect(problems[0]!.message).toContain('"a"');
    expect(problems[0]!.message).toContain('"b"');
  });

  it('rejects a malformed definition instead of throwing a TypeError', () => {
    expect(codesFor({} as unknown as FlowDefinition)).toEqual(['malformed']);
    expect(codesFor({ nodes: [{}], edges: [] } as unknown as FlowDefinition)).toEqual([
      'malformed',
    ]);
    expect(
      codesFor({
        nodes: [node('start', 'start')],
        edges: [{ fromNodeId: 'start', outputNumber: '1', toNodeId: 'start' }],
      } as unknown as FlowDefinition),
    ).toEqual(['malformed']);
  });

  describe('deliberately allowed', () => {
    it('allows a cycle: a remediation branch rejoining the main path is legitimate', () => {
      expect(
        validateFlowDefinition(
          flow({
            edges: [
              { fromNodeId: 'start', outputNumber: 1, toNodeId: 'check' },
              { fromNodeId: 'check', outputNumber: 2, toNodeId: 'enc' },
              { fromNodeId: 'enc', outputNumber: 2, toNodeId: 'check' },
            ],
          }),
          resolve,
        ),
      ).toEqual([]);
    });

    it('allows an unreachable node: an error handler and a parked branch are both unreachable', () => {
      expect(
        validateFlowDefinition(
          flow({
            nodes: [
              node('start', 'start'),
              node('check', 'checkVideoCodec'),
              node('spare', 'replace'),
            ],
            edges: [{ fromNodeId: 'start', outputNumber: 1, toNodeId: 'check' }],
          }),
          resolve,
        ),
      ).toEqual([]);
    });

    it('does not fault a node whose plugin cannot be resolved here', () => {
      expect(
        validateFlowDefinition(
          flow({
            nodes: [node('start', 'start'), node('community', 'unknown:thing')],
            edges: [{ fromNodeId: 'community', outputNumber: 7, toNodeId: 'start' }],
          }),
          resolve,
        ),
      ).toEqual([]);
    });

    it('does not claim "no start node" when an unresolvable plugin could be the start', () => {
      expect(
        validateFlowDefinition(
          flow({ nodes: [node('community', 'unknown:thing')], edges: [] }),
          resolve,
        ),
      ).toEqual([]);
    });

    it('applies the structural checks with no resolver at all', () => {
      const problems = validateFlowDefinition({
        nodes: [node('a', 'start'), node('a', 'execute')],
        edges: [],
      });
      expect(problems.map((problem) => problem.code)).toEqual(['duplicate-node-id']);
    });
  });

  it('reports every problem it finds, not just the first', () => {
    const codes = codesFor({
      nodes: [node('a', 'start'), node('a', 'execute'), node('b', 'start')],
      edges: [{ fromNodeId: 'a', outputNumber: 9, toNodeId: 'ghost' }],
    });
    expect(new Set(codes)).toEqual(
      new Set([
        'duplicate-node-id',
        'multiple-start-nodes',
        'edge-unknown-node',
        'edge-undeclared-output',
      ]),
    );
  });
});

describe('assertFlowDefinitionValid', () => {
  it('is silent for a valid flow', () => {
    expect(() => assertFlowDefinitionValid(flow(), resolve)).not.toThrow();
  });

  it('throws a FlowValidationError carrying every problem', () => {
    let caught: unknown;
    try {
      assertFlowDefinitionValid(
        flow({ nodes: [node('a', 'start'), node('a', 'execute')], edges: [] }),
        resolve,
      );
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(FlowValidationError);
    expect((caught as FlowValidationError).problems.map((problem) => problem.code)).toEqual([
      'duplicate-node-id',
    ]);
    expect((caught as FlowValidationError).message).toContain('"a"');
  });
});

describe('the flowDefinitionHash ordering hazard duplicate ids created', () => {
  /**
   * `flowDefinitionHash` sorts nodes by id, so a flow containing two nodes
   * that share one id has a version that depends on their ARRAY ORDER — two
   * definitions with an identical id set hash differently. That hash IS the
   * flow's version and feeds the convergence signature, so the convergence
   * decision depended on array order. Rejecting duplicate ids retires it:
   * no definition whose hash can move with array order is storable, which is
   * why nothing in `flowDefinitionHash` itself needed changing.
   */
  it('is unreachable once duplicate ids are rejected', () => {
    const a: FlowDefinition = {
      nodes: [node('dup', 'execute'), node('dup', 'replace'), node('start', 'start')],
      edges: [],
    };
    const b: FlowDefinition = {
      nodes: [node('dup', 'replace'), node('dup', 'execute'), node('start', 'start')],
      edges: [],
    };

    // The hazard, on the definitions validation now refuses: same node ids,
    // same edges, two different flow versions.
    expect(flowDefinitionHash(a)).not.toBe(flowDefinitionHash(b));

    // Neither can be stored, so neither hash can ever be recorded against a
    // file's signature.
    expect(codesFor(a)).toContain('duplicate-node-id');
    expect(codesFor(b)).toContain('duplicate-node-id');
  });
});
