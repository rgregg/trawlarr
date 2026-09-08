import { createInterface } from 'node:readline';

/**
 * Reads a new password from the operator, never from `argv`.
 *
 * A password passed as an argument is in that shell's history file and in
 * every other user's `ps` output for as long as the command runs, which is a
 * poor way to deliver the credential whose loss this command exists to
 * repair. It is its own module so the CLI suite can substitute it: a prompt
 * is the one input a test cannot pass as an argument either.
 *
 * On a TTY the input is not echoed and is asked for twice, because there is
 * nothing to check a typo against — the account it is being set on is, by
 * definition, one nobody can currently sign in to. Off a TTY (a pipe, CI,
 * `echo … | trawlarr …`) it reads a single line and takes it, since there is
 * no second chance to ask for and no terminal to hide the echo of.
 */
export const readNewPassword = async (): Promise<string> => {
  const input = process.stdin;
  if (!input.isTTY) {
    const rl = createInterface({ input });
    try {
      for await (const line of rl) return line.trim();
      return '';
    } finally {
      rl.close();
    }
  }

  const first = await askHidden('New password: ');
  const second = await askHidden('Confirm password: ');
  if (first !== second) throw new Error('Those passwords did not match. Nothing was changed.');
  return first;
};

/**
 * One hidden prompt.
 *
 * `readline` has no "no echo" mode, so the echo is suppressed by muting the
 * output stream for the duration and writing the prompt around it. The
 * newline the operator's Return produced is never echoed either, so it is
 * written by hand — without it every prompt after the first appears on the
 * same line as the one before.
 */
const askHidden = async (prompt: string): Promise<string> =>
  await new Promise<string>((resolve) => {
    const output = process.stdout;
    const rl = createInterface({ input: process.stdin, output, terminal: true });
    let muted = false;
    // `_writeToOutput` is readline's own hook for exactly this; it is
    // undocumented but stable, and the alternative is echoing the password.
    (rl as unknown as { _writeToOutput: (chunk: string) => void })._writeToOutput = (chunk) => {
      if (!muted) output.write(chunk);
    };
    rl.question(prompt, (answer) => {
      output.write('\n');
      rl.close();
      resolve(answer);
    });
    muted = true;
  });
