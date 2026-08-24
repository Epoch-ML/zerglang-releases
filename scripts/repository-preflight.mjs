#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const RELEASE_REPOSITORY = "Epoch-ML/zerglang-releases";
const SOURCE_REPOSITORY = "Epoch-ML/zerg";
const RELEASE_WORKFLOW = ".github/workflows/release.yml";
const RELEASE_POLICY_ANCHOR = ".github/workflows/policy-anchor.yml";
const SOURCE_WORKFLOW = ".github/workflows/zerglang-ide-release.yml";
const PAIRED_SOURCE_WORKFLOW = ".github/workflows/zergchat-native-release.yml";
const SOURCE_POLICY_ANCHOR =
  ".github/workflows/zerglang-release-policy-anchor.yml";
const SOURCE_DEFAULT_BRANCH = "development";
const SOURCE_ANCHOR_DEPENDENCY_PATHS = Object.freeze([
  SOURCE_WORKFLOW,
  SOURCE_POLICY_ANCHOR,
  "zerglang/ide/package-lock.json",
  "zerglang/ide/package.json",
  "zerglang/ide/scripts/release/anchoredSourcePolicy.mjs",
  "zerglang/ide/scripts/release/sourceWorkflowPolicy.mjs",
]);
const EXPECTED_SOURCE_DEFAULT_BRANCH_PROTECTION = Object.freeze({
  enforceAdmins: true,
  requireLastPushApproval: true,
  requireLinearHistory: true,
  strictStatusChecks: true,
  requiredStatusChecks: Object.freeze([
    "Protected-base ZergLang release policy:15368",
    "Protected-base ZergChat release policy:15368",
  ]),
});
const CANONICAL_PAGES_URL = "https://epoch-ml.github.io/zerglang-releases/";
const SHA_PATTERN = /^[0-9a-f]{40}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const COHORT_TRUST_ROOT = new URL(
  "../keys/zerglang-release-signing-keys.json",
  import.meta.url,
);

const EXPECTED_ENVIRONMENTS = Object.freeze({
  preview: Object.freeze({
    secrets: Object.freeze([
      "ZERGLANG_RELEASE_SIGNING_PRIVATE_KEY",
      "ZERGLANG_TAURI_SIGNING_PRIVATE_KEY",
      "ZERGLANG_TAURI_SIGNING_PRIVATE_KEY_PASSWORD",
    ]),
    refs: Object.freeze(["branch:main"]),
    reviewers: Object.freeze(["User:1042757"]),
    prevent_self_review: false,
    wait_timer: null,
  }),
  stable: Object.freeze({
    secrets: Object.freeze([
      "ZERGLANG_APPLE_API_ISSUER",
      "ZERGLANG_APPLE_API_KEY_ID",
      "ZERGLANG_APPLE_API_PRIVATE_KEY",
      "ZERGLANG_APPLE_CERTIFICATE",
      "ZERGLANG_APPLE_CERTIFICATE_PASSWORD",
      "ZERGLANG_APPLE_SIGNING_IDENTITY",
    ]),
    refs: Object.freeze(["branch:main"]),
    reviewers: Object.freeze(["User:1042757"]),
    prevent_self_review: false,
    wait_timer: null,
  }),
  "zerglang-apple-preview": Object.freeze({
    secrets: Object.freeze([]),
    refs: Object.freeze(["branch:main"]),
    reviewers: Object.freeze([]),
    prevent_self_review: null,
    wait_timer: null,
  }),
  "zerglang-feed": Object.freeze({
    secrets: Object.freeze(["ZERGLANG_FEED_DEPLOY_KEY"]),
    refs: Object.freeze(["branch:main"]),
    reviewers: Object.freeze([]),
    prevent_self_review: null,
    wait_timer: null,
  }),
  "zerglang-source-read": Object.freeze({
    secrets: Object.freeze(["ZERG_SOURCE_DEPLOY_KEY"]),
    refs: Object.freeze(["branch:main"]),
    reviewers: Object.freeze(["User:1042757"]),
    prevent_self_review: false,
    wait_timer: null,
  }),
  "zerglang-updater-stable": Object.freeze({
    secrets: Object.freeze([
      "ZERGLANG_RELEASE_SIGNING_PRIVATE_KEY",
      "ZERGLANG_STABLE_TAURI_SIGNING_PRIVATE_KEY",
      "ZERGLANG_STABLE_TAURI_SIGNING_PRIVATE_KEY_PASSWORD",
    ]),
    refs: Object.freeze(["branch:main"]),
    reviewers: Object.freeze(["User:1042757"]),
    prevent_self_review: false,
    wait_timer: null,
  }),
  "github-pages": Object.freeze({
    secrets: Object.freeze([]),
    refs: Object.freeze(["branch:main"]),
    reviewers: Object.freeze([]),
    prevent_self_review: null,
    wait_timer: null,
  }),
});

