import { logError } from "./log";
import { imageKey } from "./media";
import type { Env } from "./types";

// Posts an announcement through a Discord channel webhook. The webhook URL is
// a secret (anyone holding it can post to the channel), so it is never logged.

const WEBHOOK_HOSTS = [
  "discord.com",
  "discordapp.com",
  "canary.discord.com",
  "ptb.discord.com",
];
const WEBHOOK_PATH = /^\/api\/webhooks\/\d+\/[\w-]+$/;

/** The webhook to post to, or undefined when the secret is unset or not a Discord webhook. */
export function webhookUrl(value: string | undefined): URL | undefined {
  if (!value) {
    return undefined;
  }
  try {
    const url = new URL(value.trim());
    if (
      url.protocol !== "https:" ||
      !WEBHOOK_HOSTS.includes(url.hostname) ||
      !WEBHOOK_PATH.test(url.pathname) ||
      url.search ||
      url.hash
    ) {
      return undefined;
    }
    // `wait` makes Discord answer with the message, whose ID goes into the receipt.
    url.searchParams.set("wait", "true");
    return url;
  } catch {
    return undefined;
  }
}

export type DiscordResult =
  | { outcome: "posted"; messageId?: string }
  /** Discord answered and did not post: safe to try again. */
  | { outcome: "refused"; reason: string }
  /** No clear answer: the message may exist, so it must not be sent again. */
  | { outcome: "unknown"; reason: string };

/**
 * One message with the text and the images as attachments, read from R2.
 * Mentions are switched off, so a text that contains `@everyone` or a role
 * pings no one. A failed read throws; the caller builds the message before it
 * takes the lock, so nothing is left half sent.
 */
export async function discordMessage(
  env: Env,
  announcement: { id: string; text: string; mediaIds: string[] },
): Promise<FormData> {
  const form = new FormData();
  const attachments: { id: number; filename: string }[] = [];
  for (const mediaId of announcement.mediaIds) {
    const object = await env.MEDIA.get(imageKey(mediaId));
    if (!object) {
      // An image that expired does not hold back the text.
      logError("announcement-image-missing", new Error("Image not in R2"), {
        announcementId: announcement.id,
        mediaId,
      });
      continue;
    }
    const id = attachments.length;
    const filename = `announcement-${id + 1}.png`;
    attachments.push({ id, filename });
    form.append(
      `files[${id}]`,
      new Blob([await object.arrayBuffer()], { type: "image/png" }),
      filename,
    );
  }
  form.append(
    "payload_json",
    JSON.stringify({
      content: announcement.text,
      allowed_mentions: { parse: [] },
      attachments,
    }),
  );
  return form;
}

/** Sends a message built by `discordMessage` to the webhook. */
export async function postToDiscord(
  webhook: URL,
  form: FormData,
): Promise<DiscordResult> {
  let response: Response;
  try {
    response = await fetch(webhook, {
      method: "POST",
      body: form,
      signal: AbortSignal.timeout(25_000),
    });
  } catch (cause) {
    return {
      outcome: "unknown",
      reason: cause instanceof Error ? cause.message : String(cause),
    };
  }

  if (response.ok) {
    const message = (await response.json().catch(() => undefined)) as
      | { id?: unknown }
      | undefined;
    return {
      outcome: "posted",
      ...(typeof message?.id === "string" ? { messageId: message.id } : {}),
    };
  }
  const reason = `Discord HTTP ${response.status}`;
  // A server error can come after Discord stored the message.
  return response.status >= 500
    ? { outcome: "unknown", reason }
    : { outcome: "refused", reason };
}
