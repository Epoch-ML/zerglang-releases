import assert from "node:assert/strict";
import { createPrivateKey, createPublicKey, generateKeyPairSync } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, open, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, test } from "node:test";

import {
  buildReleaseCohort,
  canonicalJson,
  CohortPayloadError,
  signReleaseCohort,
  validateReleaseCohort,
  validateTrustStore,
  verifyReleaseCohort,
} from "./cohort-payload.mjs";

const temporaryDirectories = [];
const sourceSha = "0123456789abcdef0123456789abcdef01234567";
const cohortCli = fileURLToPath(new URL("./cohort-payload.mjs", import.meta.url));

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

function request(overrides = {}) {
  return {
    channel: "preview",
    products: ["ide", "toolchain"],
    release_tag: "zerglang-preview-v0.2.0-preview.1",
    requested_at: "2026-08-23T17:08:57.000Z",
    schema: "zerglang.release-request/2",
    source_ref: "refs/tags/zerglang-preview-v0.2.0-preview.1",
    source_repository: "Epoch-ML/zerg",
    source_sha: sourceSha,
    version: "0.2.0-preview.1",
    ...overrides,
  };
}

function signingFixture(status = "active") {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const keyId = "zerglang-release-ed25519-2026-08-preview";
  const trustStore = {
    schema: "zerglang.release-signing-keys/1",
    keys: [{
      algorithm: "Ed25519",
      key_id: keyId,
      public_key_pem: publicKey.export({ format: "pem", type: "spki" }).toString(),
      status,
    }],
  };
  return {
    keyId,
    privateKeyPem: privateKey.export({ format: "pem", type: "pkcs8" }).toString(),
    trustStore,
  };
}

async function assetFixture() {
  const root = await mkdtemp(join(tmpdir(), "zerglang-cohort-"));
  temporaryDirectories.push(root);
  const ideAssetPath = join(root, "ZergLang_0.2.0-preview.1_aarch64.dmg");
  const toolchainArchivePath = join(
    root,
    "zerglang-toolchain-0.2.0-preview.1-aarch64-apple-darwin.tar.gz",
  );
  await writeFile(ideAssetPath, "signed dmg bytes");
  await writeFile(toolchainArchivePath, "signed toolchain bytes");
  return { ideAssetPath, root, toolchainArchivePath };
}

async function cohortFixture() {
  const assets = await assetFixture();
  const cohort = await buildReleaseCohort({
    request: request(),
    ideAssetPath: assets.ideAssetPath,
    toolchainArchivePath: assets.toolchainArchivePath,
    releaseRepository: "Epoch-ML/zerglang-releases",
  });
  return { assets, cohort };
}

