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
const serviceNameSchema = z.string().regex(/^[a-z0-9-]{1,40}$/);
/** The Client ID of a Cloudflare Access service token, as it appears in `common_name`. */
export const SERVICE_CLIENT_ID = /^[0-9a-f]{32}\.access$/;
export const serviceSchema = z
  .object({
    clientId: z.string().regex(SERVICE_CLIENT_ID),
    name: serviceNameSchema,
  })
  .strict();
export const servicesSchema = z.array(serviceSchema);
/** A session names who is calling: an operator by e-mail, a service by its configured name. */
export const sessionSchema = z.union([
  z.object({ email: z.email(), channels: channelsSchema }).strict(),
  z.object({ service: serviceNameSchema, channels: channelsSchema }).strict(),
]);
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
