import { channelContent, selectChannels, selectsChannel } from "./channels.mjs";
import { contentDigest } from "./digest.mjs";
import { CHECK_BUFFER, ClientError } from "./errors.mjs";
import { checkDueAt } from "./job.mjs";
import { planEntry } from "./state.mjs";

// What a run is going to do with each channel, decided from the job, the
// session and the state before anything is sent.

/**
 * Plans the run and writes the plan into the state (in memory; the caller saves it).
 * @param {object} run
 * @param {{ send: boolean }} run.options
 * @param {{ now: () => number, newId: () => string }} run.deps
 * @param {{ channels: object[] }} run.session
 * @param {object} run.prepared the job, its content and its state, as read
 * @param {string} run.mode
 */
export function planRun({ options, deps, session, prepared, mode }) {
  const { job, content, statePath, state } = prepared;

  // Own entries only: an inherited name is never a channel's state.
  const stored = (id) =>
    Object.hasOwn(state.channels, id) ? state.channels[id] : undefined;
  // A channel does not change its network. A session that lists a channel
  // of this state under another one contradicts it: a network name in the
  // job would mean other channels than it did when the state was made, so
  // nothing is planned from such a session. This holds for the channels of
  // a send only: what a dry run wrote down is replaced by the next plan.
  const moved = session.channels.filter((channel) => {
    const before = state.targets?.includes(channel.id)
      ? stored(channel.id)?.service
      : undefined;
    return before !== undefined && before !== channel.service;
  });
  if (moved.length > 0)
    throw new ClientError(
      "state-mismatch",
      `The state file (${statePath}) has ${moved
        .map((channel) => `${channel.id} as ${stored(channel.id).service}`)
        .join(", ")}, and the session lists ${moved
        .map((channel) => `${channel.id} as ${channel.service}`)
        .join(
          ", ",
        )}. A channel does not change its network: fix the Worker's channel list, or use another state file (--state).`,
    );
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
  const plans = [
    ...selectChannels(job, session.channels, absent).map(planFor),
    ...absent
      .filter((channel) => selectsChannel(job, channel))
      .map((channel) => ({ ...planFor(channel), gone: true })),
  ];

  const changed = plans.filter((plan) => plan.action === "changed");
  if (changed.length > 0) {
    const names = (step) =>
      changed
        .filter((plan) => plan.entry.step === step)
        .map((plan) => `${plan.channel.service} (${plan.channel.id})`)
        .join(", ");
    const created = names("created");
    const sent = names("posting");
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

  // Why the time of this job no longer allows a send, if it does not. It
  // stops the channels that are still open and none of the others.
  let untimely;
  if (job.dueAt && prepared.stateExists) {
    try {
      checkDueAt(job.dueAt, deps.now());
    } catch (cause) {
      untimely = cause.message;
    }
  }

  // The channels of a job are fixed by its first run that sends. A channel the
  // job selects only later - the session gained one, or the job was edited -
  // would get the content of a job that was sent before, in a run made to
  // retry or to read results. It is reported and never sent.
  const targets = state.targets;
  const isLate = (plan) =>
    targets !== null && !targets.includes(plan.channel.id);
  if (targets === null && options.send)
    state.targets = plans.map((plan) => plan.channel.id);

  // What would go out in this run, were it a run that sends.
  const isOpen = (plan) =>
    plan.action === "send" && !plan.gone && !isLate(plan);

  for (const plan of plans)
    if (!plan.gone && !isLate(plan))
      state.channels[plan.channel.id] = Object.assign(plan.entry, {
        service: plan.channel.service,
      });

  return { plans, untimely, targets, isLate, isOpen, stored };
}
