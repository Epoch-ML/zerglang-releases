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

function expressionUsesSecretsContext(expression) {
  let inString = false;
  for (let index = 0; index < expression.length; index += 1) {
    const character = expression[index];
    if (character === "'") {
      if (inString && expression[index + 1] === "'") index += 1;
      else inString = !inString;
      continue;
    }
    if (inString || !/[A-Za-z_]/.test(character)) continue;
    let end = index + 1;
    while (end < expression.length && /[A-Za-z0-9_]/.test(expression[end])) {
      end += 1;
    }
    if (expression.slice(index, end).toLowerCase() === "secrets") return true;
    index = end - 1;
  }
  return false;
}

function secretReferencesInString(value) {
  const references = [];
  let start = value.indexOf("${{");
  while (start !== -1) {
    let inString = false;
    let closed = false;
    for (let index = start + 3; index < value.length - 1; index += 1) {
      if (value[index] === "'") {
        if (inString && value[index + 1] === "'") index += 1;
        else inString = !inString;
      } else if (!inString && value[index] === "}" && value[index + 1] === "}") {
        closed = true;
        const expression = value.slice(start + 3, index);
        if (expressionUsesSecretsContext(expression)) {
          const canonical = expression.trim().match(/^secrets\.([A-Z0-9_]+)$/);
          references.push({
            canonical: canonical !== null,
            name: canonical?.[1] ?? null,
          });
        }
        start = value.indexOf("${{", index + 2);
        break;
      }
    }
    if (!closed) break;
  }
  return references;
}

function collectSecretReferences(value, references = []) {
  if (typeof value === "string") {
    references.push(...secretReferencesInString(value));
  } else if (Array.isArray(value)) {
    for (const item of value) collectSecretReferences(item, references);
  } else if (value !== null && typeof value === "object") {
    for (const item of Object.values(value)) {
      collectSecretReferences(item, references);
    }
  }
  return references;
}

function collectSecretReferencesOutsideStepEnv(step) {
  const references = [];
  for (const [key, value] of Object.entries(step)) {
    if (key !== "env") collectSecretReferences(value, references);
  }
  return references;
}

function collectTokenContexts(value, path = [], contexts = []) {
  if (typeof value === "string") {
    if (value.includes("${{") || path[path.length - 1] === "if") {
      contexts.push({ path: path.join("/"), value });
    }
  } else if (Array.isArray(value)) {
    value.forEach((item, index) =>
      collectTokenContexts(item, [...path, String(index)], contexts));
  } else if (value !== null && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      collectTokenContexts(item, [...path, key], contexts);
    }
  }
  return contexts;
}

function collectRunPrograms(workflow) {
  const jobs = requireMapping(workflow.jobs, "workflow jobs");
  const programs = [];
  for (const [jobName, rawJob] of Object.entries(jobs)) {
    const job = requireMapping(rawJob, `${jobName} job`);
    if (!Array.isArray(job.steps)) continue;
    job.steps.forEach((rawStep, index) => {
      const step = requireMapping(rawStep, `${jobName} step ${index + 1}`);
      if (typeof step.run === "string") {
        programs.push({ job: jobName, index, run: step.run });
      }
    });
  }
  return programs;
}

function canonicalMetadataValue(value) {
  if (Array.isArray(value)) return value.map(canonicalMetadataValue);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, canonicalMetadataValue(value[key])]),
  );
}

