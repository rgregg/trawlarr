import type { PluginModule } from '@trawlarr/plugin-api';
import { closeFfmpegCommand, compileFfmpegArgs } from '@trawlarr/core';
import type { LoadedPlugin } from '../host/loader.js';
import { resolveEncodeTarget } from './encode-target.js';
import { decideNoopGate, type NoopGateDecision } from './noop-gate.js';
import { runFlow, type FlowRunResult, type RunFlowOptions } from './run-flow.js';
import { classifySideEffects } from './vouchable.js';

/**
 * What the no-op gate said about ONE invocation of ONE Execute node — the
 * same decision, from the same function, that the real Execute runner writes
 * to the job log as `Running ffmpeg: <reasons>` or `Skipping ffmpeg: ...`.
 *
 * This is the entire diagnostic value of a dry run: `plannedCommands` says
 * WHAT would run, and this says WHETHER it would run and WHY. Without the
 * reasons, an operator looking at a file that keeps being rewritten has to
 * deploy the flow and read a job log to find out which node contributed the
 * argument that stopped it converging.
 */
export interface DryRunExecuteDecision extends NoopGateDecision {
  /** The flow node whose Execute this was. */
  nodeId: string;
  /** The argv that would have run, or null when the gate skipped. */
  command: string[] | null;
}

export interface DryRunResult extends FlowRunResult {
  complete: boolean;
  stoppedAtNodeId: string | null;
  stoppedBecause: string | null;
  plannedCommands: string[][];
  /** Every Execute the walk reached, in the order it reached them. */
  executeDecisions: DryRunExecuteDecision[];
  /**
   * True when at least one Execute the walk reached would run ffmpeg. False
   * on a walk that reached an Execute and skipped it, AND on a walk that
   * reached no Execute at all — which is why `executeDecisions` is reported
   * beside it rather than being summarised away.
   */
  wouldRunFfmpeg: boolean;
}

class DryRunStop extends Error {
  readonly nodeId: string;

  constructor(nodeId: string, pluginId: string) {
    super(
      `Dry run stopped before node "${nodeId}": trawlarr cannot vouch for the side effects ` +
        `of plugin "${pluginId}", because a third-party plugin may run subprocesses or write ` +
        `files directly. Use a trial run to execute this flow against throwaway copies.`,
    );
    this.name = 'DryRunStop';
    this.nodeId = nodeId;
  }
}

/**
 * Walk the flow without performing side effects.
 *
 * Engine-controlled nodes are replaced by inert stand-ins: the Execute
 * substitute compiles the command that would have run and records it, then
 * routes onward as success. Any node we cannot vouch for halts the walk
 * before it is invoked.
 */
export const runDryFlow = async (
  options: RunFlowOptions & {
    outputPathFor: (path: string, container: string) => string;
  },
): Promise<DryRunResult> => {
  const plannedCommands: string[][] = [];
  const executeDecisions: DryRunExecuteDecision[] = [];

  // Nodes whose plugin we declined to vouch for, recorded when the loader
  // wrapper is asked for them. Being asked is NOT the same as being reached:
  // runFlow's start-node discovery loads candidate nodes while searching, so a
  // third-party node listed before the start node gets probed even though the
  // walk may never visit it. Recording a *candidate* here and deciding
  // afterwards which one (if any) the walk actually reached is what keeps a
  // flow that ran to completion from reporting `complete: false` with a
  // stoppedAtNodeId it never executed.
  const stopCandidates = new Map<string, string>();

  const inertStandIn = (plugin: LoadedPlugin, nodeId: string): PluginModule => ({
    details: () => plugin.details,
    plugin: (args) => {
      // The SAME gate the real Execute applies, for the same reason the
      // encode target is resolved through the same helper: a dry run that
      // reported a command the real run would skip would be describing work
      // that is never going to happen. Decided ONCE and recorded, so what the
      // caller reads is the decision that was acted on here, not a second
      // evaluation that could differ.
      const gate =
        plugin.id === 'trawlarr:execute' && args.variables.ffmpegCommand.init
          ? decideNoopGate(args)
          : null;

      if (gate !== null && !gate.skip) {
        // Report the exact command the real Execute would run — same
        // resolver, same scratch write target — so a dry run can never
        // describe an in-place command that would fail if actually run.
        const { writePath } = resolveEncodeTarget({
          path: args.inputFileObj._id,
          container: args.variables.ffmpegCommand.container,
          outputPathFor: options.outputPathFor,
        });
        const compiled = compileFfmpegArgs({
          command: args.variables.ffmpegCommand,
          outputPath: writePath,
        });
        plannedCommands.push(compiled);
        executeDecisions.push({ ...gate, nodeId, command: compiled });
        return {
          outputNumber: 1,
          outputFileObj: { _id: args.inputFileObj._id },
          variables: {
            ...args.variables,
            ffmpegCommand: closeFfmpegCommand(args.variables.ffmpegCommand),
          },
        };
      }

      if (gate !== null) {
        // Mirrors the real Execute's skip: nothing to do, so no command is
        // planned or recorded, but the command still closes the way the
        // real node closes it. The gate's own reason IS recorded — "why was
        // this file left alone" is as much a question a dry run has to
        // answer as "why would it be rewritten".
        executeDecisions.push({ ...gate, nodeId, command: null });
        return {
          outputNumber: 1,
          outputFileObj: { _id: args.inputFileObj._id },
          variables: {
            ...args.variables,
            ffmpegCommand: closeFfmpegCommand(args.variables.ffmpegCommand),
          },
        };
      }

      return {
        outputNumber: 1,
        outputFileObj: { _id: args.inputFileObj._id },
        variables: args.variables,
      };
    },
  });

  const result = await runFlow({
    ...options,
    routeLoadErrors: false,
    loadPlugin: (node) => {
      const plugin = options.loadPlugin(node);
      const classification = classifySideEffects(plugin);

      if (classification === 'unknown') {
        const stop = new DryRunStop(node.id, plugin.id);
        stopCandidates.set(node.id, stop.message);
        throw stop;
      }

      if (classification === 'engine-controlled') {
        return { ...plugin, module: inertStandIn(plugin, node.id) };
      }

      return plugin;
    },
  });

  // The walk reached a node only if runFlow recorded a step for it. A load
  // that throws produces a step with the error attached and ends the run, so
  // the last step is the only place a stop can legitimately have happened.
  const lastStep = result.steps.at(-1);
  const stoppedAtNodeId =
    lastStep !== undefined && lastStep.error !== null && stopCandidates.has(lastStep.nodeId)
      ? lastStep.nodeId
      : null;
  const stoppedBecause =
    stoppedAtNodeId === null ? null : (stopCandidates.get(stoppedAtNodeId) ?? null);
  const stoppedEarly = stoppedAtNodeId !== null;

  return {
    ...result,
    // Declining to continue is not a failure — it is the documented limit of
    // what a dry run can promise.
    failed: stoppedEarly ? false : result.failed,
    error: stoppedEarly ? null : result.error,
    complete: !stoppedEarly && !result.failed,
    stoppedAtNodeId,
    stoppedBecause,
    plannedCommands,
    executeDecisions,
    wouldRunFfmpeg: executeDecisions.some((decision) => !decision.skip),
  };
};