test("builds and signs the exact lockstep IDE and toolchain cohort", async () => {
  const assets = await assetFixture();
  const cohort = await buildReleaseCohort({
    request: request(),
    ideAssetPath: assets.ideAssetPath,
    toolchainArchivePath: assets.toolchainArchivePath,
    releaseRepository: "Epoch-ML/zerglang-releases",
  });

  assert.equal(cohort.schema, "zerglang.release-cohort/1");
  assert.equal(cohort.version, "0.2.0-preview.1");
  assert.equal(cohort.source_sha, sourceSha);
  assert.deepEqual(Object.keys(cohort.products), ["ide", "toolchain"]);
  assert.deepEqual(cohort.products.ide.commands, ["ZergLang"]);
  assert.deepEqual(
    cohort.products.toolchain.commands,
    ["zlc", "zlm", "zlsync", "zlbench-exec"],
  );
  assert.equal(
    cohort.products.toolchain.asset.name,
    "zerglang-toolchain-0.2.0-preview.1-aarch64-apple-darwin.tar.gz",
  );
  assert.equal(cohort.products.ide.asset.size, Buffer.byteLength("signed dmg bytes"));
  assert.match(cohort.products.toolchain.asset.sha256, /^[0-9a-f]{64}$/);
  assert.equal(
    cohort.products.toolchain.update_manifest_url,
    "https://epoch-ml.github.io/zerglang-releases/toolchains/v1/channels/preview/latest.json",
  );

  const keys = signingFixture();
  const signature = signReleaseCohort({
    cohort,
    privateKeyPem: keys.privateKeyPem,
    trustStore: keys.trustStore,
  });
  assert.deepEqual(Object.keys(signature).sort(), [
    "algorithm",
    "cohort_sha256",
    "key_id",
    "schema",
    "value",
  ]);
  assert.equal(signature.key_id, keys.keyId);
  assert.equal(verifyReleaseCohort({ cohort, signature, trustStore: keys.trustStore }), keys.keyId);

  await assert.rejects(
    buildReleaseCohort({
      request: request({
        version: "0.2.0-preview.2",
        release_tag: "zerglang-preview-v0.2.0-preview.2",
        source_ref: "refs/tags/zerglang-preview-v0.2.0-preview.2",
      }),
      ideAssetPath: assets.ideAssetPath,
      toolchainArchivePath: assets.toolchainArchivePath,
      releaseRepository: "Epoch-ML/zerglang-releases",
    }),
    /IDE asset must be named ZergLang_0\.2\.0-preview\.2_aarch64\.dmg/,
  );
});

test("verification rejects tampered cohorts, signatures, and retired signing authority", async () => {
  const assets = await assetFixture();
  const cohort = await buildReleaseCohort({
    request: request(),
    ideAssetPath: assets.ideAssetPath,
    toolchainArchivePath: assets.toolchainArchivePath,
    releaseRepository: "Epoch-ML/zerglang-releases",
  });
  const keys = signingFixture();
  const signature = signReleaseCohort({
    cohort,
    privateKeyPem: keys.privateKeyPem,
    trustStore: keys.trustStore,
  });

  assert.throws(
    () => verifyReleaseCohort({
      cohort: { ...cohort, source_sha: "a".repeat(40) },
      signature,
      trustStore: keys.trustStore,
    }),
    /cohort digest does not match its signature/,
  );
  assert.throws(
    () => verifyReleaseCohort({
      cohort,
      signature: { ...signature, value: Buffer.alloc(64, 7).toString("base64") },
      trustStore: keys.trustStore,
    }),
    /cohort signature verification failed/,
  );
  assert.throws(
    () => signReleaseCohort({
      cohort,
      privateKeyPem: keys.privateKeyPem,
      trustStore: { ...keys.trustStore, keys: [{ ...keys.trustStore.keys[0], status: "retired" }] },
    }),
    /private key does not match one active release signing key/,
  );
});

test("trust stores are exact, duplicate-free Ed25519 rotation documents", () => {
  const keys = signingFixture();
  assert.equal(validateTrustStore(keys.trustStore).keys[0].key_id, keys.keyId);

  for (const [candidate, message] of [
    [{ ...keys.trustStore, allow_unsigned: true }, /unexpected field: allow_unsigned/],
    [{ ...keys.trustStore, keys: [] }, /at least one signing key/],
    [{ ...keys.trustStore, keys: [...keys.trustStore.keys, keys.trustStore.keys[0]] }, /duplicate/],
    [{ ...keys.trustStore, keys: [{ ...keys.trustStore.keys[0], algorithm: "RSA" }] }, /algorithm/],
    [{ ...keys.trustStore, keys: [{ ...keys.trustStore.keys[0], status: "disabled" }] }, /status/],
    [{ ...keys.trustStore, keys: [{ ...keys.trustStore.keys[0], key_id: "release-key" }] }, /key ID/],
    [{
      ...keys.trustStore,
      keys: [{
        ...keys.trustStore.keys[0],
        public_key_pem: keys.privateKeyPem,
      }],
    }, /public.*Ed25519|public key/],
  ]) {
    assert.throws(() => validateTrustStore(candidate), message);
  }
});