const EXPECTED_RULESETS = Object.freeze([
  Object.freeze({
    name: "Release branch authority",
    refs: Object.freeze(["refs/heads/main"]),
    bypass: Object.freeze(["User:1042757"]),
    rules: Object.freeze(["creation", "update"]),
  }),
  Object.freeze({
    name: "Release branch history",
    refs: Object.freeze(["refs/heads/main"]),
    bypass: Object.freeze([]),
    rules: Object.freeze(["deletion", "non_fast_forward"]),
  }),
  Object.freeze({
    name: "Reviewed release requests",
    refs: Object.freeze(["refs/heads/main"]),
    bypass: Object.freeze(["User:1042757"]),
    rules: Object.freeze([
      "pull_request:rebase:1:last-push",
      "required_linear_history",
      "required_status_checks:Protected-base release policy:15368:strict",
    ]),
  }),
  Object.freeze({
    name: "ZergLang feed authority",
    refs: Object.freeze(["refs/heads/release-data"]),
    bypass: Object.freeze(["DeployKey:any"]),
    rules: Object.freeze(["creation", "update"]),
  }),
  Object.freeze({
    name: "ZergLang feed history",
    refs: Object.freeze(["refs/heads/release-data"]),
    bypass: Object.freeze([]),
    rules: Object.freeze(["deletion", "non_fast_forward"]),
  }),
  Object.freeze({
    name: "Release tag authority",
    refs: Object.freeze([
      "refs/tags/zerglang-preview-v*",
      "refs/tags/zerglang-v*",
    ]),
    bypass: Object.freeze(["User:1042757"]),
    rules: Object.freeze(["creation"]),
  }),
  Object.freeze({
    name: "Release tag immutability",
    refs: Object.freeze([
      "refs/tags/zerglang-ide-preview-v*",
      "refs/tags/zerglang-ide-v*",
      "refs/tags/zerglang-preview-v*",
      "refs/tags/zerglang-v*",
    ]),
    bypass: Object.freeze([]),
    rules: Object.freeze(["deletion", "update"]),
  }),
]);

const EXPECTED_SOURCE_RULESETS = Object.freeze([
  Object.freeze({
    name: "Development branch authority",
    refs: Object.freeze(["refs/heads/development"]),
    bypass: Object.freeze(["User:1042757"]),
    rules: Object.freeze(["creation", "update"]),
  }),
  Object.freeze({
    name: "Development branch history",
    refs: Object.freeze(["refs/heads/development"]),
    bypass: Object.freeze([]),
    rules: Object.freeze(["deletion", "non_fast_forward"]),
  }),
  Object.freeze({
    name: "Reviewed development changes",
    refs: Object.freeze(["refs/heads/development"]),
    bypass: Object.freeze(["User:1042757"]),
    rules: Object.freeze([
      "pull_request:rebase:1:last-push",
      "required_linear_history",
      "required_status_checks:Protected-base ZergLang release policy:15368:strict",
      "required_status_checks:Protected-base ZergChat release policy:15368:strict",
    ]),
  }),
  Object.freeze({
    name: "Desktop release tag authority",
    refs: Object.freeze([
      "refs/tags/colony-desktop-preview-v*",
      "refs/tags/colony-desktop-v*",
      "refs/tags/zde-preview-v*",
      "refs/tags/zde-v*",
      "refs/tags/zergchat-preview-v*",
      "refs/tags/zergchat-v*",
      "refs/tags/zerglang-preview-v*",
      "refs/tags/zerglang-v*",
      "refs/tags/zterm-preview-v*",
      "refs/tags/zterm-v*",
    ]),
    bypass: Object.freeze(["User:1042757"]),
    rules: Object.freeze(["creation"]),
  }),
  Object.freeze({
    name: "Desktop release tag immutability",
    refs: Object.freeze([
      "refs/tags/colony-desktop-preview-v*",
      "refs/tags/colony-desktop-v*",
      "refs/tags/zde-preview-v*",
      "refs/tags/zde-v*",
      "refs/tags/zergchat-preview-v*",
      "refs/tags/zergchat-v*",
      "refs/tags/zerglang-ide-preview-v*",
      "refs/tags/zerglang-ide-v*",
      "refs/tags/zerglang-preview-v*",
      "refs/tags/zerglang-v*",
      "refs/tags/zterm-preview-v*",
      "refs/tags/zterm-v*",
    ]),
    bypass: Object.freeze([]),
    rules: Object.freeze(["deletion", "update"]),
  }),
]);

