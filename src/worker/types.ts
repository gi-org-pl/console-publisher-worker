import type { R2Bucket } from "@cloudflare/workers-types";
import type { z } from "zod";
import type { channelSchema, serviceSchema } from "../schemas/publishing";

export interface Env {
  MEDIA: R2Bucket;
  BUFFER_API_KEY: string;
  ACCESS_TEAM_DOMAIN: string;
  ACCESS_AUD: string;
  APP_ORIGIN: string;
  CHANNELS_JSON: string;
  SERVICES_JSON?: string;
}

/** What a verified Access token proves, before the service allowlist is applied. */
export type Identity =
  | { kind: "user"; email: string; subject: string }
  | { kind: "service"; clientId: string };

/** A person signed in through Access. */
export interface UserOperator {
  kind: "user";
  email: string;
  subject: string;
}

/** An allowlisted automation authenticated with an Access service token. */
export interface ServiceOperator {
  kind: "service";
  name: string;
  subject: string;
  minScheduleLeadMs: number;
  /** When set, the only channels this service may use. */
  channelIds?: string[];
}

export type Operator = UserOperator | ServiceOperator;

export type Channel = z.infer<typeof channelSchema>;
export type Service = z.infer<typeof serviceSchema>;
