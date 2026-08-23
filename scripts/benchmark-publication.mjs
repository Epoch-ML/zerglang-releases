#!/usr/bin/env node

import {
  createHash,
  createPrivateKey,
  createPublicKey,
  sign as signBytes,
  verify as verifyBytes,
} from "node:crypto";
import { createReadStream } from "node:fs";
import {
  copyFile,
  lstat,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const REQUEST_SCHEMA = "zerglang.benchmark-publication-request/1";
const DELIVERY_SCHEMA = "zerglang.benchmark-publication-delivery/1";
const MANIFEST_SCHEMA = "zerglang.benchmark-publication/1";
const INDEX_SCHEMA = "zerglang.benchmark-index/1";
const INDEX_SIGNATURE_SCHEMA = "zerglang.benchmark-index-signature/1";
const LATEST_SCHEMA = "zerglang.benchmark-latest/1";
const KEY_SCHEMA = "zerglang.benchmark-signing-keys/1";
const SOURCE_REPOSITORY = "Epoch-ML/zerg";
const RELEASE_REPOSITORY = "Epoch-ML/zerglang-releases";
const CONTAMINATION_WARNING =
  "Public candidate source may contaminate future model-synthesis evaluations.";
const MAX_MANIFEST_BYTES = 1024 * 1024;
const MAX_ARTIFACT_BYTES = 2 * 1024 * 1024 * 1024;
const MAX_JSON_ARTIFACT_BYTES = 64 * 1024 * 1024;
const MAX_ARTIFACTS = 512;
const MAX_INDEX_RUNS = 256;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const SOURCE_SHA_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const DECIMAL_ID_PATTERN = /^[1-9][0-9]*$/;
const PROFILE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const KEY_ID_PATTERN = /^zlbench-ed25519-[0-9]{4}-[0-9]{2}(?:-[a-z0-9-]+)?$/;
const TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;
const ARTIFACT_PATH_PATTERN = /^artifacts\/[A-Za-z0-9][A-Za-z0-9._/-]*$/;
const PROHIBITED_PATH_PATTERN =
  /(?:^|[._/-])(hidden(?:[_-]?test)?|held[_-]?out|reference[_-]?solution|executable[_-]?oracle)(?:[._/-]|$)/i;
const SECRET_TEXT_PATTERN =
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|\b(?:github_pat_|ghp_|sk-proj-)[A-Za-z0-9_-]{16,}/;
const ARTIFACT_ROLES = new Set([
  "candidate_source",
  "public_performance",
  "public_report",
  "public_results",
  "public_synthesis",
  "run_log",
  "schema",
  "task_catalog",
  "task_projection",
]);
const PAGES_ARTIFACT_ROLES = new Set([
  "public_performance",
  "public_report",
  "public_results",
  "public_synthesis",
  "task_catalog",
  "task_projection",
]);
const MEDIA_TYPES = new Set([
  "application/json",
  "application/schema+json",
  "text/plain",
  "text/x-zerglang",
]);
const DISCLOSURE_FIELDS = [
  "executable_oracle_code",
  "held_out_inputs",
  "held_out_oracles",
  "hidden_tests",
  "reference_solutions",
];
const GLOBALLY_FORBIDDEN_FIELDS = new Set([
  "executable_oracle",
  "executable_oracle_code",
  "held_out_input",
  "held_out_inputs",
  "held_out_oracle",
  "held_out_oracles",
  "hidden_input",
  "hidden_inputs",
  "hidden_test",
  "hidden_tests",
  "oracle_source",
  "private_key",
  "reference_solution",
  "reference_solutions",
]);

export class BenchmarkPublicationError extends Error {
  constructor(message) {
    super(message);
    this.name = "BenchmarkPublicationError";
  }
}

function fail(message) {
  throw new BenchmarkPublicationError(message);
}

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function requireObject(value, label) {
  if (!isPlainObject(value)) {
    fail(`${label} must be a JSON object`);
  }
  return value;
}

function requireFields(value, fields, label) {
  const object = requireObject(value, label);
  const expected = new Set(fields);
  for (const field of fields) {
    if (!Object.prototype.hasOwnProperty.call(object, field)) {
      fail(`missing required field: ${label}.${field}`);
    }
  }
  for (const field of Object.keys(object).sort()) {
    if (!expected.has(field)) {
      const rendered = label === "publication request" ? field : `${label}.${field}`;
      fail(`unexpected field: ${rendered}`);
    }
  }
  return object;
}

function requireString(value, label, maximum = 1024) {
  if (typeof value !== "string" || value.length === 0) {
    fail(`${label} must be a nonempty string`);
  }
  if (value !== value.trim()) {
    fail(`${label} must not contain surrounding whitespace`);
  }
  if (Buffer.byteLength(value) > maximum) {
    fail(`${label} exceeds ${maximum} bytes`);
  }
  return value;
}

function requireNullableString(value, label, maximum = 1024) {
  return value === null ? null : requireString(value, label, maximum);
}

function requireText(value, label, maximum = 1024) {
  if (typeof value !== "string" || value.length === 0) {
    fail(`${label} must be a nonempty string`);
  }
  if (Buffer.byteLength(value) > maximum) {
    fail(`${label} exceeds ${maximum} bytes`);
  }
  return value;
}

function requireBoolean(value, label) {
  if (typeof value !== "boolean") {
    fail(`${label} must be a boolean`);
  }
  return value;
}

function requireInteger(value, label, minimum = 0, maximum = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    fail(`${label} must be an integer from ${minimum} through ${maximum}`);
  }
  return value;
}

function requirePattern(value, label, pattern, description) {
  const string = requireString(value, label);
  if (!pattern.test(string)) {
    fail(`${label} must be ${description}`);
  }
  return string;
}

function requireOneOf(value, label, choices) {
  if (!choices.includes(value)) {
    fail(`${label} must be one of ${choices.join(", ")}`);
  }
  return value;
}

function requireTimestamp(value, label) {
  const timestamp = requireString(value, label);
  if (
    !TIMESTAMP_PATTERN.test(timestamp) ||
    Number.isNaN(Date.parse(timestamp)) ||
    !timestamp.endsWith("Z")
  ) {
    fail(`${label} must be an ISO-8601 UTC timestamp`);
  }
  return timestamp;
}

function normalizeCanonical(value, location = "value") {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || Object.is(value, -0)) {
      fail(`${location} must use a safe canonical integer; decimals belong in strings`);
    }
    return value;
  }
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      if (!Object.prototype.hasOwnProperty.call(value, index)) {
        fail(`${location} must not contain sparse arrays`);
      }
    }
    return value.map((item, index) => normalizeCanonical(item, `${location}[${index}]`));
  }
  if (isPlainObject(value)) {
    const result = {};
    for (const key of Object.keys(value).sort()) {
      result[key] = normalizeCanonical(value[key], `${location}.${key}`);
    }
    return result;
  }
  fail(`${location} is not canonical JSON data`);
}

