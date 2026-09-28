# Console Publisher Worker

This repository contains an API-only Cloudflare Worker for Buffer publishing. The graphic editor and publishing controls live in the separate [console-app](https://github.com/gi-org-pl/console-app) repository. There is no HTML page or publishing form in this Worker.

Console calls these same-origin routes:

| Path | Access | Purpose |
| --- | --- | --- |
| `/api/buffer/login` | Operator only | Complete Access login, then return to Console |
| `/api/buffer/session` | Operator only | Operator email and approved channels |
| `/api/buffer/media` | Operator only | Upload one generated PNG to private R2 |
| `/api/buffer/posts` | Operator only | Create one Buffer post |
| `/buffer-media/<uuid>.png` | Public read | Let Buffer fetch an uploaded image |

The Buffer key exists only as a Worker secret. The `CHANNELS_JSON` setting is a server-side allowlist. Each post uses one PNG and one channel, with immediate publishing, the Buffer queue, or a scheduled time up to 30 days ahead. The image is not published until the operator submits the Console form.

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

4. Put only approved channels in `CHANNELS_JSON`. The Worker supports `facebook`, `instagram`, `linkedin`, `threads`, `bluesky`, `mastodon`, and `twitter` service values. It sends Instagram feed posts; Stories, Reels, videos, carousels, and platform-specific metadata are not implemented.

Buffer Free has limits on channels, queued posts, API calls, and seats; verify the [current plan limits](https://buffer.com/pricing) before expanding use. This design uses one designated operator and one Buffer account/API key. Access identities do not become separate Buffer users.

## Cloudflare routing and Access

The Console remains public at `https://console.gi.org.pl` on GitHub Pages. Its DNS record must be **proxied through Cloudflare** for Workers Routes and Access to run. Keep the GitHub Pages custom domain and `CNAME` file in place, and check that the main Console still loads over HTTPS after switching the DNS record to proxied. A Worker Route attaches to that proxied hostname; it does not host or replace the Console site.

The `wrangler.jsonc` routes attach this Worker only to `/api/buffer/*` and `/buffer-media/*`. Update the hostname and zone there if your deployment differs. Disable `workers.dev` and preview URLs as configured, so the service has no alternate public entry point.

Create one **Self-hosted** Cloudflare Access application for `console.gi.org.pl/api/buffer/*`. Its Allow policy should name the designated operator's exact email. Choose your identity provider or email one-time PIN. Do not add an Everyone allow policy. Copy the application's Audience (AUD) tag into `ACCESS_AUD` and your HTTPS team domain into `ACCESS_TEAM_DOMAIN`. The Worker independently verifies the Access JWT signature, issuer, audience, expiry, and identity.

Do **not** protect `/buffer-media/*` with that Access application: Buffer must fetch PNGs without a browser cookie. The Worker allows only GET/HEAD for UUID PNG paths there. Anyone holding a media URL can read that image, so upload only publication-ready graphics. The private R2 bucket has no public bucket endpoint.

References: [Workers Routes](https://developers.cloudflare.com/workers/configuration/routing/routes/), [Access path applications](https://developers.cloudflare.com/cloudflare-one/access-controls/policies/app-paths/), [Access JWT validation](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/).

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

Worker tests use mocked Buffer/R2 and signed Access JWT fixtures; they do not publish real posts. `yarn worker:dev` has no authentication bypass. Use an Access-protected staging hostname and test Buffer channel for integrated testing.
