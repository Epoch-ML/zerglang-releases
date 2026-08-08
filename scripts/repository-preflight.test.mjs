import assert from "node:assert/strict";
import test from "node:test";

import {
  auditRepositoryState,
  collectRepositoryState,
} from "./repository-preflight.mjs";

const RELEASE_ENVIRONMENTS = {
  preview: {
    secrets: [
      "ZERGLANG_TAURI_SIGNING_PRIVATE_KEY",
      "ZERGLANG_TAURI_SIGNING_PRIVATE_KEY_PASSWORD",
    ],
    branches: ["main"],
  },
  stable: {
    secrets: [
      "ZERGLANG_APPLE_API_ISSUER",
      "ZERGLANG_APPLE_API_KEY_ID",
      "ZERGLANG_APPLE_API_PRIVATE_KEY",
      "ZERGLANG_APPLE_CERTIFICATE",
      "ZERGLANG_APPLE_CERTIFICATE_PASSWORD",
      "ZERGLANG_APPLE_SIGNING_IDENTITY",
    ],
    branches: ["main"],
  },
  "zerglang-apple-preview": { secrets: [], branches: ["main"] },
  "zerglang-feed": {
    secrets: ["ZERGLANG_FEED_DEPLOY_KEY"],
    branches: ["main"],
  },
  "zerglang-source-read": {
    secrets: ["ZERG_SOURCE_DEPLOY_KEY"],
    branches: ["main"],
  },
  "zerglang-updater-stable": {
    secrets: [
      "ZERGLANG_STABLE_TAURI_SIGNING_PRIVATE_KEY",
      "ZERGLANG_STABLE_TAURI_SIGNING_PRIVATE_KEY_PASSWORD",
    ],
    branches: ["main"],
  },
  "github-pages": { secrets: [], branches: ["main"] },
};

function healthyState(workflowState = "disabled_manually") {
  return {
    release: {
      immutableReleases: { enabled: true },
      pages: {
        https_enforced: true,
        build_type: "workflow",
        html_url: "https://epoch-ml.github.io/zerglang-releases/",
        public: true,
      },
      feedBranch: {
        name: "release-data",
        sha: "a".repeat(40),
        tree_sha: "b".repeat(40),
        truncated: false,
        entries: [
          { path: "site", mode: "040000", type: "tree" },
          { path: "site/.nojekyll", mode: "100644", type: "blob" },
          { path: "site/index.html", mode: "100644", type: "blob" },
          {
            path: "site/preview/latest.json",
            mode: "100644",
            type: "blob",
          },
        ],
      },
      workflows: [
        {
          path: ".github/workflows/release.yml",
          state: workflowState,
        },
      ],
      environments: structuredClone(RELEASE_ENVIRONMENTS),
      repositorySecrets: [],
      deployKeys: [
        {
          title: "ZergLang release feed writer 2026-08-08",
          verified: true,
          read_only: false,
        },
      ],
      rulesets: [
        {
          name: "Release branch authority",
          refs: ["refs/heads/main"],
          bypass: ["User:1042757"],
          rules: ["creation", "update"],
        },
        {
          name: "Release branch history",
          refs: ["refs/heads/main"],
          bypass: [],
          rules: ["deletion", "non_fast_forward"],
        },
        {
          name: "Reviewed release requests",
          refs: ["refs/heads/main"],
          bypass: ["User:1042757"],
          rules: [
            "pull_request:rebase:1:last-push",
            "required_linear_history",
            "required_status_checks:Release policy:15368:strict",
          ],
        },
        {
          name: "ZergLang feed authority",
          refs: ["refs/heads/release-data"],
          bypass: ["DeployKey:any"],
          rules: ["creation", "update"],
        },
        {
          name: "ZergLang feed history",
          refs: ["refs/heads/release-data"],
          bypass: [],
          rules: ["deletion", "non_fast_forward"],
        },
      ],
    },
    source: {
      workflows: [
        {
          path: ".github/workflows/zerglang-ide-release.yml",
          state: workflowState,
        },
      ],
      deployKeys: [
        {
          title: "ZergLang releases source checkout 2026-08-08",
          verified: true,
          read_only: true,
        },
      ],
      rulesets: [
        {
          name: "ZergLang branch authority",
          refs: ["refs/heads/zerglang"],
          bypass: ["User:1042757"],
          rules: ["creation", "update"],
        },
        {
          name: "ZergLang branch history",
          refs: ["refs/heads/zerglang"],
          bypass: [],
          rules: ["deletion", "non_fast_forward"],
        },
        {
          name: "Reviewed ZergLang changes",
          refs: ["refs/heads/zerglang"],
          bypass: ["User:1042757"],
          rules: [
            "pull_request:rebase:1:last-push",
            "required_linear_history",
            "required_status_checks:ZergLang release policy:15368:strict",
          ],
        },
      ],
    },
  };
}

test("accepts the exact disabled cutover topology and reports only human-review debt", () => {
  const result = auditRepositoryState(healthyState(), { phase: "cutover" });
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.warnings.map(({ code }) => code), [
    "human-review-limitation",
  ]);
});

test("requires active workflows only in live mode", () => {
  assert.deepEqual(
    auditRepositoryState(healthyState("active"), { phase: "live" }).errors,
    [],
  );
  assert.deepEqual(
    auditRepositoryState(healthyState("active"), { phase: "cutover" }).errors.map(
      ({ code }) => code,
    ),
    ["workflow-state", "workflow-state"],
  );
});

