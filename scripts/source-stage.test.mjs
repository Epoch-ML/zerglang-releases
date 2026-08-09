import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { promisify } from "node:util";

import { create } from "tar";

import { extractSourceApplication, packageMacApplication } from "./package-macos.mjs";
import { prepareSourceStage } from "./source-stage.mjs";

const temporaryDirectories = [];
const execFileAsync = promisify(execFile);
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
  assert.notEqual(
    (await stat(join(result.applicationPath, "Contents", "MacOS", "ZergLang"))).mode & 0o111,
    0,
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

  const linkedRoot = await fixture();
  const applicationLink = join(linkedRoot.root, "Linked.app");
  await symlink(linkedRoot.app, applicationLink);
  await assert.rejects(
    packageMacApplication({
      applicationPath: applicationLink,
      outputPath: join(linkedRoot.root, "linked-root.app.tar.gz"),
    }),
    /one existing \.app directory/,
  );

  const special = await fixture();
  await execFileAsync("/usr/bin/mkfifo", [join(special.app, "hostile-pipe")]);
  await assert.rejects(
    packageMacApplication({
      applicationPath: special.app,
      outputPath: join(special.root, "special.app.tar.gz"),
    }),
    /source application contains a special entry/,
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
    ["schema_version", 3, /metadata schema or product is invalid/],
    ["product", "Other IDE", /metadata schema or product is invalid/],
    ["channel", "stable", /channel does not match/],
    ["version", "9.9.9", /version does not match/],
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

  const extraPolicy = await fixture();
  const metadataPath = join(extraPolicy.inputDirectory, "build-metadata.json");
  const metadata = JSON.parse(await readFile(metadataPath, "utf8"));
  metadata.allow_unsigned_stable = true;
  await writeFile(metadataPath, `${JSON.stringify(metadata)}\n`);
  await assert.rejects(
    prepareSourceStage(extraPolicy),
    /metadata contains unexpected fields: allow_unsigned_stable/,
  );
});

test("rejects incomplete, linked, malformed, and unselected source stages", async () => {
  const missing = await fixture();
  await rm(join(missing.inputDirectory, "updater.pubkey"));
  await assert.rejects(prepareSourceStage(missing), /missing required entries: updater\.pubkey/);

  const linked = await fixture();
  await rm(join(linked.inputDirectory, "updater.pubkey"));
  await symlink(linked.publicKeyPath, join(linked.inputDirectory, "updater.pubkey"));
  await assert.rejects(prepareSourceStage(linked), /unexpected entries: updater\.pubkey/);

  const malformed = await fixture();
  await writeFile(join(malformed.inputDirectory, "build-metadata.json"), "{not-json}\n");
  await assert.rejects(prepareSourceStage(malformed), /Unexpected token|JSON/);

  for (const options of [
    { inputDirectory: "", outputDirectory: "output", publicKeyPath: "key", request },
    { inputDirectory: "input", outputDirectory: " ", publicKeyPath: "key", request },
    { inputDirectory: "input", outputDirectory: "output", publicKeyPath: null, request },
    {
      inputDirectory: "input",
      outputDirectory: "output",
      publicKeyPath: "key",
      request: { ...request, version: null },
    },
  ]) {
    await assert.rejects(prepareSourceStage(options), /is required/);
  }
});

test("packages deterministically and enforces exact resource budget boundaries", async () => {
  const bundle = await fixture();
  const firstArchive = join(bundle.root, "first.app.tar.gz");
  const secondArchive = join(bundle.root, "second.app.tar.gz");
  const first = await packageMacApplication({
    applicationPath: bundle.app,
    outputPath: firstArchive,
  });
  const archiveBytes = (await stat(firstArchive)).size;
  const second = await packageMacApplication({
    applicationPath: bundle.app,
    outputPath: secondArchive,
    maxArchiveBytes: archiveBytes,
    maxEntryCount: first.entryCount,
    maxFileBytes: Buffer.byteLength("plist bytes\n"),
    maxUncompressedBytes: first.uncompressedBytes,
  });

  assert.deepEqual(await readFile(secondArchive), await readFile(firstArchive));
  assert.deepEqual(second, {
    entryCount: first.entryCount,
    outputPath: secondArchive,
    uncompressedBytes: first.uncompressedBytes,
  });

  const extraction = await extractSourceApplication({
    archivePath: secondArchive,
    outputDirectory: join(bundle.root, "exact-output"),
    maxArchiveBytes: archiveBytes,
    maxEntryCount: first.entryCount,
    maxFileBytes: Buffer.byteLength("plist bytes\n"),
    maxUncompressedBytes: first.uncompressedBytes,
  });
  assert.equal(extraction.entryCount, first.entryCount);
  assert.equal(extraction.uncompressedBytes, first.uncompressedBytes);
});

test("rejects invalid and exceeded package resource budgets", async () => {
  const invalid = await fixture();
  for (const [field, value] of [
    ["maxArchiveBytes", 0],
    ["maxEntryCount", -1],
    ["maxFileBytes", 1.5],
    ["maxUncompressedBytes", Number.MAX_SAFE_INTEGER + 1],
  ]) {
    await assert.rejects(
      packageMacApplication({
        applicationPath: invalid.app,
        outputPath: join(invalid.root, `${field}.app.tar.gz`),
        [field]: value,
      }),
      /must be a positive safe integer/,
    );
  }

  for (const [field, value, message] of [
    ["maxEntryCount", 1, /archive entry count exceeds 1/],
    ["maxFileBytes", 1, /archive file exceeds 1 bytes/],
    ["maxUncompressedBytes", 1, /archive uncompressed size exceeds 1 bytes/],
    ["maxArchiveBytes", 1, /archive exceeds 1 bytes/],
  ]) {
    const bundle = await fixture();
    const outputPath = join(bundle.root, `${field}-exceeded.app.tar.gz`);
    await assert.rejects(
      packageMacApplication({
        applicationPath: bundle.app,
        outputPath,
        [field]: value,
      }),
      message,
    );
    if (field === "maxArchiveBytes") {
      await assert.rejects(stat(outputPath), (error) => error.code === "ENOENT");
    }
  }
});

