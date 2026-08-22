import type { PluginFileObject, PluginInputArgs } from '@trawlarr/plugin-api';
import { describeCommandChanges, deriveShouldProcess, type CommandChange } from '@trawlarr/core';

/** What the gate decided, and everything needed to say why in a job log. */
export interface NoopGateDecision {
  /** True when running ffmpeg would rewrite the file to say what it already says. */
  skip: boolean;
  /** Every reason the output would differ; empty exactly when `skip` is true. */
  changes: CommandChange[];
  /**
   * Did any plugin ASK for work? Reported, never obeyed — see below. It is
   * the difference between "this flow does nothing" and "this flow asked for
   * something that turned out to be a no-op on this file", which are the same
   * skip but very different things for an operator to read.
   */
  pluginsAskedForWork: boolean;
  /** One line, written for the job log and the step trace. */
  reason: string;
}

/**
 * The host's no-op gate, applied at the one place every flow's encode passes
 * through.
 *
 * WHERE THIS LIVES, AND WHY. Not in the compiler: `compileFfmpegArgs` is a
 * pure argv builder shared with the dry run and with Verify Output, and it
 * cannot see the file's own probe or its current container, which are half of
 * the comparison. Not in the flow executor: `runFlow` knows nothing about
 * ffmpeg commands and should not learn. Here, in the Execute runner's own
 * module, it has the command, the original file object's probe and container,
 * the log seam that reaches both the job log and the step's `log_excerpt`,
 * and the output number — and, like the unmappable-stream drop in the
 * compiler, it is a GATE rather than a node input, so it protects every flow
 * including community ones nobody here wrote and none of them can opt out.
 * That is the reasoning `docs/engineering-notes/p2-prerequisites.md` records
 * under "An allow-list is not a rule".
 *
 * The gate replaces `deriveShouldProcess` as the SKIP DECISION at this call
 * site, and does not narrow it anywhere: `deriveShouldProcess` remains the
 * answer to "did a plugin ask for work?", is still exported unchanged, and is
 * still read here — to describe the skip, never to cause one. Substituting it
 * is strictly the safer direction in both branches:
 *
 *  - `shouldProcess` set with nothing behind it used to RUN. That is the
 *    6.5 TB of pointless rewriting this gate exists to stop.
 *  - a container change with no other signal used to SKIP, because
 *    `deriveShouldProcess` never looks at the container. That is the
 *    dangerous direction — a real change silently marked converged — and it
 *    now runs.
 *
 * The gate refuses to skip unless the Execute node is reading the ORIGINAL
 * library file. A flow with a second Begin/Execute pair runs its later
 * commands against a path an earlier Execute produced, while the file
 * object's probe and container still describe the file the job started with;
 * comparing a command against a probe of a different file could only ever
 * produce a confident wrong answer.
 */
export const decideNoopGate = (args: PluginInputArgs): NoopGateDecision => {
  const command = args.variables.ffmpegCommand;
  const pluginsAskedForWork = deriveShouldProcess(command);
  // Typed non-optional by the contract, read as optional anyway: this decides
  // whether an encode happens, and a host or harness that assembled `args`
  // without an original file must fall out on the RUN side rather than throw
  // inside the one node that does the work.
  const original = args.originalLibraryFile as PluginFileObject | undefined;

  if (original === undefined || original.ffProbeData === undefined) {
    return {
      skip: false,
      changes: [
        {
          kind: 'unverifiable',
          detail: 'no probe of the original library file was supplied to compare against',
        },
      ],
      pluginsAskedForWork,
      reason:
        'Running ffmpeg: no probe of the original library file was supplied, so the command ' +
        'cannot be proved to change nothing.',
    };
  }

  if (args.inputFileObj._id !== original._id) {
    return {
      skip: false,
      changes: [
        {
          kind: 'input',
          detail:
            `this command reads "${args.inputFileObj._id}", which is not the library file ` +
            `this job started with ("${original._id}"), so there is no probe of it to ` +
            `compare against`,
        },
      ],
      pluginsAskedForWork,
      reason:
        'Running ffmpeg: this Execute node is not reading the original library file, so the ' +
        'command cannot be proved to change nothing.',
    };
  }

  const changes = describeCommandChanges({
    command,
    source: {
      path: original._id,
      container: original.container,
      streams: original.ffProbeData.streams,
    },
  });

  if (changes.length > 0) {
    return {
      skip: false,
      changes,
      pluginsAskedForWork,
      reason: `Running ffmpeg: ${changes.map((change) => change.detail).join('; ')}.`,
    };
  }

  return {
    skip: true,
    changes,
    pluginsAskedForWork,
    reason:
      'Skipping ffmpeg: the compiled command would produce a file identical to the input — ' +
      `same container (${original.container || 'none'}), the same ` +
      `${String(original.ffProbeData.streams?.length ?? 0)} stream(s) in the same order, all ` +
      'copied, and no overall arguments' +
      (pluginsAskedForWork
        ? '. One or more plugins set shouldProcess or pushed arguments, but nothing they asked ' +
          'for changes this file.'
        : '.') +
      ' The file is already in the state this flow wants.',
  };
};
