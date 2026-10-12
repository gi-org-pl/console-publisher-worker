import { execFile } from "node:child_process";

// Starting the program of a credential store.

/**
 * Runs a program and returns its exit code and stdout, never its stderr.
 * @param {{ file: string, args: string[], env: Record<string, string> }} command
 * @returns {Promise<{ code: number, stdout: string }>}
 */
export function runProcess({ file, args, env }) {
  return new Promise((resolve) => {
    execFile(
      file,
      args,
      { env: { ...process.env, ...env }, windowsHide: true, timeout: 30_000 },
      (error, stdout) =>
        resolve({
          code: error ? (typeof error.code === "number" ? error.code : -1) : 0,
          stdout,
        }),
    );
  });
}
