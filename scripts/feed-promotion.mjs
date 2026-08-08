#!/usr/bin/env node

import { execFile } from "node:child_process";
import { lstat, realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

import { feedDestinations, stageReleaseFeed } from "./feed-policy.mjs";

const executeFile = promisify(execFile);
const SHA_PATTERN = /^[0-9a-f]{40}$/;

export class FeedPromotionError extends Error {
  constructor(message) {
    super(message);
    this.name = "FeedPromotionError";
  }
}

async function requireDirectory(path, description) {
  const metadata = await lstat(path).catch((error) => {
    if (error?.code === "ENOENT") {
      throw new FeedPromotionError(`${description} does not exist`);
    }
    throw error;
  });
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw new FeedPromotionError(`${description} must be a real directory`);
  }
}

async function git(dataDirectory, args, options = {}) {
  try {
    const { stdout } = await executeFile(
      "git",
      ["-C", dataDirectory, ...args],
      {
        encoding: "utf8",
        maxBuffer: 4 * 1024 * 1024,
        ...options,
      },
    );
    return stdout.trim();
  } catch (error) {
    const detail = typeof error.stderr === "string" && error.stderr.trim() !== ""
      ? error.stderr.trim().split("\n").at(-1)
      : error.message;
    throw new FeedPromotionError(`git ${args[0]} failed: ${detail}`);
  }
}

function expectedTag(channel, version) {
  return channel === "stable"
    ? `zerglang-ide-v${version}`
    : `zerglang-ide-preview-v${version}`;
}

function parseStatus(output) {
  if (output === "") return [];
  const entries = output.split("\0").filter((entry) => entry !== "");
  const paths = [];
  for (const entry of entries) {
    const status = entry.slice(0, 2);
    if (status.includes("R") || status.includes("C")) {
      throw new FeedPromotionError("feed promotion must not rename or copy paths");
    }
    paths.push(entry.slice(3));
  }
  return paths.sort();
}

async function requireReleaseDataWorktree(dataDirectory) {
  const root = resolve(dataDirectory);
  await requireDirectory(root, "release-data checkout");
  const topLevel = await realpath(
    resolve(await git(root, ["rev-parse", "--show-toplevel"])),
  );
  if (topLevel !== await realpath(root)) {
    throw new FeedPromotionError("release-data checkout must be the Git worktree root");
  }
  const branch = await git(root, ["symbolic-ref", "--short", "HEAD"]);
  if (branch !== "release-data") {
    throw new FeedPromotionError("feed promotion branch must be release-data");
  }
  return root;
}

export async function prepareFeedPromotion({
  dataDirectory,
  releaseDirectory,
  channel,
  version,
  releaseTag,
}) {
  const dataRoot = await requireReleaseDataWorktree(dataDirectory);
  const releaseRoot = resolve(releaseDirectory);
  feedDestinations(channel, version);
  if (releaseTag !== expectedTag(channel, version)) {
    throw new FeedPromotionError(
      `release tag must be ${expectedTag(channel, version)}`,
    );
  }
  const initialStatus = parseStatus(
    await git(dataRoot, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]),
  );
  if (initialStatus.length > 0) {
    throw new FeedPromotionError(
      `release-data checkout must start clean: ${initialStatus.join(", ")}`,
    );
  }
  const parent = await git(dataRoot, ["rev-parse", "HEAD"]);
  if (!SHA_PATTERN.test(parent)) {
    throw new FeedPromotionError("release-data parent must be an exact commit SHA");
  }

  await stageReleaseFeed({
    channel,
    pagesDirectory: resolve(dataRoot, "site"),
    releaseDirectory: releaseRoot,
    version,
  });
  const changedPaths = parseStatus(
    await git(dataRoot, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]),
  );
  const destinations = feedDestinations(channel, version);
  const allowedPaths = [
    `site/${destinations.latest}`,
    `site/${destinations.metadata}`,
  ].sort();
  for (const path of changedPaths) {
    if (!allowedPaths.includes(path)) {
      throw new FeedPromotionError(`feed promotion changed unexpected path: ${path}`);
    }
  }
  if (changedPaths.length === 0) {
    return { status: "unchanged", parent, commit: parent, changedPaths: [] };
  }

  await git(dataRoot, ["add", "--", ...changedPaths]);
  const stagedPaths = (
    await git(dataRoot, ["diff", "--cached", "--name-only", "--diff-filter=ACM"])
  ).split("\n").filter((path) => path !== "").sort();
  if (
    stagedPaths.length !== changedPaths.length ||
    stagedPaths.some((path, index) => path !== changedPaths[index])
  ) {
    throw new FeedPromotionError("staged feed paths differ from validated changes");
  }
  await git(dataRoot, [
    "-c",
    "user.name=github-actions[bot]",
    "-c",
    "user.email=41898282+github-actions[bot]@users.noreply.github.com",
    "commit",
    "-m",
    `Publish ${releaseTag} updater manifest`,
  ]);
  const commit = await git(dataRoot, ["rev-parse", "HEAD"]);
  const commitParent = await git(dataRoot, ["rev-parse", "HEAD^"]);
  if (!SHA_PATTERN.test(commit) || commitParent !== parent) {
    throw new FeedPromotionError("prepared feed commit has unexpected ancestry");
  }
  return { status: "committed", parent, commit, changedPaths };
}

