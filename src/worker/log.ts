import type { Operator } from "./types";

type Fields = Record<string, unknown>;

/** Who made the call, so a log line shows whether a person or a service acted. */
export function actorFields(operator: Operator): Fields {
  return operator.kind === "user"
    ? { actor: "user", email: operator.email }
    : { actor: "service", service: operator.name };
}

/** One JSON line per event. Never pass request headers, tokens or the Buffer key. */
export function logEvent(action: string, fields: Fields = {}): void {
  console.info(JSON.stringify({ action, ...fields }));
}

export function logError(
  action: string,
  cause: unknown,
  fields: Fields = {},
): void {
  console.error(
    JSON.stringify({
      action,
      ...fields,
      error:
        cause instanceof Error ? `${cause.name}: ${cause.message}` : `${cause}`,
    }),
  );
}
