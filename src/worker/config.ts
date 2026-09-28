import { channelsSchema } from "../schemas/publishing";
import type { Channel, Env } from "./types";

/** A server-owned allowlist; browser input never expands the available channels. */
export function loadChannels(env: Env): Channel[] {
  return channelsSchema.parse(JSON.parse(env.CHANNELS_JSON));
}
