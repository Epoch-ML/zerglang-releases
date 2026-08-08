import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";

import { collectReleasePayload } from "./release-payload.mjs";

const temporaryDirectories = [];
const request = {
  schema_version: 1,
  product: "ZergLang IDE",
  channel: "preview",
  version: "0.2.0-preview.1",
  release_tag: "zerglang-ide-preview-v0.2.0-preview.1",
  source_repository: "Epoch-ML/zerg",
  source_sha: "0123456789abcdef0123456789abcdef01234567",
  source_ref: "refs/tags/zerglang-ide-preview-v0.2.0-preview.1",
  requested_at: "2026-08-08T17:13:17.989Z",
};

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function fixture(overrides = {}) {
  const root = await mkdtemp(join(tmpdir(), "zerglang-release-payload-"));
  temporaryDirectories.push(root);
  const inputDirectory = join(root, "input");
  const outputDirectory = join(root, "output");
  await mkdir(inputDirectory);
  await writeFile(join(inputDirectory, "ZergLang.app.tar.gz"), "signed application archive");
  await writeFile(
    join(inputDirectory, "ZergLang.app.tar.gz.sig"),
    Buffer.from("substantive updater minisign signature bytes").toString("base64"),
  );
  await writeFile(
    join(inputDirectory, "ZergLang_0.2.0-preview.1_aarch64.dmg"),
    "signed disk image",
  );
  await writeFile(join(inputDirectory, "updater.pubkey"), "public updater root\n");
  await writeFile(join(inputDirectory, "platform-metadata.json"), `${JSON.stringify({
    schema_version: 2,
    product: "ZergLang IDE",
    version: request.version,
    channel: request.channel,
    release_tag: request.release_tag,
    source_sha: request.source_sha,
    platform: "darwin-aarch64",
    apple_signature: "ad-hoc",
    apple_notarized: false,
    ...overrides,
  }, null, 2)}\n`);
  return { inputDirectory, outputDirectory, root };
}

test("collects exactly six immutable assets including the feed recovery copy", async () => {
  const bundle = await fixture();
  const result = await collectReleasePayload({
    ...bundle,
    releaseRepository: "Epoch-ML/zerglang-releases",
    request,
  });

  assert.deepEqual((await readdir(bundle.outputDirectory)).sort(), [
    "ZergLang.app.tar.gz",
    "ZergLang.app.tar.gz.sig",
    "ZergLang_0.2.0-preview.1_aarch64.dmg",
    "checksums.txt",
    "latest.json",
    "release-metadata.json",
  ]);
  assert.equal(result.assets.length, 6);

  const manifest = JSON.parse(await readFile(join(bundle.outputDirectory, "latest.json"), "utf8"));
  assert.equal(manifest.version, request.version);
  assert.equal(manifest.pub_date, request.requested_at);
  assert.equal(
    manifest.platforms["darwin-aarch64"].url,
    "https://github.com/Epoch-ML/zerglang-releases/releases/download/" +
      "zerglang-ide-preview-v0.2.0-preview.1/ZergLang.app.tar.gz",
  );
  assert.equal(
    manifest.platforms["darwin-aarch64"].signature,
    Buffer.from("substantive updater minisign signature bytes").toString("base64"),
  );

  const metadata = JSON.parse(
    await readFile(join(bundle.outputDirectory, "release-metadata.json"), "utf8"),
  );
  assert.equal(metadata.source_sha, request.source_sha);
  assert.equal(metadata.apple_notarized, false);
  assert.deepEqual(metadata.artifacts.map((entry) => entry.name).sort(), [
    "ZergLang.app.tar.gz",
    "ZergLang.app.tar.gz.sig",
    "ZergLang_0.2.0-preview.1_aarch64.dmg",
  ]);
  for (const artifact of metadata.artifacts) {
    const bytes = await readFile(join(bundle.outputDirectory, artifact.name));
    assert.equal(artifact.sha256, createHash("sha256").update(bytes).digest("hex"));
  }
});

test("rejects extras, missing controls, and request-mismatched platform provenance", async () => {
  const extra = await fixture();
  await writeFile(join(extra.inputDirectory, "unexpected.txt"), "hostile");
  await assert.rejects(
    collectReleasePayload({ ...extra, releaseRepository: "Epoch-ML/zerglang-releases", request }),
    /input must contain exactly .*unexpected\.txt/,
  );

  const wrongSource = await fixture({
    source_sha: "abcdef0123456789abcdef0123456789abcdef01",
  });
  await assert.rejects(
    collectReleasePayload({
      ...wrongSource,
      releaseRepository: "Epoch-ML/zerglang-releases",
      request,
    }),
    /platform source SHA does not match/,
  );

  const unsignedStable = await fixture({ apple_signature: "ad-hoc", apple_notarized: false });
  const stableRequest = {
    ...request,
    channel: "stable",
    version: "0.2.0",
    release_tag: "zerglang-ide-v0.2.0",
    source_ref: "refs/tags/zerglang-ide-v0.2.0",
  };
  await assert.rejects(
    collectReleasePayload({
      ...unsignedStable,
      releaseRepository: "Epoch-ML/zerglang-releases",
      request: stableRequest,
    }),
    /stable payload requires Developer ID signing and notarization/,
  );
});

test("rejects empty binaries and a non-canonical updater signature", async () => {
  const empty = await fixture();
  await writeFile(join(empty.inputDirectory, "ZergLang.app.tar.gz"), "");
  await assert.rejects(
    collectReleasePayload({ ...empty, releaseRepository: "Epoch-ML/zerglang-releases", request }),
    /release artifact is empty: ZergLang\.app\.tar\.gz/,
  );

  const malformed = await fixture();
  await writeFile(join(malformed.inputDirectory, "ZergLang.app.tar.gz.sig"), "%%%not-base64%%%\n");
  await assert.rejects(
    collectReleasePayload({
      ...malformed,
      releaseRepository: "Epoch-ML/zerglang-releases",
      request,
    }),
    /updater signature must use canonical base64/,
  );
});
