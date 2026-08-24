#!/usr/bin/env node

import {
  createHash,
  createPrivateKey,
  createPublicKey,
  sign,
  verify,
} from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readFile, writeFile } from "node:fs/promises";
import { basename } from "node:path";
import { pathToFileURL } from "node:url";

import { validateReleaseRequest } from "./release-request.mjs";

const MAX_FEED_BYTES = 2 * 1024 * 1024;
const MAX_ASSET_BYTES = 2 * 1024 * 1024 * 1024;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const KEY_ID_PATTERN = /^zerglang-release-ed25519-(\d{4})-(\d{2})(?:-[a-z0-9-]+)?$/;
const TARGET = "aarch64-apple-darwin";

export class CohortPayloadError extends Error {
  constructor(message) {
    super(message);
    this.name = "CohortPayloadError";
  }
}

function fail(message) {
  throw new CohortPayloadError(message);
}

function isObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactObject(value, fields, label) {
  if (!isObject(value)) fail(`${label} must be a JSON object`);
  const expected = [...fields].sort();
  const actual = Object.keys(value).sort();
  const missing = expected.find((field) => !actual.includes(field));
  if (missing !== undefined) fail(`${label} is missing required field: ${missing}`);
  const unexpected = actual.find((field) => !expected.includes(field));
  if (unexpected !== undefined) fail(`${label} contains unexpected field: ${unexpected}`);
  return value;
}

function requiredString(value, label) {
  if (typeof value !== "string" || value === "" || value !== value.trim()) {
    fail(`${label} must be a non-empty canonical string`);
  }
  return value;
}

function httpsUrl(value, label) {
  const text = requiredString(value, label);
  let parsed;
  try {
    parsed = new URL(text);
  } catch {
    fail(`${label} must be an HTTPS URL`);
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.hostname === ""
  ) {
    fail(`${label} must be an HTTPS URL`);
  }
  return text;
}

export function canonicalJson(value) {
  if (value === null) return "null";
  if (typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || Object.is(value, -0)) {
      fail("canonical release JSON numbers must be safe integers");
    }
    return String(value);
  }
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      if (!Object.hasOwn(value, index)) fail("canonical release JSON arrays must not be sparse");
    }
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (isObject(value)) {
    return `{${Object.keys(value).sort().map((key) => {
      if (value[key] === undefined) fail("canonical release JSON cannot contain undefined");
      return `${JSON.stringify(key)}:${canonicalJson(value[key])}`;
    }).join(",")}}`;
  }
  fail("canonical release JSON contains an unsupported value");
}

function publicKeyDer(pem, label) {
  if (
    typeof pem !== "string" ||
    !pem.startsWith("-----BEGIN PUBLIC KEY-----\n") ||
    !pem.endsWith("-----END PUBLIC KEY-----\n")
  ) {
    fail(`${label} must be canonical public Ed25519 SPKI PEM`);
  }
  let key;
  try {
    key = createPublicKey(pem);
  } catch {
    fail(`${label} is not a valid public key`);
  }
  if (key.asymmetricKeyType !== "ed25519") fail(`${label} must be Ed25519`);
  const canonicalPem = key.export({ format: "pem", type: "spki" }).toString();
  if (canonicalPem !== pem) fail(`${label} must be canonical public Ed25519 SPKI PEM`);
  return key.export({ format: "der", type: "spki" });
}