export function canonicalJson(value) {
  return JSON.stringify(normalizeCanonical(value));
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function contentIdentity(document) {
  const object = requireObject(document, "publication request");
  const identityDocument = {};
  for (const [key, value] of Object.entries(object)) {
    if (key !== "run_id" && key !== "content_sha256" && key !== "signature") {
      identityDocument[key] = value;
    }
  }
  const contentSha256 = sha256(Buffer.from(canonicalJson(identityDocument), "utf8"));
  return {
    content_sha256: contentSha256,
    run_id: `run-${contentSha256.slice(0, 32)}`,
  };
}

function strictJsonParse(text, label = "JSON document") {
  let index = 0;

  function error(message) {
    fail(`${label} is not strict JSON at byte ${index}: ${message}`);
  }

  function skipWhitespace() {
    while (index < text.length && /[\t\n\r ]/.test(text[index])) {
      index += 1;
    }
  }

  function parseString() {
    if (text[index] !== '"') {
      error("expected a string");
    }
    const start = index;
    index += 1;
    while (index < text.length) {
      const character = text[index];
      if (character === '"') {
        index += 1;
        try {
          return JSON.parse(text.slice(start, index));
        } catch (cause) {
          error(cause.message);
        }
      }
      if (character === "\\") {
        index += 1;
        if (index >= text.length) {
          error("unterminated escape sequence");
        }
        if (text[index] === "u") {
          const digits = text.slice(index + 1, index + 5);
          if (!/^[0-9A-Fa-f]{4}$/.test(digits)) {
            error("invalid Unicode escape");
          }
          index += 5;
          continue;
        }
        if (!'"\\/bfnrt'.includes(text[index])) {
          error("invalid escape sequence");
        }
      } else if (character.charCodeAt(0) < 0x20) {
        error("unescaped control character");
      }
      index += 1;
    }
    error("unterminated string");
  }

  function parseNumber() {
    const match = text.slice(index).match(/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/);
    if (match === null) {
      error("invalid number");
    }
    index += match[0].length;
    const value = Number(match[0]);
    if (!Number.isFinite(value)) {
      error("number is not finite");
    }
    return value;
  }

  function parseArray() {
    const result = [];
    index += 1;
    skipWhitespace();
    if (text[index] === "]") {
      index += 1;
      return result;
    }
    while (index < text.length) {
      result.push(parseValue());
      skipWhitespace();
      if (text[index] === "]") {
        index += 1;
        return result;
      }
      if (text[index] !== ",") {
        error("expected ',' or ']'");
      }
      index += 1;
      skipWhitespace();
    }
    error("unterminated array");
  }

  function parseObject() {
    const result = {};
    const fields = new Set();
    index += 1;
    skipWhitespace();
    if (text[index] === "}") {
      index += 1;
      return result;
    }
    while (index < text.length) {
      const key = parseString();
      if (fields.has(key)) {
        error(`duplicate object field '${key}'`);
      }
      fields.add(key);
      skipWhitespace();
      if (text[index] !== ":") {
        error("expected ':'");
      }
      index += 1;
      skipWhitespace();
      result[key] = parseValue();
      skipWhitespace();
      if (text[index] === "}") {
        index += 1;
        return result;
      }
      if (text[index] !== ",") {
        error("expected ',' or '}'");
      }
      index += 1;
      skipWhitespace();
    }
    error("unterminated object");
  }

  function parseValue() {
    skipWhitespace();
    if (index >= text.length) {
      error("unexpected end of input");
    }
    if (text[index] === '"') return parseString();
    if (text[index] === "{") return parseObject();
    if (text[index] === "[") return parseArray();
    for (const [token, value] of [["true", true], ["false", false], ["null", null]]) {
      if (text.startsWith(token, index)) {
        index += token.length;
        return value;
      }
    }
    if (text[index] === "-" || /[0-9]/.test(text[index])) return parseNumber();
    error("unexpected token");
  }

  const value = parseValue();
  skipWhitespace();
  if (index !== text.length) error("trailing content");
  return value;
}

function validateSuite(value) {
  const suite = requireFields(value, ["dataset_id", "id", "lane", "profile_id", "profile_identity", "view"], "suite");
  if (suite.id !== "zl256") fail("suite.id must equal zl256");
  requirePattern(suite.dataset_id, "suite.dataset_id", SHA256_PATTERN, "a SHA-256 digest");
  requirePattern(suite.profile_id, "suite.profile_id", PROFILE_PATTERN, "a profile identifier");
  requirePattern(suite.profile_identity, "suite.profile_identity", SHA256_PATTERN, "a SHA-256 digest");
  requireOneOf(suite.lane, "suite.lane", ["conformance", "performance", "synthesis"]);
  requireOneOf(suite.view, "suite.view", ["current", "roadmap"]);
}

function validateSource(value) {
  const source = requireFields(value, ["commit_sha", "ref", "release", "repository"], "source");
  if (source.repository !== SOURCE_REPOSITORY) fail(`source.repository must equal ${SOURCE_REPOSITORY}`);
  requirePattern(source.commit_sha, "source.commit_sha", SOURCE_SHA_PATTERN, "a 40- or 64-character Git object ID");
  const sourceRef = requireString(source.ref, "source.ref", 256);
  if (!/^refs\/(?:heads|tags)\/[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(sourceRef)) {
    fail("source.ref must be a canonical heads or tags ref");
  }
  if (sourceRef.split("/").some((segment) => segment === "." || segment === "..")) {
    fail("source.ref must not contain traversal segments");
  }
  requireNullableString(source.release, "source.release", 128);
}

function validateWorkflow(value) {
  const workflow = requireFields(value, ["event", "name", "run_attempt", "run_id", "url"], "workflow");
  requireString(workflow.name, "workflow.name", 128);
  requirePattern(workflow.run_id, "workflow.run_id", DECIMAL_ID_PATTERN, "a positive decimal identifier");
  requireInteger(workflow.run_attempt, "workflow.run_attempt", 1, 1000000);
  requireOneOf(workflow.event, "workflow.event", ["push", "release", "schedule", "workflow_dispatch"]);
  const expectedUrl = `https://github.com/${SOURCE_REPOSITORY}/actions/runs/${workflow.run_id}`;
  if (workflow.url !== expectedUrl) fail(`workflow.url must equal ${expectedUrl}`);
}

function validateFilters(value) {
  const filters = requireObject(value, "execution.filters");
  for (const key of Object.keys(filters)) {
    if (!PROFILE_PATTERN.test(key)) fail("execution.filters keys must be identifiers");
    const filterValue = filters[key];
    if (typeof filterValue === "string") {
      requireString(filterValue, `execution.filters.${key}`, 256);
      continue;
    }
    if (!Array.isArray(filterValue)) fail(`execution.filters.${key} must be a string or sorted string array`);
    const normalized = filterValue.map((item, index) => requireString(item, `execution.filters.${key}[${index}]`, 256));
    if (new Set(normalized).size !== normalized.length) fail(`execution.filters.${key} must not contain duplicates`);
    if (normalized.some((item, index) => index > 0 && normalized[index - 1] >= item)) {
      fail(`execution.filters.${key} must use canonical sorted order`);
    }
  }
}

function validateExecution(value) {
  const execution = requireFields(value, ["command", "compiler_id", "executor_sha256", "filters", "harness_version", "shards"], "execution");
  requireString(execution.compiler_id, "execution.compiler_id", 256);
  requirePattern(execution.executor_sha256, "execution.executor_sha256", SHA256_PATTERN, "a SHA-256 digest");
  requireString(execution.harness_version, "execution.harness_version", 256);
  if (!Array.isArray(execution.command) || execution.command.length === 0 || execution.command.length > 128) {
    fail("execution.command must be a nonempty argv array with at most 128 items");
  }
  execution.command.forEach((item, index) => requireString(item, `execution.command[${index}]`, 1024));
  validateFilters(execution.filters);
  const shards = requireFields(execution.shards, ["completed", "count"], "execution.shards");
  const count = requireInteger(shards.count, "execution.shards.count", 1, 1000000);
  if (!Array.isArray(shards.completed)) fail("execution.shards.completed must be a sorted integer array");
  let previous = -1;
  for (const [index, shard] of shards.completed.entries()) {
    requireInteger(shard, `execution.shards.completed[${index}]`, 0, count - 1);
    if (shard <= previous) fail("execution.shards.completed must be sorted and duplicate-free");
    previous = shard;
  }
}

function validatePlatform(value) {
  const platform = requireFields(value, ["arch", "id", "machine", "os", "toolchain"], "platform");
  requirePattern(platform.id, "platform.id", PROFILE_PATTERN, "a platform identifier");
  requirePattern(platform.os, "platform.os", PROFILE_PATTERN, "an operating-system identifier");
  requirePattern(platform.arch, "platform.arch", PROFILE_PATTERN, "an architecture identifier");
  requireString(platform.machine, "platform.machine", 512);
  requireString(platform.toolchain, "platform.toolchain", 512);
}

function validateModel(value) {
  if (value === null) return;
  const model = requireFields(value, ["adapter", "model", "provider", "seed", "temperature"], "model");
  requireString(model.provider, "model.provider", 128);
  requireString(model.model, "model.model", 256);
  requireString(model.adapter, "model.adapter", 256);
  if (model.temperature !== null) {
    if (typeof model.temperature !== "string") fail("model.temperature must be a canonical decimal string or null");
    if (!/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(model.temperature)) {
      fail("model.temperature must be a canonical decimal string or null");
    }
  }
  if (model.seed !== null && !Number.isSafeInteger(model.seed)) {
    fail("model.seed must be an integer or null");
  }
}

function validateArtifact(value, index) {
  const label = `artifacts[${index}]`;
  const artifact = requireFields(value, ["media_type", "path", "role", "sha256", "size_bytes"], label);
  const artifactPath = requirePattern(artifact.path, `${label}.path`, ARTIFACT_PATH_PATTERN, "a safe path below artifacts/");
  if (path.posix.normalize(artifactPath) !== artifactPath || artifactPath.split("/").some((segment) => segment === "." || segment === "..") || artifactPath.includes("//") || PROHIBITED_PATH_PATTERN.test(artifactPath)) {
    fail(`${label}.path identifies forbidden or non-canonical material`);
  }
  if (!ARTIFACT_ROLES.has(artifact.role)) fail(`${label}.role is not publishable`);
  if (!MEDIA_TYPES.has(artifact.media_type)) fail(`${label}.media_type is not publishable`);
  requireInteger(artifact.size_bytes, `${label}.size_bytes`, 0, MAX_ARTIFACT_BYTES);
  requirePattern(artifact.sha256, `${label}.sha256`, SHA256_PATTERN, "a SHA-256 digest");
  if (artifact.role === "candidate_source" && artifact.media_type !== "text/x-zerglang") {
    fail("candidate_source artifacts must use text/x-zerglang");
  }
  if (["public_performance", "public_report", "public_results", "public_synthesis", "task_catalog", "task_projection"].includes(artifact.role) && artifact.media_type !== "application/json") {
    fail(`${artifact.role} artifacts must use application/json`);
  }
}

function validateDisclosure(value, artifacts) {
  const disclosure = requireFields(value, ["candidate_source_public", "contamination_warning", "excluded_material"], "disclosure");
  const candidateSourcePublic = requireBoolean(disclosure.candidate_source_public, "disclosure.candidate_source_public");
  const exclusions = requireFields(disclosure.excluded_material, DISCLOSURE_FIELDS, "disclosure.excluded_material");
  for (const field of DISCLOSURE_FIELDS) {
    if (exclusions[field] !== true) fail(`disclosure.excluded_material.${field} must equal true`);
  }
  const candidateCount = artifacts.filter((item) => item.role === "candidate_source").length;
  if (candidateSourcePublic) {
    if (disclosure.contamination_warning !== CONTAMINATION_WARNING) {
      fail(`disclosure.contamination_warning must equal '${CONTAMINATION_WARNING}'`);
    }
    if (candidateCount === 0) fail("candidate_source_public requires at least one candidate_source artifact");
  } else {
    if (disclosure.contamination_warning !== null) fail("disclosure.contamination_warning must be null when candidate source is absent");
    if (candidateCount !== 0) fail("candidate_source artifacts require candidate_source_public to equal true");
  }
}

function requireLaneArtifacts(suite, artifacts) {
  const roles = new Set(artifacts.map((item) => item.role));
  if (roles.has("candidate_source") && suite.lane !== "synthesis") {
    fail("candidate source is only valid for synthesis publication");
  }
  const requiredByLane = {
    conformance: ["task_catalog", "public_report", "public_results"],
    performance: ["task_catalog", "public_performance"],
    synthesis: ["task_catalog", "public_synthesis"],
  };
  for (const role of requiredByLane[suite.lane]) {
    if (!roles.has(role)) fail(`${suite.lane} publication requires a ${role} artifact`);
  }
}

export function validatePublicationRequest(document) {
  const request = requireFields(document, ["artifacts", "content_sha256", "disclosure", "execution", "model", "platform", "run_id", "schema", "signature", "source", "status", "suite", "timestamps", "workflow"], "publication request");
  if (request.schema !== REQUEST_SCHEMA) fail(`schema must equal ${REQUEST_SCHEMA}`);
  validateSuite(request.suite);
  validateSource(request.source);
  validateWorkflow(request.workflow);
  validateExecution(request.execution);
  validatePlatform(request.platform);
  validateModel(request.model);
  const timestamps = requireFields(request.timestamps, ["completed_at", "started_at"], "timestamps");
  const startedAt = requireTimestamp(timestamps.started_at, "timestamps.started_at");
  const completedAt = requireTimestamp(timestamps.completed_at, "timestamps.completed_at");
  if (Date.parse(completedAt) < Date.parse(startedAt)) {
    fail("timestamps.completed_at must not precede timestamps.started_at");
  }
  requireOneOf(request.status, "status", ["complete", "partial"]);
  if (!Array.isArray(request.artifacts) || request.artifacts.length === 0) fail("artifacts must be a nonempty array");
  if (request.artifacts.length > MAX_ARTIFACTS) fail(`artifacts must contain no more than ${MAX_ARTIFACTS} entries`);
  const seenPaths = new Set();
  const singletonRoles = new Set();
  let previousArtifactPath = "";
  for (const [index, artifact] of request.artifacts.entries()) {
    validateArtifact(artifact, index);
    if (seenPaths.has(artifact.path)) fail(`duplicate artifact path: ${artifact.path}`);
    if (index > 0 && artifact.path <= previousArtifactPath) {
      fail("artifact inventory must be sorted by path");
    }
    previousArtifactPath = artifact.path;
    seenPaths.add(artifact.path);
    if (["public_performance", "public_report", "public_results", "public_synthesis", "task_catalog"].includes(artifact.role)) {
      if (singletonRoles.has(artifact.role)) fail(`duplicate singleton artifact role: ${artifact.role}`);
      singletonRoles.add(artifact.role);
    }
  }
  requireLaneArtifacts(request.suite, request.artifacts);
  validateDisclosure(request.disclosure, request.artifacts);
  if (request.signature !== null) fail("source publication request signature must be null");
  if (request.status === "complete" && request.execution.shards.completed.length !== request.execution.shards.count) {
    fail("complete evidence must include every declared shard");
  }
  const identity = contentIdentity(request);
  if (request.content_sha256 !== identity.content_sha256) fail("content_sha256 does not match canonical publication content");
  if (request.run_id !== identity.run_id) fail(`run_id must equal ${identity.run_id}`);
  return strictJsonParse(canonicalJson(request), "canonical publication request");
}

export function admitPublicationRequest(document) {
  const request = validatePublicationRequest(document);
  if (request.status !== "complete") fail("only complete benchmark evidence may be published");
  if (
    !["refs/heads/development", "refs/heads/main"].includes(request.source.ref) &&
    !/^refs\/tags\/zerglang-v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/.test(request.source.ref)
  ) {
    fail("official evidence must come from a protected branch or ZergLang release tag");
  }
  if (request.workflow.name !== "ZergLang ZL256 benchmarks") {
    fail("official evidence must come from the ZergLang ZL256 benchmarks workflow");
  }
  return request;
}

export function validateDeliveryRequest(document) {
  const delivery = requireFields(document, ["artifact_digest", "artifact_id", "artifact_name", "requested_at", "run_id", "schema", "source_repository", "source_sha", "workflow_run_attempt", "workflow_run_id"], "delivery request");
  if (delivery.schema !== DELIVERY_SCHEMA) fail(`delivery request schema must equal ${DELIVERY_SCHEMA}`);
  requirePattern(delivery.run_id, "run_id", /^run-[0-9a-f]{32}$/, "a content-derived run identifier");
  if (delivery.source_repository !== SOURCE_REPOSITORY) fail(`source_repository must equal ${SOURCE_REPOSITORY}`);
  requirePattern(delivery.source_sha, "source_sha", SOURCE_SHA_PATTERN, "a 40- or 64-character Git object ID");
  requirePattern(delivery.workflow_run_id, "workflow_run_id", DECIMAL_ID_PATTERN, "a positive decimal identifier");
  requireInteger(delivery.workflow_run_attempt, "workflow_run_attempt", 1, 1000000);
  requirePattern(delivery.artifact_id, "artifact_id", DECIMAL_ID_PATTERN, "a positive decimal identifier");
  const expectedName = `zlbench-publication-${delivery.run_id}`;
  if (delivery.artifact_name !== expectedName) fail(`artifact_name must equal ${expectedName}`);
  requirePattern(delivery.artifact_digest, "artifact_digest", /^sha256:[0-9a-f]{64}$/, "a sha256-prefixed artifact digest");
  requireTimestamp(delivery.requested_at, "requested_at");
  return strictJsonParse(canonicalJson(delivery), "canonical delivery request");
}

async function listBundleFiles(root) {
  const rootMetadata = await lstat(root);
  if (!rootMetadata.isDirectory() || rootMetadata.isSymbolicLink()) fail("bundle path must identify a real directory");
  const files = [];
  async function visit(directory, relativeDirectory) {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const relativePath = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name;
      const absolutePath = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) fail(`symbolic links are forbidden in bundles: ${relativePath}`);
      if (entry.isDirectory()) await visit(absolutePath, relativePath);
      else if (entry.isFile()) files.push(relativePath);
      else fail(`bundle entry must be a regular file: ${relativePath}`);
    }
  }
  await visit(root, "");
  return files;
}

