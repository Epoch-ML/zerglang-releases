#!/usr/bin/env node

import { createHash } from "node:crypto";
import { copyFile, lstat, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
  buildReleaseCohort,
  canonicalJson,
  verifyReleaseCohort,
} from "./cohort-payload.mjs";
import { readReleaseRequest, validateReleaseRequest } from "./release-request.mjs";

const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const MAX_CONTROL_BYTES = 2 * 1024 * 1024;
const MAX_ASSET_BYTES = 2 * 1024 * 1024 * 1024;

async function assertExactRegularFiles(directory, expectedNames) {
  const entries = await readdir(directory, { withFileTypes: true });
  const actualNames = entries.map((entry) => entry.name).sort();
  const expected = [...expectedNames].sort();
  const invalid = entries.filter((entry) => !entry.isFile()).map((entry) => entry.name);
  if (invalid.length !== 0 || JSON.stringify(actualNames) !== JSON.stringify(expected)) {
    throw new Error(
      `release input must contain exactly ${expected.join(", ")}; found ${actualNames.join(", ")}`,
    );
  }
}

async function requireNonemptyRegularFile(path, maximum = MAX_ASSET_BYTES) {
  const metadata = await lstat(path);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error(`release artifact must be a regular file: ${basename(path)}`);
  }
  if (metadata.size === 0) throw new Error(`release artifact is empty: ${basename(path)}`);
  if (metadata.size > maximum) throw new Error(`release artifact is too large: ${basename(path)}`);
  return metadata;
}

