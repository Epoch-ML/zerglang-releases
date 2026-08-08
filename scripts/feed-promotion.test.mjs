import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import {
  FeedPromotionError,
  prepareFeedPromotion,
  pushFeedPromotion,
} from "./feed-promotion.mjs";

const run = promisify(execFile);
const temporaryDirectories = [];

test.afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true })
    ),
  );
});

async function git(directory, ...args) {
  const { stdout } = await run("git", ["-C", directory, ...args], {
    encoding: "utf8",
  });
  return stdout.trim();
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "zerglang-feed-promotion-"));
  temporaryDirectories.push(root);
  const remote = join(root, "remote.git");
  const seed = join(root, "seed");
  const data = join(root, "data");
  const canonical = join(root, "canonical");
  const sentinel = join(root, "pulled-code-executed");

  await run("git", ["init", "--bare", remote]);
  await run("git", ["init", "-b", "main", seed]);
  await git(seed, "config", "user.name", "Feed Fixture");
  await git(seed, "config", "user.email", "feed@example.invalid");
  await mkdir(join(seed, "site"));
  await mkdir(join(seed, "scripts"));
  await writeFile(join(seed, "site", ".nojekyll"), "");
  await writeFile(
    join(seed, "scripts", "feed-policy.mjs"),
    `await import("node:fs/promises").then(({writeFile}) => writeFile(${JSON.stringify(sentinel)}, "executed"));\n`,
  );
  await git(seed, "add", "site", "scripts");
  await git(seed, "commit", "-m", "seed branches");
  await git(seed, "remote", "add", "origin", remote);
  await git(seed, "push", "origin", "main");
  await git(seed, "branch", "release-data");
  await git(seed, "push", "origin", "release-data");
  const main = await git(remote, "rev-parse", "refs/heads/main");

  await run("git", ["clone", "--branch", "release-data", remote, data]);
  await mkdir(canonical);
  return { root, remote, data, canonical, sentinel, main };
}

async function writeCanonical(directory, version) {
  const latest = `${JSON.stringify({ version, platforms: {} }, null, 2)}\n`;
  const metadata = `${JSON.stringify({ version, channel: "stable" }, null, 2)}\n`;
  await writeFile(join(directory, "latest.json"), latest);
  await writeFile(join(directory, "release-metadata.json"), metadata);
  return { latest, metadata };
}

test("prepares and pushes only a canonical release-data commit without executing pulled code", async () => {
  const bundle = await fixture();
  const canonical = await writeCanonical(bundle.canonical, "1.2.3");

  const prepared = await prepareFeedPromotion({
    dataDirectory: bundle.data,
    releaseDirectory: bundle.canonical,
    channel: "stable",
    version: "1.2.3",
    releaseTag: "zerglang-ide-v1.2.3",
  });
  assert.equal(prepared.status, "committed");
  assert.deepEqual(prepared.changedPaths, [
    "site/stable/latest.json",
    "site/stable/releases/1.2.3.json",
  ]);
  assert.equal(
    await readFile(join(bundle.data, "site/stable/latest.json"), "utf8"),
    canonical.latest,
  );
  assert.equal(
    await readFile(
      join(bundle.data, "site/stable/releases/1.2.3.json"),
      "utf8",
    ),
    canonical.metadata,
  );

  const pushed = await pushFeedPromotion({
    dataDirectory: bundle.data,
    remote: bundle.remote,
    branch: "release-data",
    expectedParent: prepared.parent,
  });
  assert.deepEqual(pushed, { status: "pushed", commit: prepared.commit });
  assert.equal(
    await git(bundle.remote, "rev-parse", "refs/heads/release-data"),
    prepared.commit,
  );
  assert.equal(
    await git(bundle.remote, "rev-parse", "refs/heads/main"),
    bundle.main,
  );
  await assert.rejects(readFile(bundle.sentinel), { code: "ENOENT" });
});

test("is idempotent and rejects a concurrent release-data advance", async () => {
  const bundle = await fixture();
  await writeCanonical(bundle.canonical, "2.0.0");
  const secondData = join(bundle.root, "second-data");
  await run("git", ["clone", "--branch", "release-data", bundle.remote, secondData]);

  const first = await prepareFeedPromotion({
    dataDirectory: bundle.data,
    releaseDirectory: bundle.canonical,
    channel: "stable",
    version: "2.0.0",
    releaseTag: "zerglang-ide-v2.0.0",
  });
  const second = await prepareFeedPromotion({
    dataDirectory: secondData,
    releaseDirectory: bundle.canonical,
    channel: "stable",
    version: "2.0.0",
    releaseTag: "zerglang-ide-v2.0.0",
  });
  await pushFeedPromotion({
    dataDirectory: bundle.data,
    remote: bundle.remote,
    branch: "release-data",
    expectedParent: first.parent,
  });
  await assert.rejects(
    pushFeedPromotion({
      dataDirectory: secondData,
      remote: bundle.remote,
      branch: "release-data",
      expectedParent: second.parent,
    }),
    (error) =>
      error instanceof FeedPromotionError &&
      /release-data advanced from [0-9a-f]{40} to [0-9a-f]{40}/.test(
        error.message,
      ),
  );

  const replay = join(bundle.root, "replay");
  await run("git", ["clone", "--branch", "release-data", bundle.remote, replay]);
  const unchanged = await prepareFeedPromotion({
    dataDirectory: replay,
    releaseDirectory: bundle.canonical,
    channel: "stable",
    version: "2.0.0",
    releaseTag: "zerglang-ide-v2.0.0",
  });
  assert.deepEqual(unchanged, {
    status: "unchanged",
    parent: first.commit,
    commit: first.commit,
    changedPaths: [],
  });
});

test("rejects any target other than release-data", async () => {
  const bundle = await fixture();
  await assert.rejects(
    pushFeedPromotion({
      dataDirectory: bundle.data,
      remote: bundle.remote,
      branch: "main",
      expectedParent: bundle.main,
    }),
    (error) =>
      error instanceof FeedPromotionError &&
      error.message === "feed promotion branch must be release-data",
  );
});
