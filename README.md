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

## Official benchmark evidence

ZLBench publication is a second, isolated release channel in this repository.
It does not reuse IDE tags, updater paths, environments, or signing keys. IDE
updater URLs above remain unchanged.

The source workflow creates a disclosure-safe bundle and uploads it as one
immutable GitHub Actions artifact. A least-privilege GitHub App writes only a
locator at `benchmark-requests/<run_id>.json`. The public workflow then:

1. validates that exactly one content-derived locator was added;
2. verifies the exact source workflow run, attempt, commit, artifact ID, name,
   and GitHub artifact digest;
3. downloads that artifact with `actions:read`, then revalidates its closed
   schema, complete shard set, file inventory, sizes, SHA-256 digests, and
   disclosure policy;
4. packages the unchanged evidence deterministically and signs a release
   binding with a dedicated Ed25519 benchmark key;
5. publishes `zlbench-<run_id>` GitHub Release assets, downloads every asset
   again over HTTPS, and compares every byte; and
6. copies only digest-verified public JSON projections and the signed run
   manifest to an immutable Pages run directory, updates the append-only index,
   and changes the suite/lane `latest` pointer last.

Only `status: complete` is admitted. A benchmark failure is valid evidence and
does not make transport incomplete; `partial` means missing execution evidence
and cannot become an official run.

Public bundles use `zerglang.benchmark-public-report/1` and
`zerglang.benchmark-public-results/1`. Raw `benchmark-report/2` and raw
case-result JSONL are rejected because they can contain held-out case IDs and
diagnostics. Raw performance reports are replaced by the public-case-only
`zerglang.benchmark-public-performance/1` projection. Public cases may carry
their public inputs and expected values.
Held-out results are aggregate-only. Hidden tests, held-out inputs, held-out
oracles, executable oracle code, and reference solutions must all be excluded.
Candidate source may be included, but it is always accompanied by the exact
contamination warning enforced by the validator.

Synthesis publication requires the dedicated aggregate-safe
`zerglang.benchmark-public-synthesis/1` projection. It exposes only normalized
backend identity, aggregate outcome/readout data, and optional digest-bound
public candidate references. Every candidate is inventoried and referenced
exactly once with the canonical contamination warning. Raw synthesis reports,
held-out diagnostics, transcripts, prompts, and evaluation material are not
accepted as substitutes.

The small public discovery surface is:

- `/benchmarks/index.json` — append-only run entries;
- `/benchmarks/runs/<run_id>/manifest.json` — immutable signed run manifests;
- `/benchmarks/index.signature.json` — detached Ed25519 signature over the
  canonical discovery index;
- `/benchmarks/runs/<run_id>/artifacts/` — digest-bound public report, result,
  performance, synthesis, catalog, and task JSON for dashboards;
- `/benchmarks/latest/<suite>/<lane>.json` — mutable convenience pointers; and
- `/benchmarks/keys.json` — trusted public benchmark signing keys.

Candidate source, logs, schemas, and large evidence bundles remain GitHub
Release assets. Pages never receives private test material, executable oracle
code, or candidate source.

### Schema and validator policy

The JSON schemas under `schemas/` are the consumer contract. Public projection
schemas are pinned copies of the corresponding source-repository schema
versions; `report.schema.json`, `synthesis-report.schema.json`, and
`task.schema.json` are present only to resolve shared definitions and are never
admitted artifact roles.
The release-envelope schemas add repository admission constraints. The Node 22
validator in `scripts/benchmark-publication.mjs` is the fail-closed publication
authority: it additionally enforces canonical content identity, cross-field
bindings, sorted/unique values, exact bundle inventory, disclosure scanning,
aggregate consistency, candidate-reference cardinality, and Ed25519 trust. A
schema revision is immutable. Incompatible changes require a new schema name
and validator path; an old version is never reinterpreted.

Validate locally:

```bash
node --test scripts/*.test.mjs
node scripts/benchmark-publication.mjs validate-delivery benchmark-requests/<run_id>.json
node scripts/benchmark-publication.mjs validate-bundle /path/to/unpacked/public-bundle
```

`scripts/generate-benchmark-fixture.mjs OUTPUT_DIR` creates a deterministic,
minimal signed public bundle, archive, public key set, and manifest for website
ingestion tests. Its fixed RFC test-vector seed is test-only and is never
trusted by production.

### Benchmark credentials

Use two separately scoped GitHub App installations for transport. In the source
repository, protect a `benchmark-delivery` environment and store:

- `ZERGLANG_BENCHMARK_DELIVERY_APP_ID`
- `ZERGLANG_BENCHMARK_DELIVERY_APP_PRIVATE_KEY`

That App needs only `Contents: write` on `Epoch-ML/zerglang-releases`; the
source workflow uses its short-lived token only to add the content-addressed
locator under `benchmark-requests/`.

The release repository uses a different source-reader App with only
`Actions: read` and `Metadata: read` on `Epoch-ML/zerg`. Store its credentials
for this workflow as:

- `ZERGLANG_BENCHMARK_PUBLISHER_APP_ID`
- `ZERGLANG_BENCHMARK_PUBLISHER_APP_PRIVATE_KEY`

Create a separate Ed25519 key for the protected `benchmark-publication`
environment:

```bash
openssl genpkey -algorithm Ed25519 -out benchmark-private.pem
openssl pkey -in benchmark-private.pem -pubout -out benchmark-public.pem
```

Commit only the public key as an `active` entry in
`site/benchmarks/keys.json`. Store its matching private PEM in
`ZERGLANG_BENCHMARK_SIGNING_PRIVATE_KEY` and its ID (for example,
`zlbench-ed25519-2026-08`) in `ZERGLANG_BENCHMARK_SIGNING_KEY_ID`. The checked-in
trust store is intentionally empty until that controlled bootstrap occurs, so
publication fails closed. Never put the Tauri updater key in either benchmark
secret.
