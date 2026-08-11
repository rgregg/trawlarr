import type { PluginModule } from '@trawlarr/plugin-api';
import { closeFfmpegCommand, compileFfmpegArgs } from '@trawlarr/core';
import type { LoadedPlugin } from '../host/loader.js';
import { resolveEncodeTarget } from './encode-target.js';
import { runFlow, type FlowRunResult, type RunFlowOptions } from './run-flow.js';
import { classifySideEffects } from './vouchable.js';

export interface DryRunResult extends FlowRunResult {
  complete: boolean;
  stoppedAtNodeId: string | null;
  stoppedBecause: string | null;
  plannedCommands: string[][];
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
  let stoppedAtNodeId: string | null = null;
  let stoppedBecause: string | null = null;

  const inertStandIn = (plugin: LoadedPlugin): PluginModule => ({
    details: () => plugin.details,
    plugin: (args) => {
      if (plugin.id === 'trawlarr:execute' && args.variables.ffmpegCommand.init) {
        // Report the exact command the real Execute would run — same
        // resolver, same scratch write target — so a dry run can never
        // describe an in-place command that would fail if actually run.
        const { writePath } = resolveEncodeTarget({
          path: args.inputFileObj._id,
          container: args.variables.ffmpegCommand.container,
          outputPathFor: options.outputPathFor,
        });
        plannedCommands.push(
          compileFfmpegArgs({
            command: args.variables.ffmpegCommand,
            outputPath: writePath,
          }),
        );
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
    loadPlugin: (node) => {
      const plugin = options.loadPlugin(node);
      const classification = classifySideEffects(plugin);

      if (classification === 'unknown') {
        const stop = new DryRunStop(node.id, plugin.id);
        stoppedAtNodeId = node.id;
        stoppedBecause = stop.message;
        throw stop;
      }

      if (classification === 'engine-controlled') {
        return { ...plugin, module: inertStandIn(plugin) };
      }

      return plugin;
    },
  });

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
  };
};
