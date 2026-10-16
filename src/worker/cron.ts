import {
  ANNOUNCEMENT_PREFIX,
  type AnnouncedPost,
  type Announcement,
  type AnnouncementStatus,
  announcementSchema,
  earliestDueAt,
  writeAnnouncement,
} from "./announcements";
import { readBufferPost } from "./buffer";
import { discordMessage, postToDiscord, webhookUrl } from "./discord";
import { logError, logEvent } from "./log";
import type { Env } from "./types";

// The scheduled run behind Discord announcements. A Cron Trigger starts it
// (`triggers.crons` in wrangler.jsonc); each run looks at the pending
// announcements, asks Buffer about their posts and posts an announcement once
// the first of its posts has gone out. Nothing here is retried within a run:
// what fails is logged and looked at again by the next run.

/** Outgoing requests one run may make; a Worker on the free plan has 50. */
const MAX_FETCHES_PER_RUN = 40;
/** A post that is not due yet is still looked up this often, in case it was moved earlier. */
const RECHECK_MS = 6 * 3_600_000;
/** A post can be scheduled 30 days ahead; an announcement waiting longer is given up. */
const MAX_PENDING_MS = 45 * 86_400_000;
/** Refused deliveries before an announcement is given up: a day of hourly runs. */
const MAX_ATTEMPTS = 24;
/**
 * R2 takes one write per second to the same key and answers 429 above that,
 * so the write after the Discord request keeps this distance from the lock.
 */
const WRITE_GAP_MS = 1_100;

const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

interface Run {
  env: Env;
  webhook: URL;
  now: number;
  fetchesLeft: number;
  wait: (ms: number) => Promise<void>;
}

/** The keys of pending announcements, from the status kept in their metadata. */
async function pendingKeys(env: Env): Promise<string[]> {
  const keys: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await env.MEDIA.list({
      prefix: ANNOUNCEMENT_PREFIX,
      include: ["customMetadata"],
      ...(cursor ? { cursor } : {}),
    });
    for (const object of page.objects) {
      if (object.customMetadata?.status === "pending") {
        keys.push(object.key);
      }
    }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return keys;
}

function context(announcement: Announcement) {
  return {
    announcementId: announcement.id,
    service: announcement.service,
    postIds: announcement.posts.map((post) => post.postId),
  };
}

/** Writes the next state only if nothing changed it since it was read. */
async function update(
  run: Run,
  announcement: Announcement,
  etag: string,
  changes: Partial<Announcement> & { status: AnnouncementStatus },
) {
  const next = { ...announcement, ...changes };
  const written = await writeAnnouncement(run.env, next, etag);
  if (!written) {
    logEvent("announcement-changed-meanwhile", context(announcement));
  }
  return written && { announcement: next, etag: written.etag };
}

/** Asks Buffer about every post of the announcement; a post Buffer no longer has is `deleted`. */
async function currentPosts(
  run: Run,
  posts: AnnouncedPost[],
): Promise<AnnouncedPost[]> {
  const current: AnnouncedPost[] = [];
  for (const post of posts) {
    run.fetchesLeft -= 1;
    const result = await readBufferPost(run.env, post.postId);
    current.push(
      result.found
        ? {
            ...post,
            status: result.post.status ?? null,
            dueAt: result.post.dueAt ?? post.dueAt ?? null,
          }
        : { ...post, status: "deleted" },
    );
  }
  return current;
}

/**
 * The write that records what Discord answered. It comes at least a second
 * after the lock, and is tried once more a second later if R2 refuses it:
 * without it the announcement would stay `sending` for good.
 */
async function finish(
  run: Run,
  locked: { announcement: Announcement; etag: string },
  lockedAt: number,
  changes: Partial<Announcement> & { status: AnnouncementStatus },
) {
  await run.wait(Math.max(0, WRITE_GAP_MS - (Date.now() - lockedAt)));
  try {
    return await update(run, locked.announcement, locked.etag, changes);
  } catch (cause) {
    logError("announcement-write-retried", cause, {
      ...context(locked.announcement),
      status: changes.status,
    });
    await run.wait(WRITE_GAP_MS);
    return update(run, locked.announcement, locked.etag, changes);
  }
}