test("canonical JSON recursively sorts keys and rejects non-integer number ambiguity", async () => {
  // Property: object insertion order cannot affect signed release bytes.
  assert.equal(
    canonicalJson({ z: [3, { b: true, a: "value" }], a: null }),
    '{"a":null,"z":[3,{"a":"value","b":true}]}',
  );
  assert.equal(canonicalJson({ b: 2, a: 1 }), canonicalJson({ a: 1, b: 2 }));
  assert.equal(
    canonicalJson(JSON.parse('{"safe":1,"__proto__":{"polluted":true}}')),
    '{"__proto__":{"polluted":true},"safe":1}',
  );
  assert.throws(
    () => canonicalJson({ __proto__: { polluted: true }, safe: 1 }),
    /unsupported|plain JSON object/,
  );
  for (const value of [1.5, Number.MAX_SAFE_INTEGER + 1, -0]) {
    assert.throws(() => canonicalJson({ value }), /safe integer/);
  }

  const assets = await assetFixture();
  await mkdir(join(assets.root, "directory.dmg"));
  await assert.rejects(
    buildReleaseCohort({
      request: request(),
      ideAssetPath: join(assets.root, "directory.dmg"),
      toolchainArchivePath: assets.toolchainArchivePath,
      releaseRepository: "Epoch-ML/zerglang-releases",
    }),
    /IDE asset must be a regular file/,
  );

  const oversized = await assetFixture();
  const archive = await open(oversized.toolchainArchivePath, "w");
  await archive.truncate(2_147_483_649);
  await archive.close();
  await assert.rejects(
    buildReleaseCohort({
      request: request(),
      ideAssetPath: oversized.ideAssetPath,
      toolchainArchivePath: oversized.toolchainArchivePath,
      releaseRepository: "Epoch-ML/zerglang-releases",
    }),
    /toolchain archive size is outside the release boundary/,
  );
});

test("cohort validation rejects every mutable identity and transport boundary", async () => {
  const { cohort } = await cohortFixture();
  assert.equal(validateReleaseCohort(structuredClone(cohort)).version, cohort.version);

  const mutations = [
    (value) => { value.extra = true; },
    (value) => { delete value.release_url; },
    (value) => { value.schema = "zerglang.release-cohort/2"; },
    (value) => { value.release_url = "http://example.com/release"; },
    (value) => { value.release_url = "https://user:pass@example.com/release"; },
    (value) => { value.release_url = "https://user@example.com/release"; },
    (value) => { value.release_url = "https://:pass@example.com/release"; },
    (value) => { value.products = { ide: value.products.ide }; },
    (value) => { value.products.ide.version = "9.9.9"; },
    (value) => { value.products.ide.minimum_macos = "14.0"; },
    (value) => { value.products.ide.commands = ["ZergLang", "extra"]; },
    (value) => { value.products.ide.update_manifest_url = "relative/latest.json"; },
    (value) => { value.products.ide.asset.architecture = "Intel"; },
    (value) => { value.products.ide.asset.format = "zip"; },
    (value) => { value.products.ide.asset.target = "x86_64-apple-darwin"; },
    (value) => { value.products.ide.asset.sha256 = `x${"a".repeat(64)}`; },
    (value) => { value.products.ide.asset.sha256 = `${"a".repeat(64)}x`; },
    (value) => { value.products.ide.asset.size = 0; },
    (value) => { value.products.ide.asset.size = 2_147_483_649; },
    (value) => { value.products.ide.asset.url = "ftp://example.com/asset"; },
    (value) => { value.products.toolchain.asset.name = "renamed.tar.gz"; },
    (value) => { value.products.toolchain.commands = ["zlm"]; },
  ];
  for (const mutate of mutations) {
    const candidate = structuredClone(cohort);
    mutate(candidate);
    assert.throws(() => validateReleaseCohort(candidate), /cohort|product|asset|URL|supported|match|required/);
  }

  for (const candidate of [null, [], "cohort", 7]) {
    assert.throws(
      () => validateReleaseCohort(candidate),
      (error) => error instanceof CohortPayloadError && /must be a JSON object/.test(error.message),
    );
  }
});

