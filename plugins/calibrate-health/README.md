# Calibrate progress plugin

This package connects Codex to the read-only Calibrate MCP service at
`https://calibratehealth.darkmachines.net/mcp`. The progress explorer shows
historical weight and calorie evidence beside the current goal, with questions
that continue the current chat. Food/weight logging and goal changes stay in the
normal Calibrate app. The server owns the App UI; this package owns discovery,
OAuth connection metadata, and the progress-analysis skill.
The bundled `assets/icon.png` copies the app's `mobile/assets/icon.png` branding.
Both `interface.composerIcon` and `interface.logo` reference it for the sidebar
and marketplace presentation; keep the packaged copy in sync when the app icon changes.

## Install and authenticate

The DarkMachines marketplace uses Git-backed plugin packages. The installing
machine needs Git/SSH access to `MChartier/darkmachines` and
`MChartier/calibrate-health`, plus HTTPS access to the home-server endpoint.

After the marketplace maintainer publishes a Calibrate entry, register the
existing marketplace once:

```sh
codex plugin marketplace add ssh://git@github.com/MChartier/darkmachines.git
codex plugin marketplace list
```

Open the Plugins Directory in Codex, select **DarkMachines**, and install
**Calibrate**. Complete the browser OAuth flow using your Calibrate account and
grant the food and/or weight read scopes you want to use. No bearer token or
provider credentials belong in the plugin files or shell environment. A denied
scope leaves that part of the explorer unavailable.

Start a new chat and ask "Open my Calibrate progress explorer." Choose a period
or comparison and use a question button to continue the chat with that context.
If the host cannot render MCP Apps, the same tools still return structured data
for conversation. If it cannot send a question from the panel, copy its displayed
question into the chat.

After a new catalog revision is published, run
`codex plugin marketplace upgrade darkmachines`, refresh the Plugins Directory,
and install the updated Calibrate package. Restart Codex and use a new chat if
the installed skill/tool list is still cached. For a locally registered
DarkMachines checkout, update that checkout first.

## Validate and publish

From the Calibrate repository root, validate without a release commit or network:

```sh
node scripts/calibrate-plugin.mjs check
node --test scripts/calibrate-plugin.test.mjs
```

The validator checks package-relative paths, install metadata, read-only
capabilities, the OAuth endpoint, skill dependency consistency, and the bundled
license and required notices. Plugin versions are independent of the server version. Change the
plugin version when its installed files change; server releases continue through
the repository's existing **Cut release** workflow.

Deploy the compatible MCP server and verify its authenticated tools and App UI
before making the new plugin discoverable. Commit and publish the reviewed
package through the repository workflow. Then emit an entry for its full commit
SHA (replace the placeholder with the actual 40-character lowercase SHA):

```sh
node scripts/calibrate-plugin.mjs marketplace-entry --ref <commit-sha>
```

The command verifies every package file matches that commit after Git's configured
text normalization, including Windows line endings, and that the commit
is reachable from the published repository's advertised refs. An ancestor check
also needs the advertised tip's history available locally. It performs read-only
Git operations, fails closed when publication cannot be verified, and writes
only JSON to stdout; it never commits, pushes, deploys, or edits a marketplace.

Add the emitted object alongside BAM in the existing DarkMachines
`.agents/plugins/marketplace.json` `plugins` array. Preserve the other entries and
the marketplace name. The entry uses `git-subdir`, the immutable source SHA,
`AVAILABLE` installation, and `ON_INSTALL` OAuth. Review, commit, and publish that
catalog update through the DarkMachines workflow. Do not use BAM's release helper
for Calibrate: its token and tag assumptions belong to a different service.

For upgrades, repeat deployment verification, source publication, entry emission,
and catalog publication in that order. Keep existing installed versions usable
while the catalog update propagates. Publishing the catalog does not deploy the
server or register the marketplace on other machines.

The package includes the repository's [PolyForm Shield license](LICENSE) and
[required copyright notice](NOTICE).
Marketplace conventions follow the official
[plugin packaging documentation](https://developers.openai.com/plugins/build/plugins).
