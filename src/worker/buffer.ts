import {
  bufferResultSchema,
  type PublishInput,
  postMediaIds,
} from "../schemas/publishing";
import { mediaUrl } from "./media";
import type { Channel, Env } from "./types";

const mutation = `mutation CreatePost($input: CreatePostInput!) {
  createPost(input: $input) {
    ... on PostActionSuccess { post { id } }
    ... on MutationError { message }
  }
}`;

/** Networks where Buffer rejects a post that has no channel-specific type. */
function channelMetadata(channel: Channel): object | undefined {
  switch (channel.service) {
    case "instagram":
      return { instagram: { type: "post", shouldShareToFeed: true } };
    case "facebook":
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

export function maxImages(channel: Channel): number {
  return MAX_IMAGES[channel.service] ?? 1;
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
  const metadata = channelMetadata(channel);
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
          text: input.text,
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
