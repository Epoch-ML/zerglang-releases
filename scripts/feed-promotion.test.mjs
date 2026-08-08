import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

import {
  FeedPromotionError,
  prepareFeedPromotion,
  pushFeedPromotion,
} from "./feed-promotion.mjs";

const run = promisify(execFile);
const temporaryDirectories = [];
const commandPath = fileURLToPath(new URL("./feed-promotion.mjs", import.meta.url));

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
  return { root, remote, seed, data, canonical, sentinel, main };
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

test("rejects invalid roots, branches, tags, and dirty input state", async () => {
  assert.equal(new FeedPromotionError("bounded").name, "FeedPromotionError");

  const missing = await fixture();
  await writeCanonical(missing.canonical, "3.0.0");
  await assert.rejects(
    prepareFeedPromotion({
      dataDirectory: join(missing.root, "missing"),
      releaseDirectory: missing.canonical,
      channel: "stable",
      version: "3.0.0",
      releaseTag: "zerglang-ide-v3.0.0",
    }),
    /release-data checkout does not exist/,
  );
  const file = join(missing.root, "not-a-directory");
  await writeFile(file, "not a repository");
  await assert.rejects(
    prepareFeedPromotion({
      dataDirectory: file,
      releaseDirectory: missing.canonical,
      channel: "stable",
      version: "3.0.0",
      releaseTag: "zerglang-ide-v3.0.0",
    }),
    /release-data checkout must be a real directory/,
  );
  const linked = join(missing.root, "linked-data");
  await symlink(missing.data, linked, "dir");
  await assert.rejects(
    prepareFeedPromotion({
      dataDirectory: linked,
      releaseDirectory: missing.canonical,
      channel: "stable",
      version: "3.0.0",
      releaseTag: "zerglang-ide-v3.0.0",
    }),
    /release-data checkout must be a real directory/,
  );

  const wrongBranch = await fixture();
  await writeCanonical(wrongBranch.canonical, "3.0.0");
  await assert.rejects(
    prepareFeedPromotion({
      dataDirectory: wrongBranch.seed,
      releaseDirectory: wrongBranch.canonical,
      channel: "stable",
      version: "3.0.0",
      releaseTag: "zerglang-ide-v3.0.0",
    }),
    /feed promotion branch must be release-data/,
  );

  const wrongTag = await fixture();
  await writeCanonical(wrongTag.canonical, "3.0.0");
  await assert.rejects(
    prepareFeedPromotion({
      dataDirectory: wrongTag.data,
      releaseDirectory: wrongTag.canonical,
      channel: "stable",
      version: "3.0.0",
      releaseTag: "zerglang-ide-preview-v3.0.0",
    }),
    /release tag must be zerglang-ide-v3\.0\.0/,
  );

  const dirty = await fixture();
  await writeCanonical(dirty.canonical, "3.0.0");
  await writeFile(join(dirty.data, "unexpected.txt"), "dirty");
  await assert.rejects(
    prepareFeedPromotion({
      dataDirectory: dirty.data,
      releaseDirectory: dirty.canonical,
      channel: "stable",
      version: "3.0.0",
      releaseTag: "zerglang-ide-v3.0.0",
    }),
    /release-data checkout must start clean: unexpected\.txt/,
  );
});

test("validates push authority, parent identity, cleanliness, and ancestry", async () => {
  const unchangedBundle = await fixture();
  const initial = await git(unchangedBundle.data, "rev-parse", "HEAD");
  assert.deepEqual(
    await pushFeedPromotion({
      dataDirectory: unchangedBundle.data,
      remote: unchangedBundle.remote,
      branch: "release-data",
      expectedParent: initial,
    }),
    { status: "unchanged", commit: initial },
  );

  for (const remote of [null, "", "   "]) {
    await assert.rejects(
      pushFeedPromotion({
        dataDirectory: unchangedBundle.data,
        remote,
        branch: "release-data",
        expectedParent: initial,
      }),
      /feed promotion remote is required/,
    );
  }
  for (const expectedParent of [`x${initial}`, `${initial}x`, "main"]) {
    await assert.rejects(
      pushFeedPromotion({
        dataDirectory: unchangedBundle.data,
        remote: unchangedBundle.remote,
        branch: "release-data",
        expectedParent,
      }),
      /expected parent must be an exact commit SHA/,
    );
  }

  const dirty = await fixture();
  const dirtyParent = await git(dirty.data, "rev-parse", "HEAD");
  await writeFile(join(dirty.data, "dirty.txt"), "dirty");
  await assert.rejects(
    pushFeedPromotion({
      dataDirectory: dirty.data,
      remote: dirty.remote,
      branch: "release-data",
      expectedParent: dirtyParent,
    }),
    /prepared release-data checkout must be clean/,
  );

  const ancestry = await fixture();
  await writeCanonical(ancestry.canonical, "4.0.0");
  const prepared = await prepareFeedPromotion({
    dataDirectory: ancestry.data,
    releaseDirectory: ancestry.canonical,
    channel: "stable",
    version: "4.0.0",
    releaseTag: "zerglang-ide-v4.0.0",
  });
  await writeFile(join(ancestry.data, "site", "extra.json"), "{}\n");
  await git(ancestry.data, "add", "site/extra.json");
  await git(
    ancestry.data,
    "-c",
    "user.name=Feed Fixture",
    "-c",
    "user.email=feed@example.invalid",
    "commit",
    "-m",
    "unexpected second commit",
  );
  await assert.rejects(
    pushFeedPromotion({
      dataDirectory: ancestry.data,
      remote: ancestry.remote,
      branch: "release-data",
      expectedParent: prepared.parent,
    }),
    /prepared commit does not descend from expected parent/,
  );
});

test("exposes prepare and push through a bounded command-line interface", async () => {
  const bundle = await fixture();
  await writeCanonical(bundle.canonical, "5.0.0");
  const prepared = await run(process.execPath, [
    commandPath,
    "prepare",
    bundle.data,
    bundle.canonical,
    "stable",
    "5.0.0",
    "zerglang-ide-v5.0.0",
  ]);
  const record = JSON.parse(prepared.stdout);
  assert.equal(record.status, "committed");
  assert.match(record.parent, /^[0-9a-f]{40}$/);

  const pushed = await run(process.execPath, [
    commandPath,
    "push",
    bundle.data,
    bundle.remote,
    "release-data",
    record.parent,
  ]);
  assert.deepEqual(JSON.parse(pushed.stdout), {
    status: "pushed",
    commit: record.commit,
  });

  await assert.rejects(
    run(process.execPath, [commandPath, "unknown"]),
    (error) =>
      error.code === 1 &&
      /usage: feed-promotion\.mjs prepare/.test(error.stderr),
  );
});
