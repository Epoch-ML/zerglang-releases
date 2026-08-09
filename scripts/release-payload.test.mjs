import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { promisify } from "node:util";

import { collectReleasePayload } from "./release-payload.mjs";

const temporaryDirectories = [];
const execFileAsync = promisify(execFile);
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
  assert.equal(metadata.schema_version, 1);
  assert.equal(metadata.product, "ZergLang IDE");
  assert.equal(metadata.platform, "darwin-aarch64");
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
  assert.equal(
    await readFile(join(bundle.outputDirectory, "checksums.txt"), "utf8"),
    metadata.artifacts.map(({ name, sha256 }) => `${sha256}  ${name}\n`).join(""),
  );
  assert.equal(
    manifest.notes,
    `ZergLang IDE preview release from source ${request.source_sha}.`,
  );
  assert.deepEqual(result.assets.map((path) => path.slice(bundle.outputDirectory.length + 1)), [
    "ZergLang.app.tar.gz",
    "ZergLang.app.tar.gz.sig",
    "ZergLang_0.2.0-preview.1_aarch64.dmg",
    "checksums.txt",
    "latest.json",
    "release-metadata.json",
  ]);
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
  await writeFile(
    join(unsignedStable.inputDirectory, "platform-metadata.json"),
    `${JSON.stringify({
      schema_version: 2,
      product: "ZergLang IDE",
      version: stableRequest.version,
      channel: stableRequest.channel,
      release_tag: stableRequest.release_tag,
      source_sha: stableRequest.source_sha,
      platform: "darwin-aarch64",
      apple_signature: "ad-hoc",
      apple_notarized: false,
    }, null, 2)}\n`,
  );
  await writeFile(
    join(unsignedStable.inputDirectory, "ZergLang_0.2.0_aarch64.dmg"),
    await readFile(
      join(unsignedStable.inputDirectory, "ZergLang_0.2.0-preview.1_aarch64.dmg"),
    ),
  );
  await rm(join(unsignedStable.inputDirectory, "ZergLang_0.2.0-preview.1_aarch64.dmg"));
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

test("rejects missing or non-regular inputs and malformed metadata JSON", async () => {
  const missing = await fixture();
  await rm(join(missing.inputDirectory, "updater.pubkey"));
  await assert.rejects(
    collectReleasePayload({
      ...missing,
      releaseRepository: "Epoch-ML/zerglang-releases",
      request,
    }),
    /release input must contain exactly/,
  );

  const directory = await fixture();
  await rm(join(directory.inputDirectory, "updater.pubkey"));
  await mkdir(join(directory.inputDirectory, "updater.pubkey"));
  await assert.rejects(
    collectReleasePayload({
      ...directory,
      releaseRepository: "Epoch-ML/zerglang-releases",
      request,
    }),
    /release input must contain exactly/,
  );

  for (const bytes of ["{not-json}\n", "null\n", "[]\n", '"metadata"\n']) {
    const malformed = await fixture();
    await writeFile(join(malformed.inputDirectory, "platform-metadata.json"), bytes);
    await assert.rejects(
      collectReleasePayload({
        ...malformed,
        releaseRepository: "Epoch-ML/zerglang-releases",
        request,
      }),
      /platform metadata must contain (?:valid JSON|a JSON object)/,
    );
  }
});

test("binds every platform metadata field to exact release provenance", async () => {
  for (const [field, value, message] of [
    ["schema_version", 3, /schema or product is invalid/],
    ["product", "Other IDE", /schema or product is invalid/],
    ["channel", "stable", /platform channel does not match/],
    ["version", "9.9.9", /platform version does not match/],
    ["release_tag", "zerglang-ide-v9.9.9", /platform release tag does not match/],
    ["source_sha", "abcdef0123456789abcdef0123456789abcdef01", /source SHA does not match/],
    ["platform", "darwin-x86_64", /platform platform does not match/],
  ]) {
    const bundle = await fixture({ [field]: value });
    await assert.rejects(
      collectReleasePayload({
        ...bundle,
        releaseRepository: "Epoch-ML/zerglang-releases",
        request,
      }),
      message,
    );
  }
});

