# Releases

The update channel selects which releases an installation receives. It is separate from the
version of the build it runs.

| Channel | Versions                                                           |
| ------- | ------------------------------------------------------------------ |
| Nightly | `0.0.1-alpha.20261023.1`: UTC date, then the build number that day |
| Beta    | `0.0.1-beta.1`, then release candidates such as `0.0.1-rc.1`       |
| Stable  | `0.0.1`                                                            |

The first stable release is `0.0.1`. Choosing another channel does not downgrade an installation.
A stable release also reaches Beta and Nightly when it is newer than their current offer.
A channel without a published release has nothing to offer yet.

A checkout build uses nightly number zero, for example
`0.0.1-alpha.20261023.0+g5dbf340.t153000.dirty`. It is not a published nightly. The commit,
UTC build time and whether the source had local changes identify it without rewriting the
version in the manifests. The kernel reports these fields in `/api/health` as `build`;
`version` and `zerolux --version` show the compiled version. Mobile builds carry the same
fields in the Expo configuration, with a numeric store version and increasing build number.

## Preparing a release

`bun run release 0.0.1-beta.1`, `bun run release 0.0.1-rc.1` or `bun run release 0.0.1`
updates the release manifests, Cargo lockfile and changelog, commits them and creates a tag.
It does not push. Pushing the tag starts the release workflow.

After a stable release, set the workspace version to the next development version, such as
`0.0.2-dev`, before the next nightly. The workflow refuses to publish an alpha of a base that
is already stable. Extension package versions have their own lifecycle.

The Release workflow also runs daily at 02:17 UTC and on manual dispatch. Those runs reserve
the next nightly number, including failed drafts in the count. Retrying a draft preserves its
version, source and build time; a published release cannot be rebuilt in place.
If publication stops while advancing a channel, retrying its publish job verifies the already
published feeds and restores the pointers without changing the release or replacing a newer offer.

## Signing and publishing

Configure repository secret `TAURI_SIGNING_PRIVATE_KEY` and variable
`ZEROLUX_UPDATE_PUBLIC_KEY` with the matching Tauri updater keys. Set the optional secret
`TAURI_SIGNING_PRIVATE_KEY_PASSWORD` only when the private key is password-protected; otherwise
leave it unset. The same key pair signs all three channels and their kernel and desktop updates.
The build refuses to publish without the private and public key.
The completed feeds are verified against the public key with Minisign before publication, so
a mismatched key pair cannot advance a channel. These keys are separate from platform signing
certificates and the Android keystore.

The workflow runs the full CI checks, then builds the kernels, desktop installers and Android
app. Windows MSI keeps a separate numeric version; the update feed compares the full release
version. Kernel binaries and desktop update bundles are signed with their release version.

Desktop release builds use `target/desktop/release`, separately from the CLI's
`target/release`. Tauri packages the desktop's main executable as `zerolux` and discovers
its installers and updater artifacts in that desktop target directory. The CI cache follows
the same split; `CARGO_TARGET_DIR` can select another absolute desktop output directory.

Each version has immutable artifacts on its GitHub release. Once every build succeeds, the
workflow publishes the release and advances signed `nightly.json`, `beta.json` and
`stable.json` feeds, as applicable, on the `updates` release. Each feed includes the source
commit, build time, schema fingerprint, artifact URLs and signatures; its `.sig` authenticates
the feed itself. Updating a feed never replaces a newer offer with an older one.

The build environment can set `ZEROLUX_BUILD_VERSION`, `ZEROLUX_BUILD_CHANNEL`,
`ZEROLUX_BUILD_COMMIT` and `ZEROLUX_BUILD_BUILT_AT` to carry one identity through every
artifact. CI sets them from the reserved release, not from each runner's clock.
