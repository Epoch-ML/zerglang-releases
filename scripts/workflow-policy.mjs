#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

import { parseDocument } from "yaml";

export class WorkflowPolicyError extends Error {
  constructor(message) {
    super(message);
    this.name = "WorkflowPolicyError";
  }
}

function parseWorkflow(source) {
  if (typeof source !== "string" || source.trim() === "") {
    throw new WorkflowPolicyError("workflow source must be non-empty text");
  }
  const document = parseDocument(source, {
    maxAliasCount: 0,
    prettyErrors: false,
    strict: true,
  });
  if (document.errors.length > 0) {
    throw new WorkflowPolicyError("workflow source must be valid YAML");
  }
  const workflow = document.toJS({ maxAliasCount: 0 });
  if (workflow === null || typeof workflow !== "object" || Array.isArray(workflow)) {
    throw new WorkflowPolicyError("workflow root must be a mapping");
  }
  return workflow;
}

function requireMapping(value, description) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new WorkflowPolicyError(`${description} must be a mapping`);
  }
  return value;
}

function collectSecretNames(value, names = new Set()) {
  if (typeof value === "string") {
    for (const match of value.matchAll(/\$\{\{\s*secrets\.([A-Z0-9_]+)\s*}}/g)) {
      names.add(match[1]);
    }
    return names;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectSecretNames(item, names);
    return names;
  }
  if (value !== null && typeof value === "object") {
    for (const item of Object.values(value)) collectSecretNames(item, names);
  }
  return names;
}

function collectSecretNamesOutsideStepEnv(step) {
  const names = new Set();
  for (const [key, value] of Object.entries(step)) {
    if (key !== "env") collectSecretNames(value, names);
  }
  return names;
}

function jobContainsContractToken(serializedJob, token) {
  if (token !== "--draft") return serializedJob.includes(token);
  return /(?:^|[^A-Za-z0-9_-])--draft(?=$|[^A-Za-z0-9_=-])/.test(serializedJob);
}

function environmentName(job) {
  if (typeof job.environment === "string") return job.environment;
  if (
    job.environment !== null &&
    typeof job.environment === "object" &&
    !Array.isArray(job.environment)
  ) {
    return job.environment.name;
  }
  return undefined;
}

function addDiagnostic(diagnostics, code, job, step, message) {
  diagnostics.push({ code, job, step, message });
}

function isUpdaterSecret(name) {
  return name === "ZERGLANG_TAURI_SIGNING_PRIVATE_KEY" ||
    name === "ZERGLANG_TAURI_SIGNING_PRIVATE_KEY_PASSWORD" ||
    name === "ZERGLANG_STABLE_TAURI_SIGNING_PRIVATE_KEY" ||
    name === "ZERGLANG_STABLE_TAURI_SIGNING_PRIVATE_KEY_PASSWORD";
}

function isAppleSecret(name) {
  return name.startsWith("ZERGLANG_APPLE_");
}

const UPDATER_JOB_POLICY = Object.freeze({
  sign_updater_preview: Object.freeze({
    environment: "preview",
    privateKey: "ZERGLANG_TAURI_SIGNING_PRIVATE_KEY",
    password: "ZERGLANG_TAURI_SIGNING_PRIVATE_KEY_PASSWORD",
  }),
  sign_updater_stable: Object.freeze({
    environment: "zerglang-updater-stable",
    privateKey: "ZERGLANG_STABLE_TAURI_SIGNING_PRIVATE_KEY",
    password: "ZERGLANG_STABLE_TAURI_SIGNING_PRIVATE_KEY_PASSWORD",
  }),
});

