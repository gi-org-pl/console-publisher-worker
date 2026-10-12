import { CHECK_BUFFER } from "./errors.mjs";
import { sendChannel } from "./worker.mjs";

// What the JSON document says about one channel. For most channels of most
// runs nothing is sent: the answer comes from the plan.

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

/**
 * Does what the plan says for one channel - which may be sending it - and reports it.
 * @param {object} plan one entry of `planRun().plans`
 * @param {object} run
 * @param {boolean} run.send whether this run sends at all
 * @param {string} [run.untimely] why the time of the job no longer allows a send
 * @param {string[] | null} run.targets the channels of the first send, if there was one
 * @param {(plan: object) => boolean} run.isLate
 * @param {(id: string) => object | undefined} run.stored what the state holds
 * @param {object} run.sending what `sendChannel` needs
 * @returns {Promise<ChannelReport>}
 */
export async function reportChannel(
  plan,
  { send, untimely, targets, isLate, stored, sending },
) {
  const { channel, entry } = plan;
  let result;
  if (plan.action === "already-created") {
    result = { outcome: "already-created", postId: entry.postId };
  } else if (plan.action === "unknown") {
    result = {
      outcome: "unknown",
      ...(entry.status ? { status: entry.status } : {}),
      message:
        entry.message ??
        `An earlier run sent this post and recorded no result. ${CHECK_BUFFER}`,
    };
  } else if (plan.gone) {
    const last = stored(channel.id);
    result = {
      outcome: "failed",
      ...(last?.status ? { status: last.status } : {}),
      message: `The session no longer lists this channel, so it was not sent. ${last ? `Its last recorded step is "${last.step}".` : "The state file has no entry for it."}`,
    };
  } else if (isLate(plan)) {
    result = {
      outcome: "failed",
      message: `This channel was not among the channels of the job when it was first sent (${targets.join(", ")}). It was not sent: a post for it needs a job of its own.`,
    };
  } else if (untimely) {
    result = {
      outcome: "failed",
      message: `${untimely} This channel was not sent.`,
    };
  } else if (!send) {
    result = { outcome: "would-send" };
  } else {
    try {
      result = await sendChannel(plan, sending);
    } catch (cause) {
      // Thrown before the post request went out, so nothing was created.
      result = {
        outcome: "failed",
        message: cause instanceof Error ? cause.message : String(cause),
      };
    }
  }
  // A channel that is held back for good has no request of its own, and one
  // the session no longer lists has only what the state holds.
  const requestId = isLate(plan)
    ? undefined
    : (plan.gone ? stored(channel.id) : entry)?.requestId;
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