const EXPECTED_SOURCE_ENVIRONMENT = Object.freeze({
  secrets: Object.freeze([]),
  refs: Object.freeze([
    "tag:zerglang-preview-v*",
    "tag:zerglang-v*",
  ]),
  reviewers: Object.freeze([]),
  prevent_self_review: null,
  wait_timer: null,
});

export class RepositoryPreflightError extends Error {
  constructor(message) {
    super(message);
    this.name = "RepositoryPreflightError";
  }
}

function requireObject(value, description) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new RepositoryPreflightError(`${description} must be an object`);
  }
  return value;
}

function sortedStrings(values) {
  if (!Array.isArray(values) || values.some((value) => typeof value !== "string")) {
    return [];
  }
  return [...values].sort();
}

function equalStrings(left, right) {
  const actual = sortedStrings(left);
  const expected = sortedStrings(right);
  return actual.length === expected.length &&
    actual.every((value, index) => value === expected[index]);
}

function includesAllStrings(values, required) {
  if (
    !Array.isArray(values) ||
    values.some((value) => typeof value !== "string") ||
    !Array.isArray(required) ||
    required.some((value) => typeof value !== "string")
  ) {
    return false;
  }
  const available = new Set(values);
  return required.every((value) => available.has(value));
}

function diagnostic(code, message) {
  return { code, message };
}

function findWorkflow(workflows, path) {
  return Array.isArray(workflows)
    ? workflows.find((workflow) => workflow.path === path)
    : undefined;
}

function rulesetMatches(actual, expected) {
  return actual !== undefined &&
    includesAllStrings(actual.refs, expected.refs) &&
    includesAllStrings(expected.bypass, actual.bypass) &&
    includesAllStrings(actual.rules, expected.rules);
}

function environmentMatches(actual, expected) {
  return actual !== undefined &&
    equalStrings(actual.secrets, expected.secrets) &&
    equalStrings(actual.refs, expected.refs) &&
    equalStrings(actual.reviewers, expected.reviewers) &&
    actual.prevent_self_review === expected.prevent_self_review &&
    actual.wait_timer === expected.wait_timer;
}

function sourceAnchorDependenciesMatch(dependencies) {
  if (!Array.isArray(dependencies) ||
      dependencies.length !== SOURCE_ANCHOR_DEPENDENCY_PATHS.length) {
    return false;
  }
  const records = new Map();
  for (const dependency of dependencies) {
    if (
      dependency === null ||
      typeof dependency !== "object" ||
      Array.isArray(dependency) ||
      typeof dependency.path !== "string" ||
      records.has(dependency.path) ||
      dependency.type !== "file" ||
      !SHA_PATTERN.test(dependency.sha)
    ) {
      return false;
    }
    records.set(dependency.path, dependency);
  }
  return SOURCE_ANCHOR_DEPENDENCY_PATHS.every((path) => records.has(path));
}

function sourceDefaultBranchProtectionMatches(protection) {
  return protection !== null &&
    typeof protection === "object" &&
    !Array.isArray(protection) &&
    protection.enforceAdmins ===
      EXPECTED_SOURCE_DEFAULT_BRANCH_PROTECTION.enforceAdmins &&
    protection.requireLastPushApproval ===
      EXPECTED_SOURCE_DEFAULT_BRANCH_PROTECTION.requireLastPushApproval &&
    protection.requireLinearHistory ===
      EXPECTED_SOURCE_DEFAULT_BRANCH_PROTECTION.requireLinearHistory &&
    protection.strictStatusChecks ===
      EXPECTED_SOURCE_DEFAULT_BRANCH_PROTECTION.strictStatusChecks &&
    includesAllStrings(
      protection.requiredStatusChecks,
      EXPECTED_SOURCE_DEFAULT_BRANCH_PROTECTION.requiredStatusChecks,
    );
}