const JOB_CONTRACTS = Object.freeze({
  validate: Object.freeze({
    needs: Object.freeze([]),
    tokens: Object.freeze([
      "request_file",
      "git log --diff-filter=A",
      "the request addition commit must add only this request",
      "refs/tags/$RELEASE_TAG",
    ]),
  }),
  build: Object.freeze({
    needs: Object.freeze(["validate"]),
    tokens: Object.freeze([
      "createUpdaterArtifacts = false",
      "zerglang-unsigned-source-stage",
    ]),
  }),
  apple_sign: Object.freeze({
    needs: Object.freeze(["build", "validate"]),
    tokens: Object.freeze(["zerglang-platform-signed"]),
  }),
  sign_updater_preview: Object.freeze({
    needs: Object.freeze(["apple_sign", "validate"]),
    tokens: Object.freeze(["zerglang-release-payload"]),
  }),
  sign_updater_stable: Object.freeze({
    needs: Object.freeze(["apple_sign", "validate"]),
    tokens: Object.freeze(["zerglang-release-payload"]),
  }),
  sign_updater: Object.freeze({
    needs: Object.freeze(["sign_updater_preview", "sign_updater_stable"]),
    tokens: Object.freeze([]),
  }),
  publish: Object.freeze({
    needs: Object.freeze(["sign_updater", "validate"]),
    tokens: Object.freeze([
      "--draft",
      "--verify-tag",
      "--draft=false",
      ".immutable",
      "zerglang-canonical-release",
      "latest.json",
    ]),
  }),
  feed: Object.freeze({
    needs: Object.freeze(["publish", "validate"]),
    tokens: Object.freeze([
      "scripts/feed-policy.mjs",
      "zerglang-canonical-release",
      "actions/upload-pages-artifact",
    ]),
  }),
  deploy_pages: Object.freeze({
    needs: Object.freeze(["feed"]),
    tokens: Object.freeze(["actions/deploy-pages"]),
  }),
  verify_live: Object.freeze({
    needs: Object.freeze(["deploy_pages", "validate"]),
    tokens: Object.freeze([
      "https://epoch-ml.github.io/zerglang-releases",
      "latest.json",
    ]),
  }),
});

function normalizedNeeds(value) {
  if (value === undefined) return [];
  if (typeof value === "string") return [value];
  if (Array.isArray(value) && value.every((item) => typeof item === "string")) {
    return [...value].sort();
  }
  throw new WorkflowPolicyError("job needs must be a string or string array");
}

function arraysEqual(left, right) {
  return left.length === right.length &&
    left.every((value, index) => value === right[index]);
}

function updaterStepDoesPostSignWork(run) {
  return /(?:^|\s)(?:curl|wget|tar|sha256sum)(?:\s|$)/m.test(run) ||
    run.includes("minisign") ||
    run.includes("scripts/release-payload.mjs");
}

function appleStepDoesPostSignWork(run) {
  return run.includes("scripts/package-macos.mjs") ||
    run.includes("platform-metadata.json");
}

