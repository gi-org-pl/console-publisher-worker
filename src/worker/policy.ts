import {
  MIN_SCHEDULE_LEAD_MS,
  type PublishInput,
  SERVICE_MODES,
} from "../schemas/publishing";
import type { Channel, Operator } from "./types";

/**
 * Limits on what a service may publish. A service reads content that other
 * people control, so these hold on the server whatever the client asks for.
 * An operator signed in through Access is not restricted here.
 */

/** A service's own list can only narrow the server allowlist, never widen it. */
export function allowedChannels(
  operator: Operator,
  channels: Channel[],
): Channel[] {
  if (operator.kind !== "service" || !operator.channelIds) {
    return channels;
  }
  const { channelIds } = operator;
  return channels.filter((channel) => channelIds.includes(channel.id));
}

/** An allowlist, so a mode added later is closed to services until listed. */
export function modeAllowed(
  operator: Operator,
  mode: PublishInput["mode"],
): boolean {
  return (
    operator.kind === "user" ||
    (SERVICE_MODES as readonly string[]).includes(mode)
  );
}

export function minScheduleLeadMs(operator: Operator): number {
  return operator.kind === "service"
    ? operator.minScheduleLeadMs
    : MIN_SCHEDULE_LEAD_MS;
}
