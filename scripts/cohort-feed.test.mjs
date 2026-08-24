import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";

import { signReleaseCohort } from "./cohort-payload.mjs";
import { stageCohortFeed } from "./feed-policy.mjs";

const temporaryDirectories = [];
const { privateKey, publicKey } = generateKeyPairSync("ed25519");
const privateKeyPem = privateKey.export({ format: "pem", type: "pkcs8" }).toString();
const trustStore = {
  schema: "zerglang.release-signing-keys/1",
  keys: [{
    algorithm: "Ed25519",
    key_id: "zerglang-release-ed25519-2026-08-test",
    public_key_pem: publicKey.export({ format: "pem", type: "spki" }).toString(),
    status: "active",
  }],
};

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

function cohort(version = "1.2.3-preview.4", sourceSha = "a".repeat(40)) {
  const channel = version.includes("-") ? "preview" : "stable";
  return {
    channel,
    products: {
      ide: {
        asset: {
          architecture: "Apple Silicon",
          format: "dmg",
          name: `ZergLang_${version}_aarch64.dmg`,
          sha256: "b".repeat(64),
          size: 123,
          target: "aarch64-apple-darwin",
          url: `https://example.test/ZergLang_${version}_aarch64.dmg`,
        },
        commands: ["ZergLang"],
        minimum_macos: "15.0",
        update_manifest_url: `https://example.test/${channel}/latest.json`,
        version,
      },
      toolchain: {
        asset: {
          architecture: "Apple Silicon",
          format: "tar.gz",
          name: `zerglang-toolchain-${version}-aarch64-apple-darwin.tar.gz`,
          sha256: "c".repeat(64),
          size: 456,
          target: "aarch64-apple-darwin",
          url: `https://example.test/zerglang-toolchain-${version}-aarch64-apple-darwin.tar.gz`,
        },
        commands: ["zlc", "zlm", "zlsync", "zlbench-exec"],
        minimum_macos: "15.0",
        update_manifest_url: `https://example.test/toolchains/v1/channels/${channel}/latest.json`,
        version,
      },
    },
    published_at: "2026-08-23T17:08:57.000Z",
    release_url: `https://example.test/releases/${version}`,
    schema: "zerglang.release-cohort/1",
    source_sha: sourceSha,
    version,
  };
}

async function fixture(version = "1.2.3-preview.4") {
  const root = await mkdtemp(join(tmpdir(), "zerglang-cohort-feed-"));
  temporaryDirectories.push(root);
  const releaseDirectory = join(root, "release");
  const pagesDirectory = join(root, "site");
  await mkdir(releaseDirectory);
  const document = cohort(version);
  const signature = signReleaseCohort({ cohort: document, privateKeyPem, trustStore });
  const trustStorePath = join(root, "keys.json");
  await writeFile(trustStorePath, `${JSON.stringify(trustStore)}\n`);
  await writeFile(join(releaseDirectory, "release-cohort.json"), JSON.stringify(document));
  await writeFile(
    join(releaseDirectory, "release-cohort.signature.json"),
    JSON.stringify(signature),
  );
  return { document, pagesDirectory, releaseDirectory, signature, trustStorePath, version };
}

test("publishes immutable cohort history and updater-compatible latest aliases", async () => {
  const bundle = await fixture();
  assert.deepEqual(
    await stageCohortFeed({ ...bundle, channel: "preview" }),
    { status: "published", version: bundle.version },
  );
  assert.deepEqual(
    JSON.parse(await readFile(join(bundle.pagesDirectory, "toolchains/v1/keys.json"), "utf8")),
    trustStore,
  );
  assert.deepEqual(
    JSON.parse(await readFile(
      join(bundle.pagesDirectory, "toolchains/v1/channels/preview/latest.json"),
      "utf8",
    )),
    bundle.document,
  );
  assert.deepEqual(
    JSON.parse(await readFile(
      join(bundle.pagesDirectory, "toolchains/v1/channels/preview/latest.signature.json"),
      "utf8",
    )),
    bundle.signature,
  );
  assert.deepEqual(
    await readFile(join(
      bundle.pagesDirectory,
      `toolchains/v1/releases/${bundle.version}.json`,
    )),
    await readFile(join(bundle.releaseDirectory, "release-cohort.json")),
  );
  assert.equal(
    (await stageCohortFeed({ ...bundle, channel: "preview" })).status,
    "unchanged",
  );
});

test("preserves and pins the exact raw trust-root bytes", async () => {
  const bundle = await fixture();
  const exactTrust = Buffer.from(` ${JSON.stringify(trustStore)}\n\n`);
  await writeFile(bundle.trustStorePath, exactTrust);

  await stageCohortFeed({ ...bundle, channel: "preview" });

  assert.deepEqual(
    await readFile(join(bundle.pagesDirectory, "toolchains/v1/keys.json")),
    exactTrust,
  );

  const bom = await fixture("1.2.3-preview.5");
  await writeFile(
    bom.trustStorePath,
    Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(JSON.stringify(trustStore))]),
  );
  await assert.rejects(
    stageCohortFeed({ ...bom, channel: "preview" }),
    /release trust root must contain valid JSON/,
  );
});

test("validates the channel before deriving a publication path", async () => {
  const bundle = await fixture();
  await assert.rejects(
    stageCohortFeed({ ...bundle, channel: "../escape" }),
    /channel must be preview or stable/,
  );
  await assert.rejects(
    readFile(join(bundle.pagesDirectory, "escape", "latest.json")),
    (error) => error.code === "ENOENT",
  );
});

test("rejects signature tampering, trust-root replacement, rollback, and same-version mutation", async () => {
  const tampered = await fixture();
  const cohortPath = join(tampered.releaseDirectory, "release-cohort.json");
  const changed = { ...tampered.document, source_sha: "d".repeat(40) };
  await writeFile(cohortPath, JSON.stringify(changed));
  await assert.rejects(
    stageCohortFeed({ ...tampered, channel: "preview" }),
    /cohort digest does not match its signature/,
  );

  const sequence = await fixture("2.0.0-preview.2");
  await stageCohortFeed({ ...sequence, channel: "preview" });
  const older = cohort("2.0.0-preview.1");
  const olderSignature = signReleaseCohort({ cohort: older, privateKeyPem, trustStore });
  await writeFile(join(sequence.releaseDirectory, "release-cohort.json"), JSON.stringify(older));
  await writeFile(
    join(sequence.releaseDirectory, "release-cohort.signature.json"),
    JSON.stringify(olderSignature),
  );
  await assert.rejects(
    stageCohortFeed({ ...sequence, version: older.version, channel: "preview" }),
    /older than current/,
  );

  await writeFile(sequence.trustStorePath, `${JSON.stringify({ ...trustStore, keys: [
    { ...trustStore.keys[0], status: "retired" },
  ] })}\n`);
  await assert.rejects(
    stageCohortFeed({ ...sequence, channel: "preview" }),
    /trust root must remain byte-identical|signature key is not active/,
  );
});
