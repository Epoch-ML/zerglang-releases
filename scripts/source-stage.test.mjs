import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";

import { create } from "tar";

import { extractSourceApplication, packageMacApplication } from "./package-macos.mjs";
import { prepareSourceStage } from "./source-stage.mjs";

const temporaryDirectories = [];
const sourceSha = "0123456789abcdef0123456789abcdef01234567";
const request = {
  channel: "preview",
  release_tag: "zerglang-ide-preview-v0.2.0-preview.1",
  source_sha: sourceSha,
  version: "0.2.0-preview.1",
};

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "zerglang-source-stage-"));
  temporaryDirectories.push(root);
  const app = join(root, "application", "ZergLang.app");
  await mkdir(join(app, "Contents", "MacOS"), { recursive: true });
  await writeFile(join(app, "Contents", "Info.plist"), "plist bytes\n");
  const executable = join(app, "Contents", "MacOS", "ZergLang");
  await writeFile(executable, "native bytes");
  await chmod(executable, 0o755);
  const inputDirectory = join(root, "input");
  const outputDirectory = join(root, "output");
  await mkdir(inputDirectory);
  await packageMacApplication({
    applicationPath: app,
    outputPath: join(inputDirectory, "ZergLang_0.2.0-preview.1_aarch64.source.app.tar.gz"),
  });
  const key = "preview updater public root\n";
  await writeFile(join(inputDirectory, "updater.pubkey"), key);
  const publicKeyPath = join(root, "trusted.pubkey");
  await writeFile(publicKeyPath, key);
  await writeFile(join(inputDirectory, "build-metadata.json"), `${JSON.stringify({
    schema_version: 2,
    product: "ZergLang IDE",
    version: request.version,
    channel: request.channel,
    release_tag: request.release_tag,
    source_sha: request.source_sha,
    platform: "darwin-aarch64",
    apple_signature: "none",
  }, null, 2)}\n`);
  return { app, inputDirectory, outputDirectory, publicKeyPath, request, root };
}

test("packages and extracts one bounded regular ZergLang application tree", async () => {
  const bundle = await fixture();
  const result = await extractSourceApplication({
    archivePath: join(bundle.inputDirectory, "ZergLang_0.2.0-preview.1_aarch64.source.app.tar.gz"),
    outputDirectory: bundle.outputDirectory,
  });

  assert.equal(result.applicationPath, join(bundle.outputDirectory, "ZergLang.app"));
  assert.equal(
    await readFile(join(result.applicationPath, "Contents", "MacOS", "ZergLang"), "utf8"),
    "native bytes",
  );
  assert.ok(result.entryCount >= 4);
  assert.ok(result.uncompressedBytes >= Buffer.byteLength("native bytes"));
});

test("binds the hostile source stage to request provenance and the channel root", async () => {
  const bundle = await fixture();
  const result = await prepareSourceStage(bundle);

  assert.equal(result.applicationPath, join(bundle.outputDirectory, "ZergLang.app"));
  assert.equal(result.metadata.source_sha, sourceSha);
  assert.equal(result.metadata.apple_signature, "none");

  const wrongKey = await fixture();
  await writeFile(join(wrongKey.inputDirectory, "updater.pubkey"), "other root\n");
  await assert.rejects(prepareSourceStage(wrongKey), /does not match the channel trust root/);

  const extra = await fixture();
  await writeFile(join(extra.inputDirectory, "unexpected.txt"), "hostile");
  await assert.rejects(prepareSourceStage(extra), /unexpected entries: unexpected\.txt/);
});

test("rejects symlink input and path traversal before extraction", async () => {
  const linked = await fixture();
  await symlink(
    "Contents/Info.plist",
    join(linked.app, "linked-plist"),
  );
  await assert.rejects(
    packageMacApplication({
      applicationPath: linked.app,
      outputPath: join(linked.root, "linked.app.tar.gz"),
    }),
    /symbolic link/,
  );

  const hostileRoot = await mkdtemp(join(tmpdir(), "zerglang-hostile-archive-"));
  temporaryDirectories.push(hostileRoot);
  await writeFile(join(hostileRoot, "payload"), "escape");
  const archive = join(hostileRoot, "hostile.app.tar.gz");
  await create(
    { cwd: hostileRoot, file: archive, gzip: true, portable: true },
    ["payload"],
  );
  await assert.rejects(
    extractSourceApplication({ archivePath: archive, outputDirectory: join(hostileRoot, "out") }),
    /archive path must remain under ZergLang\.app/,
  );
});

test("rejects a source stage whose metadata can redirect signing", async () => {
  for (const [field, value, message] of [
    ["source_sha", "abcdef0123456789abcdef0123456789abcdef01", /source SHA does not match/],
    ["release_tag", "zerglang-ide-preview-v9.9.9", /release tag does not match/],
    ["apple_signature", "developer-id", /Apple signature state does not match/],
    ["platform", "darwin-x86_64", /platform does not match/],
  ]) {
    const bundle = await fixture();
    const metadataPath = join(bundle.inputDirectory, "build-metadata.json");
    const metadata = JSON.parse(await readFile(metadataPath, "utf8"));
    metadata[field] = value;
    await writeFile(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`);
    await assert.rejects(prepareSourceStage(bundle), message);
  }
});