async function hashFile(filePath) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return hash.digest("hex");
}

function scanPublicJson(value, label) {
  if (Array.isArray(value)) {
    value.forEach((item, index) => scanPublicJson(item, `${label}[${index}]`));
    return;
  }
  if (!isPlainObject(value)) return;
  for (const field of Object.keys(value)) {
    if (GLOBALLY_FORBIDDEN_FIELDS.has(field)) fail(`${label} contains forbidden non-public field: ${field}`);
  }
  if (
    ["held", "held-out"].includes(value.visibility) ||
    ["held", "held-out"].includes(value.case_visibility)
  ) {
    fail(`${label} held-out visibility is forbidden from public projections`);
  }
  for (const [field, nested] of Object.entries(value)) scanPublicJson(nested, `${label}.${field}`);
}

function validateCounter(value, label) {
  const counter = requireObject(value, label);
  let total = 0;
  for (const [name, count] of Object.entries(counter)) {
    requireString(name, `${label} key`, 128);
    total += requireInteger(count, `${label}.${name}`, 0);
  }
  return total;
}

function validateReportMetadata(value, label) {
  const metadata = requireFields(
    value,
    [
      "catalog_id",
      "compiler_id",
      "model_id",
      "platform_id",
      "profile_id",
      "profile_identity",
      "toolchain_id",
    ],
    label,
  );
  requirePattern(metadata.catalog_id, `${label}.catalog_id`, SHA256_PATTERN, "a SHA-256 digest");
  requireString(metadata.compiler_id, `${label}.compiler_id`, 256);
  requireNullableString(metadata.model_id, `${label}.model_id`, 256);
  requireString(metadata.platform_id, `${label}.platform_id`, 256);
  requireString(metadata.profile_id, `${label}.profile_id`, 256);
  requirePattern(metadata.profile_identity, `${label}.profile_identity`, SHA256_PATTERN, "a SHA-256 digest");
  requireString(metadata.toolchain_id, `${label}.toolchain_id`, 512);
  return metadata;
}

function validateScoreSummary(value, label) {
  const summary = requireFields(value, ["edition", "failures", "profile", "total"], label);
  const total = requireInteger(summary.total, `${label}.total`, 0);
  if (validateCounter(summary.profile, `${label}.profile`) !== total) {
    fail(`${label}.profile counters must sum to total`);
  }
  if (validateCounter(summary.edition, `${label}.edition`) !== total) {
    fail(`${label}.edition counters must sum to total`);
  }
  if (validateCounter(summary.failures, `${label}.failures`) > total) {
    fail(`${label}.failures counters cannot exceed total`);
  }
  return summary;
}

function validatePublicOracle(value, label) {
  const oracle = requireObject(value, label);
  if (oracle.kind === "property") {
    if (
      canonicalJson(Object.keys(oracle).sort()) !==
        canonicalJson(["availability", "kind", "reason"]) ||
      oracle.availability !== "withheld" ||
      oracle.reason !== "executable-oracle-code"
    ) {
      fail(`${label} property oracle must withhold executable oracle code`);
    }
    return;
  }
  if (oracle.kind === "diagnostic") {
    requireFields(oracle, ["code", "kind"], label);
    requireString(oracle.code, `${label}.code`, 256);
    return;
  }
  requireOneOf(oracle.kind, `${label}.kind`, ["evidence", "history", "trace", "value"]);
  requireFields(oracle, ["kind", "value"], label);
  requireObject(oracle.value, `${label}.value`);
}

function validateStringArray(value, label) {
  if (!Array.isArray(value)) fail(`${label} must be an array`);
  const strings = value.map((item, index) => requireString(item, `${label}[${index}]`, 1024));
  if (new Set(strings).size !== strings.length) fail(`${label} must not contain duplicates`);
  return strings;
}

