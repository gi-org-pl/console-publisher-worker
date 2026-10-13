import {
  bufferResultSchema,
  type PostType,
  type PublishInput,
  postMediaIds,
  postType,
} from "../schemas/publishing";
import { mediaUrl } from "./media";
import type { Channel, Env } from "./types";

const mutation = `mutation CreatePost($input: CreatePostInput!) {
  createPost(input: $input) {
    ... on PostActionSuccess { post { id } }
    ... on MutationError { message }
  }
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

/** Send one mutation. Callers must reserve its request ID before invoking this. */
export async function createBufferPost(
  env: Env,
  input: PublishInput,
  channel: Channel,
): Promise<string> {
  // One entry per image, in the order given: Buffer shows them in that order.
  const assets = postMediaIds(input).map((mediaId) => ({
    image: { url: mediaUrl(env, mediaId) },
  }));
  const metadata = channelMetadata(channel, postType(input));
  const response = await fetch("https://api.buffer.com", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${env.BUFFER_API_KEY}`,
    },
    signal: AbortSignal.timeout(25_000),
    body: JSON.stringify({
      query: mutation,
      variables: {
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
      },
    }),
  });
  if (!response.ok) {
    throw new Error(`Buffer HTTP ${response.status}`);
  }

  const result = bufferResultSchema.parse(await response.json());
  const postId = result.data?.createPost?.post?.id;
  if (!postId) {
    const reason =
      result.data?.createPost?.message ??
      result.errors?.[0]?.message ??
      "no post ID";
    throw new Error(`Buffer did not confirm creation: ${reason}`);
  }
  return postId;
}
