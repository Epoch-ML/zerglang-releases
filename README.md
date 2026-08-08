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
   Feed history is monotonic and byte-idempotent. The final job byte-compares
   the live Pages `latest.json` with the canonical release copy.

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
| This repository secret | `ZERGLANG_TAURI_SIGNING_PRIVATE_KEY` | Legacy preview-only Tauri private key. It is referenced only by the isolated updater signer running behind the protected `preview` environment. |
| This repository secret | `ZERGLANG_TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | Password for the preview-only updater key. |
| `zerglang-updater-stable` environment | `ZERGLANG_STABLE_TAURI_SIGNING_PRIVATE_KEY` | Distinct stable-only Tauri private key. |
| `zerglang-updater-stable` environment | `ZERGLANG_STABLE_TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | Password for the stable-only updater key. |

The public roots are intentionally committed at
`keys/zerglang-{preview,stable}-updater.pubkey` here and at
`zerglang/ide/src-tauri/updater.{preview,stable}.pubkey` in the source
repository. The workflow requires byte equality and refuses a shared root.
The legacy source `updater.pubkey` remains the preview root so existing preview
installations retain their update path.

The fresh Apple-signing job targets the channel environment (`preview` or
`stable`), and the isolated preview updater signer also runs behind the
protected `preview` environment while reading the legacy repository secret.
Stable macOS releases require all of these secrets on the protected **stable**
environment, rather than at repository scope:

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

Protect `preview`, `stable`, and `zerglang-updater-stable` so they deploy only
from `main`; stable environments should require the release owner as reviewer
and disable administrator bypass. Enable GitHub Pages with **GitHub Actions**
as its source. `GITHUB_TOKEN` is the only token used to create Releases, update
updater manifests, and deploy Pages.

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

GitHub Releases are draft-first and immutable. A retry resumes an exact draft
and uploads only missing assets. A retry after publication accepts only an
exact published release reporting `immutable: true`, ignores nondeterministic
regenerated bytes, reconstructs the candidate from canonical public assets,
and continues feed/Pages/live verification. Mutable published Releases fail
closed.

The historical `zerglang-ide-v0.1.1` request predates the dual-root source
contract and is intentionally not a stable release candidate. The first stable
request under this boundary must use a new source commit and version (planned
as `0.1.2`) containing both channel public roots.
