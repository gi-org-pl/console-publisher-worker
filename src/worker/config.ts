import { channelsSchema, servicesSchema } from "../schemas/publishing";
import type { Channel, Env, Service } from "./types";

/** A server-owned allowlist; browser input never expands the available channels. */
export function loadChannels(env: Env): Channel[] {
  return channelsSchema.parse(JSON.parse(env.CHANNELS_JSON));
}

/** A server-owned allowlist of service tokens. Unset means no service may call the API. */
export function loadServices(env: Env): Service[] {
  return env.SERVICES_JSON
    ? servicesSchema.parse(JSON.parse(env.SERVICES_JSON))
    : [];
}