function collectExecutionMetadata(workflow) {
  const jobs = requireMapping(workflow.jobs, "workflow jobs");
  const rootMetadata = Object.fromEntries(
    Object.entries(workflow).filter(([key]) => key !== "jobs"),
  );
  return {
    root: canonicalMetadataValue(rootMetadata),
    jobs: Object.keys(jobs)
      .sort()
      .map((jobName) => {
        const job = requireMapping(jobs[jobName], `${jobName} job`);
        const jobMetadata = Object.fromEntries(
          Object.entries(job).filter(([key]) => key !== "steps"),
        );
        const steps = Array.isArray(job.steps)
          ? job.steps.map((rawStep, index) => {
              const step = requireMapping(rawStep, `${jobName} step ${index + 1}`);
              return canonicalMetadataValue(Object.fromEntries(
                Object.entries(step).filter(([key]) => key !== "run"),
              ));
            })
          : [];
        return {
          job: jobName,
          metadata: canonicalMetadataValue(jobMetadata),
          steps,
        };
      }),
  };
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

function isFeedSecret(name) {
  return name === "ZERGLANG_FEED_DEPLOY_KEY";
}

const APPLE_ENVIRONMENT =
  "${{ needs.validate.outputs.channel == 'stable' && 'stable' || 'zerglang-apple-preview' }}";

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
      'git -C source-git fetch --no-tags --depth=1 origin \\"$EXPECTED_SHA\\"',
      '\\"$EXPECTED_REF:$EXPECTED_REF\\"',
      'git -C source-git archive \\"$ZERGLANG_SOURCE_SHA\\"',
      "--component clippy,rustfmt",
      "createUpdaterArtifacts = false",
      "zerglang-unsigned-source-stage",
    ]),
  }),
  apple_sign: Object.freeze({
    needs: Object.freeze(["build", "validate"]),
    tokens: Object.freeze(["zerglang-platform-signed"]),
  }),
  signed_smoke: Object.freeze({
    needs: Object.freeze(["apple_sign", "validate"]),
    tokens: Object.freeze([
      "codesign --verify",
      "xcrun stapler validate",
      "spctl --assess",
      "run --tier=interpreter",
      "run --tier=jit",
      "build --emit=object",
    ]),
  }),
  sign_updater_preview: Object.freeze({
    needs: Object.freeze(["signed_smoke", "validate"]),
    tokens: Object.freeze(["zerglang-release-payload"]),
  }),
  sign_updater_stable: Object.freeze({
    needs: Object.freeze(["signed_smoke", "validate"]),
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
      "release-data",
      "policy/scripts/feed-promotion.mjs",
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

const CHECKOUT_ACTION =
  "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1";
const SETUP_NODE_ACTION =
  "actions/setup-node@820762786026740c76f36085b0efc47a31fe5020";
const DOWNLOAD_ACTION =
  "actions/download-artifact@d3f86a106a0bac45b974a628896c90dbdf5c8093";
const UPLOAD_ACTION =
  "actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02";
const CONFIGURE_PAGES_ACTION =
  "actions/configure-pages@983d7736d9b0ae728b81ab479565c72886d7745b";
const UPLOAD_PAGES_ACTION =
  "actions/upload-pages-artifact@56afc609e74202658d3ffba0e8f6dda462b719fa";
const DEPLOY_PAGES_ACTION =
  "actions/deploy-pages@d6db90164ac5ed86f2b6aed7e0febac5b3c0c03e";

function action(uses, withOptions = null) {
  return { uses, with: withOptions };
}

const READ_PERMISSION = Object.freeze({ contents: "read" });
const JOB_BOUNDARIES = Object.freeze({
  validate: Object.freeze({
    runner: "ubuntu-24.04",
    permissions: READ_PERMISSION,
    environment: null,
    actions: Object.freeze([
      action(CHECKOUT_ACTION, { "fetch-depth": 0, "persist-credentials": false }),
      action(SETUP_NODE_ACTION, { "node-version": "22.23.2", cache: "npm" }),
    ]),
  }),
  build: Object.freeze({
    runner: "macos-15",
    permissions: READ_PERMISSION,
    environment: "zerglang-source-read",
    actions: Object.freeze([
      action(CHECKOUT_ACTION, {
        path: "release-repository",
        "persist-credentials": false,
      }),
      action(SETUP_NODE_ACTION, { "node-version": "22.23.2" }),
      action(SETUP_NODE_ACTION, {
        "node-version": "22.23.2",
        cache: "npm",
        "cache-dependency-path": "source/zerglang/ide/package-lock.json",
      }),
      action(UPLOAD_ACTION, {
        name: "zerglang-unsigned-source-stage",
        path: "source/zerglang/ide/dist/source-stage/*",
        "if-no-files-found": "error",
        "retention-days": 1,
        "compression-level": 0,
      }),
    ]),
  }),
  apple_sign: Object.freeze({
    runner: "macos-15",
    permissions: READ_PERMISSION,
    environment: Object.freeze({ name: APPLE_ENVIRONMENT }),
    actions: Object.freeze([
      action(CHECKOUT_ACTION, { "persist-credentials": false }),
      action(SETUP_NODE_ACTION, { "node-version": "22.23.2", cache: "npm" }),
      action(DOWNLOAD_ACTION, {
        name: "zerglang-unsigned-source-stage",
        path: "source-stage",
      }),
      action(UPLOAD_ACTION, {
        name: "zerglang-platform-signed",
        path: "${{ runner.temp }}/zerglang-platform-signed/*",
        "if-no-files-found": "error",
        "retention-days": 1,
        "compression-level": 0,
      }),
    ]),
  }),
  signed_smoke: Object.freeze({
    runner: "macos-15",
    permissions: READ_PERMISSION,
    environment: null,
    actions: Object.freeze([
      action(CHECKOUT_ACTION, {
        path: "policy",
        ref: "${{ github.sha }}",
        "persist-credentials": false,
      }),
      action(SETUP_NODE_ACTION, {
        "node-version": "22.23.2",
        cache: "npm",
        "cache-dependency-path": "policy/package-lock.json",
      }),
      action(DOWNLOAD_ACTION, {
        name: "zerglang-platform-signed",
        path: "signed",
      }),
    ]),
  }),
  sign_updater_preview: Object.freeze({
    runner: "ubuntu-24.04",
    permissions: READ_PERMISSION,
    environment: "preview",
    actions: Object.freeze([
      action(CHECKOUT_ACTION, { "persist-credentials": false }),
      action(SETUP_NODE_ACTION, { "node-version": "22.23.2", cache: "npm" }),
      action(DOWNLOAD_ACTION, {
        name: "zerglang-platform-signed",
        path: "release-input",
      }),
      action(UPLOAD_ACTION, {
        name: "zerglang-release-payload",
        path: "release/*",
        "if-no-files-found": "error",
        "retention-days": 7,
        "compression-level": 0,
      }),
    ]),
  }),
  sign_updater_stable: Object.freeze({
    runner: "ubuntu-24.04",
    permissions: READ_PERMISSION,
    environment: "zerglang-updater-stable",
    actions: Object.freeze([
      action(CHECKOUT_ACTION, { "persist-credentials": false }),
      action(SETUP_NODE_ACTION, { "node-version": "22.23.2", cache: "npm" }),
      action(DOWNLOAD_ACTION, {
        name: "zerglang-platform-signed",
        path: "release-input",
      }),
      action(UPLOAD_ACTION, {
        name: "zerglang-release-payload",
        path: "release/*",
        "if-no-files-found": "error",
        "retention-days": 7,
        "compression-level": 0,
      }),
    ]),
  }),
  sign_updater: Object.freeze({
    runner: "ubuntu-24.04",
    permissions: READ_PERMISSION,
    environment: null,
    actions: Object.freeze([]),
  }),
  publish: Object.freeze({
    runner: "ubuntu-24.04",
    permissions: Object.freeze({ contents: "write" }),
    environment: null,
    actions: Object.freeze([
      action(CHECKOUT_ACTION, {
        "fetch-depth": 0,
        path: "release-repository",
        "persist-credentials": false,
      }),
      action(SETUP_NODE_ACTION, {
        "node-version": "22.23.2",
        cache: "npm",
        "cache-dependency-path": "release-repository/package-lock.json",
      }),
      action(DOWNLOAD_ACTION, { name: "zerglang-release-payload", path: "release" }),
      action(UPLOAD_ACTION, {
        name: "zerglang-canonical-release",
        path: "${{ runner.temp }}/zerglang-canonical-release/*",
        "if-no-files-found": "error",
        "retention-days": 7,
        "compression-level": 0,
      }),
    ]),
  }),
  feed: Object.freeze({
    runner: "ubuntu-24.04",
    permissions: READ_PERMISSION,
    environment: "zerglang-feed",
    actions: Object.freeze([
      action(CHECKOUT_ACTION, {
        "fetch-depth": 0,
        path: "policy",
        ref: "${{ github.sha }}",
        "persist-credentials": false,
      }),
      action(SETUP_NODE_ACTION, {
        "node-version": "22.23.2",
        cache: "npm",
        "cache-dependency-path": "policy/package-lock.json",
      }),
      action(DOWNLOAD_ACTION, {
        name: "zerglang-canonical-release",
        path: "canonical",
      }),
      action(CONFIGURE_PAGES_ACTION),
      action(UPLOAD_PAGES_ACTION, { path: "data/site" }),
    ]),
  }),
  deploy_pages: Object.freeze({
    runner: "ubuntu-24.04",
    permissions: Object.freeze({ pages: "write", "id-token": "write" }),
    environment: Object.freeze({
      name: "github-pages",
      url: "${{ steps.deployment.outputs.page_url }}",
    }),
    actions: Object.freeze([action(DEPLOY_PAGES_ACTION)]),
  }),
  verify_live: Object.freeze({
    runner: "ubuntu-24.04",
    permissions: READ_PERMISSION,
    environment: null,
    actions: Object.freeze([
      action(DOWNLOAD_ACTION, {
        name: "zerglang-canonical-release",
        path: "canonical",
      }),
    ]),
  }),
});

const CREDENTIAL_BINDINGS = Object.freeze({
  ZERG_SOURCE_DEPLOY_KEY: Object.freeze({
    job: "build",
    step: "Fetch exact source objects with one read key",
    env: "SOURCE_DEPLOY_KEY",
    kind: "source",
  }),
  ZERGLANG_APPLE_API_ISSUER: Object.freeze({
    job: "apple_sign",
    step: "Apply preview ad-hoc or fail-closed stable Apple signing",
    env: "ZERGLANG_APPLE_API_ISSUER",
    kind: "apple",
  }),
  ZERGLANG_APPLE_API_KEY_ID: Object.freeze({
    job: "apple_sign",
    step: "Apply preview ad-hoc or fail-closed stable Apple signing",
    env: "ZERGLANG_APPLE_API_KEY_ID",
    kind: "apple",
  }),
  ZERGLANG_APPLE_API_PRIVATE_KEY: Object.freeze({
    job: "apple_sign",
    step: "Apply preview ad-hoc or fail-closed stable Apple signing",
    env: "ZERGLANG_APPLE_API_PRIVATE_KEY",
    kind: "apple",
  }),
  ZERGLANG_APPLE_CERTIFICATE: Object.freeze({
    job: "apple_sign",
    step: "Apply preview ad-hoc or fail-closed stable Apple signing",
    env: "ZERGLANG_APPLE_CERTIFICATE",
    kind: "apple",
  }),
  ZERGLANG_APPLE_CERTIFICATE_PASSWORD: Object.freeze({
    job: "apple_sign",
    step: "Apply preview ad-hoc or fail-closed stable Apple signing",
    env: "ZERGLANG_APPLE_CERTIFICATE_PASSWORD",
    kind: "apple",
  }),
  ZERGLANG_APPLE_SIGNING_IDENTITY: Object.freeze({
    job: "apple_sign",
    step: "Apply preview ad-hoc or fail-closed stable Apple signing",
    env: "ZERGLANG_APPLE_SIGNING_IDENTITY",
    kind: "apple",
  }),
  ZERGLANG_TAURI_SIGNING_PRIVATE_KEY: Object.freeze({
    job: "sign_updater_preview",
    step: "Sign only the preview updater archive",
    env: "TAURI_PRIVATE_KEY",
    kind: "updater",
  }),
  ZERGLANG_TAURI_SIGNING_PRIVATE_KEY_PASSWORD: Object.freeze({
    job: "sign_updater_preview",
    step: "Sign only the preview updater archive",
    env: "TAURI_PRIVATE_KEY_PASSWORD",
    kind: "updater",
  }),
  ZERGLANG_STABLE_TAURI_SIGNING_PRIVATE_KEY: Object.freeze({
    job: "sign_updater_stable",
    step: "Sign only the stable updater archive",
    env: "TAURI_PRIVATE_KEY",
    kind: "updater",
  }),
  ZERGLANG_STABLE_TAURI_SIGNING_PRIVATE_KEY_PASSWORD: Object.freeze({
    job: "sign_updater_stable",
    step: "Sign only the stable updater archive",
    env: "TAURI_PRIVATE_KEY_PASSWORD",
    kind: "updater",
  }),
  ZERGLANG_FEED_DEPLOY_KEY: Object.freeze({
    job: "feed",
    step: "Push only the prepared release-data commit",
    env: "FEED_DEPLOY_KEY",
    kind: "feed",
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

function executesProductCode(run) {
  return /(?:^|[\s"'])\$?zlc(?:[\s"']|$)/m.test(run) ||
    run.includes("run --tier=interpreter") ||
    run.includes("run --tier=jit") ||
    run.includes("build --emit=object");
}

function executesPulledFeedPolicy(step, run) {
  const workingDirectory = step["working-directory"];
  return /git\s+pull[^\n]*(?:\s|\/)main(?:\s|$)/m.test(run) ||
    /(?:node|npm|npx|bash|sh)\s+(?:\.\/)?data\//m.test(run) ||
    workingDirectory === "data";
}

export function auditWorkflowPolicy(source, canonicalSource = undefined) {
  const workflow = parseWorkflow(source);
  const jobs = requireMapping(workflow.jobs, "workflow jobs");
  const diagnostics = [];
  const credentialOccurrences = [];

  if (canonicalSource !== undefined) {
    const canonicalWorkflow = parseWorkflow(canonicalSource);
    const runProgramsDiffer =
      JSON.stringify(collectRunPrograms(workflow)) !==
      JSON.stringify(collectRunPrograms(canonicalWorkflow));
    const tokenContextsDiffer =
      JSON.stringify(collectTokenContexts(workflow)) !==
      JSON.stringify(collectTokenContexts(canonicalWorkflow));
    const executionMetadataDiffer =
      JSON.stringify(collectExecutionMetadata(workflow)) !==
      JSON.stringify(collectExecutionMetadata(canonicalWorkflow));
    if (runProgramsDiffer) {
      addDiagnostic(
        diagnostics,
        "run-program-boundary",
        "workflow",
        null,
        "run step order and program bytes must match the protected canonical workflow",
      );
    }
    if (executionMetadataDiffer && !runProgramsDiffer && !tokenContextsDiffer) {
      addDiagnostic(
        diagnostics,
        "execution-metadata-boundary",
        "workflow",
        null,
        "job and step execution metadata must match the protected canonical workflow",
      );
    }
    if (tokenContextsDiffer) {
      addDiagnostic(
        diagnostics,
        "token-context-boundary",
        "workflow",
        null,
        "credential-yielding expressions must match the protected canonical workflow",
      );
    }
  }

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

  if (JSON.stringify(workflow.permissions) !== JSON.stringify(READ_PERMISSION)) {
    addDiagnostic(
      diagnostics,
      "permission-boundary",
      "workflow",
      null,
      "workflow permissions must be exactly contents: read",
    );
  }

  if (Object.keys(jobs).some((jobName) => JOB_CONTRACTS[jobName] === undefined)) {
    addDiagnostic(
      diagnostics,
      "job-contract",
      "workflow",
      null,
      "release workflow must contain exactly the approved job set",
    );
  }

  const workflowSecretReferences = collectSecretReferences(
    Object.fromEntries(Object.entries(workflow).filter(([key]) => key !== "jobs")),
  );
  if (workflowSecretReferences.length > 0) {
    addDiagnostic(
      diagnostics,
      workflowSecretReferences.some(({ canonical }) => !canonical)
        ? "secret-expression-boundary"
        : "secret-outside-step-env",
      "workflow",
      null,
      "secrets are allowed only as exact expressions in one consuming step env",
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
    const boundary = JOB_BOUNDARIES[jobName];
    if (boundary === undefined) continue;
    if (job.uses !== undefined || job.secrets !== undefined) {
      addDiagnostic(
        diagnostics,
        "job-contract",
        jobName,
        null,
        "release jobs may not call reusable workflows or forward secrets",
      );
    }
    if (job["runs-on"] !== boundary.runner) {
      addDiagnostic(
        diagnostics,
        "job-contract",
        jobName,
        null,
        "release job runner differs from the exact contract",
      );
    }
    if (JSON.stringify(job.permissions ?? null) !== JSON.stringify(boundary.permissions)) {
      addDiagnostic(
        diagnostics,
        "permission-boundary",
        jobName,
        null,
        "release job permissions differ from the exact contract",
      );
    }
    if (JSON.stringify(job.environment ?? null) !== JSON.stringify(boundary.environment)) {
      addDiagnostic(
        diagnostics,
        "environment-boundary",
        jobName,
        null,
        "release job environment differs from the exact contract",
      );
    }

    const actionSteps = Array.isArray(job.steps)
      ? job.steps
        .filter((step) => step !== null && typeof step === "object" &&
          !Array.isArray(step) && typeof step.uses === "string")
        .map((step) => action(step.uses, step.with ?? null))
      : [];
    if (JSON.stringify(actionSteps) !== JSON.stringify(boundary.actions)) {
      addDiagnostic(
        diagnostics,
        "action-contract",
        jobName,
        null,
        "job actions and checkout options differ from the exact contract",
      );
    }

    if (jobName === "feed") {
      const serializedFeed = JSON.stringify(job);
      const hasReleaseDataPush = Array.isArray(job.steps) && job.steps.some((step) =>
        step !== null && typeof step === "object" && !Array.isArray(step) &&
        typeof step.run === "string" &&
        step.run.includes("policy/scripts/feed-promotion.mjs push") &&
        step.run.includes("release-data")
      );
      if (
        !serializedFeed.includes("release-data") ||
        !hasReleaseDataPush ||
        serializedFeed.includes("HEAD:main") ||
        serializedFeed.includes("origin main")
      ) {
        addDiagnostic(
          diagnostics,
          "feed-authority",
          jobName,
          null,
          "feed promotion may update only release-data",
        );
      }
    }

    const updaterPolicy = UPDATER_JOB_POLICY[jobName];

    const jobSecretReferences = collectSecretReferences(job.env ?? {});
    const jobSecretNames = new Set(
      jobSecretReferences.filter(({ canonical }) => canonical).map(({ name }) => name),
    );
    if (jobSecretReferences.some(({ canonical }) => !canonical)) {
      addDiagnostic(
        diagnostics,
        "secret-expression-boundary",
        jobName,
        null,
        "job env contains a non-canonical secrets context expression",
      );
    }
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
    for (const [index, rawStep] of job.steps.entries()) {
      const step = requireMapping(rawStep, `${jobName} step ${index + 1}`);
      const secretReferences = collectSecretReferences(step.env ?? {});
      const secretNames = new Set(
        secretReferences.filter(({ canonical }) => canonical).map(({ name }) => name),
      );
      const secretReferencesOutsideEnv = collectSecretReferencesOutsideStepEnv(step);
      const secretNamesOutsideEnv = new Set(
        secretReferencesOutsideEnv
          .filter(({ canonical }) => canonical)
          .map(({ name }) => name),
      );
      const run = typeof step.run === "string" ? step.run : "";
      const stepName = typeof step.name === "string"
        ? step.name
        : typeof step.uses === "string"
          ? `uses ${step.uses}`
          : `step ${index + 1}`;
      if (
        secretReferences.some(({ canonical }) => !canonical) ||
        secretReferencesOutsideEnv.some(({ canonical }) => !canonical)
      ) {
        addDiagnostic(
          diagnostics,
          "secret-expression-boundary",
          jobName,
          stepName,
          "secret contexts must use one exact canonical dot expression",
        );
      }
      if (step.env !== undefined && step.env !== null &&
          typeof step.env === "object" && !Array.isArray(step.env)) {
        for (const [envName, envValue] of Object.entries(step.env)) {
          for (const reference of collectSecretReferences(envValue)) {
            if (reference.canonical) {
              credentialOccurrences.push({
                env: envName,
                job: jobName,
                name: reference.name,
                step: stepName,
                value: envValue,
              });
            }
          }
        }
      }
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
      for (const name of secretNames) {
        if (CREDENTIAL_BINDINGS[name] === undefined) {
          addDiagnostic(
            diagnostics,
            "credential-allowlist",
            jobName,
            stepName,
            `secret ${name} is not part of the release credential contract`,
          );
        }
      }
      if (jobName === "apple_sign" && executesProductCode(run)) {
        addDiagnostic(
          diagnostics,
          "product-execution-boundary",
          jobName,
          stepName,
          "Apple signing jobs must not execute source-produced programs",
        );
      }
      if (jobName === "signed_smoke" && secretNames.size > 0) {
        addDiagnostic(
          diagnostics,
          "signed-smoke-credential",
          jobName,
          stepName,
          "signed smoke must execute without credentials",
        );
      }
      if (jobName === "feed" && executesPulledFeedPolicy(step, run)) {
        addDiagnostic(
          diagnostics,
          "feed-policy-boundary",
          jobName,
          stepName,
          "feed promotion must execute only the immutable policy checkout",
        );
      }
      if (jobName === "feed" && [...secretNames].some(isFeedSecret)) {
        const env = requireMapping(step.env, "feed credential env");
        if (
          env.FEED_DEPLOY_KEY !==
            "${{ secrets.ZERGLANG_FEED_DEPLOY_KEY }}" ||
          !run.includes("unset FEED_DEPLOY_KEY") ||
          !run.includes("policy/scripts/feed-promotion.mjs push") ||
          !run.includes("release-data")
        ) {
          addDiagnostic(
            diagnostics,
            "feed-credential-contract",
            jobName,
            stepName,
            "the feed deploy key may only push one prepared release-data commit",
          );
        }
      }
      if (updaterPolicy !== undefined && [...secretNames].some(isUpdaterSecret)) {
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
      if ([...secretNames].includes("ZERG_SOURCE_DEPLOY_KEY")) {
        const destroysKey = run.includes("trap cleanup EXIT") &&
          run.includes("unset SOURCE_DEPLOY_KEY") &&
          run.includes('rm -f "$key_path"');
        const materializesOrExecutes = /\bgit\b[^\n]*(?:checkout|archive)|\btar\b|\b(?:npm|cmake|ctest)\b/m
          .test(run);
        if (!destroysKey || materializesOrExecutes) {
          addDiagnostic(
            diagnostics,
            "source-credential-window",
            jobName,
            stepName,
            "the source key step may fetch objects only and must destroy its key before materialization",
          );
        }
      }
    }
  }

  const credentialGroups = new Set(
    Object.values(CREDENTIAL_BINDINGS).map(({ kind, job }) => `${kind}:${job}`),
  );
  for (const group of credentialGroups) {
    const [kind, job] = group.split(":");
    if (jobs[job] === undefined) continue;
    const expected = Object.entries(CREDENTIAL_BINDINGS)
      .filter(([, binding]) => binding.kind === kind && binding.job === job);
    const valid = expected.every(([name, binding]) => {
      const occurrences = credentialOccurrences.filter(
        (occurrence) => occurrence.name === name,
      );
      return occurrences.length === 1 &&
        occurrences[0].job === binding.job &&
        occurrences[0].step === binding.step &&
        occurrences[0].env === binding.env &&
        occurrences[0].value === `\${{ secrets.${name} }}`;
    });
    if (valid) continue;
    addDiagnostic(
      diagnostics,
      `${kind}-credential-contract`,
      job,
      null,
      `every ${kind} secret must occur once in its exact consuming step`,
    );
  }

  const uniqueDiagnostics = [...new Map(
    diagnostics.map((diagnostic) => [
      `${diagnostic.code}:${diagnostic.job}:${diagnostic.step ?? ""}`,
      diagnostic,
    ]),
  ).values()];
  return uniqueDiagnostics.sort((left, right) =>
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
  const policyActions = policy !== null && Array.isArray(policy.steps)
    ? policy.steps
      .filter((step) => step !== null && typeof step === "object" &&
        !Array.isArray(step) && typeof step.uses === "string")
      .map((step) => action(step.uses, step.with ?? null))
    : [];
  const expectedPolicyActions = [
    action(CHECKOUT_ACTION, { "persist-credentials": false }),
    action(SETUP_NODE_ACTION, { "node-version": "22.23.2", cache: "npm" }),
  ];
  const valid = arraysEqual(Object.keys(triggers).sort(), ["pull_request"]) &&
    arraysEqual(branchNames, ["main"]) &&
    safePermissions &&
    arraysEqual(Object.keys(jobs), ["policy"]) &&
    policy !== null &&
    policy["runs-on"] === "ubuntu-24.04" &&
    policy.environment === undefined &&
    policy.permissions === undefined &&
    policy.uses === undefined &&
    policy.secrets === undefined &&
    Array.isArray(policy.steps) && policy.steps.length === 3 &&
    JSON.stringify(policyActions) === JSON.stringify(expectedPolicyActions) &&
    collectSecretReferences(workflow).length === 0 &&
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