export function auditWorkflowPolicy(source) {
  const workflow = parseWorkflow(source);
  const jobs = requireMapping(workflow.jobs, "workflow jobs");
  const diagnostics = [];

  const triggers = workflow.on === undefined
    ? {}
    : requireMapping(workflow.on, "workflow triggers");
  const triggerNames = Object.keys(triggers).sort();
  const dispatch = triggers.workflow_dispatch;
  const dispatchInputs = dispatch === null || typeof dispatch !== "object" ||
      Array.isArray(dispatch)
    ? null
    : dispatch.inputs;
  const inputNames = dispatchInputs === null || typeof dispatchInputs !== "object" ||
      Array.isArray(dispatchInputs)
    ? []
    : Object.keys(dispatchInputs).sort();
  if (
    !arraysEqual(triggerNames, ["workflow_dispatch"]) ||
    !arraysEqual(inputNames, ["request_file"])
  ) {
    addDiagnostic(
      diagnostics,
      "trigger-contract",
      "workflow",
      null,
      "release workflow must dispatch only one existing request_file",
    );
  }

  for (const [requiredJobName, contract] of Object.entries(JOB_CONTRACTS)) {
    const rawRequiredJob = jobs[requiredJobName];
    if (rawRequiredJob === undefined) {
      addDiagnostic(
        diagnostics,
        "job-contract",
        requiredJobName,
        null,
        "required release job is missing",
      );
      continue;
    }
    const requiredJob = requireMapping(rawRequiredJob, `${requiredJobName} job`);
    const actualNeeds = normalizedNeeds(requiredJob.needs);
    if (!arraysEqual(actualNeeds, [...contract.needs].sort())) {
      addDiagnostic(
        diagnostics,
        "job-contract",
        requiredJobName,
        null,
        `job dependencies differ: ${actualNeeds.join(", ")}`,
      );
    }
    const serializedJob = JSON.stringify(requiredJob);
    if (
      contract.tokens.some((token) => !jobContainsContractToken(serializedJob, token))
    ) {
      addDiagnostic(
        diagnostics,
        "job-contract",
        requiredJobName,
        null,
        "required release policy operation is missing",
      );
    }
  }

  for (const [jobName, rawJob] of Object.entries(jobs)) {
    const job = requireMapping(rawJob, `${jobName} job`);
    if (jobName === "build" && environmentName(job) !== "zerglang-source-read") {
      addDiagnostic(
        diagnostics,
        "environment-boundary",
        jobName,
        null,
        "build must use the protected zerglang-source-read environment",
      );
    }

    const updaterPolicy = UPDATER_JOB_POLICY[jobName];
    if (
      updaterPolicy !== undefined &&
      environmentName(job) !== updaterPolicy.environment
    ) {
      addDiagnostic(
        diagnostics,
        "environment-boundary",
        jobName,
        null,
        `${jobName} must use the protected ${updaterPolicy.environment} environment`,
      );
    }

    const jobSecretNames = collectSecretNames(job.env ?? {});
    if (jobSecretNames.size > 0) {
      addDiagnostic(
        diagnostics,
        "job-secret-scope",
        jobName,
        null,
        `job env exposes secrets: ${[...jobSecretNames].sort().join(", ")}`,
      );
    }

    if (job.steps === undefined) continue;
    if (!Array.isArray(job.steps)) {
      throw new WorkflowPolicyError(`${jobName} job steps must be an array`);
    }
    let updaterSignerCount = 0;
    for (const [index, rawStep] of job.steps.entries()) {
      const step = requireMapping(rawStep, `${jobName} step ${index + 1}`);
      const secretNames = collectSecretNames(step.env ?? {});
      const secretNamesOutsideEnv = collectSecretNamesOutsideStepEnv(step);
      const run = typeof step.run === "string" ? step.run : "";
      const stepName = typeof step.name === "string"
        ? step.name
        : typeof step.uses === "string"
          ? `uses ${step.uses}`
          : `step ${index + 1}`;
      if (
        typeof step.uses === "string" &&
        step.uses.startsWith("actions/") &&
        !/^actions\/[a-z0-9-]+@[0-9a-f]{40}$/.test(step.uses)
      ) {
        addDiagnostic(
          diagnostics,
          "unpinned-action",
          jobName,
          stepName,
          "GitHub-owned actions must be pinned to a full commit SHA",
        );
      }
      if (secretNamesOutsideEnv.size > 0) {
        addDiagnostic(
          diagnostics,
          "secret-outside-step-env",
          jobName,
          stepName,
          "secret expressions are permitted only in the env of their consuming step",
        );
      }
      if (updaterPolicy !== undefined && [...secretNames].some(isUpdaterSecret)) {
        updaterSignerCount += 1;
        const env = requireMapping(step.env, `${jobName} signer env`);
        const expectedPrivateKey = `\${{ secrets.${updaterPolicy.privateKey} }}`;
        const expectedPassword = `\${{ secrets.${updaterPolicy.password} }}`;
        if (
          env.TAURI_PRIVATE_KEY !== expectedPrivateKey ||
          env.TAURI_PRIVATE_KEY_PASSWORD !== expectedPassword ||
          !run.includes(
            "npm exec --offline -- tauri signer sign release-input/ZergLang.app.tar.gz",
          ) ||
          !run.includes("unset TAURI_PRIVATE_KEY TAURI_PRIVATE_KEY_PASSWORD")
        ) {
          addDiagnostic(
            diagnostics,
            "updater-credential-contract",
            jobName,
            stepName,
            "updater signer must receive the channel key pair, sign once, and explicitly unset it",
          );
        }
      }
      if ([...secretNames].some(isUpdaterSecret) && updaterStepDoesPostSignWork(run)) {
        addDiagnostic(
          diagnostics,
          "updater-secret-window",
          jobName,
          stepName,
          "updater private keys must not coexist with download, verification, or payload work",
        );
      }
      if ([...secretNames].some(isAppleSecret) && appleStepDoesPostSignWork(run)) {
        addDiagnostic(
          diagnostics,
          "apple-secret-window",
          jobName,
          stepName,
          "Apple credentials must be destroyed before archive and metadata packaging",
        );
      }
    }
    if (updaterPolicy !== undefined && updaterSignerCount !== 1) {
      addDiagnostic(
        diagnostics,
        "updater-credential-contract",
        jobName,
        null,
        `${jobName} must contain exactly one credential-bearing signer step`,
      );
    }
  }

  return diagnostics.sort((left, right) =>
    `${left.code}:${left.job}:${left.step ?? ""}`.localeCompare(
      `${right.code}:${right.job}:${right.step ?? ""}`,
    )
  );
}

