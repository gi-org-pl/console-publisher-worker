import { CHECK_BUFFER } from "./errors.mjs";
import { sendChannel } from "./worker.mjs";

// What the JSON document says about one channel. The plan has decided what
// happens to the channel; here that decision becomes an outcome.

/**
 * A channel in the output. `check` lists the session's channels as they are;
 * `queue` and `schedule` add what happened to each selected one.
 * @typedef {object} ChannelReport
 * @property {string} id
 * @property {string} [name]
 * @property {string} [service]
 * @property {string} [requestId]
 * @property {"would-send" | "created" | "already-created" | "refused" | "failed" | "unknown"} [outcome]
 * @property {string} [postId]
 * @property {number} [status]
 * @property {string} [message]
 * @property {string} [text]
 * @property {string} [image]
 */

/**
 * The JSON document on stdout.
 * @typedef {object} Report
 * @property {boolean} ok
 * @property {string | null} command
 * @property {boolean} sent
 * @property {string | null} url
 * @property {Record<string, string> | null} identity
 * @property {string} [mode]
 * @property {string} [dueAt]
 * @property {string} [state]
 * @property {ChannelReport[]} channels
 * @property {{ code: string, status?: number, message: string }[]} errors
 */

/** @typedef {import("./plan.mjs").ChannelPlan} ChannelPlan */

/** The HTTP status an entry of the state recorded, if it recorded one. */
const statusOf = (entry) => (entry?.status ? { status: entry.status } : {});

/**
 * The outcome of a channel that is not sent in this run, by the plan's
 * decision about it.
 * @type {Record<Exclude<import("./plan.mjs").Decision, "send">, (plan: ChannelPlan, run: { targets: string[] | null, untimely?: string }) => object>}
 */
const NOT_SENT = {
  "already-created": ({ entry }) => ({
    outcome: "already-created",
    postId: entry.postId,
  }),
  unknown: ({ entry }) => ({
    outcome: "unknown",
    ...statusOf(entry),
    message:
      entry.message ??
      `An earlier run sent this post and recorded no result. ${CHECK_BUFFER}`,
  }),
  gone: ({ stored }) => ({
    outcome: "failed",
    ...statusOf(stored),
    message: `The session no longer lists this channel, so it was not sent. ${stored ? `Its last recorded step is "${stored.step}".` : "The state file has no entry for it."}`,
  }),
  late: (_plan, { targets }) => ({
    outcome: "failed",
    message: `This channel was not among the channels of the job when it was first sent (${targets.join(", ")}). It was not sent: a post for it needs a job of its own.`,
  }),
  untimely: (_plan, { untimely }) => ({
    outcome: "failed",
    message: `${untimely} This channel was not sent.`,
  }),
};

/** A channel the plan sends: for real with `--send`, on paper without. */
async function send(plan, { send: isSending, sending }) {
  if (!isSending) return { outcome: "would-send" };
  try {
    return await sendChannel(plan, sending);
  } catch (cause) {
    // Thrown before the post request went out, so nothing was created.
    return {
      outcome: "failed",
      message: cause instanceof Error ? cause.message : String(cause),
    };
  }
}

/**
 * Does what the plan decided for one channel - which may be sending it - and
 * reports it.
 * @param {ChannelPlan} plan
 * @param {object} run
 * @param {boolean} run.send whether this run sends at all
 * @param {string[] | null} run.targets the channels of the first send, if any
 * @param {string} [run.untimely] why the time of the job allows no send
 * @param {object} run.sending what `sendChannel` needs
 * @returns {Promise<ChannelReport>}
 */
export async function reportChannel(plan, run) {
  const { channel, requestId } = plan;
  const result =
    plan.decision === "send"
      ? await send(plan, run)
      : NOT_SENT[plan.decision](plan, run);
  return {
    id: channel.id,
    // Not known for a channel the session no longer lists.
    ...(channel.name ? { name: channel.name } : {}),
    ...(channel.service ? { service: channel.service } : {}),
    ...(requestId ? { requestId } : {}),
    ...result,
    text: plan.text,
    image: plan.image.path,
  };
}