function parseObject(bytes, description) {
  let value;
  try {
    value = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error(`${description} must contain valid JSON`);
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${description} must contain a JSON object`);
  }
  return value;
}

function exactFields(value, fields, description) {
  const expected = [...fields].sort();
  const actual = Object.keys(value).sort();
  const unexpected = actual.filter((field) => !expected.includes(field));
  if (unexpected.length !== 0) {
    throw new Error(`${description} contains unexpected fields: ${unexpected.join(", ")}`);
  }
  const missing = expected.filter((field) => !actual.includes(field));
  if (missing.length !== 0) {
    throw new Error(`${description} is missing required fields: ${missing.join(", ")}`);
  }
}

function requireSigningState(metadata, request, description) {
  if (request.channel === "stable") {
    if (metadata.apple_signature !== "developer-id" || metadata.apple_notarized !== true) {
      throw new Error(`stable ${description} requires Developer ID signing and notarization`);
    }
  } else if (metadata.apple_signature !== "ad-hoc" || metadata.apple_notarized !== false) {
    throw new Error(`preview ${description} requires ad-hoc Apple signing without notarization`);
  }
}

function validatePlatformMetadata(metadata, request) {
  exactFields(metadata, [
    "apple_notarized",
    "apple_signature",
    "channel",
    "platform",
    "product",
    "release_tag",
    "schema_version",
    "source_sha",
    "version",
  ], "platform metadata");
  if (metadata.schema_version !== 2 || metadata.product !== "ZergLang IDE") {
    throw new Error("platform metadata schema or product is invalid");
  }
  const expected = {
    channel: request.channel,
    platform: "darwin-aarch64",
    release_tag: request.release_tag,
    source_sha: request.source_sha,
    version: request.version,
  };
  const labels = {
    channel: "channel",
    platform: "platform",
    release_tag: "release tag",
    source_sha: "source SHA",
    version: "version",
  };
  for (const [field, value] of Object.entries(expected)) {
    if (metadata[field] !== value) {
      throw new Error(`platform ${labels[field]} does not match the release request`);
    }
  }
  requireSigningState(metadata, request, "payload");
}

function validateToolchainMetadata(metadata, request) {
  exactFields(metadata, [
    "apple_notarized",
    "apple_signature",
    "channel",
    "product",
    "release_tag",
    "schema",
    "source_sha",
    "target",
    "version",
  ], "toolchain metadata");
  if (
    metadata.schema !== "zerglang.toolchain-platform/1" ||
    metadata.product !== "ZergLang toolchain"
  ) {
    throw new Error("toolchain metadata schema or product is invalid");
  }
  const expected = {
    channel: request.channel,
    release_tag: request.release_tag,
    source_sha: request.source_sha,
    target: "aarch64-apple-darwin",
    version: request.version,
  };
  for (const [field, value] of Object.entries(expected)) {
    if (metadata[field] !== value) {
      throw new Error(`toolchain ${field.replaceAll("_", " ")} does not match the release request`);
    }
  }
  requireSigningState(metadata, request, "toolchain");
}

function canonicalBase64(text) {
  const value = text.trim();
  if (value.length === 0 || /\s/.test(value) || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) {
    throw new Error("updater signature must use canonical base64");
  }
  const decoded = Buffer.from(value, "base64");
  if (decoded.length < 32 || decoded.toString("base64") !== value) {
    throw new Error("updater signature must use canonical base64");
  }
  return value;
}

async function digest(path) {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

export async function collectReleasePayload(options) {
  const inputDirectory = resolve(options.inputDirectory);
  const outputDirectory = resolve(options.outputDirectory);
  const request = validateReleaseRequest(options.request);
  const releaseRepository = options.releaseRepository;
  if (releaseRepository !== "Epoch-ML/zerglang-releases") {
    throw new Error("release repository must equal Epoch-ML/zerglang-releases");
  }
  const archiveName = "ZergLang.app.tar.gz";
  const signatureName = `${archiveName}.sig`;
  const dmgName = `ZergLang_${request.version}_aarch64.dmg`;
  const toolchainName =
    `zerglang-toolchain-${request.version}-aarch64-apple-darwin.tar.gz`;
  const cohortName = "release-cohort.json";
  const cohortSignatureName = "release-cohort.signature.json";
  const inputNames = new Set([
    archiveName,
    signatureName,
    dmgName,
    toolchainName,
    "platform-metadata.json",
    "release-signing-keys.json",
    cohortName,
    cohortSignatureName,
    "toolchain-metadata.json",
    "updater.pubkey",
  ]);
  await assertExactRegularFiles(inputDirectory, inputNames);
  for (const name of inputNames) {
    const maximum = name.endsWith(".json") || name.endsWith(".sig") || name === "updater.pubkey"
      ? MAX_CONTROL_BYTES
      : MAX_ASSET_BYTES;
    await requireNonemptyRegularFile(join(inputDirectory, name), maximum);
  }

  const platformMetadata = parseObject(
    await readFile(join(inputDirectory, "platform-metadata.json")),
    "platform metadata",
  );
  validatePlatformMetadata(platformMetadata, request);
  const toolchainMetadata = parseObject(
    await readFile(join(inputDirectory, "toolchain-metadata.json")),
    "toolchain metadata",
  );
  validateToolchainMetadata(toolchainMetadata, request);
  const signature = canonicalBase64(
    await readFile(join(inputDirectory, signatureName), "utf8"),
  );
  const cohort = parseObject(
    await readFile(join(inputDirectory, cohortName)),
    "release cohort",
  );
  const cohortSignature = parseObject(
    await readFile(join(inputDirectory, cohortSignatureName)),
    "release cohort signature",
  );
  const trustStore = parseObject(
    await readFile(join(inputDirectory, "release-signing-keys.json")),
    "release trust store",
  );
  verifyReleaseCohort({ cohort, signature: cohortSignature, trustStore });
  const expectedCohort = await buildReleaseCohort({
    request,
    ideAssetPath: join(inputDirectory, dmgName),
    toolchainArchivePath: join(inputDirectory, toolchainName),
    releaseRepository,
  });
  if (canonicalJson(cohort) !== canonicalJson(expectedCohort)) {
    const expectedToolchain = expectedCohort.products.toolchain.asset;
    const observedToolchain = cohort.products?.toolchain?.asset;
    if (observedToolchain?.sha256 !== expectedToolchain.sha256) {
      throw new Error("toolchain archive digest does not match the signed cohort");
    }
    if (observedToolchain?.size !== expectedToolchain.size) {
      throw new Error("toolchain archive size does not match the signed cohort");
    }
    throw new Error("signed release cohort does not match the immutable release request and assets");
  }

  await mkdir(outputDirectory, { recursive: false });
  const artifactNames = [
    archiveName,
    signatureName,
    dmgName,
    toolchainName,
    "toolchain-metadata.json",
    cohortName,
    cohortSignatureName,
  ].sort();
  for (const name of artifactNames) {
    await copyFile(join(inputDirectory, name), join(outputDirectory, name));
  }
  const artifacts = [];
  for (const name of artifactNames) {
    const sha256 = await digest(join(outputDirectory, name));
    if (!SHA256_PATTERN.test(sha256)) throw new Error(`invalid SHA-256 for ${name}`);
    artifacts.push({ name, sha256 });
  }
  await writeFile(
    join(outputDirectory, "checksums.txt"),
    artifacts.map((artifact) => `${artifact.sha256}  ${artifact.name}\n`).join(""),
  );

  const releaseMetadata = {
    apple_notarized: platformMetadata.apple_notarized && toolchainMetadata.apple_notarized,
    artifacts,
    channel: request.channel,
    products: ["ide", "toolchain"],
    schema: "zerglang.release-metadata/2",
    source_sha: request.source_sha,
    target: "aarch64-apple-darwin",
    version: request.version,
  };
  await writeFile(
    join(outputDirectory, "release-metadata.json"),
    `${JSON.stringify(releaseMetadata, null, 2)}\n`,
  );

  const encodedTag = encodeURIComponent(request.release_tag);
  const encodedArchive = encodeURIComponent(archiveName);
  const manifest = {
    version: request.version,
    notes: `ZergLang IDE ${request.channel} release from source ${request.source_sha}.`,
    pub_date: request.requested_at,
    platforms: {
      "darwin-aarch64": {
        signature,
        url: `https://github.com/${releaseRepository}/releases/download/${encodedTag}/${encodedArchive}`,
      },
    },
  };
  await writeFile(join(outputDirectory, "latest.json"), `${JSON.stringify(manifest, null, 2)}\n`);

  return {
    assets: [
      ...artifactNames,
      "checksums.txt",
      "latest.json",
      "release-metadata.json",
    ].map((name) => join(outputDirectory, name)),
  };
}

async function main() {
  if (process.argv.length !== 5) {
    throw new Error("usage: release-payload.mjs REQUEST.json INPUT_DIRECTORY OUTPUT_DIRECTORY");
  }
  const request = await readReleaseRequest(process.argv[2]);
  const result = await collectReleasePayload({
    request,
    inputDirectory: process.argv[3],
    outputDirectory: process.argv[4],
    releaseRepository: "Epoch-ML/zerglang-releases",
  });
  process.stdout.write(`${JSON.stringify({ assetCount: result.assets.length })}\n`);
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main().catch((error) => {
    console.error(`release-payload: ${error.message}`);
    process.exitCode = 1;
  });
}
