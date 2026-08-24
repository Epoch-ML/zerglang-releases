import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { promisify } from "node:util";

import { readReleaseRequest, validateReleaseRequest } from "./release-request.mjs";

const temporaryDirectories = [];
const execFileAsync = promisify(execFile);

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

function validRequest() {
  return {
    channel: "stable",
    products: ["ide", "toolchain"],
    schema: "zerglang.release-request/2",
    version: "0.1.2",
    release_tag: "zerglang-v0.1.2",
    source_repository: "Epoch-ML/zerg",
    source_sha: "0123456789abcdef0123456789abcdef01234567",
    source_ref: "refs/tags/zerglang-v0.1.2",
    requested_at: "2026-08-08T17:13:17.989Z",
  };
}

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "zerglang-release-request-"));
  temporaryDirectories.push(directory);
  const requestPath = join(directory, "stable-v0.1.2.json");
  await writeFile(requestPath, `${JSON.stringify(validRequest(), null, 2)}\n`);
  return { directory, requestPath };
}

test("reads a bounded regular request file and returns canonical provenance", async () => {
  const bundle = await fixture();

  assert.deepEqual(await readReleaseRequest(bundle.requestPath), validRequest());
});

test("rejects a symlink even when its target is a valid request", async () => {
  const bundle = await fixture();
  const linkedPath = join(bundle.directory, "selected.json");
  await symlink(bundle.requestPath, linkedPath);

  await assert.rejects(
    readReleaseRequest(linkedPath),
    /release request path must identify a regular file/,
  );
});

test("rejects malformed and oversized request files before using their contents", async () => {
  const malformed = await fixture();
  await writeFile(malformed.requestPath, "{not-json}\n");
  await assert.rejects(readReleaseRequest(malformed.requestPath), /not valid JSON/);

  const oversized = await fixture();
  await writeFile(oversized.requestPath, "x".repeat((16 * 1024) + 1));
  await assert.rejects(readReleaseRequest(oversized.requestPath), /exceeds 16384 bytes/);
});

test("accepts a valid request at the exact byte limit", async () => {
  const bundle = await fixture();
  const json = JSON.stringify(validRequest());
  const bytes = `${json}${" ".repeat((16 * 1024) - Buffer.byteLength(json))}`;
  await writeFile(bundle.requestPath, bytes);

  assert.deepEqual(await readReleaseRequest(bundle.requestPath), validRequest());
});

test("rejects non-object, incomplete, and wrong-policy request values", () => {
  for (const value of [null, [], "request", 7]) {
    assert.throws(() => validateReleaseRequest(value), /must be a JSON object/);
  }

  for (const field of Object.keys(validRequest())) {
    const incomplete = validRequest();
    delete incomplete[field];
    assert.throws(() => validateReleaseRequest(incomplete), /missing required field/);
  }

  for (const [field, value, message] of [
    ["schema", "zerglang.release-request/1", /schema must equal zerglang\.release-request\/2/],
    ["products", ["toolchain", "ide"], /products must equal ide, toolchain/],
    ["source_repository", "attacker/zerg", /source_repository must equal Epoch-ML\/zerg/],
  ]) {
    assert.throws(
      () => validateReleaseRequest({ ...validRequest(), [field]: value }),
      message,
    );
  }
});

test("rejects non-string, padded, and partially matched provenance", () => {
  for (const [field, value, message] of [
    ["version", null, /version must be a non-empty string/],
    ["version", " 0.1.2", /version must not contain surrounding whitespace/],
    ["version", "1x.2.3", /strict SemVer/],
    ["version", "1.2x.3", /strict SemVer/],
    ["version", "1.2.3x", /strict SemVer/],
    ["version", "1.2.3trailing", /strict SemVer/],
    ["version", "1.2.3-01", /strict SemVer/],
    ["source_sha", `${validRequest().source_sha}0`, /40 lowercase hexadecimal/],
    ["source_sha", `0${validRequest().source_sha}`, /40 lowercase hexadecimal/],
    ["source_sha", " ", /source_sha must be a non-empty string/],
    ["requested_at", `x${validRequest().requested_at}`, /ISO-8601 UTC timestamp/],
    ["requested_at", `${validRequest().requested_at}x`, /ISO-8601 UTC timestamp/],
    ["requested_at", " 2026-08-08T17:13:17.989Z", /surrounding whitespace/],
  ]) {
    const candidate = { ...validRequest(), [field]: value };
    if (field === "version") {
      candidate.release_tag = `zerglang-v${value}`;
      candidate.source_ref = `refs/tags/${candidate.release_tag}`;
    }
    assert.throws(() => validateReleaseRequest(candidate), message);
  }
});

test("the command-line interface emits canonical JSON and fails on missing input", async () => {
  const bundle = await fixture();
  const script = new URL("./release-request.mjs", import.meta.url);
  const success = await execFileAsync(process.execPath, [script.pathname, bundle.requestPath]);
  assert.deepEqual(JSON.parse(success.stdout), validRequest());

  await assert.rejects(
    execFileAsync(process.execPath, [script.pathname]),
    (error) => error.code === 1 && /usage: release-request\.mjs REQUEST\.json/.test(error.stderr),
  );
});
