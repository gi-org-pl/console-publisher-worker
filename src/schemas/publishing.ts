import { z } from "zod";

export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
export const MAX_IMAGE_DIMENSION = 4096;
export const MIN_SCHEDULE_LEAD_MS = 60_000;
export const MAX_SCHEDULE_DAYS = 30;
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
export const sessionSchema = z.object({
  email: z.email(),
  channels: channelsSchema,
});
export const uploadSchema = z.object({ mediaId: z.uuid() });
export const publishInputSchema = z
  .object({
    requestId: z.uuid(),
    mediaId: z.uuid(),
    channelId: z.string().min(1),
    text: z.string().trim().min(1).max(5000),
    mode: z.enum(["addToQueue", "shareNow", "customScheduled"]),
    dueAt: z.iso.datetime().optional(),
  })
  .strict();
export const publishResultSchema = z.object({ postId: z.string().min(1) });
export const bufferResultSchema = z.object({
  data: z
    .object({
      createPost: z
        .object({
          post: z.object({ id: z.string().min(1) }).optional(),
          message: z.string().optional(),
        })
        .nullable(),
    })
    .nullish(),
  errors: z.array(z.object({ message: z.string() })).optional(),
});
export type PublishingSession = z.infer<typeof sessionSchema>;
export type PublishInput = z.infer<typeof publishInputSchema>;