test("trust validation rejects malformed key IDs, key material, and closed fields", () => {
  const keys = signingFixture();
  const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 }).publicKey
    .export({ format: "pem", type: "spki" }).toString();
  const mutations = [
    (value) => { value.schema = "zerglang.release-signing-keys/2"; },
    (value) => { value.keys = null; },
    (value) => { value.keys[0].extra = true; },
    (value) => { delete value.keys[0].algorithm; },
    (value) => { value.keys[0].key_id = `prefix-${keys.keyId}`; },
    (value) => { value.keys[0].key_id = "zerglang-release-ed25519-2026-00"; },
    (value) => { value.keys[0].key_id = "zerglang-release-ed25519-2026-13"; },
    (value) => { value.keys[0].public_key_pem = ""; },
    (value) => { value.keys[0].public_key_pem = "not a PEM"; },
    (value) => { value.keys[0].public_key_pem = rsa; },
  ];
  for (const mutate of mutations) {
    const candidate = structuredClone(keys.trustStore);
    mutate(candidate);
    assert.throws(
      () => validateTrustStore(candidate),
      /schema|signing key|field|key ID|public key|Ed25519|PEM/,
    );
  }
  for (const candidate of [null, [], "keys", 7]) {
    assert.throws(() => validateTrustStore(candidate), /must be a JSON object/);
  }
});

test("signature validation rejects non-canonical envelopes before cryptographic admission", async () => {
  const { cohort } = await cohortFixture();
  const keys = signingFixture();
  const signature = signReleaseCohort({
    cohort,
    privateKeyPem: keys.privateKeyPem,
    trustStore: keys.trustStore,
  });
  const mutations = [
    (value) => { value.extra = true; },
    (value) => { delete value.algorithm; },
    (value) => { value.schema = "zerglang.release-cohort-signature/2"; },
    (value) => { value.algorithm = "RSA"; },
    (value) => { value.cohort_sha256 = `x${value.cohort_sha256}`; },
    (value) => { value.cohort_sha256 = `${value.cohort_sha256}x`; },
    (value) => { value.key_id = "unknown-release-key"; },
    (value) => { value.value = ` ${value.value}`; },
    (value) => { value.value = Buffer.alloc(63).toString("base64"); },
    (value) => { value.value = "not-base64"; },
  ];
  for (const mutate of mutations) {
    const candidate = structuredClone(signature);
    mutate(candidate);
    assert.throws(
      () => verifyReleaseCohort({ cohort, signature: candidate, trustStore: keys.trustStore }),
      /field|schema|digest|key|base64|verification/,
    );
  }

  const finalQuartet = signature.value.slice(-4);
  assert.equal(finalQuartet.slice(-2), "==");
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  const canonicalIndex = alphabet.indexOf(finalQuartet[1]);
  const noncanonicalIndex = (canonicalIndex & 0b110000) | 0b000001;
  const padBitVariant = `${signature.value.slice(0, -3)}${alphabet[noncanonicalIndex]}==`;
  assert.deepEqual(Buffer.from(padBitVariant, "base64"), Buffer.from(signature.value, "base64"));
  assert.throws(
    () => verifyReleaseCohort({
      cohort,
      signature: { ...signature, value: padBitVariant },
      trustStore: keys.trustStore,
    }),
    /canonical base64/,
  );
});

