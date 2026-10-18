import { z } from "zod";

export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
export const MAX_IMAGE_DIMENSION = 4096;
/**
 * The largest video. It is also the request body limit of the Workers Free
 * and Pro plans, and far above a reel of the foundation (about 10 MB).
 */
export const MAX_VIDEO_BYTES = 100 * 1024 * 1024;
/** The latest frame a thumbnail may be taken from: an Instagram Reel is at most 15 minutes. */
export const MAX_THUMBNAIL_OFFSET_MS = 15 * 60 * 1000;
export const MIN_SCHEDULE_LEAD_MS = 60_000;
export const MAX_SCHEDULE_DAYS = 30;
/**
 * The most images one request may name. It is the limit of the network that
 * takes the most; the limit of each network is checked by the Worker.
 */
export const MAX_IMAGES_PER_POST = 20;
/** The longest text of a post. */
export const MAX_POST_TEXT = 5000;
/**
 * What a post can be published as. A story is there for a day and shows no
 * caption; a reel is a short video with a caption.
 */
export const POST_TYPES = ["post", "story", "reel"] as const;
/**
 * The only post types a service may create. A type added later is closed to
 * services until it is listed here. Reels are listed on purpose: the
 * foundation's bot queues them, within the same modes, lead time and channels.
 */
export const SERVICE_POST_TYPES = ["post", "story", "reel"] as const;
/** The only modes a service may use. Publishing immediately stays with a person. */
export const SERVICE_MODES = ["addToQueue", "customScheduled"] as const;
/** Time for a person to pull a service's scheduled post back in Buffer. */
export const SERVICE_MIN_SCHEDULE_LEAD_MINUTES = 120;
export const channelSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  service: z.enum([
    "facebook",
    "instagram",
    "linkedin",
    "threads",
    "bluesky",
    "mastodon",
    "twitter",
  ]),
});
export const channelsSchema = z.array(channelSchema).min(1);
const serviceNameSchema = z.string().regex(/^[a-z0-9-]{1,40}$/);
/** The Client ID of a Cloudflare Access service token, as it appears in `common_name`. */
export const SERVICE_CLIENT_ID = /^[0-9a-f]{32}\.access$/;
export const serviceSchema = z
  .object({
    clientId: z.string().regex(SERVICE_CLIENT_ID),
    name: serviceNameSchema,
    channelIds: z.array(z.string().min(1)).min(1).optional(),
    minScheduleLeadMinutes: z
      .number()
      .int()
      .min(MIN_SCHEDULE_LEAD_MS / 60_000)
      .max(MAX_SCHEDULE_DAYS * 24 * 60 - 1)
      .default(SERVICE_MIN_SCHEDULE_LEAD_MINUTES),
  })
  .strict();
export const servicesSchema = z.array(serviceSchema);
/** A session names who is calling: an operator by e-mail, a service by its configured name. */
export const sessionSchema = z.union([
  z.object({ email: z.email(), channels: channelsSchema }).strict(),
  z.object({ service: serviceNameSchema, channels: channelsSchema }).strict(),
]);
export const uploadSchema = z.object({ mediaId: z.uuid() });
/**
 * The media of a post: images, given either as `mediaIds`, an ordered list,
 * or as `mediaId`, the one image a post had before it could carry several; or
 * one video, as `videoId`. Exactly one of the three.
 */
export const publishInputSchema = z
  .object({
    requestId: z.uuid(),
    mediaId: z.uuid().optional(),
    mediaIds: z.array(z.uuid()).min(1).max(MAX_IMAGES_PER_POST).optional(),
    videoId: z.uuid().optional(),
    channelId: z.string().min(1),
    /** Left out for a story, which shows no caption; required for a post and a reel. */
    text: z.string().trim().min(1).max(MAX_POST_TEXT).optional(),
    /** Left out means "post". */
    type: z.enum(POST_TYPES).optional(),
    /** Whether an Instagram reel shows in the feed too. Left out means it does. */
    shareToFeed: z.boolean().optional(),
    /** The frame of the video Instagram shows as its thumbnail, in milliseconds. */
    thumbnailOffset: z
      .number()
      .int()
      .min(0)
      .max(MAX_THUMBNAIL_OFFSET_MS)
      .optional(),
    mode: z.enum(["addToQueue", "shareNow", "customScheduled"]),
    dueAt: z.iso.datetime().optional(),
  })
  .strict()
  .refine((input) => (input.type === "story") === (input.text === undefined), {
    message: "A post and a reel need a text; a story is sent without one.",
    path: ["text"],
  })
  .refine(
    (input) =>
      [input.mediaId, input.mediaIds, input.videoId].filter(
        (media) => media !== undefined,
      ).length === 1,
    { message: 'Give one of "mediaId", "mediaIds" or "videoId".' },
  )
  .refine(
    (input) => new Set(input.mediaIds).size === (input.mediaIds?.length ?? 0),
    { message: "An image is listed twice.", path: ["mediaIds"] },
  )
  .refine((input) => input.type !== "reel" || input.videoId !== undefined, {
    message: "A reel takes one video and no images.",
    path: ["videoId"],
  })
  .refine((input) => input.type !== "story" || input.videoId === undefined, {
    message: "A story takes an image, not a video.",
    path: ["videoId"],
  })
  .refine((input) => input.shareToFeed === undefined || input.type === "reel", {
    message: '"shareToFeed" is for a reel only.',
    path: ["shareToFeed"],
  })
  .refine(
    (input) =>
      input.thumbnailOffset === undefined || input.videoId !== undefined,
    {
      message: '"thumbnailOffset" is for a video only.',
      path: ["thumbnailOffset"],
    },
  );