export function validateTrustStore(value) {
  const trustStore = exactObject(value, ["keys", "schema"], "release trust store");
  if (trustStore.schema !== "zerglang.release-signing-keys/1") {
    fail("release trust store schema is not supported");
  }
  if (!Array.isArray(trustStore.keys) || trustStore.keys.length === 0) {
    fail("release trust store must contain at least one signing key");
  }
  const keyIds = new Set();
  const keys = trustStore.keys.map((rawKey, index) => {
    const label = `release trust store key ${index}`;
    const key = exactObject(
      rawKey,
      ["algorithm", "key_id", "public_key_pem", "status"],
      label,
    );
    if (key.algorithm !== "Ed25519") fail(`${label} algorithm must be Ed25519`);
    const keyId = requiredString(key.key_id, `${label} key ID`);
    const match = KEY_ID_PATTERN.exec(keyId);
    if (match === null || Number(match[2]) < 1 || Number(match[2]) > 12) {
      fail(`${label} key ID is not canonical`);
    }
    if (keyIds.has(keyId)) fail(`release trust store contains duplicate key ID: ${keyId}`);
    keyIds.add(keyId);
    if (key.status !== "active" && key.status !== "retired") {
      fail(`${label} status must be active or retired`);
    }
    if (typeof key.public_key_pem !== "string" || key.public_key_pem === "") {
      fail(`${label} public key must be non-empty PEM`);
    }
    const publicKeyPem = key.public_key_pem;
    publicKeyDer(publicKeyPem, `${label} public key`);
    return {
      algorithm: "Ed25519",
      key_id: keyId,
      public_key_pem: publicKeyPem,
      status: key.status,
    };
  });
  return { schema: "zerglang.release-signing-keys/1", keys };
}

async function regularAsset(path, expectedName, label) {
  let metadata;
  try {
    metadata = await lstat(path);
  } catch {
    fail(`${label} does not exist`);
  }
  if (metadata.isSymbolicLink() || !metadata.isFile()) fail(`${label} must be a regular file`);
  if (metadata.size < 1 || metadata.size > MAX_ASSET_BYTES) {
    fail(`${label} size is outside the release boundary`);
  }
  if (basename(path) !== expectedName) fail(`${label} must be named ${expectedName}`);
  return metadata;
}

async function sha256File(path) {
  const digest = createHash("sha256");
  for await (const chunk of createReadStream(path)) digest.update(chunk);
  return digest.digest("hex");
}

function releaseAssetUrl(repository, tag, name) {
  return `https://github.com/${repository}/releases/download/` +
    `${encodeURIComponent(tag)}/${encodeURIComponent(name)}`;
}

export async function buildReleaseCohort(options) {
  const request = validateReleaseRequest(options.request);
  if (options.releaseRepository !== "Epoch-ML/zerglang-releases") {
    fail("release repository must equal Epoch-ML/zerglang-releases");
  }
  const ideName = `ZergLang_${request.version}_aarch64.dmg`;
  const toolchainName = `zerglang-toolchain-${request.version}-${TARGET}.tar.gz`;
  const ideMetadata = await regularAsset(options.ideAssetPath, ideName, "IDE asset");
  const toolchainMetadata = await regularAsset(
    options.toolchainArchivePath,
    toolchainName,
    "toolchain archive",
  );
  const releaseUrl = `https://github.com/${options.releaseRepository}/releases/tag/` +
    encodeURIComponent(request.release_tag);
  return {
    channel: request.channel,
    products: {
      ide: {
        asset: {
          architecture: "Apple Silicon",
          format: "dmg",
          name: ideName,
          sha256: await sha256File(options.ideAssetPath),
          size: ideMetadata.size,
          target: TARGET,
          url: releaseAssetUrl(options.releaseRepository, request.release_tag, ideName),
        },
        commands: ["ZergLang"],
        minimum_macos: "15.0",
        update_manifest_url:
          `https://epoch-ml.github.io/zerglang-releases/${request.channel}/latest.json`,
        version: request.version,
      },
      toolchain: {
        asset: {
          architecture: "Apple Silicon",
          format: "tar.gz",
          name: toolchainName,
          sha256: await sha256File(options.toolchainArchivePath),
          size: toolchainMetadata.size,
          target: TARGET,
          url: releaseAssetUrl(options.releaseRepository, request.release_tag, toolchainName),
        },
        commands: ["zlc", "zlm", "zlsync", "zlbench-exec"],
        minimum_macos: "15.0",
        update_manifest_url:
          "https://epoch-ml.github.io/zerglang-releases/toolchains/v1/" +
          `channels/${request.channel}/latest.json`,
        version: request.version,
      },
    },
    published_at: request.requested_at,
    release_url: releaseUrl,
    schema: "zerglang.release-cohort/1",
    source_sha: request.source_sha,
    version: request.version,
  };
}

