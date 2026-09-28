import { bufferResultSchema, type PublishInput } from "../schemas/publishing";
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

/** Send one mutation. Callers must reserve its request ID before invoking this. */
export async function createBufferPost(
  env: Env,
  input: PublishInput,
  channel: Channel,
): Promise<string> {
  const imageUrl = mediaUrl(env, input.mediaId);
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
          assets: [{ image: { url: imageUrl } }],
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
