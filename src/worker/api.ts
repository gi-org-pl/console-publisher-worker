import { loadChannels } from "./config";
import { error, json } from "./http";
import { uploadMedia } from "./media";
import { allowedChannels } from "./policy";
import { createPost } from "./posts";
import type { Env, Operator } from "./types";

interface ApiContext {
  request: Request;
  url: URL;
  env: Env;
  operator: Operator;
}

interface Endpoint {
  method: "GET" | "POST";
  handle: (context: ApiContext) => Promise<Response> | Response;
}

function sessionIdentity(operator: Operator) {
  return operator.kind === "user"
    ? { email: operator.email }
    : { service: operator.name };
}

function finishLogin({ url, env, operator }: ApiContext): Response {
  if (operator.kind !== "user") {
    return error("Browser login is for operators only.", 403);
  }

  const state = url.searchParams.get("state");
  if (!state || !/^[0-9a-f-]{36}$/.test(state)) {
    return error("Invalid login identifier.", 400);
  }

  return Response.redirect(`${env.APP_ORIGIN}/buffer-auth#${state}`, 302);
}

export const endpoints: Record<string, Endpoint> = {
  "/api/buffer/login": {
    method: "GET",
    handle: finishLogin,
  },
  "/api/buffer/session": {
    method: "GET",
    handle: ({ env, operator }) =>
      json({
        ...sessionIdentity(operator),
        channels: allowedChannels(operator, loadChannels(env)),
      }),
  },
  "/api/buffer/media": {
    method: "POST",
    handle: ({ request, env, operator }) => uploadMedia(request, env, operator),
  },
  "/api/buffer/posts": {
    method: "POST",
    handle: ({ request, env, operator }) =>
      createPost(
        request,
        env,
        operator,
        allowedChannels(operator, loadChannels(env)),
      ),
  },
};