function validatePublicTaskDocument(value, label = "public task") {
  if (!isPlainObject(value) || value.schema !== "zerglang.benchmark-public-task/1") {
    fail(`${label} must use zerglang.benchmark-public-task/1`);
  }
  const task = requireFields(
    value,
    [
      "boundaries",
      "cases",
      "category",
      "clauses",
      "domains",
      "edition",
      "execution",
      "id",
      "limits",
      "maturity",
      "modalities",
      "performance",
      "preview",
      "provenance",
      "revision",
      "schema",
      "source",
      "synthesis",
      "tiers",
      "title",
    ],
    label,
  );
  requirePattern(
    task.id,
    `${label}.id`,
    /^[a-z][a-z0-9-]*\/[a-z0-9][a-z0-9-]*$/,
    "a canonical benchmark task ID",
  );
  requireInteger(task.revision, `${label}.revision`, 1);
  requireString(task.title, `${label}.title`, 512);
  requireOneOf(task.maturity, `${label}.maturity`, ["executable", "scaffold", "verified"]);
  requireOneOf(task.category, `${label}.category`, [
    "algorithm",
    "compute",
    "flow",
    "integration",
    "optimize",
    "shared",
    "state",
  ]);
  requireOneOf(task.edition, `${label}.edition`, ["core-0", "core-1"]);
  requireOneOf(task.preview, `${label}.preview`, [
    "compute",
    "flow",
    "optimize",
    "shared",
    "stable",
    "state",
  ]);
  validateStringArray(task.domains, `${label}.domains`);
  validateStringArray(task.modalities, `${label}.modalities`);
  validateStringArray(task.tiers, `${label}.tiers`);
  validateStringArray(task.clauses, `${label}.clauses`);
  if (!Array.isArray(task.boundaries)) fail(`${label}.boundaries must be an array`);
  const execution = requireFields(
    task.execution,
    ["executors", "operation", "platforms", "selector"],
    `${label}.execution`,
  );
  requireString(execution.operation, `${label}.execution.operation`, 128);
  requireString(execution.selector, `${label}.execution.selector`, 512);
  validateStringArray(execution.executors, `${label}.execution.executors`);
  validateStringArray(execution.platforms, `${label}.execution.platforms`);
  if (!Array.isArray(task.cases)) fail(`${label}.cases must be an array`);
  const caseIds = new Set();
  for (const [caseIndex, value] of task.cases.entries()) {
    const caseLabel = `${label}.cases[${caseIndex}]`;
    const benchmarkCase = requireFields(value, ["id", "input", "oracle", "visibility"], caseLabel);
    requireString(benchmarkCase.id, `${caseLabel}.id`, 256);
    if (caseIds.has(benchmarkCase.id)) fail(`${label} contains duplicate public case: ${benchmarkCase.id}`);
    caseIds.add(benchmarkCase.id);
    if (benchmarkCase.visibility !== "public") fail(`${caseLabel}.visibility must equal public`);
    requireObject(benchmarkCase.input, `${caseLabel}.input`);
    validatePublicOracle(benchmarkCase.oracle, `${caseLabel}.oracle`);
  }
  const synthesis = requireObject(task.synthesis, `${label}.synthesis`);
  requireBoolean(synthesis.eligible, `${label}.synthesis.eligible`);
  if (synthesis.eligible) {
    requireFields(
      synthesis,
      ["contamination_warning", "eligible", "interface", "prompt"],
      `${label}.synthesis`,
    );
    requireText(synthesis.prompt, `${label}.synthesis.prompt`, MAX_JSON_ARTIFACT_BYTES);
    requireText(synthesis.interface, `${label}.synthesis.interface`, MAX_JSON_ARTIFACT_BYTES);
    if (synthesis.contamination_warning !== CONTAMINATION_WARNING) {
      fail(`${label}.synthesis.contamination_warning is not canonical`);
    }
    const source = requireFields(
      task.source,
      ["availability", "reason"],
      `${label}.source`,
    );
    if (
      source.availability !== "withheld" ||
      source.reason !== "active-synthesis-reference"
    ) {
      fail(`${label}.source must withhold the active synthesis reference`);
    }
  } else {
    requireFields(synthesis, ["eligible"], `${label}.synthesis`);
    const source = requireFields(
      task.source,
      ["availability", "entry", "files"],
      `${label}.source`,
    );
    if (source.availability !== "published") {
      fail(`${label}.source.availability must equal published`);
    }
    requireString(source.entry, `${label}.source.entry`, 1024);
    if (!Array.isArray(source.files) || source.files.length === 0) {
      fail(`${label}.source.files must be a nonempty array`);
    }
    const sourcePaths = new Set();
    for (const [fileIndex, value] of source.files.entries()) {
      const fileLabel = `${label}.source.files[${fileIndex}]`;
      const file = requireFields(value, ["content", "path", "sha256"], fileLabel);
      const sourcePath = requireString(file.path, `${fileLabel}.path`, 1024);
      if (
        path.posix.normalize(sourcePath) !== sourcePath ||
        sourcePath.startsWith("/") ||
        sourcePath.includes("//") ||
        sourcePath.split("/").some((segment) => segment === "." || segment === "..")
      ) {
        fail(`${fileLabel}.path must be a canonical relative path`);
      }
      if (sourcePaths.has(sourcePath)) fail(`${label}.source.files contains duplicate path: ${sourcePath}`);
      sourcePaths.add(sourcePath);
      if (typeof file.content !== "string") fail(`${fileLabel}.content must be a string`);
      requirePattern(file.sha256, `${fileLabel}.sha256`, SHA256_PATTERN, "a SHA-256 digest");
      if (sha256(Buffer.from(file.content, "utf8")) !== file.sha256) {
        fail(`${fileLabel}.sha256 does not match content`);
      }
    }
    if (!sourcePaths.has(source.entry)) fail(`${label}.source.entry is not present in source.files`);
  }
  requireObject(task.performance, `${label}.performance`);
  requireObject(task.limits, `${label}.limits`);
  if (!Array.isArray(task.provenance)) fail(`${label}.provenance must be an array`);
  return task;
}

function validatePublicCatalogDocument(value) {
  if (!isPlainObject(value) || value.schema !== "zerglang.benchmark-public-catalog/1") {
    fail("task_catalog must use zerglang.benchmark-public-catalog/1");
  }
  const catalog = requireFields(
    value,
    ["authority", "dataset_id", "name", "schema", "tasks", "version"],
    "task_catalog",
  );
  requirePattern(catalog.dataset_id, "task_catalog.dataset_id", SHA256_PATTERN, "a SHA-256 digest");
  if (catalog.name !== "ZL256") fail("task_catalog.name must equal ZL256");
  requireString(catalog.version, "task_catalog.version", 128);
  const authority = requireFields(catalog.authority, ["boundaries", "clauses"], "task_catalog.authority");
  validateStringArray(authority.clauses, "task_catalog.authority.clauses");
  if (!Array.isArray(authority.boundaries)) fail("task_catalog.authority.boundaries must be an array");
  if (!Array.isArray(catalog.tasks)) fail("task_catalog.tasks must be an array");
  const taskIds = new Set();
  for (const [index, value] of catalog.tasks.entries()) {
    const task = validatePublicTaskDocument(value, `task_catalog.tasks[${index}]`);
    if (taskIds.has(task.id)) fail(`task_catalog contains duplicate task: ${task.id}`);
    taskIds.add(task.id);
  }
  return catalog;
}

function validatePublicResultsDocument(value) {
  if (!isPlainObject(value) || value.schema !== "zerglang.benchmark-public-results/1") {
    fail("public_results must use zerglang.benchmark-public-results/1");
  }
  const results = requireFields(
    value,
    ["dataset_id", "non_public_aggregates", "profile_identity", "public_observations", "schema"],
    "public_results",
  );
  requirePattern(results.dataset_id, "public_results.dataset_id", SHA256_PATTERN, "a SHA-256 digest");
  requirePattern(results.profile_identity, "public_results.profile_identity", SHA256_PATTERN, "a SHA-256 digest");
  if (!Array.isArray(results.public_observations)) {
    fail("public_results.public_observations must be an array");
  }
  const publicKeys = new Set();
  for (const [index, value] of results.public_observations.entries()) {
    const label = `public_results.public_observations[${index}]`;
    const observation = requireFields(
      value,
      [
        "case_id",
        "diagnostic_code",
        "edition_status",
        "executor",
        "failure_kind",
        "fixture_maturity",
        "profile_status",
        "task_id",
        "task_revision",
      ],
      label,
    );
    requireString(observation.task_id, `${label}.task_id`, 256);
    requireInteger(observation.task_revision, `${label}.task_revision`, 1);
    requireString(observation.case_id, `${label}.case_id`, 256);
    requireString(observation.executor, `${label}.executor`, 128);
    requireOneOf(observation.fixture_maturity, `${label}.fixture_maturity`, ["scaffold", "executable", "verified"]);
    requireOneOf(observation.profile_status, `${label}.profile_status`, ["pass", "fail", "skip", "infra-error"]);
    requireOneOf(observation.edition_status, `${label}.edition_status`, ["pass", "gap", "fail", "not-applicable"]);
    if (observation.failure_kind !== null) {
      requireOneOf(observation.failure_kind, `${label}.failure_kind`, ["scaffold", "unsupported", "wrong-behavior", "engine-divergence", "timeout", "crash", "harness", "platform"]);
    }
    if (
      observation.diagnostic_code !== null &&
      observation.diagnostic_code !== "non-normative-diagnostic" &&
      (typeof observation.diagnostic_code !== "string" ||
        !/^ZL-[A-Z0-9]+(?:-[A-Z0-9]+)*$/.test(observation.diagnostic_code))
    ) {
      fail(`${label}.diagnostic_code must be null, non-normative-diagnostic, or a ZL code`);
    }
    const key = `${observation.task_id}\0${observation.task_revision}\0${observation.case_id}\0${observation.executor}`;
    if (publicKeys.has(key)) fail(`duplicate public observation at ${label}`);
    publicKeys.add(key);
  }
  if (!Array.isArray(results.non_public_aggregates)) {
    fail("public_results.non_public_aggregates must be an array");
  }
  const aggregateKeys = new Set();
  let nonPublicCount = 0;
  for (const [index, value] of results.non_public_aggregates.entries()) {
    const label = `public_results.non_public_aggregates[${index}]`;
    const aggregate = requireFields(
      value,
      ["case_count", "edition", "executor", "failures", "profile", "task_id", "task_revision"],
      label,
    );
    requireString(aggregate.task_id, `${label}.task_id`, 256);
    requireInteger(aggregate.task_revision, `${label}.task_revision`, 1);
    requireString(aggregate.executor, `${label}.executor`, 128);
    const caseCount = requireInteger(aggregate.case_count, `${label}.case_count`, 1);
    if (validateCounter(aggregate.profile, `${label}.profile`) !== caseCount) {
      fail(`${label}.profile counters must sum to case_count`);
    }
    if (validateCounter(aggregate.edition, `${label}.edition`) !== caseCount) {
      fail(`${label}.edition counters must sum to case_count`);
    }
    if (validateCounter(aggregate.failures, `${label}.failures`) > caseCount) {
      fail(`${label}.failures counters cannot exceed case_count`);
    }
    const key = `${aggregate.task_id}\0${aggregate.task_revision}\0${aggregate.executor}`;
    if (aggregateKeys.has(key)) fail(`duplicate non-public aggregate at ${label}`);
    aggregateKeys.add(key);
    nonPublicCount += caseCount;
  }
  return {
    document: results,
    observationCount: results.public_observations.length + nonPublicCount,
  };
}

function validatePublicReportDocument(value) {
  if (!isPlainObject(value) || value.schema !== "zerglang.benchmark-public-report/1") {
    fail("public_report must use zerglang.benchmark-public-report/1");
  }
  const report = requireFields(value, ["metadata", "results_sha256", "schema", "summary"], "public_report");
  validateReportMetadata(report.metadata, "public_report.metadata");
  validateScoreSummary(report.summary, "public_report.summary");
  requirePattern(report.results_sha256, "public_report.results_sha256", SHA256_PATTERN, "a SHA-256 digest");
  return report;
}

