import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
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

test("rejects platform metadata fields that could smuggle unsigned policy", async () => {
  const root = await mkdtemp(join(tmpdir(), "zerglang-payload-schema-"));
  temporaryDirectories.push(root);
  const inputDirectory = join(root, "input");
  const outputDirectory = join(root, "output");
  await mkdir(inputDirectory);
  await writeFile(join(inputDirectory, "ZergLang.app.tar.gz"), "archive");
  await writeFile(
    join(inputDirectory, "ZergLang.app.tar.gz.sig"),
    Buffer.alloc(64, 7).toString("base64"),
  );
  await writeFile(
    join(inputDirectory, "ZergLang_0.2.0-preview.1_aarch64.dmg"),
    "disk image",
  );
  await writeFile(join(inputDirectory, "updater.pubkey"), "public root");
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
    allow_unsigned_stable: true,
  })}\n`);

  await assert.rejects(
    collectReleasePayload({
      inputDirectory,
      outputDirectory,
      releaseRepository: "Epoch-ML/zerglang-releases",
      request,
    }),
    /platform metadata contains unexpected fields: allow_unsigned_stable/,
  );
});
