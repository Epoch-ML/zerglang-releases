import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { parse } from "yaml";

const anchorUrl = new URL("../.github/workflows/policy-anchor.yml", import.meta.url);
const evaluatorUrl = new URL("./anchored-policy.mjs", import.meta.url);
const releaseWorkflow = await readFile(
  new URL("../.github/workflows/release.yml", import.meta.url),
  "utf8",
);

test("uses a base-anchored pull_request_target workflow without head execution", async () => {
  assert.equal(existsSync(anchorUrl), true, "the protected-base anchor must exist");
  const workflow = parse(await readFile(anchorUrl, "utf8"));

  assert.deepEqual(workflow.on, {
    pull_request_target: { branches: ["main"], types: ["opened", "reopened", "synchronize"] },
  });
  assert.deepEqual(workflow.permissions, { contents: "read" });
  assert.deepEqual(Object.keys(workflow.jobs), ["anchored-policy"]);
  const job = workflow.jobs["anchored-policy"];
  assert.equal(job.environment, undefined);
  assert.deepEqual(job.permissions, { contents: "read" });
  assert.deepEqual(
    job.steps.filter((step) => typeof step.uses === "string"),
    [
      {
        uses: "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1",
        with: {
          ref: "${{ github.sha }}",
          path: "trusted-policy",
          "fetch-depth": 1,
          "persist-credentials": false,
          submodules: false,
          lfs: false,
        },
      },
      {
        uses: "actions/setup-node@820762786026740c76f36085b0efc47a31fe5020",
        with: { "node-version": "22.23.2" },
      },
    ],
  );
  const serialized = JSON.stringify(job);
  for (const token of [
    "refs/pull/${{ github.event.pull_request.number }}/head",
    "${{ github.event.pull_request.head.sha }}",
    "${{ github.event.pull_request.base.sha }}",
    "--filter=blob:none",
    "core.hooksPath=/dev/null",
    "npm ci --ignore-scripts --no-audit --no-fund",
    "trusted-policy/scripts/anchored-policy.mjs",
  ]) {
    assert.equal(serialized.includes(token), true, token);
  }
  for (const forbidden of [
    "actions/cache",
    "secrets.",
    "github.event.pull_request.head.ref",
    "npm test",
    "git checkout",
  ]) {
    assert.equal(serialized.includes(forbidden), false, forbidden);
  }
});

test("audits immutable head workflow bytes and rejects protected policy changes", async () => {
  assert.equal(existsSync(evaluatorUrl), true, "the trusted evaluator must exist");
  const { auditAnchoredPullRequestData } = await import(evaluatorUrl.href);
  const safe = {
    baseSha: "a".repeat(40),
    headSha: "b".repeat(40),
    changedPaths: [".github/workflows/release.yml"],
    candidateMode: "100644",
    candidateSize: Buffer.byteLength(releaseWorkflow),
    candidateWorkflow: releaseWorkflow,
  };
  assert.deepEqual(auditAnchoredPullRequestData(safe), []);

  const protectedChange = structuredClone(safe);
  protectedChange.changedPaths.push("scripts/workflow-policy.mjs");
  assert.deepEqual(
    auditAnchoredPullRequestData(protectedChange).map(({ code }) => code),
    ["protected-policy-change"],
  );

  for (const protectedPath of [
    ".github/workflows/unreviewed.yml",
    "keys/zerglang-preview-updater.pubkey",
    "scripts/feed-promotion.mjs",
  ]) {
    const trustRootChange = structuredClone(safe);
    trustRootChange.changedPaths = [protectedPath];
    assert.deepEqual(
      auditAnchoredPullRequestData(trustRootChange).map(({ code }) => code),
      ["protected-policy-change"],
      protectedPath,
    );
  }

  for (const mutate of [
    (input) => { input.headSha = "moving-head"; },
    (input) => { input.changedPaths = Array.from({ length: 257 }, (_, i) => `docs/${i}`); },
    (input) => { input.candidateMode = "100755"; },
    (input) => { input.candidateSize = 262_145; },
  ]) {
    const hostile = structuredClone(safe);
    mutate(hostile);
    assert.notDeepEqual(auditAnchoredPullRequestData(hostile), []);
  }

  const leaking = structuredClone(safe);
  leaking.candidateWorkflow = releaseWorkflow.replace(
    "contents: read",
    "contents: read\n  LEAK: ${{ secrets['DYNAMIC_KEY'] }}",
  );
  leaking.candidateSize = Buffer.byteLength(leaking.candidateWorkflow);
  assert.equal(
    auditAnchoredPullRequestData(leaking).some(
      ({ code }) => code === "candidate-workflow",
    ),
    true,
  );
});