async function deliver(
  run: Run,
  announcement: Announcement,
  etag: string,
  sentPost: AnnouncedPost,
) {
  // Built first: a failed image read then leaves the announcement pending
  // for the next run instead of locked.
  const message = await discordMessage(run.env, announcement);
  // Taken before Discord is called, so a run that overlaps this one cannot
  // send it too: its write would find another etag.
  const locked = await update(run, announcement, etag, {
    status: "sending",
    attempts: announcement.attempts + 1,
  });
  if (!locked) {
    return;
  }
  const lockedAt = Date.now();

  run.fetchesLeft -= 1;
  const result = await postToDiscord(run.webhook, message);
  const at = new Date(run.now).toISOString();
  const fields = { ...context(announcement), afterPostId: sentPost.postId };

  if (result.outcome === "posted") {
    await finish(run, locked, lockedAt, {
      status: "posted",
      posted: {
        ...(result.messageId ? { messageId: result.messageId } : {}),
        postedAt: at,
        afterPostId: sentPost.postId,
      },
      closedAt: at,
      lastError: undefined,
    });
    logEvent("discord-announcement-posted", {
      ...fields,
      messageId: result.messageId,
    });
    return;
  }

  if (result.outcome === "unknown") {
    // The message may be on Discord; sending again could post it twice.
    await finish(run, locked, lockedAt, {
      status: "unconfirmed",
      lastError: result.reason,
      closedAt: at,
    });
    logError("discord-announcement-unconfirmed", new Error(result.reason), {
      ...fields,
    });
    return;
  }

  const givenUp = locked.announcement.attempts >= MAX_ATTEMPTS;
  await finish(run, locked, lockedAt, {
    status: givenUp ? "failed" : "pending",
    lastError: result.reason,
    ...(givenUp ? { closedAt: at } : {}),
  });
  logError("discord-announcement-failed", new Error(result.reason), {
    ...fields,
    attempts: locked.announcement.attempts,
    willRetry: !givenUp,
  });
}

/** One announcement. Returns false when this run has no requests left for it. */
async function processAnnouncement(run: Run, key: string): Promise<boolean> {
  const object = await run.env.MEDIA.get(key);
  if (!object) {
    return true;
  }
  const announcement = announcementSchema.parse(await object.json());
  if (announcement.status !== "pending") {
    return true;
  }
  const at = new Date(run.now).toISOString();

  if (run.now - Date.parse(announcement.createdAt) > MAX_PENDING_MS) {
    await update(run, announcement, object.etag, {
      status: "expired",
      closedAt: at,
    });
    logEvent("announcement-expired", context(announcement));
    return true;
  }

  // Not due yet: Buffer is not asked, unless the last look is old enough
  // that the post may have been moved earlier.
  const dueAt = earliestDueAt(announcement.posts);
  const lastCheck = Date.parse(
    announcement.checkedAt ?? announcement.createdAt,
  );
  if (
    dueAt &&
    Date.parse(dueAt) > run.now &&
    run.now - lastCheck < RECHECK_MS
  ) {
    return true;
  }

  if (run.fetchesLeft < announcement.posts.length + 1) {
    return false;
  }
  const posts = await currentPosts(run, announcement.posts);
  const looked = { ...announcement, posts, checkedAt: at };

  const sent = posts.find((post) => post.status === "sent");
  if (sent) {
    await deliver(run, looked, object.etag, sent);
    return true;
  }

  if (
    posts.every((post) => post.status === "deleted" || post.status === "error")
  ) {
    await update(run, looked, object.etag, {
      status: "cancelled",
      closedAt: at,
    });
    logEvent("announcement-cancelled", {
      ...context(announcement),
      statuses: posts.map((post) => post.status),
    });
    return true;
  }

  // Still waiting, possibly at a new time: keep what Buffer said.
  await update(run, looked, object.etag, { status: "pending" });
  return true;
}

/** The whole scheduled run. It never throws: a Cron Trigger has nobody to answer. */
export async function runAnnouncements(
  env: Env,
  now = Date.now(),
  wait: (ms: number) => Promise<void> = sleep,
): Promise<void> {
  const webhook = webhookUrl(env.DISCORD_ANNOUNCE_WEBHOOK_URL);
  if (!webhook || !env.BUFFER_API_KEY) {
    logEvent("announcements-not-configured", {
      webhook: env.DISCORD_ANNOUNCE_WEBHOOK_URL
        ? webhook
          ? "set"
          : "invalid"
        : "missing",
      buffer: env.BUFFER_API_KEY ? "set" : "missing",
    });
    return;
  }

  const run: Run = {
    env,
    webhook,
    now,
    fetchesLeft: MAX_FETCHES_PER_RUN,
    wait,
  };
  let keys: string[];
  try {
    keys = await pendingKeys(env);
  } catch (cause) {
    logError("announcements-list-failed", cause);
    return;
  }

  for (const [index, key] of keys.entries()) {
    try {
      if (!(await processAnnouncement(run, key))) {
        logEvent("announcements-deferred", { left: keys.length - index });
        return;
      }
    } catch (cause) {
      logError("announcement-check-failed", cause, { key });
    }
  }
}