test("rejects unsafe package and extraction paths before writing output", async () => {
  const bundle = await fixture();
  for (const options of [
    { applicationPath: "", outputPath: join(bundle.root, "empty.app.tar.gz") },
    { applicationPath: join(bundle.root, "missing.app"), outputPath: join(bundle.root, "missing.app.tar.gz") },
    { applicationPath: bundle.root, outputPath: join(bundle.root, "directory.app.tar.gz") },
    { applicationPath: bundle.app, outputPath: join(bundle.app, "nested.app.tar.gz") },
    { applicationPath: bundle.app, outputPath: join(bundle.root, "wrong.tar.gz") },
  ]) {
    await assert.rejects(packageMacApplication(options), /required|existing \.app|outside|must end/);
  }

  const archivePath = join(bundle.inputDirectory, "ZergLang_0.2.0-preview.1_aarch64.source.app.tar.gz");
  const existingOutput = join(bundle.root, "existing-output");
  await mkdir(existingOutput);
  await assert.rejects(
    extractSourceApplication({ archivePath, outputDirectory: existingOutput }),
    /must not already exist/,
  );
  await assert.rejects(
    extractSourceApplication({ archivePath, outputDirectory: "/" }),
    /extraction output directory is unsafe/,
  );
  await assert.rejects(
    extractSourceApplication({
      archivePath: join(existingOutput, "inside.app.tar.gz"),
      outputDirectory: existingOutput,
    }),
    /extraction output directory is unsafe/,
  );

  const linkedArchive = join(bundle.root, "linked.app.tar.gz");
  await symlink(archivePath, linkedArchive);
  await assert.rejects(
    extractSourceApplication({
      archivePath: linkedArchive,
      outputDirectory: join(bundle.root, "linked-output"),
    }),
    /regular non-symlink file/,
  );
  await assert.rejects(
    extractSourceApplication({
      archivePath: bundle.app,
      outputDirectory: join(bundle.root, "directory-archive-output"),
    }),
    /regular non-symlink file/,
  );
});

test("rejects duplicate and symbolic-link archive entries during preflight", async () => {
  const bundle = await fixture();
  const duplicateArchive = join(bundle.root, "duplicate.app.tar.gz");
  await create(
    { cwd: join(bundle.root, "application"), file: duplicateArchive, gzip: true, portable: true },
    ["ZergLang.app", "ZergLang.app/Contents/Info.plist"],
  );
  await assert.rejects(
    extractSourceApplication({
      archivePath: duplicateArchive,
      outputDirectory: join(bundle.root, "duplicate-output"),
    }),
    /archive contains a duplicate path/,
  );

  const linkedRoot = await mkdtemp(join(tmpdir(), "zerglang-linked-archive-"));
  temporaryDirectories.push(linkedRoot);
  const linkedApp = join(linkedRoot, "ZergLang.app");
  await mkdir(linkedApp);
  await writeFile(join(linkedRoot, "outside"), "outside bytes");
  await symlink("../outside", join(linkedApp, "linked"));
  const linkedEntryArchive = join(linkedRoot, "linked-entry.app.tar.gz");
  await create(
    { cwd: linkedRoot, file: linkedEntryArchive, gzip: true, portable: true },
    ["ZergLang.app"],
  );
  await assert.rejects(
    extractSourceApplication({
      archivePath: linkedEntryArchive,
      outputDirectory: join(linkedRoot, "output"),
    }),
    /archive entries must be regular files or directories/,
  );

  const fileRoot = await mkdtemp(join(tmpdir(), "zerglang-file-root-archive-"));
  temporaryDirectories.push(fileRoot);
  await writeFile(join(fileRoot, "ZergLang.app"), "not a bundle directory");
  const fileRootArchive = join(fileRoot, "file-root.app.tar.gz");
  await create(
    { cwd: fileRoot, file: fileRootArchive, gzip: true, portable: true },
    ["ZergLang.app"],
  );
  await assert.rejects(
    extractSourceApplication({
      archivePath: fileRootArchive,
      outputDirectory: join(fileRoot, "output"),
    }),
    /archive ZergLang\.app root must be a directory/,
  );
});

test("the package command writes one bounded archive and rejects missing arguments", async () => {
  const bundle = await fixture();
  const script = new URL("./package-macos.mjs", import.meta.url);
  const outputPath = join(bundle.root, "cli.app.tar.gz");
  const success = await execFileAsync(process.execPath, [
    script.pathname,
    bundle.app,
    outputPath,
  ]);
  const result = JSON.parse(success.stdout);
  assert.equal(result.outputPath, outputPath);
  assert.ok(result.entryCount >= 5);
  assert.ok((await stat(outputPath)).size > 0);

  await assert.rejects(
    execFileAsync(process.execPath, [script.pathname]),
    (error) => error.code === 1 && /usage: package-macos\.mjs/.test(error.stderr),
  );
});