function validatePublicPerformanceDocument(value) {
  if (!isPlainObject(value) || value.schema !== "zerglang.benchmark-public-performance/1") {
    fail("public_performance must use zerglang.benchmark-public-performance/1");
  }
  const performance = requireFields(value, ["measurements", "metadata", "schema"], "public_performance");
  validateReportMetadata(performance.metadata, "public_performance.metadata");
  if (!Array.isArray(performance.measurements)) {
    fail("public_performance.measurements must be an array");
  }
  for (const [index, value] of performance.measurements.entries()) {
    const label = `public_performance.measurements[${index}]`;
    const measurement = requireFields(
      value,
      ["case_id", "executor", "mad_ns", "median_ns", "sample_count", "sample_durations_ns", "task_id", "task_revision", "valid", "warmup_count"],
      label,
    );
    requireString(measurement.task_id, `${label}.task_id`, 256);
    requireInteger(measurement.task_revision, `${label}.task_revision`, 1);
    requireString(measurement.case_id, `${label}.case_id`, 256);
    requireString(measurement.executor, `${label}.executor`, 128);
    requireInteger(measurement.warmup_count, `${label}.warmup_count`, 0);
    const sampleCount = requireInteger(measurement.sample_count, `${label}.sample_count`, 1);
    if (!Array.isArray(measurement.sample_durations_ns) || measurement.sample_durations_ns.length !== sampleCount) {
      fail(`${label}.sample_durations_ns must contain sample_count entries`);
    }
    for (const [sampleIndex, duration] of measurement.sample_durations_ns.entries()) {
      if (duration !== null && (typeof duration !== "string" || !/^[0-9]+$/.test(duration))) {
        fail(`${label}.sample_durations_ns[${sampleIndex}] must be a decimal duration or null`);
      }
    }
    requireBoolean(measurement.valid, `${label}.valid`);
    for (const field of ["median_ns", "mad_ns"]) {
      const duration = measurement[field];
      if (duration !== null && (typeof duration !== "string" || !/^[0-9]+$/.test(duration))) {
        fail(`${label}.${field} must be a decimal duration or null`);
      }
    }
  }
  return performance;
}

function greatestCommonDivisor(left, right) {
  let a = left < 0n ? -left : left;
  let b = right < 0n ? -right : right;
  while (b !== 0n) {
    const remainder = a % b;
    a = b;
    b = remainder;
  }
  return a;
}

function reducedFraction(numerator, denominator) {
  const divisor = greatestCommonDivisor(numerator, denominator);
  return {
    numerator: String(numerator / divisor),
    denominator: String(denominator / divisor),
  };
}

function expectedPassAtK(sampleCount, correctCount, k) {
  if (sampleCount - correctCount < k) return { numerator: "1", denominator: "1" };
  let misses = 1n;
  let possibilities = 1n;
  for (let index = 0; index < k; index += 1) {
    misses *= BigInt(sampleCount - correctCount - index);
    possibilities *= BigInt(sampleCount - index);
  }
  return reducedFraction(possibilities - misses, possibilities);
}

function validateFraction(value, label) {
  const fraction = requireFields(value, ["denominator", "numerator"], label);
  if (typeof fraction.numerator !== "string" || !/^(?:0|[1-9][0-9]*)$/.test(fraction.numerator)) {
    fail(`${label}.numerator must be a canonical nonnegative decimal integer`);
  }
  if (typeof fraction.denominator !== "string" || !/^[1-9][0-9]*$/.test(fraction.denominator)) {
    fail(`${label}.denominator must be a canonical positive decimal integer`);
  }
  return fraction;
}

function validatePublicSynthesisDocument(value) {
  if (!isPlainObject(value) || value.schema !== "zerglang.benchmark-public-synthesis/1") {
    fail("public_synthesis must use zerglang.benchmark-public-synthesis/1");
  }
  const synthesis = requireFields(
    value,
    [
      "candidate_source_public",
      "catalog_id",
      "contamination_warning",
      "profile_identity",
      "schema",
      "tasks",
    ],
    "public_synthesis",
  );
  requirePattern(synthesis.catalog_id, "public_synthesis.catalog_id", SHA256_PATTERN, "a SHA-256 digest");
  requirePattern(
    synthesis.profile_identity,
    "public_synthesis.profile_identity",
    SHA256_PATTERN,
    "a SHA-256 digest",
  );
  requireBoolean(synthesis.candidate_source_public, "public_synthesis.candidate_source_public");
  const expectedWarning = synthesis.candidate_source_public ? CONTAMINATION_WARNING : null;
  if (synthesis.contamination_warning !== expectedWarning) {
    fail("public_synthesis contamination warning is not canonical");
  }
  if (!Array.isArray(synthesis.tasks)) fail("public_synthesis.tasks must be an array");
  const taskKeys = new Set();
  for (const [taskIndex, value] of synthesis.tasks.entries()) {
    const label = `public_synthesis.tasks[${taskIndex}]`;
    const task = requireFields(
      value,
      ["pass_at_k", "repair_at_3", "samples", "task_id", "task_revision"],
      label,
    );
    requireString(task.task_id, `${label}.task_id`, 256);
    requireInteger(task.task_revision, `${label}.task_revision`, 1);
    const taskKey = `${task.task_id}\0${task.task_revision}`;
    if (taskKeys.has(taskKey)) fail(`duplicate public synthesis task: ${task.task_id}`);
    taskKeys.add(taskKey);
    if (!Array.isArray(task.samples) || task.samples.length === 0) {
      fail(`${label}.samples must be a nonempty array`);
    }
    let singleShotCorrect = 0;
    let repairedCorrect = 0;
    for (const [sampleIndex, value] of task.samples.entries()) {
      const sampleLabel = `${label}.samples[${sampleIndex}]`;
      const sample = requireFields(
        value,
        [
          "attempted",
          "backend",
          "candidate",
          "outcome",
          "repair_turns",
          "repaired_pass",
          "sample_index",
          "single_shot_pass",
        ],
        sampleLabel,
      );
      if (requireInteger(sample.sample_index, `${sampleLabel}.sample_index`, 0) !== sampleIndex) {
        fail(`${label}.samples must use canonical consecutive sample indices`);
      }
      requireBoolean(sample.attempted, `${sampleLabel}.attempted`);
      requireOneOf(sample.outcome, `${sampleLabel}.outcome`, [
        "adapter-failure",
        "pass",
        "unavailable",
        "wrong",
      ]);
      requireBoolean(sample.single_shot_pass, `${sampleLabel}.single_shot_pass`);
      requireBoolean(sample.repaired_pass, `${sampleLabel}.repaired_pass`);
      requireInteger(sample.repair_turns, `${sampleLabel}.repair_turns`, 0, 3);
      if (sample.attempted !== (sample.outcome !== "unavailable")) {
        fail(`${sampleLabel}.attempted does not match outcome`);
      }
      if ((sample.outcome === "pass") !== (sample.single_shot_pass || sample.repaired_pass)) {
        fail(`${sampleLabel}.outcome does not match pass flags`);
      }
      if (sample.single_shot_pass && (!sample.repaired_pass || sample.repair_turns !== 0)) {
        fail(`${sampleLabel} single-shot pass has inconsistent repair state`);
      }
      if (sample.repaired_pass && !sample.single_shot_pass && sample.repair_turns === 0) {
        fail(`${sampleLabel} repaired pass must record at least one repair turn`);
      }
      if (["adapter-failure", "unavailable"].includes(sample.outcome) && sample.repair_turns !== 0) {
        fail(`${sampleLabel} unavailable outcome cannot record repair turns`);
      }
      if (sample.backend !== null) {
        const backend = requireFields(
          sample.backend,
          ["adapter", "model", "protocol", "provider", "reasoning"],
          `${sampleLabel}.backend`,
        );
        for (const field of ["adapter", "model", "protocol", "provider", "reasoning"]) {
          requireNullableString(backend[field], `${sampleLabel}.backend.${field}`, 256);
        }
        if (Object.values(backend).every((item) => item === null)) {
          fail(`${sampleLabel}.backend must be null when every identity field is null`);
        }
      }
      if (sample.candidate !== null) {
        const candidate = requireFields(
          sample.candidate,
          ["artifact_path", "contamination_warning", "public", "sha256"],
          `${sampleLabel}.candidate`,
        );
        const artifactPath = requirePattern(
          candidate.artifact_path,
          `${sampleLabel}.candidate.artifact_path`,
          ARTIFACT_PATH_PATTERN,
          "a safe path below artifacts/",
        );
        if (
          !artifactPath.startsWith("artifacts/candidates/") ||
          path.posix.normalize(artifactPath) !== artifactPath ||
          artifactPath.includes("//") ||
          artifactPath.split("/").some((segment) => segment === "." || segment === "..")
        ) {
          fail(`${sampleLabel}.candidate.artifact_path must be canonical under artifacts/candidates/`);
        }
        requirePattern(candidate.sha256, `${sampleLabel}.candidate.sha256`, SHA256_PATTERN, "a SHA-256 digest");
        if (candidate.public !== true || candidate.contamination_warning !== CONTAMINATION_WARNING) {
          fail(`${sampleLabel}.candidate must carry the canonical public contamination disclosure`);
        }
        if (["adapter-failure", "unavailable"].includes(sample.outcome)) {
          fail(`${sampleLabel} unavailable outcome cannot publish a candidate`);
        }
      }
      if (sample.single_shot_pass) singleShotCorrect += 1;
      if (sample.repaired_pass) repairedCorrect += 1;
    }
    const passAtK = requireObject(task.pass_at_k, `${label}.pass_at_k`);
    const expectedKeys = Array.from(
      { length: task.samples.length },
      (_, index) => String(index + 1),
    );
    if (canonicalJson(Object.keys(passAtK).sort((left, right) => Number(left) - Number(right))) !== canonicalJson(expectedKeys)) {
      fail(`${label}.pass_at_k must contain every k from 1 through sample count`);
    }
    for (const kValue of expectedKeys) {
      const fraction = validateFraction(passAtK[kValue], `${label}.pass_at_k.${kValue}`);
      if (canonicalJson(fraction) !== canonicalJson(expectedPassAtK(task.samples.length, singleShotCorrect, Number(kValue)))) {
        fail(`${label}.pass_at_k.${kValue} does not match sample outcomes`);
      }
    }
    const repair = requireFields(task.repair_at_3, ["correct", "rate", "total"], `${label}.repair_at_3`);
    if (requireInteger(repair.correct, `${label}.repair_at_3.correct`, 0, task.samples.length) !== repairedCorrect) {
      fail(`${label}.repair_at_3.correct does not match sample outcomes`);
    }
    if (requireInteger(repair.total, `${label}.repair_at_3.total`, 1) !== task.samples.length) {
      fail(`${label}.repair_at_3.total does not match sample count`);
    }
    const rate = validateFraction(repair.rate, `${label}.repair_at_3.rate`);
    if (canonicalJson(rate) !== canonicalJson(reducedFraction(BigInt(repairedCorrect), BigInt(task.samples.length)))) {
      fail(`${label}.repair_at_3.rate does not match sample outcomes`);
    }
  }
  return synthesis;
}

