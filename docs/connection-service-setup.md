# Slack and Figma connection service setup

This setup is for Elf's maintainer, once. Designers connect their accounts from
onboarding or Settings without creating apps or configuring secrets. Both apps
use the existing Elf Console Worker.

As of 27 October 2026, the OAuth database migration and Worker deployment are
complete. Both configured start routes redirect to the correct provider with the
expected scope and callback. Full account authorization and live sync/notification
checks remain; follow [the live test plan](tonight-test-plan.md).
The public Figma plugin has not been published or fully verified against a live OAuth app.

| Provider | Exact redirect URL | Required permission |
| --- | --- | --- |
| Slack | `https://elf-console.nonyonah.workers.dev/api/local-connect/slack/callback` | `incoming-webhook` bot scope |
| Figma | `https://elf-console.nonyonah.workers.dev/api/local-connect/figma/callback` | `file_content:read` |

## Slack app

1. Open [Your Slack apps](https://api.slack.com/apps). For your existing app,
   add the Slack redirect URL above in **OAuth & Permissions**. Preserve existing
   redirect URLs if another integration uses them.
2. Enable **Incoming Webhooks** and add only the `incoming-webhook` bot scope for
   this flow. Slack asks the installer to choose the notification channel.
3. This is a confidential web-app exchange using the server's client secret.
   Slack's localhost PKCE flow does not support the required bot scope. If your
   existing app is configured exclusively for that flow, create a separate app
   using [slack-app-manifest.json](slack-app-manifest.json).
4. Find the Client ID and Client Secret in **Basic Information**. Enter them
   directly into Wrangler's secret prompts below; do not paste them into chat,
   source code, browser settings, or the npm package.
5. Configure Slack's app distribution before expecting installation in other
   workspaces. Test workspace policies may still require an admin to approve it.

The existing Console dashboard uses a separate callback,
`https://elf-console.nonyonah.workers.dev/api/slack/oauth/callback`.
The supplied manifest includes both URLs so dashboard installations also work.

References: [Slack OAuth](https://docs.slack.dev/authentication/installing-with-oauth/),
[PKCE restrictions](https://docs.slack.dev/authentication/using-pkce/),
[app manifest reference](https://docs.slack.dev/reference/app-manifest/).

## Figma app

1. Open [Figma developer apps](https://www.figma.com/developers/apps) and create
   an OAuth app for Elf under the appropriate team or organization.
2. Add the exact Figma redirect URL above. Select only `file_content:read`.
   File writes use the paired plugin; account access verifies which file it is.
3. Save the Client ID and the Client Secret privately when Figma displays them.
   Enter them into Wrangler's secret prompts below.
4. Complete Figma's required app configuration and publishing steps for testing.
   Public use requires Figma's review. An OAuth app and a Community plugin are
   separate registrations; registering one does not publish the other.

Reference: [Figma OAuth apps](https://developers.figma.com/docs/rest-api/oauth-apps/).

## Configure and activate the Worker

From `console/`, enter values interactively:

```sh
npx wrangler secret put SLACK_CLIENT_ID
npx wrangler secret put SLACK_CLIENT_SECRET
npx wrangler secret put FIGMA_CLIENT_ID
npx wrangler secret put FIGMA_CLIENT_SECRET
```

The existing `SECRETS_KEY` encrypts transient grants and Console credentials.
Keep it unchanged: replacing it would prevent existing credentials from decrypting.
`CONSOLE_ORIGIN` is already configured for the callback origin above. If you
change that origin, update both app registrations and the package's trusted
connection origin together.

After reviewing and committing the release, apply migrations **before** deploying
the Worker that references `local_oauth`. Use a clean checkout of the intended
release so unrelated local UI edits are excluded:

```sh
npx wrangler d1 migrations apply elf-console --remote
npx wrangler deploy
```

Build the Console client first if `dist/client` is absent, using the Console's
documented build configuration. Migration `0005_local_oauth.sql` and deployment
from implementation commit `eef9146` were completed on 27 October 2026. Publish
the updated npm package separately after the hosted flows pass live verification.

## Verify the designer's flow

1. Run Elf in a project and open onboarding or `elf settings`.
2. Connect Slack, authorize a channel, and return to Settings. Cancel once and
   reconnect to confirm cancellation leaves the project disconnected.
3. Connect Figma and authorize read access. Settings displays connection status;
   credentials are never returned by its browser API.
4. For the public plugin build, use `dist/bridge-plugin-public/manifest.json`, paste
   the current Figma file's link, then pair with the code printed by the package.
   Save/sync the document if proof verification needs time to reach Figma's API.
5. Reopen the plugin in that file: its saved pairing should reconnect. Try a copy
   of the file: it must require its own verified identity and pairing.
6. Change a discovered token/component, verify the sync and report, then introduce
   drift and confirm an actual Slack notification in the selected test channel.

Figma's public plugin needs document edit permission to write its nonvisual
verification marker. It must remain running for live bridge work; Figma closing
the plugin stops that runtime. The development plugin can still use its native
file key without account verification.

## Credential boundaries

App secrets stay on the Worker. Browser redirects contain random single-use
grants, bound to a local verifier and browser state, rather than provider tokens.
Encrypted transient grants expire after ten minutes and are removed on redemption
or expiry cleanup. The local process makes file-verification requests directly
to Figma; the Worker only exchanges and refreshes account credentials.

The Figma account is stored privately at `~/.elf/figma-account.json`; the Slack
webhook is stored privately per project. Removing Figma access in Settings removes
that machine's account file. To revoke the app's authorization at Figma itself,
also remove Elf in Figma's connected-app settings. Plugin pairing is a separate
credential and can be forgotten per file.

## Import the public test build in Figma Desktop

Run `npm run build:bridge-plugin` from the Elf repository. In Figma Desktop,
open **Plugins → Development → Import plugin from manifest** and select
`dist/bridge-plugin-public/manifest.json`. Keep `code.js` and `ui.html` beside it
in that generated folder. `bridge-plugin/manifest.public.json` is a build template,
not the file to select in the import dialog.

The development and public builds share the same assigned plugin ID. Figma may
update the existing Elf Bridge development entry rather than add a second entry.
Close any running Elf Bridge instance first. If importing appears to do nothing,
remove the existing entry from **Manage plugins → Development**, then import the
generated manifest and run **Elf Bridge (Public)** again. Removing a local development entry
is separate from revoking its saved file pairing.

The generated public build always uses explicit file-link verification, even if
Figma exposes a native file key while it is imported as a development plugin.
With no saved link, it opens **Link this Figma file** with a URL input. The regular
`bridge-plugin/manifest.json` build can use the native identity and will not need
that input.

The plugin's network permission uses `ws://localhost:8765`. Keep the bridge host
set to `localhost:8765` in the plugin; numeric IP patterns are not included in
the manifest. This preserves the fixed loopback restriction without wildcard
network access. The bridge server itself continues to bind to loopback addresses.
