import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";

import fc from "fast-check";

import { feedDestinations, stageReleaseFeed } from "./feed-policy.mjs";

const temporaryDirectories = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "zerglang-feed-policy-"));
  temporaryDirectories.push(root);
  const releaseDirectory = join(root, "release");
  const pagesDirectory = join(root, "site");
  await mkdir(releaseDirectory);
  return { pagesDirectory, releaseDirectory, root };
}

async function writeCandidate(bundle, version, note = `ZergLang ${version}`) {
  const latest = Buffer.from(`${JSON.stringify({
    version,
    notes: note,
    pub_date: "2026-08-08T17:13:17.989Z",
    platforms: {
      "darwin-aarch64": {
        signature: "signed-updater-archive",
        url: "https://github.com/Epoch-ML/zerglang-releases/releases/download/tag/ZergLang.app.tar.gz",
      },
    },
  }, null, 2)}\n`);
  const metadata = Buffer.from(`${JSON.stringify({
    schema_version: 1,
    product: "ZergLang IDE",
    version,
    channel: version.includes("preview") ? "preview" : "stable",
    source_sha: "0123456789abcdef0123456789abcdef01234567",
  }, null, 2)}\n`);
  await writeFile(join(bundle.releaseDirectory, "latest.json"), latest);
  await writeFile(join(bundle.releaseDirectory, "release-metadata.json"), metadata);
  return { latest, metadata };
}

test("publishes only channel-scoped canonical latest and immutable history bytes", async () => {
  const bundle = await fixture();
  const candidate = await writeCandidate(bundle, "1.2.3");

  assert.deepEqual(feedDestinations("stable", "1.2.3"), {
    latest: "stable/latest.json",
    metadata: "stable/releases/1.2.3.json",
  });
  assert.deepEqual(
    await stageReleaseFeed({ ...bundle, channel: "stable", version: "1.2.3" }),
    { status: "published", version: "1.2.3" },
  );
  assert.deepEqual(
    await readFile(join(bundle.pagesDirectory, "stable", "latest.json")),
    candidate.latest,
  );
  assert.deepEqual(
    await readFile(join(bundle.pagesDirectory, "stable", "releases", "1.2.3.json")),
    candidate.metadata,
  );
});

test("is byte-idempotent and rejects same-version or history mutation", async () => {
  const bundle = await fixture();
  const candidate = await writeCandidate(bundle, "2.3.4");
  await stageReleaseFeed({ ...bundle, channel: "stable", version: "2.3.4" });

  assert.deepEqual(
    await stageReleaseFeed({ ...bundle, channel: "stable", version: "2.3.4" }),
    { status: "unchanged", version: "2.3.4" },
  );
  assert.deepEqual(
    await readFile(join(bundle.pagesDirectory, "stable", "latest.json")),
    candidate.latest,
  );

  await writeCandidate(bundle, "2.3.4", "mutated release notes");
  await assert.rejects(
    stageReleaseFeed({ ...bundle, channel: "stable", version: "2.3.4" }),
    /latest manifest for 2\.3\.4 must remain byte-identical/,
  );
  assert.deepEqual(
    await readFile(join(bundle.pagesDirectory, "stable", "latest.json")),
    candidate.latest,
  );

  await writeFile(
    join(bundle.pagesDirectory, "stable", "releases", "2.3.4.json"),
    '{"source_sha":"hostile"}\n',
  );
  await assert.rejects(
    stageReleaseFeed({ ...bundle, channel: "stable", version: "2.3.4" }),
    /history for 2\.3\.4 must remain byte-identical/,
  );
});

test("rejects rollback and equal-precedence aliases without moving latest", async () => {
  const bundle = await fixture();
  const current = await writeCandidate(bundle, "3.0.0-preview.2");
  await stageReleaseFeed({ ...bundle, channel: "preview", version: "3.0.0-preview.2" });

  for (const [version, message] of [
    ["3.0.0-preview.1", /older than current/],
    ["3.0.0-preview.2+rebuilt", /equal precedence but different identities/],
  ]) {
    await writeCandidate(bundle, version);
    await assert.rejects(
      stageReleaseFeed({ ...bundle, channel: "preview", version }),
      message,
    );
    assert.deepEqual(
      await readFile(join(bundle.pagesDirectory, "preview", "latest.json")),
      current.latest,
    );
  }
});

test("repeated canonical staging is idempotent across generated stable versions", async () => {
  await fc.assert(fc.asyncProperty(
    fc.tuple(
      fc.integer({ min: 0, max: 20 }),
      fc.integer({ min: 0, max: 20 }),
      fc.integer({ min: 0, max: 20 }),
    ),
    fc.string({ minLength: 1, maxLength: 40 }),
    async (parts, note) => {
      const bundle = await fixture();
      const version = parts.join(".");
      const candidate = await writeCandidate(bundle, version, note);
      await stageReleaseFeed({ ...bundle, channel: "stable", version });

      // Property: replaying one canonical release is an exact byte-level no-op.
      assert.equal(
        (await stageReleaseFeed({ ...bundle, channel: "stable", version })).status,
        "unchanged",
      );
      assert.deepEqual(
        await readFile(join(bundle.pagesDirectory, "stable", "latest.json")),
        candidate.latest,
      );
      assert.deepEqual(
        await readFile(join(bundle.pagesDirectory, "stable", "releases", `${version}.json`)),
        candidate.metadata,
      );
    },
  ), { numRuns: 30 });
});

test("fails closed on invalid channels, stable prereleases, and symlinked state", async () => {
  const invalidChannel = await fixture();
  await writeCandidate(invalidChannel, "1.0.0");
  await assert.rejects(
    stageReleaseFeed({ ...invalidChannel, channel: "nightly", version: "1.0.0" }),
    /channel must be preview or stable/,
  );

  const unstable = await fixture();
  await writeCandidate(unstable, "1.0.0-preview.1");
  await assert.rejects(
    stageReleaseFeed({ ...unstable, channel: "stable", version: "1.0.0-preview.1" }),
    /stable feed versions must use MAJOR\.MINOR\.PATCH/,
  );

  const linked = await fixture();
  await symlink(linked.root, linked.pagesDirectory);
  await writeCandidate(linked, "1.0.0");
  await assert.rejects(
    stageReleaseFeed({ ...linked, channel: "stable", version: "1.0.0" }),
    /feed root must be a real directory/,
  );
});
