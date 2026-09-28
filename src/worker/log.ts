type Fields = Record<string, unknown>;

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
