# Console Publisher Worker

This repository contains an API-only Cloudflare Worker for Buffer publishing. The graphic editor and publishing controls live in the separate [console-app](https://github.com/gi-org-pl/console-app) repository. There is no HTML page or publishing form in this Worker.

Console calls these same-origin routes:

| Path | Access | Purpose |
| --- | --- | --- |
| `/api/buffer/login` | Operator only | Complete Access login, then return to Console |
| `/api/buffer/session` | Operator or allowlisted service | Caller identity and approved channels |
| `/api/buffer/media` | Operator or allowlisted service | Upload one generated PNG to private R2 |
| `/api/buffer/posts` | Operator or allowlisted service | Create one Buffer post |
| `/api/buffer/announcements` | Allowlisted service only | Register a Discord announcement for posts the service created; see [Discord announcements](#discord-announcements) |
| `/buffer-media/<uuid>.png` | Public read | Let Buffer fetch an uploaded image |

Besides these routes, a Cron Trigger runs the Worker once an hour to post the Discord announcements whose posts have gone out.

An operator is a person signed in through Cloudflare Access. A service is an automation that presents a Cloudflare Access service token; see [Service tokens for automation](#service-tokens-for-automation). Both go through the same Access application - there is no route that bypasses it.

The Buffer key exists only as a Worker secret. The `CHANNELS_JSON` setting is a server-side allowlist. Each post goes to one channel and carries one PNG or several (see [Several images](#several-images)), with immediate publishing, the Buffer queue, or a scheduled time up to 30 days ahead. The image is not published until the operator submits the Console form. A service has a narrower set of options; see [Publishing restrictions](#publishing-restrictions).

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

4. Put only approved channels in `CHANNELS_JSON`. The Worker supports `facebook`, `instagram`, `linkedin`, `threads`, `bluesky`, `mastodon`, and `twitter` service values. It sends Instagram and Facebook feed posts (Buffer requires a post type for both) and Instagram stories (see [Stories](#stories)); Facebook stories, Reels, videos, and other platform-specific metadata are not implemented.

Buffer Free has limits on channels, queued posts, API calls, and seats; verify the [current plan limits](https://buffer.com/pricing) before expanding use. This design uses one designated operator and one Buffer account/API key. Access identities do not become separate Buffer users.

## Cloudflare routing and Access

The Console remains public at `https://console.gi.org.pl` on GitHub Pages. Its DNS record must be **proxied through Cloudflare** for Workers Routes and Access to run. Keep the GitHub Pages custom domain and `CNAME` file in place, and check that the main Console still loads over HTTPS after switching the DNS record to proxied. A Worker Route attaches to that proxied hostname; it does not host or replace the Console site.

The `wrangler.jsonc` routes attach this Worker only to `/api/buffer/*` and `/buffer-media/*`. Update the hostname and zone there if your deployment differs. Disable `workers.dev` and preview URLs as configured, so the service has no alternate public entry point.

Create one **Self-hosted** Cloudflare Access application for `console.gi.org.pl/api/buffer/*`. Its Allow policy should name the designated operator's exact email. Choose your identity provider or email one-time PIN. Do not add an Everyone allow policy. Copy the application's Audience (AUD) tag into `ACCESS_AUD` and your HTTPS team domain into `ACCESS_TEAM_DOMAIN`. The Worker independently verifies the Access JWT signature, issuer, audience, expiry, and identity.

Do **not** protect `/buffer-media/*` with that Access application: Buffer must fetch PNGs without a browser cookie. The Worker allows only GET/HEAD for UUID PNG paths there. Anyone holding a media URL can read that image, so upload only publication-ready graphics. The private R2 bucket has no public bucket endpoint.

## Several images

`POST /api/buffer/posts` takes the images of a post in one of two ways, never both:

| Field | Meaning |
| --- | --- |
| `mediaIds` | An ordered list of media IDs, one to twenty. Buffer gets one asset per image, in this order. No ID may be listed twice. |
| `mediaId` | One media ID - the form from before a post could carry several. It stays accepted, so a Console build or a client that knows no list keeps working. |

- **Every image is uploaded on its own** through `/api/buffer/media`, as before: PNG only, up to 5 MB and 4096 px. Each has to exist and belong to the caller; one that does not refuses the whole post with 403 before Buffer is called.
- **Limit per network:** Instagram 10 (a carousel), LinkedIn 20, Facebook 10; every other network 1. A longer list is refused with 400. The numbers for Instagram and LinkedIn are from Buffer's help pages (read on 2026-10-12); Buffer names none for Facebook, which got the lower of the two; the other networks were not looked up. They live in `MAX_IMAGES` in `src/worker/buffer.ts`.
- **Instagram** shows the images of a carousel in the aspect ratio of the first one and crops the others to it, so the images of one post should share a format.
- **Retries:** the receipt of a request covers the whole list and its order. The same request ID with the same list returns the same post; with a list that differs in any way it returns 409.
- **Services:** nothing new is open to a service. The modes, the lead time and the channel list apply to a post with several images exactly as to one.
- **Storage:** Buffer fetches every image when the post goes out, not when it is created, so all images of a queued or scheduled post have to stay in R2 until then. The lifecycle rule under [R2 and deployment](#r2-and-deployment) covers that as long as it is longer than the furthest schedule (30 days).

## Stories

`POST /api/buffer/posts` takes an optional `type`: `post` (the default, also when the field is left out) or `story`.

- **Networks:** a story is accepted for Instagram channels only. For any other channel, a Facebook one among them, the request is refused with 400 and Buffer is not called. Buffer publishes a story to a Facebook Page only through a notification on a phone, which the Worker does not use.
- **No caption:** a story is sent without `text`; a story that carries one is refused with 400, and so is a post without one. Buffer publishes an image story by itself only when it has no text, link or sticker - those need its reminder flow on a phone, which the Worker does not use (`schedulingType` stays `automatic`).
- **One image:** a story takes one image. Several would be several frames of a story; that was not asked for and not tried.
- **Format:** the Worker does not check the 9:16 ratio. Buffer calls it the suggested ratio, not a required one, and Console sends its 9:16 format.
- **Instagram:** the story is not shared to the feed (`shouldShareToFeed: false`).
- **Modes:** the queue, now and a chosen time work as for posts.
- **Services:** a service may create a story, like a post. The modes, the lead time and the channel list apply to it exactly as to a post. The types open to a service are listed in `SERVICE_POST_TYPES`; a type that is not listed there is refused with 403 and a `service-post-denied` log line.
- **A post and a story of the same material** are two requests with two request IDs.
- Buffer publishes an Instagram story automatically only for a professional (Business or Creator) account. For another account it falls back to a reminder on a phone with the Buffer app, and the post does not go out by itself.

## The time Buffer gives a post

`POST /api/buffer/posts` answers `{ "postId": "...", "dueAt": "..." }`. `dueAt` is the time Buffer means to publish the post: the chosen time of a scheduled post, or the slot Buffer gave a queued one. It is left out when Buffer names none. The Worker reads it, with the post's `status`, from Buffer's [`Post`](https://developers.buffer.com/types/Post.md) type when it creates the post, and keeps both in the receipt. A replay of the same request returns the same answer.

## Discord announcements

Volunteers and friends on Discord already know the context of a post, so they get a short version of it on the announcements channel, after the post has gone out on the social networks. The Worker posts it; Buffer has no webhook and cannot publish to Discord. The proposal behind this is gi-org-pl/product#125.

1. **The short version is registered when the post is queued.** The service that queues the posts (the foundation's bot, through [the queue script](#queueing-a-post-from-the-command-line)) sends the announcement right after them: a text, one to four images and the posts it belongs to.
2. **A scheduled run publishes it.** Once an hour the Worker looks at the pending announcements, asks Buffer where their posts stand and, once the first of them has been sent, posts the announcement to Discord through a channel webhook.

### Registering one

`POST /api/buffer/announcements`, as JSON:

| Field | Meaning |
| --- | --- |
| `requestId` | A UUID, the ID of the announcement. The same request again returns the same answer; different content under the same ID gets 409. |
| `text` | The text of the Discord message, 1 to 1000 characters after trimming. Mentions in it ping nobody. |
| `mediaIds` | One to four images uploaded through `/api/buffer/media` by the same service: one landscape graphic, or squares. A portrait image is refused with 400. They are attached in this order. |
| `postRequestIds` | The request IDs the posts were created with: one per channel of the same post, one to ten. |

The posts are named by their request IDs, not by Buffer's post IDs: the Worker looks each one up in its own receipts, so it knows that this service created it and which Buffer post it became. A post created by an operator or by another service is refused with 403; one whose creation Buffer never confirmed with 409. A post can belong to one announcement only; a second one that names it gets 409. Each post is claimed in R2 (`announcement-posts/<requestId>`) before the announcement is stored. Claims are never deleted: a claim counts while the announcement it points to is stored and names the post, or while it is less than a minute old (a registration in progress). A claim left by a registration that stopped, was refused or lost a race is taken over by the next registration after that minute. The answer is `{ "announcementId": "...", "status": "pending", "dueAt": "..." }`, `dueAt` being the earliest time Buffer named for the posts.

Only an allowlisted service may register an announcement. An operator signed in through Access gets 403 and an `announcement-denied` log line, so Console cannot publish to Discord; a post created in Console has no announcement and produces nothing there. The [publishing restrictions](#publishing-restrictions) of a service hold for its posts as before; the announcement only follows them.

The image size check uses the width and height that `/api/buffer/media` records with every upload; an image uploaded before that was recorded is refused with 400. Upload it again.

### The scheduled run

The Cron Trigger is set in `wrangler.jsonc`:

```jsonc
"triggers": { "crons": ["17 * * * *"] }
```

That is minute 17 of every hour, in UTC. Every two hours would be `"17 */2 * * *"`. A change takes effect with the next deploy. Each run:

1. lists the announcements in R2 (`announcements/<id>.json`) whose status is `pending`;
2. skips one whose earliest `dueAt` is still ahead, unless its last look at Buffer is six hours old (a post can be moved earlier in Buffer);
3. asks Buffer for the current `status` and `dueAt` of each of its posts (the `post` query);
4. decides:

| Buffer says | The announcement |
| --- | --- |
| One of the posts is `sent` | Posted to Discord, then `posted` |
| Every post is gone (Buffer answers `NOT_FOUND`) or has the status `error` | `cancelled`, nothing is posted |
| Anything else (scheduled, sending, a new `dueAt`) | Stays `pending`, with the new time |

An announcement still pending 45 days after it was registered becomes `expired`. A run makes at most 40 outgoing requests (the free plan allows 50 per run); what does not fit is left for the next run and an `announcements-deferred` line is logged.

### Never twice

Every change of state is a conditional write in R2: it happens only if nobody changed the announcement since it was read. Before the Discord request the announcement is set to `sending`, so a run that overlaps cannot send it too. Then:

| Discord answers | The announcement | Log line |
| --- | --- | --- |
| 2xx | `posted`, with the Discord message ID, the time and the Buffer post that went out (the receipt) | `discord-announcement-posted` |
| 4xx (for example 429, or 404 for a deleted webhook) | Back to `pending`, tried again on the next run; `failed` after 24 attempts | `discord-announcement-failed` |
| 5xx, a timeout or a broken connection | `unconfirmed`; never sent again on its own, because the message may exist | `discord-announcement-unconfirmed` |

An error while asking Buffer (`announcement-check-failed`) leaves the announcement as it was, and the next run asks again. R2 takes one write a second to the same key, so the write that records Discord's answer waits until a second has passed since the lock, and is tried once more a second later if R2 refuses it (`announcement-write-retried`). An announcement that still stays `sending` means that write failed twice; it is not sent again either. For `unconfirmed` or a lingering `sending`, look at the channel: if the message is not there, post it by hand. An image that has expired from R2 is left out and the text is posted (`announcement-image-missing`).

The message goes out with `allowed_mentions: { parse: [] }`, so `@everyone`, roles and users in the text are shown but ping no one. The webhook URL is never written to a log line.

### Set up the webhook

1. In Discord, open the settings of the announcements channel > **Integrations** > **Webhooks** > **New Webhook**. Give it a name and an avatar (they show as the author of every announcement) and select **Copy Webhook URL**. Anyone holding the URL can post to the channel, so treat it as a secret.
2. Store it as a Worker secret, pasting it only into Wrangler's prompt:

   ```sh
   yarn wrangler secret put DISCORD_ANNOUNCE_WEBHOOK_URL
   ```

3. Deploy the Worker, so the Cron Trigger exists. Check it under **Workers & Pages** > the Worker > **Settings** > **Triggers**.

Without the secret, or with a value that is not a `https://discord.com/api/webhooks/<id>/<token>` URL, every run logs `announcements-not-configured` and does nothing; the pending announcements wait. To stop announcements, delete the secret (`yarn wrangler secret delete DISCORD_ANNOUNCE_WEBHOOK_URL`) or delete the webhook in Discord; to move them to another channel, create a webhook there and put its URL in the secret.

### Cost

Cron Triggers are part of the Workers free plan (up to five per account). An hourly run is 24 invocations a day; the time spent waiting on Buffer and Discord is not CPU time. The announcements are small JSON objects in the existing bucket. See [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/) and [limits](https://developers.cloudflare.com/workers/platform/limits/).

Each run that has something due asks Buffer once per post. Buffer's API has request limits per plan ([Rate Limits](https://developers.buffer.com/guides/api-limits.md)); a few posts an hour stay far below them.

### What is not verified

The Buffer `post` query, its `NOT_FOUND` answer for a deleted post and the Discord webhook are covered by tests with stand-ins, from Buffer's and Discord's documentation. None of them has been called with real credentials. See step 7 in [Verify before live use](#verify-before-live-use).

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
| Post types | `post` and `story`. A type not listed returns 403. | Fixed in code (`SERVICE_POST_TYPES`) |
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

## Queueing a post from the command line

`scripts/queuePost.mjs` queues one post on the channels a job names, as a service identity. It runs on Node 24+ with the repository's dependencies installed, and it does four things: reads the service token, reads the job, uploads each image once, and sends one post (or story) per channel, printing what the Worker answered. The Worker validates every request (text, images, channel, mode, type); the script only keeps the token secret, keeps the images inside the job's folder and reports.

```sh
node scripts/queuePost.mjs check
node scripts/queuePost.mjs preview job.json
node scripts/queuePost.mjs queue job.json
```

| Command | What it does |
| --- | --- |
| `check` | Asks for the session and prints the Worker's answer: the service and the channels, with the channel IDs a job uses. |
| `preview` | Reads the job and prints what `queue` would send: the type, the text (a post only), the images in order, the request ID of each channel and the announcement with its request ID. Nothing is requested, uploaded or posted. |
| `queue` | Uploads each image once, in the job's order (those of the announcement too), and creates a post (or a story) in mode `addToQueue` on each channel of the job. Then it registers the announcement, if the job has one, for the posts that exist. |

There is no command for "now" and none for a chosen time. `--credential <name>` may be added to any of them, see [The token](#the-token). The script talks to `https://console.gi.org.pl` only, sends no `Origin` header, follows no redirect and gives up on a request after 60 seconds.

### The job

```json
{
  "name": "autumn-news",
  "text": "The text of the post.",
  "images": ["first.png", "second.png"],
  "channels": ["BUFFER_CHANNEL_ID", "ANOTHER_CHANNEL_ID"]
}
```

A post can carry an announcement for Discord (see [Discord announcements](#discord-announcements)):

```json
{
  "name": "autumn-news",
  "text": "The text of the post.",
  "images": ["first.png"],
  "channels": ["BUFFER_CHANNEL_ID", "ANOTHER_CHANNEL_ID"],
  "announce": {
    "text": "Two or three sentences for Discord, with a link.",
    "images": ["discord.png"]
  }
}
```

A story has a `type`, no text and one image:

```json
{
  "name": "autumn-story",
  "type": "story",
  "image": "story.png",
  "channels": ["INSTAGRAM_CHANNEL_ID"]
}
```

| Key | Meaning |
| --- | --- |
| `name` | The name of the post: 3 to 64 lower-case letters, digits and hyphens. It decides what counts as the same post, see [A second run](#a-second-run). |
| `type` | Optional: `post` (the default) or `story`. |
| `text` | A post needs it, a story has none (a job that does it the other way round is refused as malformed). The text for every channel, as the job has it; the Worker trims leading and trailing whitespace before it publishes, and `preview` shows the text untrimmed. |
| `images` | The PNGs of the post, in order, as paths inside the folder of the job, the same for every channel. At least one. Every path is checked: an absolute path, a network path and anything that leaves the folder (also through a link) is refused before anything is requested. |
| `image` | One path, the same as `images` with one entry, so earlier jobs keep working. A job has `images` or `image`, not both. |
| `channels` | The channel IDs the Worker knows (`check` prints them). At least one, none twice. |
| `announce` | Optional. `text`: 1 to 1000 characters after trimming. `images`: one to four PNGs, landscape or square, as paths inside the folder of the job, like `images`. Nothing else. |

A key the script does not know stops the run before anything is requested. The `announce` block is the one place where the script checks the Worker's rules itself - the length of the text, the number of images and that each is a PNG that is not portrait - because the announcement is registered after the posts are queued, and one the Worker refused then would leave the posts without it. Otherwise the script checks nothing: how many images a network takes, that stories are for Instagram channels only (a Facebook channel gets 400 "This channel has no stories."), the size and format of a post image and the channels are the Worker's rules. It sends the request anyway and prints the Worker's 400 or 403 in that channel's entry; the other channels still get theirs, and the exit code is 1. Whether a service may queue stories at all is the Worker's policy too (`SERVICE_POST_TYPES`); where it does not, a story gets 403.

### A second run

The script keeps no state. The request ID of a channel is derived from the Client ID, the name of the post and the channel, so every run of the same post sends the same IDs, and the Worker decides what happens: it reserves an ID before it calls Buffer and never creates a second post under it. The images are uploaded again and get new media IDs, so the Worker answers a repeat with 409 and creates nothing; that holds for several images and for stories as well. A story gets a request ID of its own, so it never collides with a post of the same name on the same channel. A changed text under the same name ends the same way: a new post needs a new name. After a run in which one channel was refused, run the same job again: the channels that have their post answer 409, the other one is created.

The announcement has a request ID of its own, derived the same way from the name of the post. `queue` registers it for every channel whose post answered 200 or 409, so a second run after a first one that stopped before the announcement registers it for the posts of the first. Once it is registered, a second run gets 409 for it, as for the posts, and nothing is announced twice. If an upload fails, no post is sent and the announcement is `skipped`.

### The output

One JSON document on stdout:

```json
{
  "ok": true,
  "command": "queue",
  "name": "autumn-news",
  "results": [
    { "channelId": "li1", "requestId": "...", "step": "post", "status": 200, "response": { "postId": "..." } },
    { "channelId": "ig1", "requestId": "...", "step": "post", "status": 409, "response": { "message": "..." } }
  ]
}
```

Per channel, `status` is the HTTP status of the Worker and `response` what it said. `step` is `post`, or `upload` when an image was not uploaded and so nothing was posted (then `status` and `response` are the upload's). Status `0` means no answer (the connection broke or the 60 seconds passed); for a post that means the post may exist, so look in Buffer before anything else - running the job again cannot create a second one. A job with an announcement adds `announcement: { "requestId", "step", "status", "response" }`: `step` is `announce`, or `skipped` (without `status`) when no post exists to announce. `check` has one result with `step: "session"`; `preview` has `name`, `type`, `text` (a post only), `images` and `channels` instead of `results`; a failure of the script itself is `{ "ok": false, "command": ..., "error": "..." }` with the command as far as the arguments were understood (otherwise `null`). The exit code is 0 only when `ok` is true: no error, and every request answered with a 2xx status, the announcement's too.

### The token

The script takes the service token from the environment: `CF_ACCESS_CLIENT_ID` and `CF_ACCESS_CLIENT_SECRET`. When they are not both set and `--credential <name>` is given, it reads the entry of that name from the credential store of the system.

| System | Where | The entry |
| --- | --- | --- |
| Windows | Credential Manager > Windows Credentials > Add a generic credential | The address is `<name>`, the user name is the Client ID, the password is the Client Secret. |
| macOS | The login Keychain, a generic password: `security add-generic-password -s <name> -a <Client ID> -w` (it asks for the password, so the secret is in no command line) | The service is `<name>`, the account is the Client ID, the password is the Client Secret. |

On Windows the entry is read by `scripts/queue-post/readCredential.ps1`, which the script starts itself. On macOS it is read with `/usr/bin/security`: the account first, and the password only when the account is a service token Client ID. The macOS path has not been run on a Mac yet.

Both values of the token go into the two request headers and nowhere else: every text the script prints has them removed first, also when the Worker repeats them, and a job whose text or channel contains them is refused before anything is sent.

### Where the code is

`scripts/queuePost.mjs` is the whole run. `scripts/queue-post/token.mjs` and `readCredential.ps1` read the token from the environment or a credential store and remove it from the output. The tests of the token sit next to it; `scripts/queue-post/tests/` runs the whole script against the Worker's own code, with stand-ins for Access, R2 and Buffer.

### Permission rule

An operator who lets an agent run this script can allow looking without allowing sending. For Claude Code:

```json
{
  "permissions": {
    "allow": [
      "Bash(node /path/to/console-publisher-worker/scripts/queuePost.mjs check:*)",
      "Bash(node /path/to/console-publisher-worker/scripts/queuePost.mjs preview:*)"
    ]
  }
}
```

Add the same line with `queue` to let the agent send without a question. Two things to know before doing that:

- **The rule allows whatever is at that path.** Point it at a checkout the agent does not edit, by its full path. A rule with a relative path, in a folder the agent may write to, allows any code the agent puts there - with the token within its reach.
- **`queue` has no way back.** A queued post goes out at the channel's next slot. What a service may publish at all stays limited by the Worker, see [Publishing restrictions](#publishing-restrictions).

## R2 and deployment

Use Node 24+ and Yarn 1.22. Enable R2 in your Cloudflare account, then:

```sh
yarn install --frozen-lockfile
yarn wrangler login
yarn wrangler r2 bucket create console-buffer-media
```

Set the actual bucket name in `r2_buckets[0].bucket_name`. Keep the bucket private; do not enable `r2.dev` or attach a public R2 custom domain. Add R2 lifecycle deletion rules for `images/`, `receipts/`, `announcements/` and `announcement-posts/` after 90 days. If a post may remain queued longer, increase image retention before relying on it. R2 has a free allowance but overages can be billed; see [R2 pricing](https://developers.cloudflare.com/r2/pricing/).

Edit `wrangler.jsonc`:

| Setting | Value |
| --- | --- |
| `APP_ORIGIN` | Exact Console origin, for example `https://console.gi.org.pl` |
| `ACCESS_TEAM_DOMAIN` | `https://YOUR-TEAM.cloudflareaccess.com` |
| `ACCESS_AUD` | Audience tag of the `/api/buffer/*` Access application |
| `CHANNELS_JSON` | JSON string with approved channel IDs, names, and service values |
| `SERVICES_JSON` | JSON string with the allowlisted service tokens (Client ID, name, and optional `channelIds` and `minScheduleLeadMinutes`). `[]` admits none |
| `triggers.crons` | When the [announcement run](#the-scheduled-run) starts, in UTC. Hourly by default |

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

For Discord announcements, also `yarn wrangler secret put DISCORD_ANNOUNCE_WEBHOOK_URL` (see [Set up the webhook](#set-up-the-webhook)); without it the Worker posts nothing to Discord and everything else works as before.

Paste the Buffer API key only into Wrangler's interactive secret prompt. Publishing fails closed until the secret and valid channel configuration exist. Repository changes alone do not deploy the Worker or create a secret.

After deployment, set `BUFFER_ENABLED=true` as a GitHub Actions variable in the Console repository and redeploy Console Pages. This maps to the public `VITE_BUFFER_ENABLED` build flag. It is a UI switch, not an authorization control; Access and the Worker enforce authorization. For local Console development, a same-origin proxy to an Access-protected staging Worker is needed; setting `VITE_BUFFER_ENABLED=true` alone cannot provide the API.

## Verify before live use

1. Open Console in a private window. The editor remains public. Its **Connect to Buffer** button should open an Access login window. An unapproved identity must be denied.
2. Sign in as the operator. The window returns to Console, and the editor shows the operator email and allowlisted channels. No image or post is sent during login.
3. Create a graphic, choose its format, channel, caption, and queue mode. Use a test channel with its Buffer queue paused, then click **Publish**. Confirm exactly one post in Buffer with the correct PNG and caption. Buffer accepting a post does not guarantee final delivery to the social network.
4. Confirm that `/buffer-media/<uuid>.png` works without Access while `/api/buffer/session` requires it. Never broaden an Access bypass to fix an API error.
5. For a 502 or ambiguous network error, inspect Buffer's queue and history before trying again. The Worker reserves a request ID in R2 to block duplicate submissions. It intentionally does not retry Buffer mutations.

6. If a service token is configured: call `/api/buffer/session` with its two headers and confirm the response names the service. Then confirm that a second service token which is not in `SERVICES_JSON` gets 403, and that the same call without the headers is stopped by Access. With the service token, confirm that a `shareNow` post returns 403 and that a post scheduled 10 minutes ahead returns 400; neither may appear in Buffer.

7. If the Discord webhook is set: queue one post with an `announce` block on a test channel whose next Buffer slot is near, and watch the Worker's logs (`yarn wrangler tail`) around the next run after the post goes out. Confirm exactly one message in the channel, with its images and no ping, and `discord-announcement-posted` in the log. Queue a second one and delete its post in Buffer before it goes out; the next run should log `announcement-cancelled` and post nothing.

Worker tests use mocked Buffer/R2/Discord and signed Access JWT fixtures; they do not publish real posts. The service token fixture follows Cloudflare's documented payload; it has not been compared with a token issued by the production Access application, so do step 6 before relying on it. `yarn worker:dev` has no authentication bypass. Use an Access-protected staging hostname and test Buffer channel for integrated testing.