function validatePublicArtifactDocument(document, artifact) {
  if (artifact.role === "public_results") return validatePublicResultsDocument(document).document;
  if (artifact.role === "public_report") return validatePublicReportDocument(document);
  if (artifact.role === "public_performance") return validatePublicPerformanceDocument(document);
  if (artifact.role === "public_synthesis") return validatePublicSynthesisDocument(document);
  if (artifact.role === "task_catalog") return validatePublicCatalogDocument(document);
  if (artifact.role === "task_projection") return validatePublicTaskDocument(document);
  return document;
}

async function scanArtifact(filePath, artifact) {
  if (artifact.size_bytes > MAX_JSON_ARTIFACT_BYTES) {
    if (artifact.media_type === "application/json" || artifact.media_type === "application/x-ndjson") {
      fail(`${artifact.path} exceeds the public structured-data size limit`);
    }
    return;
  }
  if (artifact.media_type === "application/json" || artifact.media_type === "application/schema+json") {
    const text = await readFile(filePath, "utf8");
    const document = strictJsonParse(text, artifact.path);
    scanPublicJson(document, artifact.path);
    if (SECRET_TEXT_PATTERN.test(text)) fail(`${artifact.path} contains secret-looking material`);
    return validatePublicArtifactDocument(document, artifact);
  }
  if (artifact.media_type === "application/x-ndjson") {
    fail("raw JSONL result artifacts are not publishable");
  }
  if (artifact.size_bytes <= MAX_JSON_ARTIFACT_BYTES) {
    const text = await readFile(filePath, "utf8");
    if (SECRET_TEXT_PATTERN.test(text)) fail(`${artifact.path} contains secret-looking material`);
  }
  return null;
}

function requireMetadataBinding(metadata, request, role) {
  const expected = {
    catalog_id: request.suite.dataset_id,
    profile_id: request.suite.profile_id,
    profile_identity: request.suite.profile_identity,
    compiler_id: request.execution.compiler_id,
    platform_id: request.platform.id,
    toolchain_id: request.platform.toolchain,
    model_id: request.model === null ? null : request.model.model,
  };
  for (const [field, expectedValue] of Object.entries(expected)) {
    if (metadata[field] !== expectedValue) {
      fail(`${role} metadata ${field} does not match publication request`);
    }
  }
}

function catalogTaskMap(catalog) {
  return new Map(catalog.tasks.map((task) => [task.id, task]));
}

function requireCatalogTask(tasks, taskId, taskRevision, label) {
  const task = tasks.get(taskId);
  if (task === undefined || task.revision !== taskRevision) {
    fail(`${label} does not match a public catalog task revision`);
  }
  return task;
}

function requireCatalogCase(tasks, taskId, taskRevision, caseId, executor, label) {
  const task = requireCatalogTask(tasks, taskId, taskRevision, label);
  if (!task.cases.some((item) => item.id === caseId && item.visibility === "public")) {
    fail(`${label} does not match a public catalog case`);
  }
  if (!task.execution.executors.includes(executor)) {
    fail(`${label} executor is not admitted by the public catalog task`);
  }
  return task;
}

function validateBundleBindings(request, documents) {
  if (request.execution.compiler_id !== request.source.commit_sha) {
    fail("execution.compiler_id does not match source.commit_sha");
  }
  const catalog = documents.get("task_catalog");
  if (!isPlainObject(catalog) || catalog.dataset_id !== request.suite.dataset_id) {
    fail("task catalog dataset_id does not match publication request");
  }
  const tasks = catalogTaskMap(catalog);
  if (request.suite.lane === "conformance") {
    const results = documents.get("public_results");
    const report = documents.get("public_report");
    if (!isPlainObject(results) || !isPlainObject(report)) {
      fail("conformance publication lacks structured public report evidence");
    }
    if (results.dataset_id !== request.suite.dataset_id) {
      fail("public results dataset_id does not match publication request");
    }
    if (results.profile_identity !== request.suite.profile_identity) {
      fail("public results profile_identity does not match publication request");
    }
    if (report.results_sha256 !== sha256(Buffer.from(canonicalJson(results), "utf8"))) {
      fail("public report does not bind public results");
    }
    requireMetadataBinding(report.metadata, request, "public_report");
    const resultCounts = validatePublicResultsDocument(results);
    for (const observation of results.public_observations) {
      const task = requireCatalogCase(
        tasks,
        observation.task_id,
        observation.task_revision,
        observation.case_id,
        observation.executor,
        "public result",
      );
      if (observation.fixture_maturity !== task.maturity) {
        fail("public result fixture maturity does not match public catalog task");
      }
    }
    for (const aggregate of results.non_public_aggregates) {
      const task = requireCatalogTask(
        tasks,
        aggregate.task_id,
        aggregate.task_revision,
        "non-public result aggregate",
      );
      if (!task.execution.executors.includes(aggregate.executor)) {
        fail("non-public result aggregate executor is not admitted by public catalog task");
      }
    }
    if (report.summary.total !== resultCounts.observationCount) {
      fail("public report total does not match public and non-public observation counts");
    }
  } else if (request.suite.lane === "performance") {
    const performance = documents.get("public_performance");
    if (!isPlainObject(performance)) fail("performance publication lacks public_performance");
    requireMetadataBinding(performance.metadata, request, "public_performance");
    for (const measurement of performance.measurements) {
      requireCatalogCase(
        tasks,
        measurement.task_id,
        measurement.task_revision,
        measurement.case_id,
        measurement.executor,
        "public performance measurement",
      );
    }
  } else if (request.suite.lane === "synthesis") {
    const synthesis = documents.get("public_synthesis");
    if (!isPlainObject(synthesis)) fail("synthesis publication lacks public_synthesis");
    if (synthesis.catalog_id !== request.suite.dataset_id) {
      fail("public synthesis catalog_id does not match publication request");
    }
    if (synthesis.profile_identity !== request.suite.profile_identity) {
      fail("public synthesis profile_identity does not match publication request");
    }
    for (const synthesisTask of synthesis.tasks) {
      const catalogTask = requireCatalogTask(
        tasks,
        synthesisTask.task_id,
        synthesisTask.task_revision,
        "public synthesis task",
      );
      if (catalogTask.synthesis.eligible !== true) {
        fail("public synthesis task is not synthesis-eligible in the public catalog");
      }
    }
    const candidateArtifacts = new Map(
      request.artifacts
        .filter((item) => item.role === "candidate_source")
        .map((item) => [item.path, item]),
    );
    const hasCandidates = candidateArtifacts.size > 0;
    if (
      synthesis.candidate_source_public !== hasCandidates ||
      request.disclosure.candidate_source_public !== hasCandidates
    ) {
      fail("public synthesis candidate flag does not match bundle");
    }
    const expectedWarning = hasCandidates ? CONTAMINATION_WARNING : null;
    if (
      synthesis.contamination_warning !== expectedWarning ||
      request.disclosure.contamination_warning !== expectedWarning
    ) {
      fail("public synthesis contamination warning does not match bundle");
    }
    const candidateReferenceCounts = new Map();
    for (const task of synthesis.tasks) {
      for (const sample of task.samples) {
        if (sample.backend !== null) {
          if (request.model === null) {
            fail("public synthesis backend identity requires publication model identity");
          }
          for (const field of ["adapter", "model", "provider"]) {
            if (sample.backend[field] !== request.model[field]) {
              fail(`public synthesis backend ${field} does not match publication model`);
            }
          }
        }
        if (sample.candidate === null) continue;
        const artifact = candidateArtifacts.get(sample.candidate.artifact_path);
        if (artifact === undefined) {
          fail("public synthesis references a missing candidate artifact");
        }
        if (sample.candidate.sha256 !== artifact.sha256) {
          fail("public synthesis candidate digest does not match artifact inventory");
        }
        candidateReferenceCounts.set(
          artifact.path,
          (candidateReferenceCounts.get(artifact.path) ?? 0) + 1,
        );
      }
    }
    for (const artifact of candidateArtifacts.values()) {
      if (candidateReferenceCounts.get(artifact.path) !== 1) {
        fail("candidate artifact must be referenced exactly once by public synthesis");
      }
    }
  } else {
    fail(`unsupported publication lane: ${request.suite.lane}`);
  }
}

export async function validateBundle(root) {
  const files = await listBundleFiles(root);
  if (!files.includes("publication.json")) fail("bundle must contain publication.json");
  if (files.length > MAX_ARTIFACTS + 1) fail("bundle contains too many files");
  const publicationPath = path.join(root, "publication.json");
  const publicationMetadata = await lstat(publicationPath);
  if (publicationMetadata.size > MAX_MANIFEST_BYTES) fail(`publication.json exceeds ${MAX_MANIFEST_BYTES} bytes`);
  const request = admitPublicationRequest(strictJsonParse(await readFile(publicationPath, "utf8"), "publication.json"));
  const expectedFiles = new Set(["publication.json", ...request.artifacts.map((item) => item.path)]);
  for (const file of files) if (!expectedFiles.has(file)) fail(`unlisted bundle file: ${file}`);
  for (const expected of expectedFiles) if (!files.includes(expected)) fail(`listed artifact is missing: ${expected}`);
  const documents = new Map();
  for (const artifact of request.artifacts) {
    const absolutePath = path.join(root, ...artifact.path.split("/"));
    const metadata = await lstat(absolutePath);
    if (!metadata.isFile() || metadata.isSymbolicLink()) fail(`artifact must be a regular file: ${artifact.path}`);
    if (metadata.size !== artifact.size_bytes) fail(`size mismatch for ${artifact.path}`);
    if ((await hashFile(absolutePath)) !== artifact.sha256) fail(`digest mismatch for ${artifact.path}`);
    const document = await scanArtifact(absolutePath, artifact);
    if (document !== null) documents.set(artifact.role, document);
  }
  validateBundleBindings(request, documents);
  return request;
}

