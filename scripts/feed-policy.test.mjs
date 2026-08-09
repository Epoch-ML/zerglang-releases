import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { promisify } from "node:util";

import fc from "fast-check";

import { feedDestinations, stageReleaseFeed } from "./feed-policy.mjs";

const temporaryDirectories = [];
const execFileAsync = promisify(execFile);

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

test("rejects malformed version identities before deriving feed paths", () => {
  for (const version of [null, "", "v1.2.3", "1.2.3trailing", "01.2.3", "1.2.3-01"]) {
    assert.throws(() => feedDestinations("preview", version), /strict SemVer/);
  }
});

test("fails closed when the canonical directory or either control is absent", async () => {
  const absentDirectory = await fixture();
  await rm(absentDirectory.releaseDirectory, { recursive: true });
  await assert.rejects(
    stageReleaseFeed({ ...absentDirectory, channel: "stable", version: "1.0.0" }),
    /canonical release directory does not exist/,
  );

  for (const missingName of ["latest.json", "release-metadata.json"]) {
    const incomplete = await fixture();
    await writeCandidate(incomplete, "1.0.0");
    await rm(join(incomplete.releaseDirectory, missingName));
    await assert.rejects(
      stageReleaseFeed({ ...incomplete, channel: "stable", version: "1.0.0" }),
      /canonical release controls are incomplete/,
    );
  }

  const releaseFile = await fixture();
  await rm(releaseFile.releaseDirectory, { recursive: true });
  await writeFile(releaseFile.releaseDirectory, "not a directory");
  await assert.rejects(
    stageReleaseFeed({ ...releaseFile, channel: "stable", version: "1.0.0" }),
    /canonical release directory must be a real directory/,
  );

  const linkedRelease = await fixture();
  await rm(linkedRelease.releaseDirectory, { recursive: true });
  await symlink(linkedRelease.root, linkedRelease.releaseDirectory);
  await assert.rejects(
    stageReleaseFeed({ ...linkedRelease, channel: "stable", version: "1.0.0" }),
    /canonical release directory must be a real directory/,
  );
});

test("rejects non-regular, empty, oversized, and malformed canonical controls", async () => {
  const linked = await fixture();
  await writeCandidate(linked, "1.0.0");
  const latestPath = join(linked.releaseDirectory, "latest.json");
  const realLatest = join(linked.root, "real-latest.json");
  await rm(latestPath);
  await writeFile(realLatest, '{"version":"1.0.0"}\n');
  await symlink(realLatest, latestPath);
  await assert.rejects(
    stageReleaseFeed({ ...linked, channel: "stable", version: "1.0.0" }),
    /canonical latest manifest must be a regular file/,
  );

  for (const [bytes, message] of [
    ["", /must contain 1-1048576 bytes/],
    ["x".repeat((1024 * 1024) + 1), /must contain 1-1048576 bytes/],
    ["{not-json}\n", /must contain valid JSON/],
    ["[]\n", /must contain a JSON object/],
    ["null\n", /must contain a JSON object/],
    ["7\n", /must contain a JSON object/],
    ['"metadata"\n', /must contain a JSON object/],
  ]) {
    const malformed = await fixture();
    await writeCandidate(malformed, "1.0.0");
    await writeFile(join(malformed.releaseDirectory, "release-metadata.json"), bytes);
    await assert.rejects(
      stageReleaseFeed({ ...malformed, channel: "stable", version: "1.0.0" }),
      message,
    );
  }
});

test("accepts canonical control bytes at the exact size ceiling", async () => {
  const bundle = await fixture();
  const candidate = await writeCandidate(bundle, "1.0.0");
  const padding = " ".repeat((1024 * 1024) - candidate.latest.length);
  const exactLatest = Buffer.concat([candidate.latest, Buffer.from(padding)]);
  await writeFile(join(bundle.releaseDirectory, "latest.json"), exactLatest);

  assert.deepEqual(
    await stageReleaseFeed({ ...bundle, channel: "stable", version: "1.0.0" }),
    { status: "published", version: "1.0.0" },
  );
  assert.deepEqual(
    await readFile(join(bundle.pagesDirectory, "stable", "latest.json")),
    exactLatest,
  );
});