export function auditPolicyWorkflow(source) {
  const workflow = parseWorkflow(source);
  const triggers = workflow.on === undefined
    ? {}
    : requireMapping(workflow.on, "policy workflow triggers");
  const pullRequest = triggers.pull_request;
  const jobs = requireMapping(workflow.jobs, "policy workflow jobs");
  const policy = jobs.policy === undefined
    ? null
    : requireMapping(jobs.policy, "policy job");
  const serialized = policy === null ? "" : JSON.stringify(policy);
  const requiredTokens = [
    "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1",
    "actions/setup-node@820762786026740c76f36085b0efc47a31fe5020",
    "npm ci --ignore-scripts --no-audit --no-fund",
    "npm audit --audit-level=moderate",
    "npm test",
    "node scripts/workflow-policy.mjs .github/workflows/release.yml",
    "node scripts/workflow-policy.mjs .github/workflows/policy.yml --policy-ci",
    "actionlint_1.7.12_linux_amd64.tar.gz",
    "8aca8db96f1b94770f1b0d72b6dddcb1ebb8123cb3712530b08cc387b349a3d8",
    "git diff --check",
  ];
  const branchNames = pullRequest !== null && typeof pullRequest === "object" &&
      !Array.isArray(pullRequest) && Array.isArray(pullRequest.branches)
    ? [...pullRequest.branches].sort()
    : [];
  const permissions = workflow.permissions;
  const safePermissions = permissions !== null && typeof permissions === "object" &&
    !Array.isArray(permissions) &&
    Object.keys(permissions).length === 1 && permissions.contents === "read";
  const valid = arraysEqual(Object.keys(triggers).sort(), ["pull_request"]) &&
    arraysEqual(branchNames, ["main"]) &&
    safePermissions &&
    policy !== null &&
    collectSecretNames(workflow).size === 0 &&
    requiredTokens.every((token) => serialized.includes(token));
  return valid
    ? []
    : [{
        code: "policy-ci-contract",
        job: "policy",
        step: null,
        message: "pull-request CI must execute every public release policy gate without secrets",
      }];
}

async function main() {
  if (
    process.argv.length !== 3 &&
    !(process.argv.length === 4 && process.argv[3] === "--policy-ci")
  ) {
    throw new WorkflowPolicyError(
      "usage: workflow-policy.mjs WORKFLOW.yml [--policy-ci]",
    );
  }
  const source = await readFile(process.argv[2], "utf8");
  const diagnostics = process.argv[3] === "--policy-ci"
    ? auditPolicyWorkflow(source)
    : auditWorkflowPolicy(source);
  process.stdout.write(`${JSON.stringify({ diagnostics }, null, 2)}\n`);
  if (diagnostics.length > 0) process.exitCode = 1;
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main().catch((error) => {
    console.error(`workflow-policy: ${error.message}`);
    process.exitCode = 1;
  });
}