function validatePublicationBinding(value, request) {
  const publication = requireFields(
    value,
    [
      "bundle_asset",
      "bundle_sha256",
      "public_artifact_base",
      "published_at",
      "release_tag",
      "repository",
    ],
    "publication",
  );
  if (publication.repository !== RELEASE_REPOSITORY) fail(`publication.repository must equal ${RELEASE_REPOSITORY}`);
  const expectedTag = `zlbench-${request.run_id}`;
  if (publication.release_tag !== expectedTag) fail(`publication.release_tag must equal ${expectedTag}`);
  const expectedAsset = `zlbench-${request.run_id}.tar.gz`;
  if (publication.bundle_asset !== expectedAsset) fail(`publication.bundle_asset must equal ${expectedAsset}`);
  const expectedPublicArtifactBase = `/benchmarks/runs/${request.run_id}/artifacts/`;
  if (publication.public_artifact_base !== expectedPublicArtifactBase) {
    fail(`publication.public_artifact_base must equal ${expectedPublicArtifactBase}`);
  }
  requirePattern(publication.bundle_sha256, "publication.bundle_sha256", SHA256_PATTERN, "a SHA-256 digest");
  const publishedAt = requireTimestamp(publication.published_at, "publication.published_at");
  if (Date.parse(publishedAt) < Date.parse(request.timestamps.completed_at)) {
    fail("publication.published_at must not precede benchmark completion");
  }
}

function signingPayload(manifest) {
  return Buffer.from(canonicalJson({ schema: manifest.schema, request: manifest.request, publication: manifest.publication }), "utf8");
}

export function createSignedManifest(requestDocument, options) {
  const request = admitPublicationRequest(requestDocument);
  const configuration = requireFields(options, ["bundleAsset", "bundleSha256", "keyId", "privateKey", "publishedAt", "repository"], "signing options");
  requirePattern(configuration.keyId, "signing options.keyId", KEY_ID_PATTERN, "a versioned benchmark Ed25519 key identifier");
  const unsigned = {
    schema: MANIFEST_SCHEMA,
    request,
    publication: {
      repository: configuration.repository,
      release_tag: `zlbench-${request.run_id}`,
      bundle_asset: configuration.bundleAsset,
      bundle_sha256: configuration.bundleSha256,
      public_artifact_base: `/benchmarks/runs/${request.run_id}/artifacts/`,
      published_at: configuration.publishedAt,
    },
  };
  validatePublicationBinding(unsigned.publication, request);
  let privateKey;
  try {
    privateKey = createPrivateKey(configuration.privateKey);
  } catch (cause) {
    fail(`benchmark signing private key is invalid: ${cause.message}`);
  }
  if (privateKey.asymmetricKeyType !== "ed25519") fail("benchmark signing key must be Ed25519");
  const signature = signBytes(null, signingPayload(unsigned), privateKey).toString("base64");
  return { ...unsigned, signature: { algorithm: "Ed25519", key_id: configuration.keyId, value: signature } };
}

export function validateTrustStore(document) {
  const store = requireFields(document, ["keys", "schema"], "benchmark trust store");
  if (store.schema !== KEY_SCHEMA) fail(`benchmark trust-store schema must equal ${KEY_SCHEMA}`);
  if (!Array.isArray(store.keys)) fail("benchmark trust-store keys must be an array");
  const trust = {};
  for (const [index, value] of store.keys.entries()) {
    const key = requireFields(value, ["algorithm", "key_id", "public_key_pem", "status"], `benchmark trust store.keys[${index}]`);
    requirePattern(key.key_id, `benchmark trust store.keys[${index}].key_id`, KEY_ID_PATTERN, "a versioned benchmark Ed25519 key identifier");
    if (key.algorithm !== "Ed25519") fail("benchmark trust-store keys must use Ed25519");
    requireOneOf(key.status, `benchmark trust store.keys[${index}].status`, ["active", "retired"]);
    if (
      typeof key.public_key_pem !== "string" ||
      Buffer.byteLength(key.public_key_pem) > 4096 ||
      key.public_key_pem !== `${key.public_key_pem.trim()}\n`
    ) {
      fail(`benchmark trust store.keys[${index}].public_key_pem must be canonical PEM ending in one newline`);
    }
    if (Object.prototype.hasOwnProperty.call(trust, key.key_id)) fail(`duplicate benchmark trust-store key: ${key.key_id}`);
    let publicKey;
    try {
      publicKey = createPublicKey(key.public_key_pem);
    } catch (cause) {
      fail(`invalid benchmark public key ${key.key_id}: ${cause.message}`);
    }
    if (publicKey.asymmetricKeyType !== "ed25519") fail(`benchmark public key ${key.key_id} must be Ed25519`);
    trust[key.key_id] = {
      public_key_pem: key.public_key_pem,
      status: key.status,
    };
  }
  return trust;
}

export function assertPrivateKeyTrusted(keyId, privateKeyValue, trustedKeys) {
  if (!Object.prototype.hasOwnProperty.call(trustedKeys, keyId)) fail(`untrusted benchmark signing key: ${keyId}`);
  const trustedEntry = trustedKeys[keyId];
  if (!isPlainObject(trustedEntry) || trustedEntry.status !== "active") {
    if (isPlainObject(trustedEntry) && trustedEntry.status === "retired") {
      fail(`retired benchmark signing key cannot sign new releases: ${keyId}`);
    }
    fail(`benchmark signing key lacks active trust metadata: ${keyId}`);
  }
  let derived;
  let trusted;
  try {
    derived = createPublicKey(createPrivateKey(privateKeyValue)).export({ format: "der", type: "spki" });
    trusted = createPublicKey(trustedEntry.public_key_pem).export({ format: "der", type: "spki" });
  } catch (cause) {
    fail(`unable to compare benchmark signing key: ${cause.message}`);
  }
  if (!Buffer.from(derived).equals(Buffer.from(trusted))) fail(`benchmark private key does not match trusted key: ${keyId}`);
}

export function verifySignedManifest(document, trustedKeys) {
  const manifest = requireFields(document, ["publication", "request", "schema", "signature"], "signed benchmark manifest");
  if (manifest.schema !== MANIFEST_SCHEMA) fail(`signed benchmark manifest schema must equal ${MANIFEST_SCHEMA}`);
  const request = admitPublicationRequest(manifest.request);
  validatePublicationBinding(manifest.publication, request);
  const signature = requireFields(manifest.signature, ["algorithm", "key_id", "value"], "signature");
  if (signature.algorithm !== "Ed25519") fail("signature.algorithm must equal Ed25519");
  requirePattern(signature.key_id, "signature.key_id", KEY_ID_PATTERN, "a versioned benchmark Ed25519 key identifier");
  const signatureValue = requireString(signature.value, "signature.value", 256);
  if (!/^[A-Za-z0-9+/]{86}==$/.test(signatureValue)) fail("signature.value must be a base64-encoded Ed25519 signature");
  if (!isPlainObject(trustedKeys) || !Object.prototype.hasOwnProperty.call(trustedKeys, signature.key_id)) {
    fail(`untrusted benchmark signing key: ${signature.key_id}`);
  }
  const trustedEntry = trustedKeys[signature.key_id];
  const trustedPublicKey = isPlainObject(trustedEntry)
    ? trustedEntry.public_key_pem
    : trustedEntry;
  let publicKey;
  try {
    publicKey = createPublicKey(trustedPublicKey);
  } catch (cause) {
    fail(`trusted benchmark public key is invalid: ${cause.message}`);
  }
  if (publicKey.asymmetricKeyType !== "ed25519") fail("trusted benchmark public key must be Ed25519");
  if (!verifyBytes(null, signingPayload(manifest), publicKey, Buffer.from(signatureValue, "base64"))) {
    fail("benchmark manifest signature verification failed");
  }
  return strictJsonParse(canonicalJson(manifest), "canonical signed benchmark manifest");
}

function createSignedIndex(index, options, trustedKeys) {
  const configuration = requireFields(
    options,
    ["keyId", "privateKey"],
    "index signing options",
  );
  assertPrivateKeyTrusted(
    configuration.keyId,
    configuration.privateKey,
    trustedKeys,
  );
  const payload = Buffer.from(canonicalJson(index));
  const privateKey = createPrivateKey(configuration.privateKey);
  return {
    algorithm: "Ed25519",
    index_sha256: sha256(payload),
    key_id: configuration.keyId,
    schema: INDEX_SIGNATURE_SCHEMA,
    value: signBytes(null, payload, privateKey).toString("base64"),
  };
}

export function verifySignedIndex(index, document, trustedKeys) {
  const signature = requireFields(
    document,
    ["algorithm", "index_sha256", "key_id", "schema", "value"],
    "benchmark index signature",
  );
  if (signature.schema !== INDEX_SIGNATURE_SCHEMA) {
    fail(`benchmark index signature schema must equal ${INDEX_SIGNATURE_SCHEMA}`);
  }
  if (signature.algorithm !== "Ed25519") {
    fail("benchmark index signature algorithm must equal Ed25519");
  }
  requirePattern(
    signature.key_id,
    "benchmark index signature.key_id",
    KEY_ID_PATTERN,
    "a versioned benchmark Ed25519 key identifier",
  );
  requirePattern(
    signature.index_sha256,
    "benchmark index signature.index_sha256",
    SHA256_PATTERN,
    "a lowercase SHA-256 digest",
  );
  const signatureValue = requireString(
    signature.value,
    "benchmark index signature.value",
    256,
  );
  if (!/^[A-Za-z0-9+/]{86}==$/.test(signatureValue)) {
    fail("benchmark index signature.value must be a base64 Ed25519 signature");
  }
  if (!Object.prototype.hasOwnProperty.call(trustedKeys, signature.key_id)) {
    fail(`untrusted benchmark signing key: ${signature.key_id}`);
  }
  const trustedEntry = trustedKeys[signature.key_id];
  const publicKeyValue = isPlainObject(trustedEntry)
    ? trustedEntry.public_key_pem
    : trustedEntry;
  const payload = Buffer.from(canonicalJson(index));
  if (sha256(payload) !== signature.index_sha256) {
    fail("benchmark index digest does not match its signature");
  }
  let publicKey;
  try {
    publicKey = createPublicKey(publicKeyValue);
  } catch (cause) {
    fail(`trusted benchmark public key is invalid: ${cause.message}`);
  }
  if (
    publicKey.asymmetricKeyType !== "ed25519" ||
    !verifyBytes(
      null,
      payload,
      publicKey,
      Buffer.from(signatureValue, "base64"),
    )
  ) {
    fail("benchmark index signature verification failed");
  }
  return index;
}

