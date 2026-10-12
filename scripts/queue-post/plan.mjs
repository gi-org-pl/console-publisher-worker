import { createHash } from "node:crypto";
import { publishInputSchema } from "../../src/schemas/publishing.ts";
import { invalidJob } from "./errors.mjs";

// What each channel of a run gets, and under which request ID.

/** The request ID of a channel: the same for every run of the same post. */
function requestId(clientId, name, channelId) {
  const hash = createHash("sha256")
    .update(`${clientId}\n${name}\n${channelId}`)
    .digest("hex");
  const variant = "89ab"[Number.parseInt(hash[16], 16) & 3];
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-8${hash.slice(13, 16)}-${variant}${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
}

/** What each selected channel gets. Everything a request needs but the media ID is checked here. */
export function plan(job, channels, token) {
  const matches = (key, channel) =>
    key === channel.id || key === channel.service;
  const strangers = [
    ...(job.channels ?? []),
    ...Object.keys(job.overrides),
  ].filter((key) => !channels.some((channel) => matches(key, channel)));
  if (strangers.length > 0)
    throw invalidJob(
      `Not a channel of this session: ${strangers.join(", ")}. The session has: ${channels
        .map((channel) => `${channel.service} (${channel.id})`)
        .join(", ")}.`,
    );
  return channels
    .filter(
      (channel) =>
        !job.channels || job.channels.some((key) => matches(key, channel)),
    )
    .map((channel) => {
      // An override for the channel itself comes before one for its network.
      const own = {
        ...job.overrides[channel.service],
        ...job.overrides[channel.id],
      };
      const entry = {
        channel,
        requestId: requestId(token.clientId, job.name, channel.id),
        text: own.text ?? job.text,
        image: own.image ?? job.image,
      };
      const probe = publishInputSchema.safeParse(body(entry, entry.requestId));
      if (!probe.success)
        throw invalidJob(
          `The post for ${channel.service} (${channel.id}) would be refused: ${probe.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ")}.`,
        );
      // A text goes out as it is: one that holds the token would publish it.
      if (
        [token.clientId, token.clientSecret].some((value) =>
          entry.text.includes(value),
        )
      )
        throw invalidJob(
          `The text for ${channel.service} (${channel.id}) contains the service token. Nothing was sent.`,
        );
      return entry;
    });
}

export const body = ({ channel, requestId: id, text }, mediaId) => ({
  requestId: id,
  mediaId,
  channelId: channel.id,
  text,
  mode: "addToQueue",
});
