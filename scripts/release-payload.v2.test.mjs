import assert from "node:assert/strict";
import { createHash, generateKeyPairSync } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";

import { buildReleaseCohort, signReleaseCohort } from "./cohort-payload.mjs";
import { collectReleasePayload } from "./release-payload.mjs";

const temporaryDirectories = [];
const sourceSha = "0123456789abcdef0123456789abcdef01234567";
const { privateKey, publicKey } = generateKeyPairSync("ed25519");
const privateKeyPem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const trustStore = {
  schema: "zerglang.release-signing-keys/1",
  keys: [{
    algorithm: "Ed25519",
    key_id: "zerglang-release-ed25519-2026-08-test",
    public_key_pem: publicKey.export({ type: "spki", format: "pem" }).toString(),
    status: "active",
  }],
};

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

function releaseRequest(channel = "preview") {
  const version = channel === "stable" ? "1.2.3" : "1.2.3-preview.4";
  const releaseTag = channel === "stable"
    ? `zerglang-v${version}`
    : `zerglang-preview-v${version}`;
  return {
    channel,
    products: ["ide", "toolchain"],
    release_tag: releaseTag,
    requested_at: "2026-08-23T17:08:57.000Z",
    schema: "zerglang.release-request/2",
    source_ref: `refs/tags/${releaseTag}`,
    source_repository: "Epoch-ML/zerg",
    source_sha: sourceSha,
    version,
  };
}

async function fixture(channel = "preview", metadataOverrides = {}) {
  const request = releaseRequest(channel);
  const root = await mkdtemp(join(tmpdir(), "zerglang-release-payload-v2-"));
  temporaryDirectories.push(root);
  const inputDirectory = join(root, "input");
  const outputDirectory = join(root, "output");
  await mkdir(inputDirectory);
  const appArchive = join(inputDirectory, "ZergLang.app.tar.gz");
  const appSignature = `${appArchive}.sig`;
  const dmg = join(inputDirectory, `ZergLang_${request.version}_aarch64.dmg`);
  const toolchain = join(
    inputDirectory,
    `zerglang-toolchain-${request.version}-aarch64-apple-darwin.tar.gz`,
  );
  await writeFile(appArchive, "signed application archive");
  await writeFile(appSignature, Buffer.alloc(64, 9).toString("base64"));
  await writeFile(dmg, "signed disk image");
  await writeFile(toolchain, "signed toolchain archive");
  await writeFile(join(inputDirectory, "updater.pubkey"), "tauri updater root\n");
  const signatureState = channel === "stable" ? "developer-id" : "ad-hoc";
  const notarized = channel === "stable";
  await writeFile(join(inputDirectory, "platform-metadata.json"), `${JSON.stringify({
    apple_notarized: notarized,
    apple_signature: signatureState,
    channel,
    platform: "darwin-aarch64",
    product: "ZergLang IDE",
    release_tag: request.release_tag,
    schema_version: 2,
    source_sha: sourceSha,
    version: request.version,
    ...metadataOverrides,
  }, null, 2)}\n`);
  await writeFile(join(inputDirectory, "toolchain-metadata.json"), `${JSON.stringify({
    apple_notarized: notarized,
    apple_signature: signatureState,
    channel,
    product: "ZergLang toolchain",
    release_tag: request.release_tag,
    schema: "zerglang.toolchain-platform/1",
    source_sha: sourceSha,
    target: "aarch64-apple-darwin",
    version: request.version,
  }, null, 2)}\n`);
  const cohort = await buildReleaseCohort({
    request,
    ideAssetPath: dmg,
    toolchainArchivePath: toolchain,
    releaseRepository: "Epoch-ML/zerglang-releases",
  });
  const cohortSignature = signReleaseCohort({ cohort, privateKeyPem, trustStore });
  await writeFile(join(inputDirectory, "release-cohort.json"), JSON.stringify(cohort));
  await writeFile(
    join(inputDirectory, "release-cohort.signature.json"),
    JSON.stringify(cohortSignature),
  );
  await writeFile(join(inputDirectory, "release-signing-keys.json"), JSON.stringify(trustStore));
  return { inputDirectory, outputDirectory, request, root };
}

