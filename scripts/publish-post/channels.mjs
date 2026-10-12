import { ClientError } from "./errors.mjs";

// Which channels of the session a job means, and what each of them gets.

/**
 * @typedef {{ id: string, name: string, service: string }} Channel
 */

/** A job names a channel by its id or by its network; the id wins. */
function findOverride(values, channel) {
  for (const key of [channel.id, channel.service])
    if (Object.hasOwn(values, key)) return values[key];
  return undefined;
}

/** @param {string} key a channel ID or a network name, as a job writes it */
const matches = (key, channel) => channel.id === key || channel.service === key;

/**
 * Whether the job means this channel: every channel when it names none.
 * @param {{ channels?: string[] }} job
 * @param {{ id: string, service?: string }} channel
 */
export function selectsChannel(job, channel) {
  return !job.channels || job.channels.some((key) => matches(key, channel));
}

/**
 * The session's channels this job posts to. A name that matches nothing is a
 * mistake in the job, so nothing is sent until it is fixed.
 * @param {{ channels?: string[], channelText: object, channelTextFile: object, channelImage: object }} job
 * @param {Channel[]} available
 * @param {{ id: string, service?: string }[]} [absent] channels of an earlier
 *   send that the session no longer lists. A name in the job may still mean
 *   one of them, so it is no mistake; they are never among the result.
 * @returns {Channel[]}
 */
export function selectChannels(job, available, absent = []) {
  checkChannelList(available);

  const problems = [];
  let selected = available;
  if (job.channels) {
    const wanted = job.channels;
    for (const key of wanted)
      if (![...available, ...absent].some((channel) => matches(key, channel)))
        problems.push(`channels: "${key}" is not a channel of this session`);
    selected = available.filter((channel) =>
      wanted.some((key) => matches(key, channel)),
    );
  }
  const meant = [
    ...selected,
    ...absent.filter((channel) => selectsChannel(job, channel)),
  ];
  for (const name of ["channelText", "channelTextFile", "channelImage"])
    for (const key of Object.keys(job[name]))
      if (!meant.some((channel) => matches(key, channel)))
        problems.push(`${name}: "${key}" matches no selected channel`);

  if (problems.length > 0)
    throw new ClientError(
      "unknown-channel",
      `${problems.join("; ")}. The session has: ${available
        .map((channel) => `${channel.service} (${channel.id})`)
        .join(", ")}.`,
    );
  return selected;
}

/**
 * Refuses a session whose channel list the state file cannot hold.
 * @param {{ id: string }[]} available the channels of the session
 */
function checkChannelList(available) {
  // The state keeps one entry per channel id. An id listed twice would get two
  // request ids and two posts, so a session like that is refused as a whole.
  const repeated = available
    .map((channel) => channel.id)
    .filter((id, index, ids) => ids.indexOf(id) !== index);
  if (repeated.length > 0)
    throw new ClientError(
      "duplicate-channel",
      `The session lists a channel more than once: ${[...new Set(repeated)].join(", ")}. Nothing is sent until the Worker's channel list is fixed.`,
    );
  // The state file is a JSON object keyed by channel ID. A name that every
  // object inherits (constructor, __proto__, toString, ...) cannot be such a
  // key: it reads back as something that is no entry, and it does not survive
  // a round trip through the file. Such a session is refused as a whole.
  const inherited = available
    .map((channel) => channel.id)
    .filter((id) => id in Object.prototype);
  if (inherited.length > 0)
    throw new ClientError(
      "unusable-channel",
      `The session lists a channel whose ID cannot be a key of the state file: ${[...new Set(inherited)].join(", ")}. Nothing is sent until the Worker's channel list is fixed.`,
    );
}

/**
 * What one channel gets: its own text and image when the job has them.
 * @template T
 * @param {{ text: string, image: T, channelText: Record<string, string>, channelImage: Record<string, T> }} content
 * @param {Channel} channel
 */
export function channelContent(content, channel) {
  return {
    text: findOverride(content.channelText, channel) ?? content.text,
    image: findOverride(content.channelImage, channel) ?? content.image,
  };
}

/**
 * The state is keyed by channel ID, and it is cleared of both credentials
 * before it is written. An ID that carries a credential would be written
 * as something else, and the next run would not find its own entry. No
 * channel has such an ID, so a session that says so is refused before
 * anything is planned. (The network is one of a fixed list.)
 * @param {{ id: string, service: string }[]} channels the channels of the session
 * @param {{ clientId: string, clientSecret: string }} credentials
 */
export function checkChannelIds(channels, credentials) {
  const carrying = channels.filter((channel) =>
    [credentials.clientSecret, credentials.clientId].some((credential) =>
      channel.id.includes(credential),
    ),
  );
  if (carrying.length > 0)
    throw new ClientError(
      "unusable-channel",
      `The session lists a channel whose ID contains a credential of this service: ${carrying
        .map((channel) => `${channel.service} (${channel.id})`)
        .join(
          ", ",
        )}. Nothing is sent until the Worker's channel list is fixed.`,
    );
}