/**
 * `dueAt` is when Buffer means to publish the post: the chosen time, or the
 * queue slot Buffer gave it. Null when Buffer named none.
 */
export const publishResultSchema = z.object({
  postId: z.string().min(1),
  dueAt: z.string().nullish(),
});
/** What Buffer says about a post. Its statuses are listed in `PostStatus`. */
const bufferPostSchema = z.object({
  id: z.string().min(1),
  status: z.string().nullish(),
  dueAt: z.string().nullish(),
  sentAt: z.string().nullish(),
});
const bufferErrorsSchema = z
  .array(
    z.object({
      message: z.string(),
      extensions: z.object({ code: z.string().optional() }).optional(),
    }),
  )
  .optional();
export const bufferResultSchema = z.object({
  data: z
    .object({
      createPost: z
        .object({
          post: bufferPostSchema.optional(),
          message: z.string().optional(),
        })
        .nullable(),
    })
    .nullish(),
  errors: bufferErrorsSchema,
});
export const bufferPostResultSchema = z.object({
  data: z.object({ post: bufferPostSchema.nullish() }).nullish(),
  errors: bufferErrorsSchema,
});
export type BufferPost = z.infer<typeof bufferPostSchema>;

/** The longest text of a Discord announcement; it is a short version of the post. */
export const ANNOUNCEMENT_MAX_TEXT = 1000;
/** Images of one announcement: one landscape graphic, or a few squares. */
export const ANNOUNCEMENT_MAX_IMAGES = 4;
/** Posts one announcement may belong to: one per channel of the same post. */
export const ANNOUNCEMENT_MAX_POSTS = 10;
const uniqueIds = (ids: string[]) => new Set(ids).size === ids.length;
/**
 * An announcement names its posts by the request IDs they were created with,
 * so the Worker finds them in its own receipts: it knows who created each one
 * and which Buffer post it became.
 */
export const announcementInputSchema = z
  .object({
    requestId: z.uuid(),
    text: z.string().trim().min(1).max(ANNOUNCEMENT_MAX_TEXT),
    mediaIds: z
      .array(z.uuid())
      .min(1)
      .max(ANNOUNCEMENT_MAX_IMAGES)
      .refine(uniqueIds, "An image is listed twice."),
    postRequestIds: z
      .array(z.uuid())
      .min(1)
      .max(ANNOUNCEMENT_MAX_POSTS)
      .refine(uniqueIds, "A post is listed twice."),
    /**
     * The text the posts were queued with. When given, every post has to
     * carry it, so a changed post under an old request ID is not announced.
     */
    postText: z.string().trim().min(1).max(MAX_POST_TEXT).optional(),
    /**
     * Images uploaded with the same content as the posts', in order. When
     * given, every post has to carry the same images (compared by R2 etag),
     * so a post whose images changed under an old request ID is not announced.
     */
    postMediaIds: z.array(z.uuid()).min(1).max(MAX_IMAGES_PER_POST).optional(),
    /**
     * A video uploaded with the same content as the posts'. The same check
     * as `postMediaIds`, for posts that carry a video; never both.
     */
    postVideoId: z.uuid().optional(),
  })
  .strict()
  .refine(
    (input) =>
      input.postMediaIds === undefined || input.postVideoId === undefined,
    { message: 'Give "postMediaIds" or "postVideoId", not both.' },
  );
export type AnnouncementInput = z.infer<typeof announcementInputSchema>;
export type PublishingSession = z.infer<typeof sessionSchema>;
export type PublishInput = z.infer<typeof publishInputSchema>;

export type PostType = (typeof POST_TYPES)[number];

export function postType(input: PublishInput): PostType {
  return input.type ?? "post";
}

/** The images of a post, in the order they are shown. */
export function postMediaIds(input: PublishInput): string[] {
  return input.mediaIds ?? (input.mediaId ? [input.mediaId] : []);
}
