import { randomUUID } from "node:crypto";
import path from "node:path";
import { z } from "zod";
import { ClientError } from "./errors.mjs";
import { decodeText } from "./files.mjs";
import { defaultStatePath } from "./job.mjs";
import { redactDeep } from "./redaction.mjs";

// The state file next to a job: a request ID per channel and how far each
// got, so that a second run never creates a second post.

/**
 * Where a channel stands. `posting` means a post request went out and no
 * created post was recorded for it.
 */
const STEPS = [
  "prepared",
  "uploading",
  "uploaded",
  "posting",
  "created",
  "refused",
  "failed",
];

const entrySchema = z
  .strictObject({
    service: z.string().optional(),
    requestId: z.uuid(),
    digest: z.string().regex(/^[0-9a-f]{64}$/),
    step: z.enum(STEPS),
    mediaId: z.uuid().optional(),
    postId: z.string().min(1).optional(),
    status: z.number().int().optional(),
    message: z.string().optional(),
  })
  .refine((entry) => entry.step !== "created" || entry.postId !== undefined, {
    message: 'a "created" entry needs a postId',
  });

const stateSchema = z.strictObject({
  version: z.literal(1),
  // The Worker the state was made against: a post created at one address says
  // nothing about another, so a state without it cannot be used.
  origin: z.string().min(1),
  // The channels of the first run that sent: later runs send to no other,
  // whatever the session lists by then. `null` until such a run.
  targets: z.array(z.string().min(1)).nullable(),
  channels: z.record(z.string().min(1), entrySchema),
});

/**
 * @typedef {z.infer<typeof entrySchema>} StateEntry
 * @typedef {z.infer<typeof stateSchema>} State
 */

/**
 * @param {string} origin the address of the Worker the run goes to
 * @returns {State}
 */
export function emptyState(origin) {
  return { version: 1, origin, targets: null, channels: {} };
}

/**
 * A state file that cannot be read is never replaced: it may hold the request
 * IDs of posts that exist.
 * @param {string} input
 * @returns {State}
 */
export function parseState(input) {
  let json;
  try {
    json = JSON.parse(input);
  } catch (cause) {
    throw new ClientError(
      "invalid-state",
      `The state file is not valid JSON: ${cause.message}`,
    );
  }
  const result = stateSchema.safeParse(json);
  if (!result.success)
    throw new ClientError(
      "invalid-state",
      `The state file is not a state of this client: ${result.error.issues
        .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
        .join("; ")}`,
    );
  return result.data;
}

/** @param {State} state */
export function serializeState(state) {
  return `${JSON.stringify(state, null, 2)}\n`;
}

/**
 * Decides what to do with one channel from its earlier state.
 *
 * - `send`: nothing is in doubt; the entry carries the request ID to use.
 * - `already-created`: the post exists, for exactly this content.
 * - `unknown`: an earlier post request has no recorded result. It is never
 *   repeated on its own.
 * - `changed`: a post exists, or may exist, for other content than the job
 *   now holds. Nothing is reported as this job's.
 *
 * @param {StateEntry | undefined} entry
 * @param {string} digest of the content prepared for the channel now
 * @param {() => string} newId
 * @returns {{ action: "send" | "already-created" | "unknown" | "changed", entry: StateEntry }}
 */
export function planEntry(entry, digest, newId) {
  if (!entry)
    return {
      action: "send",
      entry: { requestId: newId(), digest, step: "prepared" },
    };
  // What may be in Buffer is the content of that request, not of the job as
  // it is now: reporting it as unknown for the new content would send the
  // operator looking for the wrong post.
  if (entry.step === "posting")
    return { action: entry.digest === digest ? "unknown" : "changed", entry };
  if (entry.step === "created")
    return {
      action: entry.digest === digest ? "already-created" : "changed",
      entry,
    };
  if (entry.digest === digest) return { action: "send", entry };
  // Nothing was created for the old content, so the request ID is still free.
  return {
    action: "send",
    entry: { requestId: entry.requestId, digest, step: "prepared" },
  };
}

/**
 * @param {{ job: string, state?: string }} options
 * @param {{ cwd: string }} deps
 */
export function resolveStatePath(options, deps) {
  return path.resolve(deps.cwd, options.state ?? defaultStatePath(options.job));
}

/**
 * Reads the state of a job, or starts an empty one when the job was never run.
 * @param {string} statePath
 * @param {string} origin the address of the Worker the run goes to
 * @param {{ fs: { readFile: Function } }} deps
 * @returns {Promise<{ state: State, stateExists: boolean }>}
 */
export async function readState(statePath, origin, deps) {
  try {
    const state = parseState(decodeText(await deps.fs.readFile(statePath)));
    return { state, stateExists: true };
  } catch (cause) {
    if (cause?.code !== "ENOENT") {
      throw cause instanceof ClientError
        ? cause
        : new ClientError(
            "invalid-state",
            `Cannot read the state file (${statePath}): ${cause.code ?? cause.message}`,
          );
    }
    return { state: emptyState(origin), stateExists: false };
  }
}

/**
 * Writes the state of a run. Every write is the whole state.
 * @param {object} run
 * @param {State} run.state the state the run changes as it goes
 * @param {string} run.statePath
 * @param {boolean} run.stateExists whether the file was there when the run began
 * @param {{ fs: object }} run.deps
 * @param {string[]} run.secrets removed from everything that is written
 * @param {object[]} run.errors the errors of the report; one about a result
 *   that a later write did record is taken back
 */
export function createStateWriter({
  state,
  statePath,
  stateExists,
  deps,
  secrets,
  errors,
}) {
  let stateOnDisk = stateExists;
  // The errors of results that are not in the state file yet.
  const unsaved = [];
  const save = async () => {
    try {
      const data = serializeState(redactDeep(state, secrets));
      if (stateOnDisk) {
        // A later write replaces the file in one step: a run that dies in the
        // middle of it leaves the last complete state, not half of a new one.
        // The draft has a name nobody can prepare and is created exclusively,
        // so a file or a link that is already there is never written through.
        const draft = `${statePath}.${randomUUID()}.tmp`;
        try {
          await deps.fs.writeFile(draft, data, { flag: "wx", flush: true });
          await deps.fs.rename(draft, statePath);
        } catch (cause) {
          // Only a draft this run made is cleared away.
          if (cause?.code !== "EEXIST")
            await deps.fs.unlink?.(draft)?.catch(() => {});
          throw cause;
        }
      } else {
        // The first write must not replace a file another run has just made.
        await deps.fs.writeFile(statePath, data, { flag: "wx" });
      }
      stateOnDisk = true;
    } catch (cause) {
      throw new ClientError(
        "state-failed",
        cause.code === "EEXIST"
          ? `Another run created the state file (${statePath}) in the meantime. Run again.`
          : `Cannot write the state file (${statePath}): ${cause.code ?? cause.message}.`,
      );
    }
    // Every write is the whole state, so this one holds the results an
    // earlier write failed to record: what was said about them is taken back.
    for (const error of unsaved.splice(0))
      errors.splice(errors.indexOf(error), 1);
  };
  return { save, unsaved };
}
