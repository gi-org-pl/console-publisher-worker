import {
  type BufferPost,
  bufferPostResultSchema,
  bufferResultSchema,
  type PostType,
  type PublishInput,
  postMediaIds,
  postType,
} from "../schemas/publishing";
import { mediaUrl, videoUrl } from "./media";
import type { Channel, Env } from "./types";

const BUFFER_API = "https://api.buffer.com";

// `dueAt` and `status` are fields of Buffer's `Post` type: the time Buffer
// means to publish (also a queue slot it picked) and where the post stands.
const mutation = `mutation CreatePost($input: CreatePostInput!) {
  createPost(input: $input) {
    ... on PostActionSuccess { post { id dueAt status } }
    ... on MutationError { message }
  }
}`;

const postQuery = `query Post($input: PostInput!) {
  post(input: $input) { id status dueAt sentAt }
}`;

/**
 * The networks a story can be sent to; Buffer takes the type in their
 * metadata. Facebook is not one of them: Buffer publishes a story to a
 * Facebook Page only through a notification on a phone, which the Worker does
 * not use.
 */
const STORY_SERVICES: readonly Channel["service"][] = ["instagram"];

export function hasStories(channel: Channel): boolean {
  return STORY_SERVICES.includes(channel.service);
}

/** The networks a reel can be sent to; Buffer takes the type in their metadata. */
const REEL_SERVICES: readonly Channel["service"][] = ["instagram", "facebook"];

export function hasReels(channel: Channel): boolean {
  return REEL_SERVICES.includes(channel.service);
}

/**
 * The types a video can go out as, per network. On Instagram and Facebook a
 * video is a reel: Instagram shows every video as one, and a video in a
 * Facebook feed post was not asked for and not tried. LinkedIn has no post
 * types, so a video there is a post. A network that is not listed takes no
 * video until its rules are looked up.
 */
const VIDEO_TYPES: Partial<Record<Channel["service"], readonly PostType[]>> = {
  instagram: ["reel"],
  facebook: ["reel"],
  linkedin: ["post"],
};

export function videoTypes(channel: Channel): readonly PostType[] {
  return VIDEO_TYPES[channel.service] ?? [];
}

/** Networks where Buffer rejects a post that has no channel-specific type. */
function channelMetadata(
  channel: Channel,
  input: PublishInput,
): object | undefined {
  const type = postType(input);
  switch (channel.service) {
    case "instagram":
      // A story is not a feed post, so it is not shared to the feed; a reel
      // is, unless the post says otherwise.
      return {
        instagram: {
          type,
          shouldShareToFeed:
            type === "post" || (type === "reel" && input.shareToFeed !== false),
        },
      };
    case "facebook":
      // A feed post or a reel: a story for Facebook is refused before this.
      return { facebook: { type: type === "reel" ? "reel" : "post" } };
    default:
      return undefined;
  }
}

/**
 * The media of a post as Buffer takes it: one asset per image, in the order
 * given (Buffer shows them in that order), or the one video. Buffer takes a
 * thumbnail offset on Instagram only (and TikTok and Pinterest, which the
 * Worker does not serve), so it is left out elsewhere.
 */
function postAssets(env: Env, input: PublishInput, channel: Channel) {
  if (input.videoId) {
    const offset =
      input.thumbnailOffset !== undefined && channel.service === "instagram"
        ? { metadata: { thumbnailOffset: input.thumbnailOffset } }
        : {};
    return [{ video: { url: videoUrl(env, input.videoId), ...offset } }];
  }
  return postMediaIds(input).map((mediaId) => ({
    image: { url: mediaUrl(env, mediaId) },
  }));
}

/**
 * How many images one post may carry, per network. Instagram (a carousel) and
 * LinkedIn are the numbers Buffer's help pages gave on 2026-10-12. Buffer names
 * none for Facebook, so it gets the lower of the two. A network that is not
 * listed keeps to one image until its limit is looked up.
 */
const MAX_IMAGES: Partial<Record<Channel["service"], number>> = {
  instagram: 10,
  facebook: 10,
  linkedin: 20,
};

export function maxImages(channel: Channel, type: PostType = "post"): number {
  // A story is one image here: several would be several frames, which was not
  // asked for and not tried.
  return type === "story" ? 1 : (MAX_IMAGES[channel.service] ?? 1);
}

function bufferRequest(env: Env, query: string, variables: object) {
  return fetch(BUFFER_API, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${env.BUFFER_API_KEY}`,
    },
    signal: AbortSignal.timeout(25_000),
    body: JSON.stringify({ query, variables }),
  });
}

/** The post Buffer created: its ID, and when and how Buffer means to send it. */
export interface CreatedPost {
  postId: string;
  dueAt: string | null;
  status: string | null;
}

/** Send one mutation. Callers must reserve its request ID before invoking this. */
export async function createBufferPost(
  env: Env,
  input: PublishInput,
  channel: Channel,
): Promise<CreatedPost> {
  const assets = postAssets(env, input, channel);
  const metadata = channelMetadata(channel, input);
  const response = await bufferRequest(env, mutation, {
    input: {
      channelId: channel.id,
      ...(input.text === undefined ? {} : { text: input.text }),
      mode: input.mode,
      ...(input.dueAt ? { dueAt: input.dueAt } : {}),
      schedulingType: "automatic",
      needsApproval: false,
      saveToDraft: false,
      assets,
      ...(metadata ? { metadata } : {}),
    },
  });
  if (!response.ok) {
    throw new Error(`Buffer HTTP ${response.status}`);
  }

  const result = bufferResultSchema.parse(await response.json());
  const post = result.data?.createPost?.post;
  if (!post) {
    const reason =
      result.data?.createPost?.message ??
      result.errors?.[0]?.message ??
      "no post ID";
    throw new Error(`Buffer did not confirm creation: ${reason}`);
  }
  return {
    postId: post.id,
    dueAt: post.dueAt ?? null,
    status: post.status ?? null,
  };
}

/**
 * Where a post stands now. `post` returns a non-null `Post`, so Buffer reports
 * a post that does not exist (deleted, or never there) as an error with the
 * code `NOT_FOUND`; that is the one answer read as "missing". Any other error
 * throws, so the caller tries again later instead of guessing.
 */
export async function readBufferPost(
  env: Env,
  postId: string,
): Promise<{ found: true; post: BufferPost } | { found: false }> {
  const response = await bufferRequest(env, postQuery, {
    input: { id: postId },
  });
  if (!response.ok) {
    throw new Error(`Buffer HTTP ${response.status}`);
  }
  const result = bufferPostResultSchema.parse(await response.json());
  const post = result.data?.post;
  if (post) {
    return { found: true, post };
  }
  if (result.errors?.some((entry) => entry.extensions?.code === "NOT_FOUND")) {
    return { found: false };
  }
  throw new Error(
    `Buffer did not return the post: ${result.errors?.[0]?.message ?? "no post"}`,
  );
}