test("matches the updater canonical JSON and Ed25519 wire vector", () => {
  const seed = Buffer.from(
    "9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60",
    "hex",
  );
  const privateKey = createPrivateKey({
    key: Buffer.concat([
      Buffer.from("302e020100300506032b657004220420", "hex"),
      seed,
    ]),
    format: "der",
    type: "pkcs8",
  });
  const publicKeyPem = createPublicKey(privateKey)
    .export({ format: "pem", type: "spki" }).toString();
  const version = "1.2.3-preview.4";
  const cohort = {
    channel: "preview",
    products: {
      ide: {
        asset: {
          architecture: "Apple Silicon",
          format: "dmg",
          name: `ZergLang_${version}_aarch64.dmg`,
          sha256: "b".repeat(64),
          size: 123,
          target: "aarch64-apple-darwin",
          url: "https://example.test/ZergLang.dmg",
        },
        commands: ["ZergLang"],
        minimum_macos: "15.0",
        update_manifest_url: "https://example.test/preview/latest.json",
        version,
      },
      toolchain: {
        asset: {
          architecture: "Apple Silicon",
          format: "tar.gz",
          name: `zerglang-toolchain-${version}-aarch64-apple-darwin.tar.gz`,
          sha256: "c".repeat(64),
          size: 456,
          target: "aarch64-apple-darwin",
          url: "https://example.test/zerglang-toolchain.tar.gz",
        },
        commands: ["zlc", "zlm", "zlsync", "zlbench-exec"],
        minimum_macos: "15.0",
        update_manifest_url:
          "https://example.test/toolchains/v1/channels/preview/latest.json",
        version,
      },
    },
    published_at: "2026-08-23T17:08:57.000Z",
    release_url: "https://example.test/releases/1.2.3-preview.4",
    schema: "zerglang.release-cohort/1",
    source_sha: "a".repeat(40),
    version,
  };
  const privateKeyPem = privateKey.export({ format: "pem", type: "pkcs8" }).toString();
  const trustStore = {
    schema: "zerglang.release-signing-keys/1",
    keys: [{
      algorithm: "Ed25519",
      key_id: "zerglang-release-ed25519-2026-08-vector",
      public_key_pem: publicKeyPem,
      status: "active",
    }],
  };

  const signature = signReleaseCohort({ cohort, privateKeyPem, trustStore });
  assert.equal(
    signature.cohort_sha256,
    "4fb6e1d6dabbb806cca4cf6adfbc7292f8f8a883822f966004d513cd6334940b",
  );
  assert.equal(
    signature.value,
    "sxy34EhuOinHljXpGmWzAaq12AqoEcxdC/GQydNNg0eoP8ja3gEWnPzKwGfKRzPX7uUclGF1YwFaLHEATZwPAw==",
  );
  assert.equal(verifyReleaseCohort({ cohort, signature, trustStore }), trustStore.keys[0].key_id);
});

test("canonical JSON rejects sparse, undefined, and non-JSON values", () => {
  const sparse = [];
  sparse[1] = "value";
  for (const value of [
    sparse,
    { value: undefined },
    { value: Number.NaN },
    { value: Number.POSITIVE_INFINITY },
    { value: () => "not JSON" },
    { value: Symbol("not JSON") },
  ]) {
    assert.throws(() => canonicalJson(value), /sparse|undefined|safe integer|unsupported/);
  }
});

