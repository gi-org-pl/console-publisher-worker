import {
  type BufferPost,
  bufferPostResultSchema,
  bufferResultSchema,
  type PostType,
  type PublishInput,
  postMediaIds,
  postType,
} from "../schemas/publishing";
import { mediaUrl } from "./media";
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

/** Networks where Buffer rejects a post that has no channel-specific type. */
function channelMetadata(channel: Channel, type: PostType): object | undefined {
  switch (channel.service) {
    case "instagram":
      // A story is not a feed post, so it is not shared to the feed.
      return { instagram: { type, shouldShareToFeed: type === "post" } };
    case "facebook":
      // Always a feed post: a story for Facebook is refused before this.
      return { facebook: { type: "post" } };
    default:
      return undefined;
  }
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
  // One entry per image, in the order given: Buffer shows them in that order.
  const assets = postMediaIds(input).map((mediaId) => ({
    image: { url: mediaUrl(env, mediaId) },
  }));
  const metadata = channelMetadata(channel, postType(input));
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
