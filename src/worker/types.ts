import type { R2Bucket } from "@cloudflare/workers-types";
import type { z } from "zod";
import type { channelSchema } from "../schemas/publishing";

export interface Env {
  MEDIA: R2Bucket;
  BUFFER_API_KEY: string;
  ACCESS_TEAM_DOMAIN: string;
  ACCESS_AUD: string;
  APP_ORIGIN: string;
  CHANNELS_JSON: string;
}

export interface Operator {
  email: string;
  subject: string;
}

export type Channel = z.infer<typeof channelSchema>;