test("binds both canonical controls to the requested channel and version", async () => {
  const wrongLatest = await fixture();
  await writeCandidate(wrongLatest, "1.0.1");
  await assert.rejects(
    stageReleaseFeed({ ...wrongLatest, channel: "stable", version: "1.0.0" }),
    /latest manifest version does not match/,
  );

  for (const [field, value] of [["version", "1.0.1"], ["channel", "preview"]]) {
    const wrongMetadata = await fixture();
    await writeCandidate(wrongMetadata, "1.0.0");
    const path = join(wrongMetadata.releaseDirectory, "release-metadata.json");
    const metadata = JSON.parse(await readFile(path, "utf8"));
    metadata[field] = value;
    await writeFile(path, `${JSON.stringify(metadata)}\n`);
    await assert.rejects(
      stageReleaseFeed({ ...wrongMetadata, channel: "stable", version: "1.0.0" }),
      /metadata provenance does not match/,
    );
  }
});

test("rejects malformed current state and repairs only missing immutable history", async () => {
  for (const current of [7, null, "not-semver", []]) {
    const malformed = await fixture();
    await writeCandidate(malformed, "2.0.0");
    await mkdir(join(malformed.pagesDirectory, "stable", "releases"), { recursive: true });
    await writeFile(
      join(malformed.pagesDirectory, "stable", "latest.json"),
      `${JSON.stringify({ version: current })}\n`,
    );
    await assert.rejects(
      stageReleaseFeed({ ...malformed, channel: "stable", version: "2.0.0" }),
      /current channel manifest version must be strict SemVer/,
    );
  }

  const repair = await fixture();
  const candidate = await writeCandidate(repair, "2.0.0");
  await stageReleaseFeed({ ...repair, channel: "stable", version: "2.0.0" });
  const history = join(repair.pagesDirectory, "stable", "releases", "2.0.0.json");
  await rm(history);
  assert.deepEqual(
    await stageReleaseFeed({ ...repair, channel: "stable", version: "2.0.0" }),
    { status: "unchanged", version: "2.0.0" },
  );
  assert.deepEqual(await readFile(history), candidate.metadata);
});

test("advances monotonically without rewriting an existing immutable history entry", async () => {
  const bundle = await fixture();
  await writeCandidate(bundle, "1.0.0");
  await stageReleaseFeed({ ...bundle, channel: "stable", version: "1.0.0" });

  const next = await writeCandidate(bundle, "1.0.1");
  const nextHistory = join(bundle.pagesDirectory, "stable", "releases", "1.0.1.json");
  await writeFile(nextHistory, next.metadata, { mode: 0o400 });
  assert.deepEqual(
    await stageReleaseFeed({ ...bundle, channel: "stable", version: "1.0.1" }),
    { status: "published", version: "1.0.1" },
  );
  assert.equal((await stat(nextHistory)).mode & 0o777, 0o400);
  assert.deepEqual(
    await readFile(join(bundle.pagesDirectory, "stable", "latest.json")),
    next.latest,
  );

  await chmod(nextHistory, 0o600);
  assert.equal(
    (await stageReleaseFeed({ ...bundle, channel: "stable", version: "1.0.1" })).status,
    "unchanged",
  );
  assert.equal((await stat(nextHistory)).mode & 0o777, 0o600);
});

test("the command-line interface stages the selected canonical feed", async () => {
  const bundle = await fixture();
  await writeCandidate(bundle, "4.5.6");
  const script = new URL("./feed-policy.mjs", import.meta.url);
  const result = await execFileAsync(process.execPath, [
    script.pathname,
    "stable",
    "4.5.6",
    bundle.releaseDirectory,
    bundle.pagesDirectory,
  ]);

  assert.deepEqual(JSON.parse(result.stdout), { status: "published", version: "4.5.6" });
  assert.equal(
    JSON.parse(await readFile(join(bundle.pagesDirectory, "stable", "latest.json"), "utf8"))
      .version,
    "4.5.6",
  );

  await assert.rejects(
    execFileAsync(process.execPath, [script.pathname]),
    (error) => error.code === 1 && /usage: feed-policy\.mjs/.test(error.stderr),
  );
});
