import assert from "node:assert/strict";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";

import { readReleaseRequest } from "./release-request.mjs";

const temporaryDirectories = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

function validRequest() {
  return {
    schema_version: 1,
    product: "ZergLang IDE",
    channel: "stable",
    version: "0.1.2",
    release_tag: "zerglang-ide-v0.1.2",
    source_repository: "Epoch-ML/zerg",
    source_sha: "0123456789abcdef0123456789abcdef01234567",
    source_ref: "refs/tags/zerglang-ide-v0.1.2",
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