function isBoundedFeedBranch(feedBranch) {
  if (
    feedBranch === null ||
    typeof feedBranch !== "object" ||
    Array.isArray(feedBranch) ||
    feedBranch.name !== "release-data" ||
    !SHA_PATTERN.test(feedBranch.sha) ||
    !SHA_PATTERN.test(feedBranch.tree_sha) ||
    feedBranch.truncated !== false ||
    !Array.isArray(feedBranch.entries) ||
    feedBranch.entries.length < 3 ||
    feedBranch.entries.length > 4_096
  ) {
    return false;
  }
  const paths = new Set();
  for (const entry of feedBranch.entries) {
    if (
      entry === null ||
      typeof entry !== "object" ||
      Array.isArray(entry) ||
      typeof entry.path !== "string" ||
      entry.path.length === 0 ||
      entry.path.length > 512 ||
      paths.has(entry.path)
    ) {
      return false;
    }
    paths.add(entry.path);
    if (entry.path === "site") {
      if (entry.type !== "tree" || entry.mode !== "040000") return false;
      continue;
    }
    if (!entry.path.startsWith("site/")) return false;
    const regularBlob = entry.type === "blob" && entry.mode === "100644";
    const directory = entry.type === "tree" && entry.mode === "040000";
    if (!regularBlob && !directory) return false;
  }
  return paths.has("site") &&
    paths.has("site/.nojekyll") &&
    paths.has("site/index.html");
}

