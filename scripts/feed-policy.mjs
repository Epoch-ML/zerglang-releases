#!/usr/bin/env node

import { lstat, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { compare, valid } from "semver";

import { verifyReleaseCohort } from "./cohort-payload.mjs";

const MAX_CONTROL_BYTES = 1024 * 1024;
const SEMVER_PATTERN =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const STABLE_VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

export class FeedPolicyError extends Error {
  constructor(message) {
    super(message);
    this.name = "FeedPolicyError";
  }
}

function validateVersion(channel, version) {
  if (typeof version !== "string" || !SEMVER_PATTERN.test(version) || valid(version) === null) {
    throw new FeedPolicyError("version must be strict SemVer without a v prefix");
  }
  if (channel === "stable" && !STABLE_VERSION_PATTERN.test(version)) {
    throw new FeedPolicyError("stable feed versions must use MAJOR.MINOR.PATCH");
  }
}

export function feedDestinations(channel, version) {
  if (channel !== "preview" && channel !== "stable") {
    throw new FeedPolicyError("channel must be preview or stable");
  }
  validateVersion(channel, version);
  return {
    latest: join(channel, "latest.json"),
    metadata: join(channel, "releases", `${version}.json`),
  };
}

export async function stageCohortFeed({
  channel,
  pagesDirectory,
  releaseDirectory,
  trustStorePath,
  version,
}) {
  feedDestinations(channel, version);
  const releaseRoot = resolve(releaseDirectory);
  const pagesRoot = resolve(pagesDirectory);
  const releaseMetadata = await lstat(releaseRoot).catch((error) => {
    if (error?.code === "ENOENT") {
      throw new FeedPolicyError("canonical release directory does not exist");
    }
    throw error;
  });
  if (releaseMetadata.isSymbolicLink() || !releaseMetadata.isDirectory()) {
    throw new FeedPolicyError("canonical release directory must be a real directory");
  }
  const candidateCohort = await readOptionalRegularFile(
    join(releaseRoot, "release-cohort.json"),
    "canonical release cohort",
  );
  const candidateSignature = await readOptionalRegularFile(
    join(releaseRoot, "release-cohort.signature.json"),
    "canonical release cohort signature",
  );
  const candidateTrust = await readOptionalRegularFile(
    resolve(trustStorePath),
    "release trust root",
  );
  if (
    candidateCohort === undefined ||
    candidateSignature === undefined ||
    candidateTrust === undefined
  ) {
    throw new FeedPolicyError("canonical cohort controls are incomplete");
  }
  const cohortObject = parseObject(candidateCohort, "canonical release cohort");
  const signatureObject = parseObject(
    candidateSignature,
    "canonical release cohort signature",
  );
  const trustObject = parseObject(candidateTrust, "release trust root");
  verifyReleaseCohort({
    cohort: cohortObject,
    signature: signatureObject,
    trustStore: trustObject,
  });
  if (cohortObject.channel !== channel || cohortObject.version !== version) {
    throw new FeedPolicyError("canonical cohort provenance does not match the release");
  }

  await ensureDirectory(pagesRoot, "feed root");
  const toolchains = join(pagesRoot, "toolchains");
  const versionRoot = join(toolchains, "v1");
  const channelsRoot = join(versionRoot, "channels");
  const channelRoot = join(channelsRoot, channel);
  const releasesRoot = join(versionRoot, "releases");
  await ensureDirectory(toolchains, "toolchain feed directory");
  await ensureDirectory(versionRoot, "versioned toolchain feed directory");
  await ensureDirectory(channelsRoot, "toolchain channels directory");
  await ensureDirectory(channelRoot, "toolchain channel directory");
  await ensureDirectory(releasesRoot, "toolchain release history directory");

  const trustPath = join(versionRoot, "keys.json");
  const currentTrust = await readOptionalRegularFile(trustPath, "current release trust root");
  if (currentTrust === undefined) {
    await atomicWrite(trustPath, candidateTrust);
  } else if (!candidateTrust.equals(currentTrust)) {
    throw new FeedPolicyError("release trust root must remain byte-identical");
  }

  const historyPath = join(releasesRoot, `${version}.json`);
  const historySignaturePath = join(releasesRoot, `${version}.signature.json`);
  const latestPath = join(channelRoot, "latest.json");
  const latestSignaturePath = join(channelRoot, "latest.signature.json");
  const currentHistory = await readOptionalRegularFile(
    historyPath,
    `cohort history for ${version}`,
  );
  const currentHistorySignature = await readOptionalRegularFile(
    historySignaturePath,
    `cohort signature history for ${version}`,
  );
  if ((currentHistory === undefined) !== (currentHistorySignature === undefined)) {
    throw new FeedPolicyError(`cohort history for ${version} is incomplete`);
  }
  if (currentHistory !== undefined) {
    requireIdentical(candidateCohort, currentHistory, `cohort history for ${version}`);
    requireIdentical(
      candidateSignature,
      currentHistorySignature,
      `cohort signature history for ${version}`,
    );
  }

  const currentLatest = await readOptionalRegularFile(latestPath, "current release cohort");
  const currentLatestSignature = await readOptionalRegularFile(
    latestSignaturePath,
    "current release cohort signature",
  );
  if ((currentLatest === undefined) !== (currentLatestSignature === undefined)) {
    throw new FeedPolicyError("current release cohort feed is incomplete");
  }
  if (currentLatest !== undefined) {
    const currentObject = parseObject(currentLatest, "current release cohort");
    const currentSignatureObject = parseObject(
      currentLatestSignature,
      "current release cohort signature",
    );
    verifyReleaseCohort({
      cohort: currentObject,
      signature: currentSignatureObject,
      trustStore: trustObject,
    });
    if (currentObject.channel !== channel) {
      throw new FeedPolicyError("current release cohort channel does not match");
    }
    const ordering = compare(version, currentObject.version);
    if (ordering < 0) {
      throw new FeedPolicyError(
        `candidate ${version} is older than current ${currentObject.version}`,
      );
    }
    if (ordering === 0 && version !== currentObject.version) {
      throw new FeedPolicyError(
        `feed versions ${version} and ${currentObject.version} have equal precedence but different identities`,
      );
    }
    if (ordering === 0) {
      requireIdentical(candidateCohort, currentLatest, `latest cohort for ${version}`);
      requireIdentical(
        candidateSignature,
        currentLatestSignature,
        `latest cohort signature for ${version}`,
      );
      if (currentHistory === undefined) {
        await atomicWrite(historyPath, candidateCohort);
        await atomicWrite(historySignaturePath, candidateSignature);
      }
      return { status: "unchanged", version };
    }
  }

  if (currentHistory === undefined) {
    await atomicWrite(historyPath, candidateCohort);
    await atomicWrite(historySignaturePath, candidateSignature);
  }
  await atomicWrite(latestSignaturePath, candidateSignature);
  await atomicWrite(latestPath, candidateCohort);
  return { status: "published", version };
}

async function readOptionalRegularFile(path, description) {
  let metadata;
  try {
    metadata = await lstat(path);
  } catch (error) {
    if (error?.code === "ENOENT") return undefined;
    throw error;
  }
  if (metadata.isSymbolicLink() || !metadata.isFile()) {
    throw new FeedPolicyError(`${description} must be a regular file`);
  }
  if (metadata.size === 0 || metadata.size > MAX_CONTROL_BYTES) {
    throw new FeedPolicyError(
      `${description} must contain 1-${MAX_CONTROL_BYTES} bytes`,
    );
  }
  return readFile(path);
}

async function ensureDirectory(path, description) {
  try {
    const metadata = await lstat(path);
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
      throw new FeedPolicyError(`${description} must be a real directory`);
    }
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    await mkdir(path);
  }
}

