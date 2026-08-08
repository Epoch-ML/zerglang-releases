#!/usr/bin/env node

import { pathToFileURL } from "node:url";

const RELEASE_REPOSITORY = "Epoch-ML/zerglang-releases";
const SOURCE_REPOSITORY = "Epoch-ML/zerg";
const RELEASE_WORKFLOW = ".github/workflows/release.yml";
const SOURCE_WORKFLOW = ".github/workflows/zerglang-ide-release.yml";

const EXPECTED_ENVIRONMENTS = Object.freeze({
  preview: Object.freeze({
    secrets: Object.freeze([
      "ZERGLANG_TAURI_SIGNING_PRIVATE_KEY",
      "ZERGLANG_TAURI_SIGNING_PRIVATE_KEY_PASSWORD",
    ]),
    branches: Object.freeze(["main"]),
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
    branches: Object.freeze(["main"]),
  }),
  "zerglang-apple-preview": Object.freeze({
    secrets: Object.freeze([]),
    branches: Object.freeze(["main"]),
  }),
  "zerglang-feed": Object.freeze({
    secrets: Object.freeze(["ZERGLANG_FEED_DEPLOY_KEY"]),
    branches: Object.freeze(["main"]),
  }),
  "zerglang-source-read": Object.freeze({
    secrets: Object.freeze(["ZERG_SOURCE_DEPLOY_KEY"]),
    branches: Object.freeze(["main"]),
  }),
  "zerglang-updater-stable": Object.freeze({
    secrets: Object.freeze([
      "ZERGLANG_STABLE_TAURI_SIGNING_PRIVATE_KEY",
      "ZERGLANG_STABLE_TAURI_SIGNING_PRIVATE_KEY_PASSWORD",
    ]),
    branches: Object.freeze(["main"]),
  }),
  "github-pages": Object.freeze({
    secrets: Object.freeze([]),
    branches: Object.freeze(["main"]),
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
      "required_status_checks:Release policy:15368:strict",
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
]);

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
    equalStrings(actual.refs, expected.refs) &&
    equalStrings(actual.bypass, expected.bypass) &&
    equalStrings(actual.rules, expected.rules);
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

  for (const [repository, workflows, path] of [
    ["release", release.workflows, RELEASE_WORKFLOW],
    ["source", source.workflows, SOURCE_WORKFLOW],
  ]) {
    const workflow = findWorkflow(workflows, path);
    if (workflow?.state !== expectedWorkflowState) {
      errors.push(diagnostic(
        "workflow-state",
        `${repository} workflow must be ${expectedWorkflowState}`,
      ));
    }
  }

  const environments = requireObject(
    release.environments,
    "release environments",
  );
  for (const [name, expected] of Object.entries(EXPECTED_ENVIRONMENTS)) {
    const actual = environments[name];
    if (
      actual === undefined ||
      !equalStrings(actual.secrets, expected.secrets) ||
      !equalStrings(actual.branches, expected.branches)
    ) {
      errors.push(diagnostic(
        "environment-contract",
        `${name} environment secrets or branch policy differ`,
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
  const sourceKey = Array.isArray(source.deployKeys)
    ? source.deployKeys.find((key) =>
      key.title.startsWith("ZergLang releases source checkout ")
    )
    : undefined;
  if (sourceKey?.verified !== true || sourceKey?.read_only !== true) {
    errors.push(diagnostic(
      "source-key",
      "the ZergLang source deploy key must be verified and read-only",
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
    const actual = rulesets.find((ruleset) => ruleset.name === expected.name);
    if (!rulesetMatches(actual, expected)) {
      errors.push(diagnostic(
        "ruleset-contract",
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

async function defaultRequest({ repository, path, apiVersion = "2022-11-28" }) {
  const token = process.env.GH_TOKEN;
  if (typeof token !== "string" || token === "") {
    throw new RepositoryPreflightError("GH_TOKEN is required for repository preflight");
  }
  const response = await fetch(
    `https://api.github.com/repos/${repository}/${path}`,
    {
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "X-GitHub-Api-Version": apiVersion,
      },
    },
  );
  if (!response.ok) {
    throw new RepositoryPreflightError(
      `GitHub API ${repository}/${path} returned ${response.status}`,
    );
  }
  return response.json();
}

async function collectEnvironments(request, repository, response) {
  const environments = {};
  const records = Array.isArray(response.environments) ? response.environments : [];
  for (const record of records.sort((left, right) => left.name.localeCompare(right.name))) {
    const secrets = await request({
      repository,
      path: `environments/${encodeURIComponent(record.name)}/secrets`,
    });
    const branches = await request({
      repository,
      path: `environments/${encodeURIComponent(record.name)}/deployment-branch-policies`,
    });
    environments[record.name] = {
      secrets: Array.isArray(secrets.secrets)
        ? secrets.secrets.map((secret) => secret.name).sort()
        : [],
      branches: Array.isArray(branches.branch_policies)
        ? branches.branch_policies.map((branch) => branch.name).sort()
        : [],
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
  request = defaultRequest,
  releaseRepository = RELEASE_REPOSITORY,
  sourceRepository = SOURCE_REPOSITORY,
} = {}) {
  if (typeof request !== "function") {
    throw new RepositoryPreflightError("request must be a function");
  }
  const immutableReleases = await request({
    repository: releaseRepository,
    path: "immutable-releases",
    apiVersion: "2026-03-10",
  });
  const pages = await request({ repository: releaseRepository, path: "pages" });
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
  );
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
  const sourceWorkflows = await request({
    repository: sourceRepository,
    path: "actions/workflows",
  });
  const sourceKeys = await request({ repository: sourceRepository, path: "keys" });

  return {
    release: {
      immutableReleases,
      pages,
      workflows: Array.isArray(releaseWorkflows.workflows)
        ? releaseWorkflows.workflows.map(({ path, state }) => ({ path, state }))
        : [],
      environments,
      deployKeys: Array.isArray(releaseKeys) ? releaseKeys : [],
      rulesets,
    },
    source: {
      workflows: Array.isArray(sourceWorkflows.workflows)
        ? sourceWorkflows.workflows.map(({ path, state }) => ({ path, state }))
        : [],
      deployKeys: Array.isArray(sourceKeys) ? sourceKeys : [],
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