export function auditRepositoryState(state, { phase } = {}) {
  if (phase !== "cutover" && phase !== "live") {
    throw new RepositoryPreflightError("phase must be cutover or live");
  }
  const root = requireObject(state, "repository state");
  const release = requireObject(root.release, "release repository state");
  const source = requireObject(root.source, "source repository state");
  const errors = [];
  const warnings = [];
  const expectedWorkflowState = phase === "cutover" ? "disabled_manually" : "active";

  if (source.defaultBranch !== SOURCE_DEFAULT_BRANCH) {
    errors.push(diagnostic(
      "source-default-branch-contract",
      "the protected source default branch must be development",
    ));
  }
  if (!sourceAnchorDependenciesMatch(source.anchorDependencies)) {
    errors.push(diagnostic(
      "source-anchor-dependencies",
      "source anchor dependency bytes must be the exact protected file roots",
    ));
  }
  if (!sourceDefaultBranchProtectionMatches(source.defaultBranchProtection)) {
    errors.push(diagnostic(
      "source-default-branch-protection",
      "development must enforce admins, last-push approval, linear history, and the strict protected-base check",
    ));
  }

  if (release.immutableReleases?.enabled !== true) {
    errors.push(diagnostic(
      "immutable-releases",
      "release immutability must be enabled",
    ));
  }
  if (
    release.pages?.https_enforced !== true ||
    release.pages?.build_type !== "workflow"
  ) {
    errors.push(diagnostic(
      "pages-contract",
      "Pages must use a workflow deployment with HTTPS enforced",
    ));
  }
  if (
    release.pages?.html_url !== CANONICAL_PAGES_URL ||
    release.pages?.public !== true
  ) {
    errors.push(diagnostic(
      "pages-contract",
      "Pages must publish the canonical public HTTPS origin",
    ));
  }
  if (!isBoundedFeedBranch(release.feedBranch)) {
    errors.push(diagnostic(
      "feed-branch-contract",
      "release-data must contain only a bounded site tree",
    ));
  }

  for (const [repository, workflows, workflowPath, anchorPath] of [
    [
      "release",
      release.workflows,
      RELEASE_WORKFLOW,
      RELEASE_POLICY_ANCHOR,
    ],
    ["source", source.workflows, SOURCE_WORKFLOW, SOURCE_POLICY_ANCHOR],
  ]) {
    const workflow = findWorkflow(workflows, workflowPath);
    const anchor = findWorkflow(workflows, anchorPath);
    if (
      workflow?.state !== expectedWorkflowState ||
      anchor?.state !== "active"
    ) {
      errors.push(diagnostic(
        "workflow-state",
        `${repository} workflow must be ${expectedWorkflowState} and its ` +
          "protected-base policy anchor must be active",
      ));
    }
  }
  if (
    findWorkflow(source.workflows, PAIRED_SOURCE_WORKFLOW)?.state !== "active"
  ) {
    errors.push(diagnostic(
      "workflow-state",
      "the paired ZergChat source request workflow must remain active",
    ));
  }

  const environments = requireObject(
    release.environments,
    "release environments",
  );
  for (const [name, expected] of Object.entries(EXPECTED_ENVIRONMENTS)) {
    const actual = environments[name];
    if (!environmentMatches(actual, expected)) {
      errors.push(diagnostic(
      "environment-contract",
      `${name} environment credentials, refs, or protection rules differ`,
      ));
    }
  }

  const writableKeys = Array.isArray(release.deployKeys)
    ? release.deployKeys.filter((key) => key.read_only === false)
    : [];
  if (
    writableKeys.length !== 1 ||
    writableKeys[0].verified !== true ||
    !writableKeys[0].title.startsWith("ZergLang release feed writer ")
  ) {
    errors.push(diagnostic(
      "deploy-key",
      "the public repository must have exactly one verified feed writer key",
    ));
  }
  const sourceKeys = Array.isArray(source.deployKeys)
    ? source.deployKeys.filter((key) =>
      key.title.startsWith("ZergLang releases source checkout ")
    )
    : [];
  if (
    sourceKeys.length !== 1 ||
    sourceKeys[0].verified !== true ||
    sourceKeys[0].read_only !== true
  ) {
    errors.push(diagnostic(
      "source-key",
      "the ZergLang source deploy key must be verified and read-only",
    ));
  }
  const sourceEnvironments = requireObject(
    source.environments,
    "source environments",
  );
  const sourceRequestEnvironment = sourceEnvironments["zerglang-release-request"];
  if (
    !environmentMatches(
      sourceRequestEnvironment,
      EXPECTED_SOURCE_ENVIRONMENT,
    )
  ) {
    errors.push(diagnostic(
      "source-environment-contract",
      "zerglang-release-request must be secret-free and tag-scoped",
    ));
  }
  const cohortTrustRootSha256 = release.cohortTrustRootSha256;
  if (
    typeof cohortTrustRootSha256 !== "string" ||
    !SHA256_PATTERN.test(cohortTrustRootSha256) ||
    sourceRequestEnvironment?.variables?.ZERGLANG_UPDATE_TRUST_ROOT_SHA256 !==
      cohortTrustRootSha256
  ) {
    errors.push(diagnostic(
      "cohort-trust-pin",
      "the source release environment must pin the exact raw cohort trust-store digest",
    ));
  }
  if (
    Array.isArray(source.repositorySecrets) &&
    source.repositorySecrets.includes("ZERGLANG_RELEASES_DEPLOY_KEY")
  ) {
    errors.push(diagnostic(
      "source-repository-secret",
      "source request write credentials must be absent",
    ));
  }
  if (Array.isArray(release.repositorySecrets) && release.repositorySecrets.length > 0) {
    errors.push(diagnostic(
      "repository-secret",
      "release credentials must remain environment-scoped",
    ));
  }

  const rulesets = Array.isArray(release.rulesets) ? release.rulesets : [];
  for (const expected of EXPECTED_RULESETS) {
    const matches = rulesets.filter(
      (ruleset) => ruleset.name === expected.name,
    );
    if (matches.length !== 1 || !rulesetMatches(matches[0], expected)) {
      errors.push(diagnostic(
        "ruleset-contract",
        `${expected.name} differs from the cutover contract`,
      ));
    }
  }
  const sourceRulesets = Array.isArray(source.rulesets) ? source.rulesets : [];
  for (const expected of EXPECTED_SOURCE_RULESETS) {
    const matches = sourceRulesets.filter(
      (ruleset) => ruleset.name === expected.name,
    );
    if (matches.length !== 1 || !rulesetMatches(matches[0], expected)) {
      errors.push(diagnostic(
        "source-ruleset-contract",
        `${expected.name} differs from the cutover contract`,
      ));
    }
  }
  const reviewed = rulesets.find(
    (ruleset) => ruleset.name === "Reviewed release requests",
  );
  if (reviewed?.bypass?.includes("User:1042757")) {
    warnings.push(diagnostic(
      "human-review-limitation",
      "Idan retains review bypass until a second trusted human is available",
    ));
  }

  const sortDiagnostics = (values) => values.sort((left, right) =>
    `${left.code}:${left.message}`.localeCompare(`${right.code}:${right.message}`)
  );
  return {
    errors: sortDiagnostics(errors),
    warnings: sortDiagnostics(warnings),
  };
}