function validateAsset(value, label, format, suffix) {
  const asset = exactObject(
    value,
    ["architecture", "format", "name", "sha256", "size", "target", "url"],
    `${label} asset`,
  );
  if (
    asset.architecture !== "Apple Silicon" ||
    asset.format !== format ||
    asset.target !== TARGET ||
    typeof asset.name !== "string" ||
    !asset.name.endsWith(suffix) ||
    !SHA256_PATTERN.test(asset.sha256) ||
    !Number.isSafeInteger(asset.size) ||
    asset.size < 1 ||
    asset.size > MAX_ASSET_BYTES
  ) {
    fail(`${label} asset is not supported`);
  }
  httpsUrl(asset.url, `${label} asset URL`);
}

function validateProduct(value, label, version, commands, format, suffix) {
  const product = exactObject(
    value,
    ["asset", "commands", "minimum_macos", "update_manifest_url", "version"],
    `${label} product`,
  );
  if (product.version !== version) fail(`${label} version does not match the release cohort`);
  if (
    !Array.isArray(product.commands) ||
    product.commands.length !== commands.length ||
    product.commands.some((command, index) => command !== commands[index])
  ) {
    fail(`${label} commands do not expose the required entrypoints`);
  }
  if (product.minimum_macos !== "15.0") fail(`${label} minimum macOS is not supported`);
  httpsUrl(product.update_manifest_url, `${label} update manifest URL`);
  validateAsset(product.asset, label, format, suffix);
}

export function validateReleaseCohort(value) {
  const cohort = exactObject(
    value,
    ["channel", "products", "published_at", "release_url", "schema", "source_sha", "version"],
    "release cohort",
  );
  if (cohort.schema !== "zerglang.release-cohort/1") fail("release cohort schema is not supported");
  const tag = cohort.channel === "stable"
    ? `zerglang-v${cohort.version}`
    : `zerglang-preview-v${cohort.version}`;
  validateReleaseRequest({
    channel: cohort.channel,
    products: ["ide", "toolchain"],
    release_tag: tag,
    requested_at: cohort.published_at,
    schema: "zerglang.release-request/2",
    source_ref: `refs/tags/${tag}`,
    source_repository: "Epoch-ML/zerg",
    source_sha: cohort.source_sha,
    version: cohort.version,
  });
  httpsUrl(cohort.release_url, "release cohort URL");
  const products = exactObject(cohort.products, ["ide", "toolchain"], "release cohort products");
  validateProduct(products.ide, "IDE", cohort.version, ["ZergLang"], "dmg", ".dmg");
  validateProduct(
    products.toolchain,
    "toolchain",
    cohort.version,
    ["zlc", "zlm", "zlsync", "zlbench-exec"],
    "tar.gz",
    ".tar.gz",
  );
  const expectedToolchain = `zerglang-toolchain-${cohort.version}-${TARGET}.tar.gz`;
  if (products.toolchain.asset.name !== expectedToolchain) {
    fail("toolchain archive name does not match its release identity");
  }
  return cohort;
}

function activeKeyForPrivateKey(trustStore, privateKeyPem) {
  let privateKey;
  try {
    privateKey = createPrivateKey(privateKeyPem);
  } catch {
    fail("release signing private key is not valid PKCS#8 PEM");
  }
  if (privateKey.asymmetricKeyType !== "ed25519") fail("release signing private key must be Ed25519");
  const derived = createPublicKey(privateKey).export({ format: "der", type: "spki" });
  const matches = trustStore.keys.filter((key) =>
    key.status === "active" &&
    publicKeyDer(key.public_key_pem, "release signing public key").equals(derived));
  if (matches.length !== 1) fail("private key does not match one active release signing key");
  return { privateKey, key: matches[0] };
}

export function signReleaseCohort(options) {
  const cohort = validateReleaseCohort(options.cohort);
  const trustStore = validateTrustStore(options.trustStore);
  const { privateKey, key } = activeKeyForPrivateKey(trustStore, options.privateKeyPem);
  const canonical = canonicalJson(cohort);
  return {
    algorithm: "Ed25519",
    cohort_sha256: createHash("sha256").update(canonical).digest("hex"),
    key_id: key.key_id,
    schema: "zerglang.release-cohort-signature/1",
    value: sign(null, Buffer.from(canonical), privateKey).toString("base64"),
  };
}