async function readExistingIndex(indexPath, signaturePath, trustedKeys) {
  try {
    const text = await readFile(indexPath, "utf8");
    const document = requireFields(strictJsonParse(text, "benchmark index"), ["runs", "schema", "updated_at"], "benchmark index");
    if (document.schema !== INDEX_SCHEMA) fail(`benchmark index schema must equal ${INDEX_SCHEMA}`);
    requireTimestamp(document.updated_at, "benchmark index.updated_at");
    if (!Array.isArray(document.runs)) fail("benchmark index.runs must be an array");
    if (document.runs.length > MAX_INDEX_RUNS) {
      fail(`benchmark index.runs must contain at most ${MAX_INDEX_RUNS} runs`);
    }
    const seen = new Set();
    for (const [index, entry] of document.runs.entries()) {
      requireFields(entry, ["bundle_asset", "bundle_sha256", "dataset_id", "lane", "manifest_path", "manifest_sha256", "profile_id", "profile_identity", "public_artifact_base", "published_at", "release_tag", "run_id", "source_sha", "status", "suite_id"], `benchmark index.runs[${index}]`);
      if (seen.has(entry.run_id)) fail(`benchmark index contains duplicate run: ${entry.run_id}`);
      seen.add(entry.run_id);
    }
    const signature = strictJsonParse(
      await readFile(signaturePath, "utf8"),
      "benchmark index signature",
    );
    verifySignedIndex(document, signature, trustedKeys);
    return document;
  } catch (cause) {
    if (cause !== null && typeof cause === "object" && cause.code === "ENOENT") {
      return { schema: INDEX_SCHEMA, updated_at: "1970-01-01T00:00:00.000Z", runs: [] };
    }
    throw cause;
  }
}

async function atomicWriteJson(destination, document) {
  await mkdir(path.dirname(destination), { recursive: true });
  const temporary = `${destination}.tmp-${process.pid}`;
  await writeFile(temporary, `${canonicalJson(document)}\n`, { encoding: "utf8", flag: "wx" });
  await rename(temporary, destination);
}

export async function publishPagesManifest(
  siteRoot,
  document,
  trustedKeys,
  bundleRoot,
  indexSigningOptions,
) {
  const manifest = verifySignedManifest(document, trustedKeys);
  const request = manifest.request;
  const validatedBundleRequest = await validateBundle(bundleRoot);
  if (canonicalJson(validatedBundleRequest) !== canonicalJson(request)) {
    fail("Pages bundle request does not match signed benchmark manifest");
  }
  const benchmarksRoot = path.join(siteRoot, "benchmarks");
  const runsRoot = path.join(benchmarksRoot, "runs");
  const runRoot = path.join(runsRoot, request.run_id);
  const indexPath = path.join(benchmarksRoot, "index.json");
  const indexSignaturePath = path.join(benchmarksRoot, "index.signature.json");
  const index = await readExistingIndex(indexPath, indexSignaturePath, trustedKeys);
  if (index.runs.some((item) => item.run_id === request.run_id)) {
    fail(`run is already published and cannot be overwritten: ${request.run_id}`);
  }
  if (index.runs.length >= MAX_INDEX_RUNS) {
    fail(`benchmark index is full at ${MAX_INDEX_RUNS} runs; publish a paginated schema revision`);
  }
  try {
    await lstat(runRoot);
    fail(`partial or conflicting run directory already exists: ${request.run_id}`);
  } catch (cause) {
    if (!(cause !== null && typeof cause === "object" && cause.code === "ENOENT")) throw cause;
  }
  const manifestPayload = `${canonicalJson(manifest)}\n`;
  const entry = {
    run_id: request.run_id,
    suite_id: request.suite.id,
    dataset_id: request.suite.dataset_id,
    profile_id: request.suite.profile_id,
    profile_identity: request.suite.profile_identity,
    lane: request.suite.lane,
    status: request.status,
    source_sha: request.source.commit_sha,
    published_at: manifest.publication.published_at,
    manifest_path: `/benchmarks/runs/${request.run_id}/manifest.json`,
    manifest_sha256: sha256(Buffer.from(manifestPayload, "utf8")),
    public_artifact_base: manifest.publication.public_artifact_base,
    release_tag: manifest.publication.release_tag,
    bundle_asset: manifest.publication.bundle_asset,
    bundle_sha256: manifest.publication.bundle_sha256,
  };
  await mkdir(runsRoot, { recursive: true });
  const stagingRoot = await mkdtemp(path.join(runsRoot, `.staging-${request.run_id}-`));
  let promoted = false;
  try {
    await writeFile(path.join(stagingRoot, "manifest.json"), manifestPayload, {
      encoding: "utf8",
      flag: "wx",
    });
    for (const artifact of request.artifacts) {
      if (!PAGES_ARTIFACT_ROLES.has(artifact.role)) continue;
      if (artifact.media_type !== "application/json") {
        fail(`Pages artifact ${artifact.path} must use application/json`);
      }
      const relativePath = artifact.path.slice("artifacts/".length);
      const sourcePath = path.join(bundleRoot, ...artifact.path.split("/"));
      const destinationPath = path.join(stagingRoot, "artifacts", ...relativePath.split("/"));
      await mkdir(path.dirname(destinationPath), { recursive: true });
      await copyFile(sourcePath, destinationPath);
      const copiedMetadata = await lstat(destinationPath);
      if (!copiedMetadata.isFile() || copiedMetadata.isSymbolicLink()) {
        fail(`copied Pages artifact is not a regular file: ${artifact.path}`);
      }
      if (copiedMetadata.size !== artifact.size_bytes) {
        fail(`copied Pages artifact size mismatch: ${artifact.path}`);
      }
      if ((await hashFile(destinationPath)) !== artifact.sha256) {
        fail(`copied Pages artifact digest mismatch: ${artifact.path}`);
      }
    }
    await rename(stagingRoot, runRoot);
    promoted = true;
  } finally {
    if (!promoted) await rm(stagingRoot, { force: true, recursive: true });
  }
  const nextIndex = {
    schema: INDEX_SCHEMA,
    updated_at: manifest.publication.published_at,
    runs: [...index.runs, entry],
  };
  const indexSignature = createSignedIndex(
    nextIndex,
    indexSigningOptions,
    trustedKeys,
  );
  await atomicWriteJson(indexPath, nextIndex);
  await atomicWriteJson(indexSignaturePath, indexSignature);
  const latestPath = path.join(siteRoot, "benchmarks", "latest", request.suite.id, `${request.suite.lane}.json`);
  await atomicWriteJson(latestPath, { schema: LATEST_SCHEMA, ...entry });
  return entry;
}

async function readStrictJsonFile(filePath, maximumBytes, label) {
  const metadata = await lstat(filePath);
  if (!metadata.isFile() || metadata.isSymbolicLink()) fail(`${label} path must identify a regular file`);
  if (metadata.size > maximumBytes) fail(`${label} exceeds ${maximumBytes} bytes`);
  return strictJsonParse(await readFile(filePath, "utf8"), label);
}

function commandOptions(argumentsList, required) {
  const options = {};
  for (let index = 0; index < argumentsList.length; index += 2) {
    const name = argumentsList[index];
    const value = argumentsList[index + 1];
    if (typeof name !== "string" || !name.startsWith("--") || value === undefined) fail("command options must be --name value pairs");
    const field = name.slice(2);
    if (Object.prototype.hasOwnProperty.call(options, field)) fail(`duplicate command option: --${field}`);
    options[field] = value;
  }
  for (const field of required) if (!Object.prototype.hasOwnProperty.call(options, field)) fail(`missing command option: --${field}`);
  for (const field of Object.keys(options)) if (!required.includes(field)) fail(`unexpected command option: --${field}`);
  return options;
}

async function readTrustStore(filePath) {
  return validateTrustStore(await readStrictJsonFile(filePath, MAX_MANIFEST_BYTES, "benchmark trust store"));
}

async function main() {
  const [command, target, ...argumentsList] = process.argv.slice(2);
  if (command === "validate-delivery" && target !== undefined && argumentsList.length === 0) {
    const delivery = validateDeliveryRequest(await readStrictJsonFile(target, MAX_MANIFEST_BYTES, "delivery request"));
    process.stdout.write(`${canonicalJson(delivery)}\n`);
    return;
  }
  if (command === "validate-bundle" && target !== undefined && argumentsList.length === 0) {
    process.stdout.write(`${canonicalJson(await validateBundle(target))}\n`);
    return;
  }
  if (command === "sign" && target !== undefined) {
    const options = commandOptions(argumentsList, ["bundle-asset", "bundle-sha256", "key-id", "keys", "output", "private-key", "published-at"]);
    const request = await validateBundle(target);
    const trust = await readTrustStore(options.keys);
    const privateKey = await readFile(options["private-key"], "utf8");
    assertPrivateKeyTrusted(options["key-id"], privateKey, trust);
    const manifest = createSignedManifest(request, {
      repository: RELEASE_REPOSITORY,
      bundleAsset: options["bundle-asset"],
      bundleSha256: options["bundle-sha256"],
      publishedAt: options["published-at"],
      keyId: options["key-id"],
      privateKey,
    });
    await atomicWriteJson(options.output, manifest);
    process.stdout.write(`${canonicalJson(manifest)}\n`);
    return;
  }
  if (command === "verify" && target !== undefined) {
    const options = commandOptions(argumentsList, ["keys"]);
    const manifest = await readStrictJsonFile(target, MAX_MANIFEST_BYTES, "signed benchmark manifest");
    const trust = await readTrustStore(options.keys);
    process.stdout.write(`${canonicalJson(verifySignedManifest(manifest, trust))}\n`);
    return;
  }
  if (command === "publish-pages" && target !== undefined) {
    const options = commandOptions(argumentsList, ["bundle", "key-id", "keys", "private-key", "site"]);
    const manifest = await readStrictJsonFile(target, MAX_MANIFEST_BYTES, "signed benchmark manifest");
    const trust = await readTrustStore(options.keys);
    const privateKey = await readFile(options["private-key"], "utf8");
    process.stdout.write(`${canonicalJson(await publishPagesManifest(
      options.site,
      manifest,
      trust,
      options.bundle,
      { keyId: options["key-id"], privateKey },
    ))}\n`);
    return;
  }
  fail("usage: benchmark-publication.mjs validate-delivery FILE | validate-bundle DIR | sign DIR OPTIONS | verify MANIFEST --keys FILE | publish-pages MANIFEST --bundle DIR --key-id ID --keys FILE --private-key FILE --site DIR");
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(`benchmark-publication: ${error.message}`);
    process.exitCode = 1;
  });
}
