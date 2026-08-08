#!/usr/bin/env node

import { lstat, readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const EXPECTED_FIELDS = [
  "channel",
  "product",
  "release_tag",
  "requested_at",
  "schema_version",
  "source_ref",
  "source_repository",
  "source_sha",
  "version",
];
const MAX_REQUEST_BYTES = 16 * 1024;
const SEMVER_PATTERN =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const STABLE_SEMVER_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const SOURCE_SHA_PATTERN = /^[0-9a-f]{40}$/;
const UTC_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

export class ReleaseRequestError extends Error {
  constructor(message) {
    super(message);
    this.name = "ReleaseRequestError";
  }
}

function requireString(value, field) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new ReleaseRequestError(`${field} must be a non-empty string`);
  }
  if (value !== value.trim()) {
    throw new ReleaseRequestError(`${field} must not contain surrounding whitespace`);
  }
  return value;
}

export function expectedReleaseTag(channel, version) {
  return channel === "stable"
    ? `zerglang-ide-v${version}`
    : `zerglang-ide-preview-v${version}`;
}

export function validateReleaseRequest(request) {
  if (request === null || typeof request !== "object" || Array.isArray(request)) {
    throw new ReleaseRequestError("release request must be a JSON object");
  }

  const actualFields = Object.keys(request).sort();
  const missingFields = EXPECTED_FIELDS.filter((field) => !actualFields.includes(field));
  if (missingFields.length > 0) {
    throw new ReleaseRequestError(`missing required field: ${missingFields[0]}`);
  }
  const unexpectedFields = actualFields.filter((field) => !EXPECTED_FIELDS.includes(field));
  if (unexpectedFields.length > 0) {
    throw new ReleaseRequestError(`unexpected field: ${unexpectedFields[0]}`);
  }

  if (request.schema_version !== 1) {
    throw new ReleaseRequestError("schema_version must equal 1");
  }
  if (request.product !== "ZergLang IDE") {
    throw new ReleaseRequestError("product must equal ZergLang IDE");
  }
  if (request.source_repository !== "Epoch-ML/zerg") {
    throw new ReleaseRequestError("source_repository must equal Epoch-ML/zerg");
  }
  if (request.channel !== "preview" && request.channel !== "stable") {
    throw new ReleaseRequestError("channel must be preview or stable");
  }

  const version = requireString(request.version, "version");
  if (!SEMVER_PATTERN.test(version)) {
    throw new ReleaseRequestError("version must be strict SemVer without a v prefix");
  }
  if (request.channel === "stable" && !STABLE_SEMVER_PATTERN.test(version)) {
    throw new ReleaseRequestError(
      "stable versions must use MAJOR.MINOR.PATCH without prerelease or build metadata",
    );
  }

  const sourceSha = requireString(request.source_sha, "source_sha");
  if (!SOURCE_SHA_PATTERN.test(sourceSha)) {
    throw new ReleaseRequestError(
      "source_sha must contain exactly 40 lowercase hexadecimal characters",
    );
  }

  const expectedTag = expectedReleaseTag(request.channel, version);
  if (request.release_tag !== expectedTag) {
    throw new ReleaseRequestError(`release_tag must equal ${expectedTag}`);
  }
  const expectedRef = `refs/tags/${expectedTag}`;
  if (request.source_ref !== expectedRef) {
    throw new ReleaseRequestError(`source_ref must equal ${expectedRef}`);
  }

  const requestedAt = requireString(request.requested_at, "requested_at");
  if (
    !UTC_TIMESTAMP_PATTERN.test(requestedAt) ||
    Number.isNaN(Date.parse(requestedAt)) ||
    new Date(requestedAt).toISOString() !== requestedAt
  ) {
    throw new ReleaseRequestError(
      "requested_at must be an ISO-8601 UTC timestamp with milliseconds",
    );
  }

  return {
    schema_version: 1,
    product: "ZergLang IDE",
    channel: request.channel,
    version,
    release_tag: expectedTag,
    source_repository: "Epoch-ML/zerg",
    source_sha: sourceSha,
    source_ref: expectedRef,
    requested_at: requestedAt,
  };
}

export async function readReleaseRequest(path) {
  const metadata = await lstat(path);
  if (metadata.isSymbolicLink() || !metadata.isFile()) {
    throw new ReleaseRequestError("release request path must identify a regular file");
  }
  if (metadata.size > MAX_REQUEST_BYTES) {
    throw new ReleaseRequestError(`release request exceeds ${MAX_REQUEST_BYTES} bytes`);
  }

  let parsed;
  try {
    parsed = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    throw new ReleaseRequestError(`release request is not valid JSON: ${error.message}`);
  }
  return validateReleaseRequest(parsed);
}

async function main() {
  if (process.argv.length !== 3) {
    throw new ReleaseRequestError("usage: release-request.mjs REQUEST.json");
  }
  const request = await readReleaseRequest(process.argv[2]);
  process.stdout.write(`${JSON.stringify(request, null, 2)}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(`release-request: ${error.message}`);
    process.exitCode = 1;
  });
}
