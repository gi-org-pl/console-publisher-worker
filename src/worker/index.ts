import { error } from "./http";
import { logError } from "./log";
import { routeRequest } from "./router";
import type { Env } from "./types";

export type { Env } from "./types";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      return await routeRequest(request, env);
    } catch (cause) {
      logError("request-failed", cause, {
        path: new URL(request.url).pathname,
      });
      return error(
        "The publishing service is unavailable. Try again later.",
        503,
      );
    }
  },
};
