import { z } from "zod";

export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
export const MAX_IMAGE_DIMENSION = 4096;
export const MIN_SCHEDULE_LEAD_MS = 60_000;
export const MAX_SCHEDULE_DAYS = 30;
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
/** The Client ID of a Cloudflare Access service token, as it appears in `common_name`. */
export const SERVICE_CLIENT_ID = /^[0-9a-f]{32}\.access$/;
export const serviceSchema = z
  .object({
    clientId: z.string().regex(SERVICE_CLIENT_ID),
    name: z.string().regex(/^[a-z0-9-]{1,40}$/),
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