function parseObject(bytes, description) {
  let value;
  try {
    value = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new FeedPolicyError(`${description} must contain valid JSON`);
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new FeedPolicyError(`${description} must contain a JSON object`);
  }
  return value;
}

function requireIdentical(candidate, current, description) {
  if (!candidate.equals(current)) {
    throw new FeedPolicyError(`${description} must remain byte-identical`);
  }
}

async function atomicWrite(path, bytes) {
  const temporary = `${path}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(temporary, bytes, { flag: "wx", mode: 0o644 });
  await rename(temporary, path);
}

export async function stageReleaseFeed({ channel, pagesDirectory, releaseDirectory, version }) {
  const destinations = feedDestinations(channel, version);
  const releaseRoot = resolve(releaseDirectory);
  const pagesRoot = resolve(pagesDirectory);
  const releaseMetadata = await lstat(releaseRoot).catch((error) => {
    if (error?.code === "ENOENT") {
      throw new FeedPolicyError("canonical release directory does not exist");
    }
    throw error;
  });
  if (releaseMetadata.isSymbolicLink() || !releaseMetadata.isDirectory()) {
    throw new FeedPolicyError("canonical release directory must be a real directory");
  }
  await ensureDirectory(pagesRoot, "feed root");
  await ensureDirectory(join(pagesRoot, channel), "channel feed directory");
  await ensureDirectory(join(pagesRoot, channel, "releases"), "release history directory");

  const candidateLatest = await readOptionalRegularFile(
    join(releaseRoot, "latest.json"),
    "canonical latest manifest",
  );
  const candidateMetadata = await readOptionalRegularFile(
    join(releaseRoot, "release-metadata.json"),
    "canonical release metadata",
  );
  if (candidateLatest === undefined || candidateMetadata === undefined) {
    throw new FeedPolicyError("canonical release controls are incomplete");
  }

  const latestObject = parseObject(candidateLatest, "canonical latest manifest");
  const metadataObject = parseObject(candidateMetadata, "canonical release metadata");
  if (latestObject.version !== version) {
    throw new FeedPolicyError("canonical latest manifest version does not match the release");
  }
  if (metadataObject.version !== version || metadataObject.channel !== channel) {
    throw new FeedPolicyError("canonical release metadata provenance does not match the release");
  }

  const latestPath = join(pagesRoot, destinations.latest);
  const historyPath = join(pagesRoot, destinations.metadata);
  const currentLatest = await readOptionalRegularFile(latestPath, "current channel manifest");
  const currentHistory = await readOptionalRegularFile(historyPath, `history for ${version}`);
  if (currentHistory !== undefined) {
    requireIdentical(candidateMetadata, currentHistory, `history for ${version}`);
  }

  if (currentLatest !== undefined) {
    const currentObject = parseObject(currentLatest, "current channel manifest");
    if (
      typeof currentObject.version !== "string"
      || !SEMVER_PATTERN.test(currentObject.version)
      || valid(currentObject.version) === null
    ) {
      throw new FeedPolicyError("current channel manifest version must be strict SemVer");
    }
    const ordering = compare(version, currentObject.version);
    if (ordering < 0) {
      throw new FeedPolicyError(
        `candidate ${version} is older than current ${currentObject.version}`,
      );
    }
    if (ordering === 0 && version !== currentObject.version) {
      throw new FeedPolicyError(
        `feed versions ${version} and ${currentObject.version} have equal precedence but different identities`,
      );
    }
    if (ordering === 0) {
      requireIdentical(candidateLatest, currentLatest, `latest manifest for ${version}`);
      if (currentHistory === undefined) await atomicWrite(historyPath, candidateMetadata);
      return { status: "unchanged", version };
    }
  }

  if (currentHistory === undefined) await atomicWrite(historyPath, candidateMetadata);
  await atomicWrite(latestPath, candidateLatest);
  return { status: "published", version };
}

async function main() {
  if (process.argv.length !== 6) {
    throw new FeedPolicyError(
      "usage: feed-policy.mjs CHANNEL VERSION RELEASE_DIRECTORY PAGES_DIRECTORY",
    );
  }
  const result = await stageReleaseFeed({
    channel: process.argv[2],
    version: process.argv[3],
    releaseDirectory: process.argv[4],
    pagesDirectory: process.argv[5],
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main().catch((error) => {
    console.error(`feed-policy: ${error.message}`);
    process.exitCode = 1;
  });
}
