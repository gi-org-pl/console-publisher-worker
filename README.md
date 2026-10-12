# Console Publisher Worker

This repository contains an API-only Cloudflare Worker for Buffer publishing. The graphic editor and publishing controls live in the separate [console-app](https://github.com/gi-org-pl/console-app) repository. There is no HTML page or publishing form in this Worker.

Console calls these same-origin routes:

| Path | Access | Purpose |
| --- | --- | --- |
| `/api/buffer/login` | Operator only | Complete Access login, then return to Console |
| `/api/buffer/session` | Operator or allowlisted service | Caller identity and approved channels |
| `/api/buffer/media` | Operator or allowlisted service | Upload one generated PNG to private R2 |
| `/api/buffer/posts` | Operator or allowlisted service | Create one Buffer post |
| `/buffer-media/<uuid>.png` | Public read | Let Buffer fetch an uploaded image |

An operator is a person signed in through Cloudflare Access. A service is an automation that presents a Cloudflare Access service token; see [Service tokens for automation](#service-tokens-for-automation). Both go through the same Access application - there is no route that bypasses it.

The Buffer key exists only as a Worker secret. The `CHANNELS_JSON` setting is a server-side allowlist. Each post uses one PNG and one channel, with immediate publishing, the Buffer queue, or a scheduled time up to 30 days ahead. The image is not published until the operator submits the Console form. A service has a narrower set of options; see [Publishing restrictions](#publishing-restrictions).

## Buffer setup

1. Sign in to the Buffer account that owns the connected channels. Connect each intended social profile and configure its queue.
2. Create a personal API key under [Buffer Settings → API](https://publish.buffer.com/settings/api) with post creation permission. Keep the key out of Git, Console build variables, and chat.
3. Use the [Buffer API Explorer](https://developers.buffer.com/explorer.html) to obtain organization and channel IDs with read-only queries:

   ```graphql
   query { account { organizations { id name } } }
   ```

   ```graphql
   query {
     channels(input: { organizationId: "YOUR_ORGANIZATION_ID" }) {
       id
       name
       service
     }
   }
   ```

4. Put only approved channels in `CHANNELS_JSON`. The Worker supports `facebook`, `instagram`, `linkedin`, `threads`, `bluesky`, `mastodon`, and `twitter` service values. It sends Instagram and Facebook feed posts (Buffer requires a post type for both); Stories, Reels, videos, carousels, and other platform-specific metadata are not implemented.

Buffer Free has limits on channels, queued posts, API calls, and seats; verify the [current plan limits](https://buffer.com/pricing) before expanding use. This design uses one designated operator and one Buffer account/API key. Access identities do not become separate Buffer users.

## Cloudflare routing and Access

The Console remains public at `https://console.gi.org.pl` on GitHub Pages. Its DNS record must be **proxied through Cloudflare** for Workers Routes and Access to run. Keep the GitHub Pages custom domain and `CNAME` file in place, and check that the main Console still loads over HTTPS after switching the DNS record to proxied. A Worker Route attaches to that proxied hostname; it does not host or replace the Console site.

The `wrangler.jsonc` routes attach this Worker only to `/api/buffer/*` and `/buffer-media/*`. Update the hostname and zone there if your deployment differs. Disable `workers.dev` and preview URLs as configured, so the service has no alternate public entry point.

Create one **Self-hosted** Cloudflare Access application for `console.gi.org.pl/api/buffer/*`. Its Allow policy should name the designated operator's exact email. Choose your identity provider or email one-time PIN. Do not add an Everyone allow policy. Copy the application's Audience (AUD) tag into `ACCESS_AUD` and your HTTPS team domain into `ACCESS_TEAM_DOMAIN`. The Worker independently verifies the Access JWT signature, issuer, audience, expiry, and identity.

Do **not** protect `/buffer-media/*` with that Access application: Buffer must fetch PNGs without a browser cookie. The Worker allows only GET/HEAD for UUID PNG paths there. Anyone holding a media URL can read that image, so upload only publication-ready graphics. The private R2 bucket has no public bucket endpoint.

## Service tokens for automation

A trusted non-browser client (for example the foundation's bot, which prepares posts from briefs) can call `/api/buffer/session`, `/api/buffer/media` and `/api/buffer/posts` with a [Cloudflare Access service token](https://developers.cloudflare.com/cloudflare-one/access-controls/service-credentials/service-tokens/). The Worker keeps no secret of its own for this: Access checks the token, and the Worker checks the JWT that Access issues. A service has to pass two gates, and both are closed by default:

1. an Access policy on the `/api/buffer/*` application that admits that one service token, and
2. an entry for its Client ID in the Worker's `SERVICES_JSON` allowlist.

### Create a token

1. In the Cloudflare dashboard go to **Zero Trust** > **Access controls** > **Service credentials** > **Service Tokens** and select **Create Service Token**. Name it after the client, choose the shortest duration you can live with, and select **Generate token**.
2. Copy the Client ID and the Client Secret. The secret is shown only once. Store it in the client's secret store - never in Git, in `SERVICES_JSON`, or in chat. The Client ID is not a secret.
3. Open the existing Access application for `console.gi.org.pl/api/buffer/*` and add a second policy with the action **Service Auth** and one Include rule: selector **Service Token**, value the token you just created. Do not use **Any Access Service Token**, **Valid Certificate** or **Common Name** here, and do not create a separate application for the service. Leave the operator's Allow policy as it is.
4. Add the Client ID to `SERVICES_JSON` in `wrangler.jsonc` under a short name (lowercase letters, digits and hyphens), then deploy:

   ```json
   "SERVICES_JSON": "[{\"clientId\":\"0123456789abcdef0123456789abcdef.access\",\"name\":\"gieniek-bot\"}]"
   ```

The client then sends both headers with every request, and no `Origin` header:

```sh
curl https://console.gi.org.pl/api/buffer/session \
  -H "CF-Access-Client-Id: $CF_ACCESS_CLIENT_ID" \
  -H "CF-Access-Client-Secret: $CF_ACCESS_CLIENT_SECRET"
```

A service session returns `{ "service": "<name>", "channels": [...] }` instead of an operator `email`.

### What the Worker checks

The signature, issuer, audience and expiry checks are the same as for an operator. A service token JWT differs only in its identity claims, [as documented by Cloudflare](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/application-token/): `sub` is an empty string, there is no `email`, and `common_name` holds the Client ID. The Worker accepts exactly that shape (plus `type: "app"`) and refuses anything in between, such as a token that carries both an email and a `common_name`.

- A valid service token whose Client ID is not in `SERVICES_JSON` gets 403 and a `service-denied` log line with the Client ID.
- An unset or empty `SERVICES_JSON` admits no service. An invalid one fails closed with 503 for services only; operators are not affected.
- `/api/buffer/login` is a browser redirect and returns 403 to a service.
- Uploaded images belong to the identity that uploaded them. A service can only post its own uploads, and an operator cannot post a service's upload.
- Log lines for posts carry `"actor":"user"` with the operator's `email`, or `"actor":"service"` with the service name.

### Publishing restrictions

A service reads content that other people control - chat messages, issues, web pages - and someone can plant an instruction there. What it may publish is therefore limited in the Worker, whatever the client sends. None of this applies to an operator signed in through Access.

| Restriction | Behaviour | Configuration |
| --- | --- | --- |
| Modes | Only `addToQueue` and `customScheduled`. `shareNow` returns 403. | Fixed in code (`SERVICE_MODES`) |
| Lead time | A `customScheduled` post must be due at least 120 minutes from now, so a person has time to pull it back in Buffer. Earlier times return 400. Operators keep their one-minute minimum. | `minScheduleLeadMinutes` per service, 1 to 43199 |
| Channels | By default every channel in `CHANNELS_JSON`. With a list, only those channels are returned by `/api/buffer/session` and accepted by `/api/buffer/posts`; others return 403. The list can narrow `CHANNELS_JSON` but never add to it. | `channelIds` per service, optional |

Both settings live in the service's `SERVICES_JSON` entry. An unknown key or an out-of-range value makes the whole list invalid, which fails closed for services:

```json
"SERVICES_JSON": "[{\"clientId\":\"0123456789abcdef0123456789abcdef.access\",\"name\":\"gieniek-bot\",\"channelIds\":[\"BUFFER_CHANNEL_ID\"],\"minScheduleLeadMinutes\":120}]"
```

Every post a service creates is traceable: the `buffer-post-created` log line and the receipt in R2 (`receipts/<requestId>`) both carry the service name, and each refused request writes a `service-post-denied` log line with the request ID, channel, mode and reason. A burst of those lines is worth a look - it can mean the automation is being steered.

The lead time does not cover `addToQueue`: a queued post goes out at the channel's next Buffer slot, which can be minutes away. If that is too soon for a given service, keep the channel's queue paused or sparse in Buffer. The Buffer API can also save a post as a draft (`saveToDraft` on `createPost`), which never publishes until a person schedules it; the Worker does not use it yet.

### Origin header

POST requests from an operator must carry `Origin` equal to `APP_ORIGIN`. This is CSRF protection: a browser attaches the operator's Access cookie to cross-site requests on its own, and the `Origin` header is how the Worker tells such a request apart. A service token is different - the client has to add the credential headers itself, so a third-party page cannot trigger an authenticated request. A service may therefore omit `Origin`. If it does send one, it must still equal `APP_ORIGIN`, so a service identity can never be driven from another site's page.

### Revoke and rotate

- **Revoke now:** delete the token under **Service Tokens**. Access stops admitting it. Then remove its entry from `SERVICES_JSON` and deploy.
- **Suspend without touching Cloudflare:** remove the entry from `SERVICES_JSON` and deploy. The token still passes Access but the Worker answers 403.
- **Rotate the secret:** select the three dots next to the token > **Rotate secret**. The Client ID stays the same, so `SERVICES_JSON` does not change; update the secret on the client.
- **Expiry:** a token stops working at the end of its duration. **Refresh** or **Edit** it before then, or create a new token and replace the Client ID in `SERVICES_JSON`.

References: [Workers Routes](https://developers.cloudflare.com/workers/configuration/routing/routes/), [Access path applications](https://developers.cloudflare.com/cloudflare-one/access-controls/policies/app-paths/), [Access JWT validation](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/).

## Command-line client for services

`scripts/publishPost.mjs` queues or schedules a post as a service identity, from a job file. It needs no knowledge of the code: everything below is the whole interface. It runs on Node 24+ with the repository's dependencies installed (`yarn install --frozen-lockfile`) and takes the request contract and its limits from the Worker's own schema in `src/schemas/publishing.ts`.

```sh
node scripts/publishPost.mjs check
node scripts/publishPost.mjs queue job.json [--send]
node scripts/publishPost.mjs schedule job.json [--send]
```

| Command | What it does |
| --- | --- |
| `check` | Calls `/api/buffer/session` and prints the identity and the channels it may post to. Nothing else is sent. |
| `queue <job.json>` | One post per channel in mode `addToQueue`: it goes out at the channel's next Buffer slot. |
| `schedule <job.json>` | One post per channel in mode `customScheduled`, at the job's `dueAt`. |

There is no command for `shareNow`. `queue` and `schedule` are separate commands on purpose, so a permission rule can allow one without the other.

**Dry run by default.** Without `--send` the client validates the job, reads every file it names, asks for the session and prints what it would send to each channel. No upload and no post is sent. The state file is written also in a dry run, so the request IDs it prints are the ones a later `--send` uses.

| Option | Meaning |
| --- | --- |
| `--send` | Really upload the images and create the posts. |
| `--state <file>` | The state file. Default: the job's path with `.state.json` in place of `.json`. |
| `--url <origin>` | Another address of the Worker, for local development: `http://localhost:8787`. Default: `https://console.gi.org.pl`. Only that origin and loopback addresses (`localhost`, `127.0.0.1`, `[::1]`) are accepted, because the credentials are sent to it. |
| `--credential <name>` | Windows only: the name of a generic credential in the Windows credential store that holds the service token. See below. |

Relative paths in the arguments are relative to the current directory. The client sends the two Access headers and no `Origin` header, and does not follow redirects.

### Credentials

The client takes the service token from the environment: `CF_ACCESS_CLIENT_ID` and `CF_ACCESS_CLIENT_SECRET`. When they are not both set and `--credential <name>` is given, it reads the generic credential of that name from the Windows credential store (Credential Manager > Windows Credentials > Add a generic credential): the user name is the Client ID, the password is the Client Secret. Without either, the client fails with `missing-credentials` and sends nothing.

The secret is used for the request headers only. It is never printed, never written to the state file and never part of an error message: every text the client prints or writes has both values of the token removed first, also when a failed request or the other side repeats them. The credentials are resolved before the job is read, so this holds for an error about the job, its files or its state as well. Only an error about the arguments themselves comes earlier than a read of the credential store.

### The job

```json
{
  "textFile": "post.txt",
  "image": "square.png",
  "channels": ["linkedin", "facebook", "instagram"],
  "channelText": { "instagram": "A shorter text for Instagram." },
  "channelImage": { "instagram": "portrait.png" },
  "dueAt": "2026-10-20T09:00:00+02:00"
}
```

| Key | Meaning |
| --- | --- |
| `text` or `textFile` | The text of the post, inline or as a UTF-8 file. Exactly one of the two. |
| `image` | One PNG. The Worker's limits are checked before anything is sent: at most 5 MB, each side 1-4096 px. |
| `channels` | Optional. Network names (`linkedin`, `facebook`, `instagram`, ...) and/or channel ids, matched against the channels of the session. A network name takes every channel of that network. Default: every channel of the session. |
| `channelText`, `channelTextFile` | Optional. A text for one channel, keyed by network name or channel id, in place of `text`. |
| `channelImage` | Optional. A PNG for one channel, keyed the same way, in place of `image`. |
| `dueAt` | The time of a scheduled post, ISO 8601 with an offset or `Z`. Required for `schedule`, refused for `queue`. It is sent to the Worker in UTC. |

- File paths in a job are relative to the job file.
- An unknown key is an error. So is a name in `channels`, `channelText`, `channelTextFile` or `channelImage` that matches no selected channel (`unknown-channel`): nothing is sent until the job is right. A channel id wins over a network name when both have a variant.
- Line endings of a text become `\n`, a byte order mark is dropped and the text is trimmed. After that it must have 1 to 5000 characters, as the Worker requires.
- `dueAt` must be in the future and at most 30 days ahead. The lead time of the service (120 minutes by default, see [Publishing restrictions](#publishing-restrictions)) is known to the Worker only, which refuses an earlier time for each channel.

### State and reruns

For every channel the client keeps a request ID and how far it got, in the state file: `prepared`, `uploading`, `uploaded`, `posting`, `created`, `refused` or `failed`. The file is written before each request, so a run that dies in the middle leaves a trace. A run in which no channel would be sent writes nothing: it only reports what the file holds. When that write fails, the request is not sent and the step is taken back, so the file never says that a request went out which did not. It holds IDs, the network name, a digest of the content, HTTP statuses and messages - no text of the post and no credentials.

- A channel whose post was created is never sent again: a second run with the same job and state file sends nothing new and reports the same post IDs as `already-created`. This also works for a scheduled job after its time has passed: the channels that are done are reported as before, and a channel that would still be sent is reported as `failed` with the reason and is not sent (a job that has no state yet is held to its time before any request).
- A channel that was refused, or whose upload failed, is tried again on the next run with the same request ID. A changed job is accepted as long as no post was created for it.
- A channel whose post request went out without a recorded result (`posting`) is **not** sent again automatically, whatever the reason: no answer, a 5xx, a 409, or a run that was stopped. It is reported as `unknown`. Look in Buffer first. If the post is there, nothing is left to do for that channel; if it is not, delete the channel's entry from the state file and run again.
- A job that changed after one of its posts was created is refused with `state-mismatch`. A new post needs a new state file. The same holds for a job that changed while a post request has no recorded result (`posting`): what may be in Buffer is the earlier content, so the run is refused instead of reporting `unknown` for the new one.
- A state belongs to the address it was made against (`origin` in the file). A run against another address - the Console after a local `wrangler dev`, or the other way round - is refused with `state-mismatch` before any request, so a post made at one address is never taken for a post at another. A state file without an address is not a state of this client and is refused with `invalid-state`.
- A state file that cannot be read is never replaced, and the first write never overwrites a file that another run created in the meantime. Do not run two sends of the same job at once.
- Every later write goes to `<state file>.tmp` first and replaces the state file in one step, so a run that is stopped in the middle of a write leaves the last complete state behind, never half of a new one.
- A session that lists the same channel ID twice is refused as a whole (`duplicate-channel`) and nothing is sent: the state has one entry per channel, and two entries of one channel would mean two posts. The fix is in the Worker's `CHANNELS_JSON`.
- A session with a channel ID that is a name every JavaScript object inherits (`constructor`, `__proto__`, `toString` and the like) is refused as well (`unusable-channel`): the state file is a JSON object keyed by channel ID, and such a key cannot be read back. Buffer's channel IDs are hexadecimal, so this can only come from a mistake in `CHANNELS_JSON`.

### Output

Stdout is one JSON document; nothing else is printed there. Progress lines go to stderr.

```json
{
  "ok": false,
  "command": "queue",
  "sent": true,
  "url": "https://console.gi.org.pl",
  "identity": { "service": "gieniek-bot" },
  "mode": "addToQueue",
  "state": "/abs/post.state.json",
  "channels": [
    {
      "id": "BUFFER_CHANNEL_ID",
      "name": "Foundation LinkedIn",
      "service": "linkedin",
      "requestId": "5f0d7c2e-6c1b-4b7e-9a52-3f3f0a4a8f10",
      "outcome": "created",
      "postId": "BUFFER_POST_ID",
      "text": "The text this channel got.",
      "image": "/abs/square.png"
    },
    {
      "id": "OTHER_CHANNEL_ID",
      "name": "Foundation Facebook",
      "service": "facebook",
      "requestId": "0b1f6f0a-3a0e-4d0c-8a51-0d7b3f6d2c11",
      "outcome": "refused",
      "status": 403,
      "message": "This channel is not allowed.",
      "text": "The text this channel got.",
      "image": "/abs/square.png"
    }
  ],
  "errors": []
}
```

- `sent` is `true` for a run with `--send` and `false` for a dry run. Whether a request went out for a channel is in its `outcome`.
- `identity` is what the session returned (`{ "service": "<name>" }`), or `null` when the run stopped before it.
- `mode`, `state` and, for `schedule`, `dueAt` (in UTC) are present once the job was read. `check` has none of them, and its `channels` are the session's channels as they are: `id`, `name`, `service`.
- The exit code is `0` when `ok` is `true` and `1` otherwise. `ok` is `true` when `errors` is empty and every selected channel ended as `would-send`, `created` or `already-created`. Channels that succeeded are still listed when another one did not.

| `outcome` | Meaning |
| --- | --- |
| `would-send` | Dry run: the channel is ready and nothing was sent. |
| `created` | The post was created in this run; `postId` is Buffer's ID. |
| `already-created` | The state file has the post for exactly this content; nothing was sent. `postId` as before. |
| `refused` | The Worker or Access answered and turned the upload or the post down; `status` and `message` are its answer (403 for a channel that is not allowed, 400 for a `dueAt` inside the lead time). Nothing was created. |
| `failed` | The upload got no usable answer, the state file could not be written, or the time of a scheduled job has passed for a channel that was still open. No post request was sent. |
| `unknown` | A post request was sent and no created post was recorded. The post may exist: look in Buffer. See [State and reruns](#state-and-reruns). |

`errors` holds what stopped the run before the channels, each with a `code`, a `message` and, for an HTTP answer, a `status`: `invalid-arguments`, `invalid-job`, `invalid-state`, `missing-credentials`, `invalid-credentials`, `credential-unavailable`, `session-failed`, `duplicate-channel`, `unusable-channel`, `unknown-channel`, `state-mismatch`, `state-failed`, `unexpected`. A `state-failed` error next to a `created` channel means the post exists but the state file does not have it; fix the file before the next run. Stdout is the JSON document in every one of these cases.

### Permission rule

An operator who lets an agent run this client can allow one command and leave the others to a question. For Claude Code, in `.claude/settings.json` of the checkout the agent works in:

```json
{
  "permissions": {
    "allow": [
      "Bash(node scripts/publishPost.mjs check:*)",
      "Bash(node scripts/publishPost.mjs queue:*)"
    ]
  }
}
```

The rules match the start of the command, so they cover the job path, `--send` and `--credential`, and they do not cover `schedule`. They decide what may run without a question, not when the agent should publish; that belongs to its own instructions. What a service may publish at all stays limited by the Worker, see [Publishing restrictions](#publishing-restrictions).

## R2 and deployment

Use Node 24+ and Yarn 1.22. Enable R2 in your Cloudflare account, then:

```sh
yarn install --frozen-lockfile
yarn wrangler login
yarn wrangler r2 bucket create console-buffer-media
```

Set the actual bucket name in `r2_buckets[0].bucket_name`. Keep the bucket private; do not enable `r2.dev` or attach a public R2 custom domain. Add R2 lifecycle deletion rules for `images/` and `receipts/` after 90 days. If a post may remain queued longer, increase image retention before relying on it. R2 has a free allowance but overages can be billed; see [R2 pricing](https://developers.cloudflare.com/r2/pricing/).

Edit `wrangler.jsonc`:

| Setting | Value |
| --- | --- |
| `APP_ORIGIN` | Exact Console origin, for example `https://console.gi.org.pl` |
| `ACCESS_TEAM_DOMAIN` | `https://YOUR-TEAM.cloudflareaccess.com` |
| `ACCESS_AUD` | Audience tag of the `/api/buffer/*` Access application |
| `CHANNELS_JSON` | JSON string with approved channel IDs, names, and service values |
| `SERVICES_JSON` | JSON string with the allowlisted service tokens (Client ID, name, and optional `channelIds` and `minScheduleLeadMinutes`). `[]` admits none |

Example channel setting:

```json
"CHANNELS_JSON": "[{\"id\":\"BUFFER_CHANNEL_ID\",\"name\":\"Foundation Instagram\",\"service\":\"instagram\"}]"
```

Then check and deploy:

```sh
yarn typecheck
yarn lint
yarn test:coverage
yarn worker:check
yarn worker:deploy
yarn wrangler secret put BUFFER_API_KEY
```

Paste the Buffer API key only into Wrangler's interactive secret prompt. Publishing fails closed until the secret and valid channel configuration exist. Repository changes alone do not deploy the Worker or create a secret.

After deployment, set `BUFFER_ENABLED=true` as a GitHub Actions variable in the Console repository and redeploy Console Pages. This maps to the public `VITE_BUFFER_ENABLED` build flag. It is a UI switch, not an authorization control; Access and the Worker enforce authorization. For local Console development, a same-origin proxy to an Access-protected staging Worker is needed; setting `VITE_BUFFER_ENABLED=true` alone cannot provide the API.

## Verify before live use

1. Open Console in a private window. The editor remains public. Its **Connect to Buffer** button should open an Access login window. An unapproved identity must be denied.
2. Sign in as the operator. The window returns to Console, and the editor shows the operator email and allowlisted channels. No image or post is sent during login.
3. Create a graphic, choose its format, channel, caption, and queue mode. Use a test channel with its Buffer queue paused, then click **Publish**. Confirm exactly one post in Buffer with the correct PNG and caption. Buffer accepting a post does not guarantee final delivery to the social network.
4. Confirm that `/buffer-media/<uuid>.png` works without Access while `/api/buffer/session` requires it. Never broaden an Access bypass to fix an API error.
5. For a 502 or ambiguous network error, inspect Buffer's queue and history before trying again. The Worker reserves a request ID in R2 to block duplicate submissions. It intentionally does not retry Buffer mutations.

6. If a service token is configured: call `/api/buffer/session` with its two headers and confirm the response names the service. Then confirm that a second service token which is not in `SERVICES_JSON` gets 403, and that the same call without the headers is stopped by Access. With the service token, confirm that a `shareNow` post returns 403 and that a post scheduled 10 minutes ahead returns 400; neither may appear in Buffer.

Worker tests use mocked Buffer/R2 and signed Access JWT fixtures; they do not publish real posts. The service token fixture follows Cloudflare's documented payload; it has not been compared with a token issued by the production Access application, so do step 6 before relying on it. The tests of the command-line client run it against the Worker's code served on `127.0.0.1`, with the same stand-ins for Access, R2 and Buffer; no test talks to the live Worker or reads the Windows credential store. `yarn worker:dev` has no authentication bypass. Use an Access-protected staging hostname and test Buffer channel for integrated testing.