function normalizeRule(rule) {
  if (rule.type === "pull_request") {
    const parameters = rule.parameters ?? {};
    const methods = sortedStrings(parameters.allowed_merge_methods).join("+");
    const approvals = parameters.required_approving_review_count;
    const lastPush = parameters.require_last_push_approval === true
      ? "last-push"
      : "no-last-push";
    return `pull_request:${methods}:${approvals}:${lastPush}`;
  }
  if (rule.type === "required_status_checks") {
    const parameters = rule.parameters ?? {};
    const strict = parameters.strict_required_status_checks_policy === true
      ? "strict"
      : "non-strict";
    const checks = Array.isArray(parameters.required_status_checks)
      ? parameters.required_status_checks
      : [];
    return checks.map((check) =>
      `required_status_checks:${check.context}:${check.integration_id}:${strict}`
    );
  }
  return rule.type;
}

function normalizeRuleset(ruleset) {
  const refs = ruleset.conditions?.ref_name?.include ?? [];
  const bypass = Array.isArray(ruleset.bypass_actors)
    ? ruleset.bypass_actors.map((actor) =>
      `${actor.actor_type}:${actor.actor_id ?? "any"}`
    )
    : [];
  const rules = Array.isArray(ruleset.rules)
    ? ruleset.rules.flatMap(normalizeRule)
    : [];
  return {
    name: ruleset.name,
    refs: sortedStrings(refs),
    bypass: sortedStrings(bypass),
    rules: sortedStrings(rules),
  };
}

export async function requestGitHub({
  repository,
  path,
  apiVersion = "2022-11-28",
  allowNotFound = false,
}, {
  token = process.env.GH_TOKEN,
  fetchImpl = fetch,
} = {}) {
  if (typeof token !== "string" || token === "") {
    throw new RepositoryPreflightError("GH_TOKEN is required for repository preflight");
  }
  if (typeof fetchImpl !== "function") {
    throw new RepositoryPreflightError("fetchImpl must be a function");
  }
  const resource = path === "" ? repository : `${repository}/${path}`;
  const response = await fetchImpl(
    `https://api.github.com/repos/${resource}`,
    {
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "X-GitHub-Api-Version": apiVersion,
      },
    },
  );
  if (allowNotFound && response.status === 404) return null;
  if (!response.ok) {
    throw new RepositoryPreflightError(
      `GitHub API ${resource} returned ${response.status}`,
    );
  }
  return response.json();
}

async function collectEnvironments(
  request,
  repository,
  response,
  expectedNames,
) {
  const environments = {};
  const expected = new Set(expectedNames);
  const records = Array.isArray(response.environments) ? response.environments : [];
  const relevantRecords = records.filter(
    (record) =>
      record !== null &&
      typeof record === "object" &&
      typeof record.name === "string" &&
      expected.has(record.name),
  );
  for (const record of relevantRecords.sort(
    (left, right) => left.name.localeCompare(right.name),
  )) {
    const protectionRules = Array.isArray(record.protection_rules)
      ? record.protection_rules
      : [];
    const reviewerRules = protectionRules.filter(
      (rule) => rule?.type === "required_reviewers",
    );
    const waitTimerRules = protectionRules.filter(
      (rule) => rule?.type === "wait_timer",
    );
    const reviewers = reviewerRules.flatMap((rule) =>
      Array.isArray(rule.reviewers)
        ? rule.reviewers.flatMap((reviewer) => {
            const type = reviewer?.type;
            const id = reviewer?.reviewer?.id;
            return typeof type === "string" && Number.isSafeInteger(id)
              ? [`${type}:${id}`]
              : [];
          })
        : []
    );
    const preventSelfReview = reviewerRules.length === 0
      ? null
      : reviewerRules.length === 1 &&
          typeof reviewerRules[0].prevent_self_review === "boolean"
        ? reviewerRules[0].prevent_self_review
        : "invalid";
    const waitTimer = waitTimerRules.length === 0
      ? null
      : waitTimerRules.length === 1 &&
          Number.isSafeInteger(waitTimerRules[0].wait_timer)
        ? waitTimerRules[0].wait_timer
        : "invalid";
    const secrets = await request({
      repository,
      path: `environments/${encodeURIComponent(record.name)}/secrets`,
    });
    const policies = await request({
      repository,
      path: `environments/${encodeURIComponent(record.name)}/deployment-branch-policies`,
      allowNotFound: true,
    });
    environments[record.name] = {
      secrets: Array.isArray(secrets.secrets)
        ? secrets.secrets.map((secret) => secret.name).sort()
        : [],
      refs: Array.isArray(policies?.branch_policies)
        ? policies.branch_policies.map((policy) =>
          `${policy.type}:${policy.name}`
        ).sort()
        : [],
      reviewers: reviewers.sort(),
      prevent_self_review: preventSelfReview,
      wait_timer: waitTimer,
    };
  }
  return environments;
}

