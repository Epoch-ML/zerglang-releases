# ZergLang releases

This public repository is the distribution boundary for the Apple Silicon
ZergLang IDE. It contains release requests, public GitHub Release assets, and
the GitHub Pages updater manifests consumed by installed applications. The
ZergLang source remains in `Epoch-ML/zerg` and is checked out at the immutable
40-character commit recorded by each request.

Release publication is intentionally request-driven:

1. A matching tag in `Epoch-ML/zerg` validates and uploads one bounded request
   JSON artifact. A human downloads that artifact, verifies it, adds exactly
   that one file to `requests/`, and opens a pull request. Source CI holds no
   credential capable of writing to this repository.
2. This repository validates the request schema, channel, strict SemVer,
   channel-specific tag, source ref, and source SHA.
3. A pinned Apple Silicon `macos-15` runner checks out the source SHA with a
   separate read-only deploy key, verifies the source tag and both independent
   channel trust roots, builds/tests the compiler and IDE, and emits a bounded
   ad-hoc source stage. It receives no Apple or updater-signing credentials.
4. A fresh Apple runner validates the hostile stage with public repository
   code, then applies preview ad-hoc signing or stable Developer ID signing and
   notarization. It receives no updater private key.
5. Exactly one fresh updater signer runs. Preview uses the legacy preview key;
   stable uses a distinct protected stable key. It signs only the finished
   Apple-signed archive and emits exactly six assets, including `latest.json`
   as an immutable recovery copy.
6. Publication creates or resumes a draft, rejects unexpected, duplicate, or
   mismatched assets, verifies authenticated draft bytes, publishes, and then
   requires the GitHub API to report `immutable: true`.
7. The workflow downloads all six public assets over HTTPS, verifies their API
   sizes/digests, checksums, updater signature, archive bounds, request
   provenance, and exact URL shape, and promotes only those canonical bytes.
   A credential-free step prepares a bounded commit in the data-only
   `release-data` branch. The feed credential exists only in the final push
   step, which runs trusted policy from the immutable `main` workflow commit
   and never executes code from `release-data`.
8. GitHub Pages is deployed from the verified `release-data` tree. The final
   job byte-compares the live HTTPS `latest.json` with the canonical Release
   asset. Feed history is monotonic and byte-idempotent.

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
npm ci --ignore-scripts
npm test
npm audit --audit-level=moderate
node scripts/release-request.mjs requests/zerglang-ide-preview-v0.2.0-rc.1.json
```

## Repository credentials

No personal access token or repository-scoped Actions secret is used. Each
credential is held by the one protected environment whose job needs it.

| Location | Secret / setting | Scope |
|---|---|---|
| `Epoch-ML/zerg` `zerglang-release-request` environment | none | Secret-free handoff, restricted to the `zerglang` branch; it uploads only the reviewed request artifact. |
| `zerglang-source-read` environment | `ZERG_SOURCE_DEPLOY_KEY` | Private key whose public half is a **read-only** deploy key on `Epoch-ML/zerg`; it may only fetch the exact source commit and tag. |
| `preview` environment | `ZERGLANG_TAURI_SIGNING_PRIVATE_KEY` | Preview-only Tauri updater private key. |
| `preview` environment | `ZERGLANG_TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | Password for the preview-only updater key. |
| `zerglang-updater-stable` environment | `ZERGLANG_STABLE_TAURI_SIGNING_PRIVATE_KEY` | Distinct stable-only Tauri private key. |
| `zerglang-updater-stable` environment | `ZERGLANG_STABLE_TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | Password for the stable-only updater key. |
| `stable` environment | `ZERGLANG_APPLE_*` | Developer ID certificate, signing identity, and App Store Connect notarization credentials; Apple signing only. |
| `zerglang-apple-preview` environment | none | Empty environment that keeps preview Apple-signing policy separate from updater-key custody. |
| `zerglang-feed` environment | `ZERGLANG_FEED_DEPLOY_KEY` | Private key whose public half is the repository's only write-enabled deploy key; it may advance only `release-data` under the feed rulesets. |

The public roots are intentionally committed at
`keys/zerglang-{preview,stable}-updater.pubkey` here and at
`zerglang/ide/src-tauri/updater.{preview,stable}.pubkey` in the source
repository. The workflow requires byte equality and refuses a shared root.
The legacy source `updater.pubkey` remains the preview root so existing preview
installations retain their update path.

The fresh Apple-signing job targets `zerglang-apple-preview` for preview builds
and `stable` for stable builds. The preview updater signer separately targets
`preview`; the stable updater signer targets `zerglang-updater-stable`. Stable
macOS releases require all of these secrets on the protected `stable`
environment:

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

Protect `preview`, `stable`, `zerglang-apple-preview`, `zerglang-feed`,
`zerglang-source-read`, `zerglang-updater-stable`, and `github-pages` so they
deploy only from `main`. Enable GitHub Pages with **GitHub Actions** as its
source and enforce HTTPS. `GITHUB_TOKEN` is used only for read-only validation,
the GitHub Release API, and Pages deployment; it never writes the updater feed.

The `release-data` branch contains only the deployed `site/` tree. Protect it
with two active rulesets: creation/update may be bypassed only by the dedicated
feed deploy key, while deletion and non-fast-forward updates have no bypass.
Protect `main` with rebase-only pull requests, one approval, approval after the
last push, strict `Release policy`, and linear history. Apply the equivalent
strict `ZergLang release policy` contract to the source `zerglang` branch.

Before cutover, keep both release workflows manually disabled and run:

```bash
GH_TOKEN="$(gh auth token)" npm run preflight:cutover
```

After an explicit, separately reviewed enablement change, require the same
audit with `npm run preflight:live`. The audit intentionally reports that Idan
retains a review bypass until a second trusted human can be enrolled; removing
that bypass first would risk locking out the only current administrator.

## Manual recovery

`workflow_dispatch` accepts only an existing
`requests/<release-tag>.json` path. The request must still be byte-identical to
its unique addition commit, that commit must add only the request, and the
protected public tag must already target that exact request commit. Recovery
cannot synthesize new provenance from manual channel/version/SHA inputs.

After reviewing the request and protected tag, an authorized operator starts
or resumes it from `main` with:

```bash
gh workflow run release.yml --ref main \
  -f request_file=requests/<release-tag>.json
```

GitHub Releases are draft-first and immutable. If a run fails after creating a
partial draft, use **Re-run failed jobs** on that same workflow run: the retry
resumes the exact draft and uploads only missing assets. Do not start a second
dispatch while that run can be resumed. A later recovery dispatch after
publication accepts only an exact published release reporting
`immutable: true`, ignores nondeterministic regenerated bytes, reconstructs the
candidate from canonical public assets, and continues feed/Pages/live
verification. Mutable published Releases fail closed.

The historical `zerglang-ide-v0.1.1` request predates the dual-root source
contract and is intentionally not a stable release candidate. The first stable
request under this boundary must use a new source commit and version (planned
as `0.1.2`) containing both channel public roots.