export async function pushFeedPromotion({
  dataDirectory,
  remote,
  branch,
  expectedParent,
}) {
  if (branch !== "release-data") {
    throw new FeedPromotionError("feed promotion branch must be release-data");
  }
  if (typeof remote !== "string" || remote.trim() === "") {
    throw new FeedPromotionError("feed promotion remote is required");
  }
  if (!SHA_PATTERN.test(expectedParent)) {
    throw new FeedPromotionError("expected parent must be an exact commit SHA");
  }
  const dataRoot = await requireReleaseDataWorktree(dataDirectory);
  const localStatus = parseStatus(
    await git(dataRoot, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]),
  );
  if (localStatus.length > 0) {
    throw new FeedPromotionError("prepared release-data checkout must be clean");
  }
  const remoteRecord = await git(dataRoot, [
    "ls-remote",
    "--exit-code",
    "--refs",
    remote,
    `refs/heads/${branch}`,
  ]);
  const remoteHead = remoteRecord.split(/\s+/)[0];
  if (!SHA_PATTERN.test(remoteHead)) {
    throw new FeedPromotionError("remote release-data head is not an exact SHA");
  }
  if (remoteHead !== expectedParent) {
    throw new FeedPromotionError(
      `release-data advanced from ${expectedParent} to ${remoteHead}`,
    );
  }
  const commit = await git(dataRoot, ["rev-parse", "HEAD"]);
  if (commit === expectedParent) {
    return { status: "unchanged", commit };
  }
  const parent = await git(dataRoot, ["rev-parse", "HEAD^"]);
  if (parent !== expectedParent) {
    throw new FeedPromotionError("prepared commit does not descend from expected parent");
  }
  await git(dataRoot, [
    "-c",
    "core.hooksPath=/dev/null",
    "push",
    "--porcelain",
    remote,
    `HEAD:refs/heads/${branch}`,
  ]);
  return { status: "pushed", commit };
}

async function main() {
  const operation = process.argv[2];
  let result;
  if (operation === "prepare" && process.argv.length === 8) {
    result = await prepareFeedPromotion({
      dataDirectory: process.argv[3],
      releaseDirectory: process.argv[4],
      channel: process.argv[5],
      version: process.argv[6],
      releaseTag: process.argv[7],
    });
  } else if (operation === "push" && process.argv.length === 7) {
    result = await pushFeedPromotion({
      dataDirectory: process.argv[3],
      remote: process.argv[4],
      branch: process.argv[5],
      expectedParent: process.argv[6],
    });
  } else {
    throw new FeedPromotionError(
      "usage: feed-promotion.mjs prepare DATA RELEASE CHANNEL VERSION TAG | push DATA REMOTE release-data EXPECTED_PARENT",
    );
  }
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main().catch((error) => {
    console.error(`feed-promotion: ${error.message}`);
    process.exitCode = 1;
  });
}