test("fails closed on mutable releases, unsafe Pages, credentials, or missing rules", () => {
  const state = healthyState();
  state.release.immutableReleases.enabled = false;
  state.release.pages.https_enforced = false;
  state.release.environments.preview.secrets.push("UNEXPECTED_SECRET");
  state.release.deployKeys.push({
    title: "second writer",
    verified: true,
    read_only: false,
  });
  state.source.deployKeys[0].read_only = false;
  state.release.repositorySecrets.push("UNSCOPED_RELEASE_KEY");
  state.release.rulesets = state.release.rulesets.filter(
    ({ name }) => name !== "ZergLang feed history",
  );
  state.source.rulesets = state.source.rulesets.filter(
    ({ name }) => name !== "Reviewed ZergLang changes",
  );

  assert.deepEqual(
    auditRepositoryState(state, { phase: "cutover" }).errors.map(
      ({ code }) => code,
    ),
    [
      "deploy-key",
      "environment-contract",
      "immutable-releases",
      "pages-contract",
      "repository-secret",
      "ruleset-contract",
      "source-key",
      "source-ruleset-contract",
    ],
  );
});

test("requires the canonical public Pages origin and a data-only feed branch", () => {
  const state = healthyState();
  state.release.pages.html_url = "https://example.invalid/zerglang-releases/";
  state.release.feedBranch.entries.push({
    path: "scripts/pulled-policy.mjs",
    mode: "100755",
    type: "blob",
  });

  assert.deepEqual(
    auditRepositoryState(state, { phase: "cutover" }).errors,
    [
      {
        code: "feed-branch-contract",
        message: "release-data must contain only a bounded site tree",
      },
      {
        code: "pages-contract",
        message: "Pages must publish the canonical public HTTPS origin",
      },
    ],
  );

  state.release.pages = {
    https_enforced: true,
    build_type: "workflow",
    html_url: "https://epoch-ml.github.io/zerglang-releases/",
    public: true,
  };
  state.release.feedBranch = null;
  assert.deepEqual(
    auditRepositoryState(state, { phase: "cutover" }).errors.map(
      ({ code }) => code,
    ),
    ["feed-branch-contract"],
  );
});

test("collects settings through one injected read-only HTTP boundary", async () => {
  const calls = [];
  const responses = new Map([
    ["Epoch-ML/zerglang-releases:immutable-releases", { enabled: true }],
    [
      "Epoch-ML/zerglang-releases:pages",
      {
        https_enforced: true,
        build_type: "workflow",
        html_url: "https://epoch-ml.github.io/zerglang-releases/",
        public: true,
      },
    ],
    [
      "Epoch-ML/zerglang-releases:branches/release-data",
      {
        name: "release-data",
        commit: {
          sha: "a".repeat(40),
          commit: { tree: { sha: "b".repeat(40) } },
        },
      },
    ],
    [
      `Epoch-ML/zerglang-releases:git/trees/${"b".repeat(40)}?recursive=1`,
      {
        truncated: false,
        tree: [
          { path: "site", mode: "040000", type: "tree" },
          { path: "site/.nojekyll", mode: "100644", type: "blob" },
          { path: "site/index.html", mode: "100644", type: "blob" },
        ],
      },
    ],
    [
      "Epoch-ML/zerglang-releases:actions/workflows",
      { workflows: [{ path: ".github/workflows/release.yml", state: "disabled_manually" }] },
    ],
    ["Epoch-ML/zerglang-releases:environments", { environments: [] }],
    ["Epoch-ML/zerglang-releases:actions/secrets", { secrets: [] }],
    ["Epoch-ML/zerglang-releases:keys", []],
    ["Epoch-ML/zerglang-releases:rulesets", []],
    [
      "Epoch-ML/zerg:actions/workflows",
      { workflows: [{ path: ".github/workflows/zerglang-ide-release.yml", state: "disabled_manually" }] },
    ],
    ["Epoch-ML/zerg:keys", []],
    ["Epoch-ML/zerg:rulesets", []],
  ]);
  const request = async ({ repository, path }) => {
    calls.push(`${repository}:${path}`);
    return structuredClone(responses.get(`${repository}:${path}`));
  };

  const state = await collectRepositoryState({ request });
  assert.deepEqual(state, {
    release: {
      immutableReleases: { enabled: true },
      pages: {
        https_enforced: true,
        build_type: "workflow",
        html_url: "https://epoch-ml.github.io/zerglang-releases/",
        public: true,
      },
      feedBranch: {
        name: "release-data",
        sha: "a".repeat(40),
        tree_sha: "b".repeat(40),
        truncated: false,
        entries: [
          { path: "site", mode: "040000", type: "tree" },
          { path: "site/.nojekyll", mode: "100644", type: "blob" },
          { path: "site/index.html", mode: "100644", type: "blob" },
        ],
      },
      workflows: [
        {
          path: ".github/workflows/release.yml",
          state: "disabled_manually",
        },
      ],
      environments: {},
      repositorySecrets: [],
      deployKeys: [],
      rulesets: [],
    },
    source: {
      workflows: [
        {
          path: ".github/workflows/zerglang-ide-release.yml",
          state: "disabled_manually",
        },
      ],
      deployKeys: [],
      rulesets: [],
    },
  });
  assert.deepEqual(calls, [...responses.keys()]);
});