test("collects the exact immutable lockstep cohort while retaining the Tauri feed", async () => {
  const bundle = await fixture();
  const result = await collectReleasePayload({
    ...bundle,
    releaseRepository: "Epoch-ML/zerglang-releases",
  });
  const expected = [
    "ZergLang.app.tar.gz",
    "ZergLang.app.tar.gz.sig",
    `ZergLang_${bundle.request.version}_aarch64.dmg`,
    "checksums.txt",
    "latest.json",
    "release-cohort.json",
    "release-cohort.signature.json",
    "release-metadata.json",
    "toolchain-metadata.json",
    `zerglang-toolchain-${bundle.request.version}-aarch64-apple-darwin.tar.gz`,
  ].sort();
  assert.deepEqual((await readdir(bundle.outputDirectory)).sort(), expected);
  assert.equal(result.assets.length, 10);

  const tauri = JSON.parse(await readFile(join(bundle.outputDirectory, "latest.json"), "utf8"));
  assert.equal(tauri.version, bundle.request.version);
  assert.equal(
    tauri.platforms["darwin-aarch64"].url,
    "https://github.com/Epoch-ML/zerglang-releases/releases/download/" +
      `${encodeURIComponent(bundle.request.release_tag)}/ZergLang.app.tar.gz`,
  );

  const metadata = JSON.parse(
    await readFile(join(bundle.outputDirectory, "release-metadata.json"), "utf8"),
  );
  assert.equal(metadata.schema, "zerglang.release-metadata/2");
  assert.deepEqual(metadata.products, ["ide", "toolchain"]);
  assert.equal(metadata.source_sha, sourceSha);
  assert.equal(metadata.artifacts.length, 7);
  for (const artifact of metadata.artifacts) {
    const bytes = await readFile(join(bundle.outputDirectory, artifact.name));
    assert.equal(artifact.sha256, createHash("sha256").update(bytes).digest("hex"));
  }
  assert.equal(
    await readFile(join(bundle.outputDirectory, "checksums.txt"), "utf8"),
    metadata.artifacts.map(({ name, sha256 }) => `${sha256}  ${name}\n`).join(""),
  );
});

test("rejects any cohort, signature, asset, or signing-key substitution", async () => {
  const tamperedCohort = await fixture();
  const cohortPath = join(tamperedCohort.inputDirectory, "release-cohort.json");
  const cohort = JSON.parse(await readFile(cohortPath, "utf8"));
  cohort.source_sha = "a".repeat(40);
  await writeFile(cohortPath, JSON.stringify(cohort));
  await assert.rejects(
    collectReleasePayload({
      ...tamperedCohort,
      releaseRepository: "Epoch-ML/zerglang-releases",
    }),
    /cohort digest does not match its signature/,
  );

  const tamperedArchive = await fixture();
  await writeFile(
    join(
      tamperedArchive.inputDirectory,
      `zerglang-toolchain-${tamperedArchive.request.version}-aarch64-apple-darwin.tar.gz`,
    ),
    "replacement archive",
  );
  await assert.rejects(
    collectReleasePayload({
      ...tamperedArchive,
      releaseRepository: "Epoch-ML/zerglang-releases",
    }),
    /toolchain archive digest does not match the signed cohort/,
  );

  const retired = await fixture();
  const keysPath = join(retired.inputDirectory, "release-signing-keys.json");
  await writeFile(keysPath, JSON.stringify({
    ...trustStore,
    keys: [{ ...trustStore.keys[0], status: "retired" }],
  }));
  await assert.rejects(
    collectReleasePayload({ ...retired, releaseRepository: "Epoch-ML/zerglang-releases" }),
    /cohort signature key is not active/,
  );
});

test("requires exact platform provenance and stable Developer ID notarization for both products", async () => {
  const wrongSource = await fixture("preview", { source_sha: "a".repeat(40) });
  await assert.rejects(
    collectReleasePayload({ ...wrongSource, releaseRepository: "Epoch-ML/zerglang-releases" }),
    /platform source SHA does not match/,
  );

  const stable = await fixture("stable");
  await collectReleasePayload({ ...stable, releaseRepository: "Epoch-ML/zerglang-releases" });
  const stableMetadata = JSON.parse(
    await readFile(join(stable.outputDirectory, "release-metadata.json"), "utf8"),
  );
  assert.equal(stableMetadata.apple_notarized, true);

  const unsignedStable = await fixture("stable", {
    apple_signature: "ad-hoc",
    apple_notarized: false,
  });
  await assert.rejects(
    collectReleasePayload({
      ...unsignedStable,
      releaseRepository: "Epoch-ML/zerglang-releases",
    }),
    /stable payload requires Developer ID signing and notarization/,
  );

  const smuggled = await fixture("preview", { allow_unsigned_stable: true });
  await assert.rejects(
    collectReleasePayload({ ...smuggled, releaseRepository: "Epoch-ML/zerglang-releases" }),
    /platform metadata contains unexpected fields: allow_unsigned_stable/,
  );
});

test("rejects extra, missing, non-regular, empty, or malformed control inputs", async () => {
  const extra = await fixture();
  await writeFile(join(extra.inputDirectory, "unexpected"), "hostile");
  await assert.rejects(
    collectReleasePayload({ ...extra, releaseRepository: "Epoch-ML/zerglang-releases" }),
    /input must contain exactly .*unexpected/,
  );

  const empty = await fixture();
  await writeFile(join(empty.inputDirectory, "ZergLang.app.tar.gz"), "");
  await assert.rejects(
    collectReleasePayload({ ...empty, releaseRepository: "Epoch-ML/zerglang-releases" }),
    /release artifact is empty/,
  );

  const malformed = await fixture();
  await writeFile(join(malformed.inputDirectory, "toolchain-metadata.json"), "null\n");
  await assert.rejects(
    collectReleasePayload({ ...malformed, releaseRepository: "Epoch-ML/zerglang-releases" }),
    /toolchain metadata must contain a JSON object/,
  );
});
