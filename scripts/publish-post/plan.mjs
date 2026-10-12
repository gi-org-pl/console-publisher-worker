import { channelContent, selectChannels, selectsChannel } from "./channels.mjs";
import { contentDigest } from "./digest.mjs";
import { CHECK_BUFFER, ClientError } from "./errors.mjs";
import { checkDueAt } from "./job.mjs";
import { planEntry } from "./state.mjs";

// What a run is going to do with each channel, decided from the job, the
// session and the state before anything is sent. Every channel gets one
// decision here; the report and the send only read it.

/**
 * What a run does with a channel. Everything but `send` is a reason why the
 * channel is not sent in this run:
 *
 * - `already-created`: the post exists, for exactly this content.
 * - `unknown`: an earlier post request has no recorded result.
 * - `gone`: the session no longer lists the channel.
 * - `late`: the channel was not among the channels of the first send.
 * - `untimely`: the time of the job no longer allows a send.
 *
 * @typedef {"send" | "already-created" | "unknown" | "gone" | "late" | "untimely"} Decision
 */

/**
 * One channel of a run.
 * @typedef {object} ChannelPlan
 * @property {{ id: string, name?: string, service?: string }} channel
 * @property {string} text
 * @property {{ path: string, bytes: Uint8Array, sha256: string }} image
 * @property {import("./state.mjs").StateEntry} entry the entry a send works on
 * @property {Decision} decision
 * @property {string} [requestId] the request ID to report for the channel
 * @property {import("./state.mjs").StateEntry} [stored] for a channel that is
 *   gone: what the state holds about it, if anything
 */

/** The names of channels in a message. */
const list = (channels, describe) => channels.map(describe).join(", ");

/**
 * A channel does not change its network. A session that lists a channel of
 * this state under another one contradicts it: a network name in the job
 * would mean other channels than it did when the state was made, so nothing
 * is planned from such a session. This holds for the channels of a send
 * only: what a dry run wrote down is replaced by the next plan.
 */
function checkNetworks(session, state, statePath, stored) {
  const moved = session.channels.filter((channel) => {
    const before = state.targets?.includes(channel.id)
      ? stored(channel.id)?.service
      : undefined;
    return before !== undefined && before !== channel.service;
  });
  if (moved.length > 0)
    throw new ClientError(
      "state-mismatch",
      `The state file (${statePath}) has ${list(
        moved,
        (channel) => `${channel.id} as ${stored(channel.id).service}`,
      )}, and the session lists ${list(
        moved,
        (channel) => `${channel.id} as ${channel.service}`,
      )}. A channel does not change its network: fix the Worker's channel list, or use another state file (--state).`,
    );
}

/**
 * A job that changed after something was sent for it is not this job any
 * more: nothing is reported as its own.
 */
function checkUnchanged(plans) {
  const changed = plans.filter((plan) => plan.action === "changed");
  if (changed.length === 0) return;
  const at = (step) =>
    list(
      changed.filter((plan) => plan.entry.step === step),
      (plan) => `${plan.channel.service} (${plan.channel.id})`,
    );
  const created = at("created");
  const sent = at("posting");
  throw new ClientError(
    "state-mismatch",
    [
      created && `The job changed after a post was created for ${created}.`,
      sent &&
        `The job changed after a post for ${sent} was sent with no recorded result: what may be in Buffer is the earlier content. ${CHECK_BUFFER}`,
      "A new post needs a new state file (--state).",
    ]
      .filter(Boolean)
      .join(" "),
  );
}

/**
 * Why the time of the job no longer allows a send, if it does not. A job
 * that was never run is held to its time when it is read; this is for a job
 * that is run again.
 * @returns {string | undefined}
 */
function whyUntimely(job, stateExists, now) {
  if (!job.dueAt || !stateExists) return undefined;
  try {
    checkDueAt(job.dueAt, now);
    return undefined;
  } catch (cause) {
    return cause.message;
  }
}

/**
 * Plans the run and writes the plan into the state (in memory; the caller
 * saves it).
 * @param {object} run
 * @param {{ send: boolean }} run.options
 * @param {{ now: () => number, newId: () => string }} run.deps
 * @param {{ channels: { id: string, name: string, service: string }[] }} run.session
 * @param {object} run.prepared the job, its content and its state, as read
 * @param {string} run.mode
 * @returns {{ plans: ChannelPlan[], targets: string[] | null, untimely: string | undefined }}
 */
export function planRun({ options, deps, session, prepared, mode }) {
  const { job, content, statePath, state } = prepared;
  // Own entries only: an inherited name is never a channel's state.
  const stored = (id) =>
    Object.hasOwn(state.channels, id) ? state.channels[id] : undefined;

  checkNetworks(session, state, statePath, stored);

  // Channels of the first send that the session no longer lists. Nothing can
  // be sent to them, but what the state holds about them still belongs to the
  // job: a post that exists, one with no known result, one that never went
  // out. A run that left them out would call such a job done.
  const absent = (state.targets ?? [])
    .filter((id) => !session.channels.some((channel) => channel.id === id))
    .map((id) => ({ id, service: stored(id)?.service }));
  const planFor = (channel) => {
    const { text, image } = channelContent(content, channel);
    const digest = contentDigest({
      mode,
      dueAt: job.dueAt,
      text,
      imageSha256: image.sha256,
    });
    return {
      channel,
      text,
      image,
      ...planEntry(stored(channel.id), digest, deps.newId),
    };
  };
  const drafts = [
    ...selectChannels(job, session.channels, absent).map(planFor),
    ...absent
      .filter((channel) => selectsChannel(job, channel))
      .map((channel) => ({ ...planFor(channel), gone: true })),
  ];
  checkUnchanged(drafts);

  const untimely = whyUntimely(job, prepared.stateExists, deps.now());

  // The channels of a job are fixed by its first run that sends. A channel the
  // job selects only later - the session gained one, or the job was edited -
  // would get the content of a job that was sent before, in a run made to
  // retry or to read results. It is reported and never sent.
  const targets = state.targets;
  const isLate = (draft) =>
    targets !== null && !targets.includes(draft.channel.id);
  if (targets === null && options.send)
    state.targets = drafts.map((draft) => draft.channel.id);

  // The state keeps an entry for every channel this job may still send to.
  for (const draft of drafts)
    if (!draft.gone && !isLate(draft))
      state.channels[draft.channel.id] = Object.assign(draft.entry, {
        service: draft.channel.service,
      });

  /**
   * The order is the precedence: what the state knows about a post comes
   * before every reason not to send one.
   * @returns {Decision}
   */
  const decide = ({ action, gone }, late) => {
    if (action !== "send") return action;
    if (gone) return "gone";
    if (late) return "late";
    return untimely ? "untimely" : "send";
  };
  const plans = drafts.map((draft) => {
    const { channel, text, image, entry, gone } = draft;
    const late = isLate(draft);
    const kept = gone ? stored(channel.id) : entry;
    return {
      channel,
      text,
      image,
      entry,
      decision: decide(draft, late),
      // A channel that is held back for good has no request of its own, and
      // one the session no longer lists has only what the state holds.
      requestId: late ? undefined : kept?.requestId,
      ...(gone ? { stored: kept } : {}),
    };
  });

  return { plans, targets, untimely };
}