test("CLI prepares, signs, verifies, and preserves create-only outputs", async () => {
  const assets = await assetFixture();
  const keys = signingFixture();
  const requestPath = join(assets.root, "request.json");
  const cohortPath = join(assets.root, "cohort.json");
  const keysPath = join(assets.root, "keys.json");
  const signaturePath = join(assets.root, "signature.json");
  await writeFile(requestPath, JSON.stringify(request()));
  await writeFile(keysPath, JSON.stringify(keys.trustStore));

  const prepared = spawnSync(
    process.execPath,
    [cohortCli, "prepare", requestPath, assets.ideAssetPath, assets.toolchainArchivePath, cohortPath],
    { encoding: "utf8" },
  );
  assert.equal(prepared.status, 0, prepared.stderr);
  assert.equal(JSON.parse(await readFile(cohortPath, "utf8")).version, request().version);

  const signed = spawnSync(
    process.execPath,
    [cohortCli, "sign", cohortPath, keysPath, signaturePath],
    {
      encoding: "utf8",
      env: { ...process.env, ZERGLANG_RELEASE_SIGNING_PRIVATE_KEY: keys.privateKeyPem },
    },
  );
  assert.equal(signed.status, 0, signed.stderr);
  assert.equal(JSON.parse(await readFile(signaturePath, "utf8")).key_id, keys.keyId);

  const duplicateSignature = spawnSync(
    process.execPath,
    [cohortCli, "sign", cohortPath, keysPath, signaturePath],
    {
      encoding: "utf8",
      env: { ...process.env, ZERGLANG_RELEASE_SIGNING_PRIVATE_KEY: keys.privateKeyPem },
    },
  );
  assert.equal(duplicateSignature.status, 1);
  assert.match(duplicateSignature.stderr, /EEXIST|file already exists/);

  const verified = spawnSync(
    process.execPath,
    [cohortCli, "verify", cohortPath, keysPath, signaturePath],
    { encoding: "utf8" },
  );
  assert.equal(verified.status, 0, verified.stderr);
  assert.deepEqual(JSON.parse(verified.stdout), { key_id: keys.keyId });

  const duplicate = spawnSync(
    process.execPath,
    [cohortCli, "prepare", requestPath, assets.ideAssetPath, assets.toolchainArchivePath, cohortPath],
    { encoding: "utf8" },
  );
  assert.equal(duplicate.status, 1);
  assert.match(duplicate.stderr, /EEXIST|file already exists/);
});

test("CLI rejects missing signing authority, linked input, oversized control, and bad arity", async () => {
  const assets = await assetFixture();
  const requestPath = join(assets.root, "request.json");
  const linkedRequest = join(assets.root, "linked-request.json");
  const oversizedRequest = join(assets.root, "oversized-request.json");
  const output = join(assets.root, "output.json");
  await writeFile(requestPath, JSON.stringify(request()));
  await symlink(requestPath, linkedRequest);
  await writeFile(oversizedRequest, Buffer.alloc(2 * 1024 * 1024 + 1, 0x20));

  for (const [args, message] of [
    [["sign", requestPath, requestPath, output], /SIGNING_PRIVATE_KEY is unavailable/],
    [["prepare", linkedRequest, assets.ideAssetPath, assets.toolchainArchivePath, output], /regular file/],
    [["prepare", oversizedRequest, assets.ideAssetPath, assets.toolchainArchivePath, output], /exceeds 2097152 bytes/],
    [["unknown", requestPath, requestPath, requestPath], /usage: cohort-payload/],
    [[], /usage: cohort-payload/],
  ]) {
    const result = spawnSync(process.execPath, [cohortCli, ...args], {
      encoding: "utf8",
      env: { ...process.env, ZERGLANG_RELEASE_SIGNING_PRIVATE_KEY: "" },
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, message);
  }
});

test("CLI accepts a valid JSON control at the exact feed-size limit", async () => {
  const { assets, cohort } = await cohortFixture();
  const keys = signingFixture();
  const cohortPath = join(assets.root, "cohort.json");
  const keysPath = join(assets.root, "keys-at-limit.json");
  const signaturePath = join(assets.root, "signature-at-limit.json");
  const serializedKeys = JSON.stringify(keys.trustStore);
  const paddedKeys = `${serializedKeys}${" ".repeat((2 * 1024 * 1024) - serializedKeys.length)}`;
  await writeFile(cohortPath, JSON.stringify(cohort));
  await writeFile(keysPath, paddedKeys);

  const result = spawnSync(
    process.execPath,
    [cohortCli, "sign", cohortPath, keysPath, signaturePath],
    {
      encoding: "utf8",
      env: { ...process.env, ZERGLANG_RELEASE_SIGNING_PRIVATE_KEY: keys.privateKeyPem },
    },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(await readFile(signaturePath, "utf8")).key_id, keys.keyId);
});