async function collectRulesets(request, repository, response) {
  const summaries = Array.isArray(response) ? response : [];
  const rulesets = [];
  for (const summary of summaries.sort((left, right) => left.id - right.id)) {
    const full = await request({
      repository,
      path: `rulesets/${summary.id}`,
    });
    if (full.enforcement === "active") rulesets.push(normalizeRuleset(full));
  }
  return rulesets;
}

export async function collectRepositoryState({
  request = requestGitHub,
  readTrustRoot = readFile,
  releaseRepository = RELEASE_REPOSITORY,
  sourceRepository = SOURCE_REPOSITORY,
} = {}) {
  if (typeof request !== "function") {
    throw new RepositoryPreflightError("request must be a function");
  }
  if (typeof readTrustRoot !== "function") {
    throw new RepositoryPreflightError("readTrustRoot must be a function");
  }
  let cohortTrustRootSha256 = null;
  try {
    const trustBytes = await readTrustRoot(COHORT_TRUST_ROOT);
    cohortTrustRootSha256 = createHash("sha256").update(trustBytes).digest("hex");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  const immutableReleases = await request({
    repository: releaseRepository,
    path: "immutable-releases",
    apiVersion: "2026-03-10",
  });
  const pages = await request({ repository: releaseRepository, path: "pages" });
  const feedBranchResponse = await request({
    repository: releaseRepository,
    path: "branches/release-data",
    allowNotFound: true,
  });
  let feedBranch = null;
  if (feedBranchResponse !== null) {
    const branch = requireObject(feedBranchResponse, "release-data branch");
    const commit = requireObject(branch.commit, "release-data commit");
    const commitMetadata = requireObject(
      commit.commit,
      "release-data commit metadata",
    );
    const tree = requireObject(commitMetadata.tree, "release-data tree reference");
    const treeResponse = await request({
      repository: releaseRepository,
      path: `git/trees/${tree.sha}?recursive=1`,
    });
    const treeDocument = requireObject(treeResponse, "release-data tree");
    feedBranch = {
      name: branch.name,
      sha: commit.sha,
      tree_sha: tree.sha,
      truncated: treeDocument.truncated,
      entries: Array.isArray(treeDocument.tree)
        ? treeDocument.tree.map(({ path, mode, type }) => ({ path, mode, type }))
          .sort((left, right) => left.path.localeCompare(right.path))
        : [],
    };
  }
  const releaseWorkflows = await request({
    repository: releaseRepository,
    path: "actions/workflows",
  });
  const environmentResponse = await request({
    repository: releaseRepository,
    path: "environments",
  });
  const environments = await collectEnvironments(
    request,
    releaseRepository,
    environmentResponse,
    Object.keys(EXPECTED_ENVIRONMENTS),
  );
  const repositorySecretsResponse = await request({
    repository: releaseRepository,
    path: "actions/secrets",
  });
  const releaseKeys = await request({
    repository: releaseRepository,
    path: "keys",
  });
  const rulesetResponse = await request({
    repository: releaseRepository,
    path: "rulesets",
  });
  const rulesets = await collectRulesets(
    request,
    releaseRepository,
    rulesetResponse,
  );
  const sourceMetadata = requireObject(
    await request({ repository: sourceRepository, path: "" }),
    "source repository metadata",
  );
  const sourceDefaultBranch = sourceMetadata.default_branch;
  const sourceAnchorDependencies = [];
  for (const path of SOURCE_ANCHOR_DEPENDENCY_PATHS) {
    const dependency = requireObject(
      await request({
        repository: sourceRepository,
        path: `contents/${path}?ref=${encodeURIComponent(SOURCE_DEFAULT_BRANCH)}`,
      }),
      `source anchor dependency ${path}`,
    );
    sourceAnchorDependencies.push({
      path: dependency.path,
      sha: dependency.sha,
      type: dependency.type,
    });
  }
  const protection = requireObject(
    await request({
      repository: sourceRepository,
      path: `branches/${SOURCE_DEFAULT_BRANCH}/protection`,
    }),
    "source default branch protection",
  );
  const protectionChecks = Array.isArray(protection.required_status_checks?.checks)
    ? protection.required_status_checks.checks
    : [];
  const sourceDefaultBranchProtection = {
    enforceAdmins: protection.enforce_admins?.enabled === true,
    requireLastPushApproval:
      protection.required_pull_request_reviews?.require_last_push_approval === true,
    requireLinearHistory: protection.required_linear_history?.enabled === true,
    strictStatusChecks: protection.required_status_checks?.strict === true,
    requiredStatusChecks: protectionChecks.map((check) =>
      `${check.context}:${check.app_id ?? "any"}`
    ).sort(),
  };
  const sourceWorkflows = await request({
    repository: sourceRepository,
    path: "actions/workflows",
  });
  const sourceEnvironmentResponse = await request({
    repository: sourceRepository,
    path: "environments",
  });
  const sourceEnvironments = await collectEnvironments(
    request,
    sourceRepository,
    sourceEnvironmentResponse,
    ["zerglang-release-request"],
  );
  const sourceTrustVariablesResponse = await request({
    repository: sourceRepository,
    path: "environments/zerglang-release-request/variables",
  });
  const sourceTrustVariables = Array.isArray(sourceTrustVariablesResponse.variables)
    ? Object.fromEntries(sourceTrustVariablesResponse.variables.map(({ name, value }) => [
      name,
      value,
    ]))
    : {};
  if (sourceEnvironments["zerglang-release-request"] !== undefined) {
    sourceEnvironments["zerglang-release-request"].variables = sourceTrustVariables;
  }
  const sourceRepositorySecretsResponse = await request({
    repository: sourceRepository,
    path: "actions/secrets",
  });
  const sourceKeys = await request({ repository: sourceRepository, path: "keys" });
  const sourceRulesetResponse = await request({
    repository: sourceRepository,
    path: "rulesets",
  });
  const sourceRulesets = await collectRulesets(
    request,
    sourceRepository,
    sourceRulesetResponse,
  );

  return {
    release: {
      cohortTrustRootSha256,
      immutableReleases,
      pages,
      feedBranch,
      workflows: Array.isArray(releaseWorkflows.workflows)
        ? releaseWorkflows.workflows.map(({ path, state }) => ({ path, state }))
        : [],
      environments,
      repositorySecrets: Array.isArray(repositorySecretsResponse.secrets)
        ? repositorySecretsResponse.secrets.map((secret) => secret.name).sort()
        : [],
      deployKeys: Array.isArray(releaseKeys) ? releaseKeys : [],
      rulesets,
    },
    source: {
      defaultBranch: sourceDefaultBranch,
      anchorDependencies: sourceAnchorDependencies,
      defaultBranchProtection: sourceDefaultBranchProtection,
      workflows: Array.isArray(sourceWorkflows.workflows)
        ? sourceWorkflows.workflows.map(({ path, state }) => ({ path, state }))
        : [],
      environments: sourceEnvironments,
      repositorySecrets: Array.isArray(sourceRepositorySecretsResponse.secrets)
        ? sourceRepositorySecretsResponse.secrets.map((secret) => secret.name).sort()
        : [],
      deployKeys: Array.isArray(sourceKeys) ? sourceKeys : [],
      rulesets: sourceRulesets,
    },
  };
}

async function main() {
  const phase = process.argv[2];
  if (phase !== "cutover" && phase !== "live") {
    throw new RepositoryPreflightError(
      "usage: repository-preflight.mjs cutover|live",
    );
  }
  const result = auditRepositoryState(
    await collectRepositoryState(),
    { phase },
  );
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (result.errors.length > 0) process.exitCode = 1;
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main().catch((error) => {
    console.error(`repository-preflight: ${error.message}`);
    process.exitCode = 1;
  });
}