test("accepts only the exact Apple-signing state for each channel", async () => {
  for (const overrides of [
    { apple_signature: "developer-id", apple_notarized: false },
    { apple_signature: "ad-hoc", apple_notarized: true },
  ]) {
    const invalidPreview = await fixture(overrides);
    await assert.rejects(
      collectReleasePayload({
        ...invalidPreview,
        releaseRepository: "Epoch-ML/zerglang-releases",
        request,
      }),
      /preview payload requires ad-hoc Apple signing without notarization/,
    );
  }

  const stableRequest = {
    ...request,
    channel: "stable",
    version: "0.2.0",
    release_tag: "zerglang-ide-v0.2.0",
    source_ref: "refs/tags/zerglang-ide-v0.2.0",
  };
  for (const overrides of [
    { apple_signature: "ad-hoc", apple_notarized: true },
    { apple_signature: "developer-id", apple_notarized: false },
  ]) {
    const invalidStable = await fixture({
      version: stableRequest.version,
      channel: stableRequest.channel,
      release_tag: stableRequest.release_tag,
      ...overrides,
    });
    await writeFile(
      join(invalidStable.inputDirectory, "ZergLang_0.2.0_aarch64.dmg"),
      await readFile(
        join(invalidStable.inputDirectory, "ZergLang_0.2.0-preview.1_aarch64.dmg"),
      ),
    );
    await rm(join(invalidStable.inputDirectory, "ZergLang_0.2.0-preview.1_aarch64.dmg"));
    await assert.rejects(
      collectReleasePayload({
        ...invalidStable,
        releaseRepository: "Epoch-ML/zerglang-releases",
        request: stableRequest,
      }),
      /stable payload requires Developer ID signing and notarization/,
    );
  }

  const stable = await fixture({
    version: stableRequest.version,
    channel: stableRequest.channel,
    release_tag: stableRequest.release_tag,
    apple_signature: "developer-id",
    apple_notarized: true,
  });
  await writeFile(
    join(stable.inputDirectory, "ZergLang_0.2.0_aarch64.dmg"),
    await readFile(join(stable.inputDirectory, "ZergLang_0.2.0-preview.1_aarch64.dmg")),
  );
  await rm(join(stable.inputDirectory, "ZergLang_0.2.0-preview.1_aarch64.dmg"));
  await collectReleasePayload({
    ...stable,
    releaseRepository: "Epoch-ML/zerglang-releases",
    request: stableRequest,
  });
  const metadata = JSON.parse(
    await readFile(join(stable.outputDirectory, "release-metadata.json"), "utf8"),
  );
  assert.equal(metadata.apple_notarized, true);
  assert.deepEqual((await readdir(stable.outputDirectory)).sort(), [
    "ZergLang.app.tar.gz",
    "ZergLang.app.tar.gz.sig",
    "ZergLang_0.2.0_aarch64.dmg",
    "checksums.txt",
    "latest.json",
    "release-metadata.json",
  ]);
});

test("enforces canonical updater signature length and output/repository boundaries", async () => {
  const shortSignature = await fixture();
  await writeFile(
    join(shortSignature.inputDirectory, "ZergLang.app.tar.gz.sig"),
    Buffer.alloc(31, 1).toString("base64"),
  );
  await assert.rejects(
    collectReleasePayload({
      ...shortSignature,
      releaseRepository: "Epoch-ML/zerglang-releases",
      request,
    }),
    /canonical base64/,
  );

  const noncanonicalSignature = await fixture();
  await writeFile(
    join(noncanonicalSignature.inputDirectory, "ZergLang.app.tar.gz.sig"),
    `${Buffer.alloc(32, 1).toString("base64")}=`,
  );
  await assert.rejects(
    collectReleasePayload({
      ...noncanonicalSignature,
      releaseRepository: "Epoch-ML/zerglang-releases",
      request,
    }),
    /canonical base64/,
  );

  const exactSignature = await fixture();
  await writeFile(
    join(exactSignature.inputDirectory, "ZergLang.app.tar.gz.sig"),
    Buffer.alloc(32, 2).toString("base64"),
  );
  const exact = await collectReleasePayload({
    ...exactSignature,
    releaseRepository: "Epoch-ML/zerglang-releases",
    request,
  });
  assert.equal(exact.assets.length, 6);

  const wrongRepository = await fixture();
  await assert.rejects(
    collectReleasePayload({
      ...wrongRepository,
      releaseRepository: "attacker/releases",
      request,
    }),
    /release repository must equal Epoch-ML\/zerglang-releases/,
  );

  const existingOutput = await fixture();
  await mkdir(existingOutput.outputDirectory);
  await assert.rejects(
    collectReleasePayload({
      ...existingOutput,
      releaseRepository: "Epoch-ML/zerglang-releases",
      request,
    }),
    /EEXIST|file already exists/i,
  );
});

test("the command-line collector emits the exact asset count", async () => {
  const bundle = await fixture();
  const requestPath = join(bundle.root, "request.json");
  await writeFile(requestPath, `${JSON.stringify(request)}\n`);
  const script = new URL("./release-payload.mjs", import.meta.url);
  const result = await execFileAsync(process.execPath, [
    script.pathname,
    requestPath,
    bundle.inputDirectory,
    bundle.outputDirectory,
  ]);

  assert.deepEqual(JSON.parse(result.stdout), { assetCount: 6 });
  assert.equal((await readdir(bundle.outputDirectory)).length, 6);

  await assert.rejects(
    execFileAsync(process.execPath, [script.pathname]),
    (error) => error.code === 1 && /usage: release-payload\.mjs/.test(error.stderr),
  );
});