export function verifyReleaseCohort(options) {
  const cohort = validateReleaseCohort(options.cohort);
  const trustStore = validateTrustStore(options.trustStore);
  const signature = exactObject(
    options.signature,
    ["algorithm", "cohort_sha256", "key_id", "schema", "value"],
    "release cohort signature",
  );
  if (
    signature.schema !== "zerglang.release-cohort-signature/1" ||
    signature.algorithm !== "Ed25519"
  ) {
    fail("release cohort signature schema is not supported");
  }
  if (!SHA256_PATTERN.test(signature.cohort_sha256)) fail("cohort signature digest is malformed");
  const key = trustStore.keys.find((candidate) => candidate.key_id === signature.key_id);
  if (key === undefined || key.status !== "active") fail("cohort signature key is not active");
  const canonical = canonicalJson(cohort);
  const digest = createHash("sha256").update(canonical).digest("hex");
  if (digest !== signature.cohort_sha256) fail("cohort digest does not match its signature");
  let signatureBytes;
  try {
    signatureBytes = Buffer.from(signature.value, "base64");
  } catch {
    fail("cohort signature is not canonical base64");
  }
  if (
    signatureBytes.length !== 64 ||
    signatureBytes.toString("base64") !== signature.value
  ) {
    fail("cohort signature is not canonical base64");
  }
  const publicKey = createPublicKey(key.public_key_pem);
  if (!verify(null, Buffer.from(canonical), publicKey, signatureBytes)) {
    fail("cohort signature verification failed");
  }
  return key.key_id;
}

async function readJson(path, label) {
  const metadata = await lstat(path).catch(() => fail(`${label} does not exist`));
  if (metadata.isSymbolicLink() || !metadata.isFile()) fail(`${label} must be a regular file`);
  if (metadata.size > MAX_FEED_BYTES) fail(`${label} exceeds ${MAX_FEED_BYTES} bytes`);
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    fail(`${label} must contain valid JSON`);
  }
}

async function main() {
  const operation = process.argv[2];
  if (operation === "prepare" && process.argv.length === 7) {
    const request = await readJson(process.argv[3], "release request");
    const cohort = await buildReleaseCohort({
      request,
      ideAssetPath: process.argv[4],
      toolchainArchivePath: process.argv[5],
      releaseRepository: "Epoch-ML/zerglang-releases",
    });
    await writeFile(process.argv[6], canonicalJson(cohort), { flag: "wx", mode: 0o644 });
    return;
  }
  if (operation === "sign" && process.argv.length === 6) {
    const privateKeyPem = process.env.ZERGLANG_RELEASE_SIGNING_PRIVATE_KEY;
    if (typeof privateKeyPem !== "string" || privateKeyPem.trim() === "") {
      fail("ZERGLANG_RELEASE_SIGNING_PRIVATE_KEY is unavailable");
    }
    const cohort = await readJson(process.argv[3], "release cohort");
    const trustStore = await readJson(process.argv[4], "release trust store");
    const signature = signReleaseCohort({ cohort, privateKeyPem, trustStore });
    await writeFile(process.argv[5], `${canonicalJson(signature)}\n`, { flag: "wx", mode: 0o644 });
    return;
  }
  if (operation === "verify" && process.argv.length === 6) {
    const cohort = await readJson(process.argv[3], "release cohort");
    const trustStore = await readJson(process.argv[4], "release trust store");
    const signature = await readJson(process.argv[5], "release cohort signature");
    const keyId = verifyReleaseCohort({ cohort, signature, trustStore });
    process.stdout.write(`${JSON.stringify({ key_id: keyId })}\n`);
    return;
  }
  fail("usage: cohort-payload.mjs prepare REQUEST DMG TOOLCHAIN COHORT | " +
    "sign COHORT KEYS SIGNATURE | verify COHORT KEYS SIGNATURE");
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main().catch((error) => {
    console.error(`cohort-payload: ${error.message}`);
    process.exitCode = 1;
  });
}
