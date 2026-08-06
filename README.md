# ZergLang releases

This public repository is the distribution boundary for the Apple Silicon
ZergLang IDE. It contains release requests, public GitHub Release assets, and
the GitHub Pages updater manifests consumed by installed applications. The
ZergLang source remains in `Epoch-ML/zerg` and is checked out at the immutable
40-character commit recorded by each request.

Release publication is intentionally pull-based:

1. A matching tag in `Epoch-ML/zerg` writes exactly one immutable JSON file to
   `requests/` through a write-scoped deploy key.
2. This repository validates the request schema, channel, strict SemVer,
   channel-specific tag, source ref, and source SHA.
3. A pinned Apple Silicon `macos-15` runner checks out the source SHA with a
   separate read-only deploy key, verifies the source tag, and builds/tests the
   compiler and IDE.
4. Tauri produces a signed updater archive and DMG. The workflow verifies the
   archive's minisign signature, native bundle structure, checksums, and (for
   stable releases) Developer ID signature and notarization ticket.
5. The workflow creates the GitHub Release, downloads every asset again over
   HTTPS, compares it byte-for-byte, and only then commits
   `site/<channel>/latest.json` and deploys Pages.

The updater URLs are:

- `https://epoch-ml.github.io/zerglang-releases/preview/latest.json`
- `https://epoch-ml.github.io/zerglang-releases/stable/latest.json`

There is deliberately no fake `latest.json`. A channel returns 404 until its
first verified release; publishing an unsigned placeholder would create an
invalid updater response.

## Release request schema

Request filenames are `requests/<release_tag>.json`. Unknown keys are rejected.

```json
{
  "schema_version": 1,
  "product": "ZergLang IDE",
  "channel": "preview",
  "version": "0.2.0-rc.1",
  "release_tag": "zerglang-ide-preview-v0.2.0-rc.1",
  "source_repository": "Epoch-ML/zerg",
  "source_sha": "0123456789abcdef0123456789abcdef01234567",
  "source_ref": "refs/tags/zerglang-ide-preview-v0.2.0-rc.1",
  "requested_at": "2026-08-05T19:00:00.000Z"
}
```

Preview tags are `zerglang-ide-preview-v<VERSION>` and accept full strict
SemVer. Stable tags are `zerglang-ide-v<MAJOR.MINOR.PATCH>` and reject
prerelease/build metadata.

Validate the policy locally with Node 22 or newer:

```bash
node --test scripts/release-request.test.mjs
node scripts/release-request.mjs requests/zerglang-ide-preview-v0.2.0-rc.1.json
```

## Repository credentials

No personal access token is used. Configure two different deploy-key pairs;
GitHub does not allow one deploy key to be attached to multiple repositories.

| Location | Secret / setting | Scope |
|---|---|---|
| `Epoch-ML/zerg` secret | `ZERGLANG_RELEASES_DEPLOY_KEY` | Private key whose public half is a **write-enabled** deploy key on this repository; it may only submit request JSON. |
| This repository secret | `ZERG_SOURCE_DEPLOY_KEY` | Private key whose public half is a **read-only** deploy key on `Epoch-ML/zerg`; it may only fetch source. |
| This repository secret | `ZERGLANG_TAURI_SIGNING_PRIVATE_KEY` | Long-lived Tauri updater private key. Back it up securely; losing it breaks updates for every installed client that trusts its public key. |
| This repository secret | `ZERGLANG_TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | Password for the updater private key. |

The matching updater public key is intentionally public and committed at
`zerglang/ide/src-tauri/updater.pubkey` in the source repository.

The build job targets a GitHub environment named after its channel (`preview`
or `stable`). Stable macOS releases additionally require all of these secrets
on the **stable environment**, rather than at repository scope:

- `ZERGLANG_APPLE_CERTIFICATE`: base64-encoded Developer ID Application `.p12`
- `ZERGLANG_APPLE_CERTIFICATE_PASSWORD`: export password for that `.p12`
- `ZERGLANG_APPLE_SIGNING_IDENTITY`: its complete Developer ID identity
- `ZERGLANG_APPLE_API_ISSUER`: App Store Connect API issuer UUID
- `ZERGLANG_APPLE_API_KEY_ID`: App Store Connect API key ID
- `ZERGLANG_APPLE_API_PRIVATE_KEY`: complete `.p8` private-key text

An Apple Developer Account Holder must issue the Developer ID certificate and
grant/create the App Store Connect API key. Those identities cannot be safely
synthesized by CI. Preview builds need no Apple identity and are ad-hoc signed,
so Gatekeeper may warn users; stable publication fails closed when any Apple
credential or notarization evidence is missing. Environment protection rules
can require a human approval before the stable job receives those credentials.

Enable GitHub Pages with **GitHub Actions** as its source. `GITHUB_TOKEN` is the
only token used to create Releases, update updater manifests, and deploy Pages.

## Manual recovery

`workflow_dispatch` accepts a channel, version, and exact source SHA, but still
requires the matching immutable tag to exist in `Epoch-ML/zerg`. It is for
replaying a request delivery failure, not bypassing the source-tag contract.

GitHub Releases are treated as immutable. If publication stops after a Release
is created but before the Pages manifest is committed, inspect the Release and
its checksums before recovery; do not replace assets underneath an already
published updater manifest.
