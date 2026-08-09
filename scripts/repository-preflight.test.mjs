import assert from "node:assert/strict";
import test from "node:test";

import {
  auditRepositoryState,
  collectRepositoryState,
  RepositoryPreflightError,
  requestGitHub,
} from "./repository-preflight.mjs";

const RELEASE_ENVIRONMENTS = {
  preview: {
    secrets: [
      "ZERGLANG_TAURI_SIGNING_PRIVATE_KEY",
      "ZERGLANG_TAURI_SIGNING_PRIVATE_KEY_PASSWORD",
    ],
    refs: ["branch:main"],
    reviewers: ["User:1042757"],
    prevent_self_review: false,
    wait_timer: null,
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
    refs: ["branch:main"],
    reviewers: ["User:1042757"],
    prevent_self_review: false,
    wait_timer: null,
  },
  "zerglang-apple-preview": {
    secrets: [], refs: ["branch:main"], reviewers: [],
    prevent_self_review: null, wait_timer: null,
  },
  "zerglang-feed": {
    secrets: ["ZERGLANG_FEED_DEPLOY_KEY"],
    refs: ["branch:main"],
    reviewers: [],
    prevent_self_review: null,
    wait_timer: null,
  },
  "zerglang-source-read": {
    secrets: ["ZERG_SOURCE_DEPLOY_KEY"],
    refs: ["branch:main"],
    reviewers: ["User:1042757"],
    prevent_self_review: false,
    wait_timer: null,
  },
  "zerglang-updater-stable": {
    secrets: [
      "ZERGLANG_STABLE_TAURI_SIGNING_PRIVATE_KEY",
      "ZERGLANG_STABLE_TAURI_SIGNING_PRIVATE_KEY_PASSWORD",
    ],
    refs: ["branch:main"],
    reviewers: ["User:1042757"],
    prevent_self_review: false,
    wait_timer: null,
  },
  "github-pages": {
    secrets: [], refs: ["branch:main"], reviewers: [],
    prevent_self_review: null, wait_timer: null,
  },
};

const SOURCE_ANCHOR_DEPENDENCIES = [
  ".github/workflows/zerglang-ide-release.yml",
  ".github/workflows/zerglang-release-policy-anchor.yml",
  "zerglang/ide/package-lock.json",
  "zerglang/ide/package.json",
  "zerglang/ide/scripts/release/anchoredSourcePolicy.mjs",
  "zerglang/ide/scripts/release/sourceWorkflowPolicy.mjs",
].map((path, index) => ({
  path,
  sha: index.toString(16).padStart(40, "0"),
  type: "file",
}));

const SHARED_SOURCE_BRANCH_RULESETS = [
  {
    name: "Development branch authority",
    refs: ["refs/heads/development"],
    bypass: ["User:1042757"],
    rules: ["creation", "update"],
  },
  {
    name: "Development branch history",
    refs: ["refs/heads/development"],
    bypass: [],
    rules: ["deletion", "non_fast_forward"],
  },
  {
    name: "Reviewed development changes",
    refs: ["refs/heads/development"],
    bypass: ["User:1042757"],
    rules: [
      "pull_request:rebase:1:last-push",
      "required_linear_history",
      "required_status_checks:Protected-base ZergLang release policy:15368:strict",
      "required_status_checks:Protected-base ZergChat release policy:15368:strict",
    ],
  },
];

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
          { path: "site/preview", mode: "040000", type: "tree" },
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
        {
          path: ".github/workflows/policy-anchor.yml",
          state: "active",
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
            "required_status_checks:Protected-base release policy:15368:strict",
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
        {
          name: "Release tag authority",
          refs: [
            "refs/tags/zerglang-ide-preview-v*",
            "refs/tags/zerglang-ide-v*",
          ],
          bypass: ["User:1042757"],
          rules: ["creation"],
        },
        {
          name: "Release tag immutability",
          refs: [
            "refs/tags/zerglang-ide-preview-v*",
            "refs/tags/zerglang-ide-v*",
          ],
          bypass: [],
          rules: ["deletion", "update"],
        },
      ],
    },
    source: {
      defaultBranch: "development",
      anchorDependencies: structuredClone(SOURCE_ANCHOR_DEPENDENCIES),
      defaultBranchProtection: {
        enforceAdmins: true,
        requireLastPushApproval: true,
        requireLinearHistory: true,
        strictStatusChecks: true,
        requiredStatusChecks: [
          "Protected-base ZergLang release policy:15368",
        ],
      },
      workflows: [
        {
          path: ".github/workflows/zerglang-ide-release.yml",
          state: workflowState,
        },
        {
          path: ".github/workflows/zergchat-native-release.yml",
          state: "active",
        },
        {
          path: ".github/workflows/zerglang-release-policy-anchor.yml",
          state: "active",
        },
      ],
      deployKeys: [
        {
          title: "ZergLang releases source checkout 2026-08-08",
          verified: true,
          read_only: true,
        },
      ],
      environments: {
        "zerglang-release-request": {
          secrets: [],
          refs: [
            "tag:zerglang-ide-preview-v*",
            "tag:zerglang-ide-v*",
          ],
          reviewers: [],
          prevent_self_review: null,
          wait_timer: null,
        },
      },
      repositorySecrets: [],
      rulesets: [
        ...structuredClone(SHARED_SOURCE_BRANCH_RULESETS),
        {
          name: "Desktop release tag authority",
          refs: [
            "refs/tags/colony-desktop-preview-v*",
            "refs/tags/colony-desktop-v*",
            "refs/tags/zde-preview-v*",
            "refs/tags/zde-v*",
            "refs/tags/zergchat-preview-v*",
            "refs/tags/zergchat-v*",
            "refs/tags/zerglang-ide-preview-v*",
            "refs/tags/zerglang-ide-v*",
            "refs/tags/zterm-preview-v*",
            "refs/tags/zterm-v*",
          ],
          bypass: ["User:1042757"],
          rules: ["creation"],
        },
        {
          name: "Desktop release tag immutability",
          refs: [
            "refs/tags/colony-desktop-preview-v*",
            "refs/tags/colony-desktop-v*",
            "refs/tags/zde-preview-v*",
            "refs/tags/zde-v*",
            "refs/tags/zergchat-preview-v*",
            "refs/tags/zergchat-v*",
            "refs/tags/zerglang-ide-preview-v*",
            "refs/tags/zerglang-ide-v*",
            "refs/tags/zterm-preview-v*",
            "refs/tags/zterm-v*",
          ],
          bypass: [],
          rules: ["deletion", "update"],
        },
      ],
    },
  };
}

function errorCodes(state, phase = "cutover") {
  return auditRepositoryState(state, { phase }).errors.map(({ code }) => code);
}

test("accepts the exact disabled cutover topology and reports only human-review debt", () => {
  const result = auditRepositoryState(healthyState(), { phase: "cutover" });
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.warnings.map(({ code }) => code), [
    "human-review-limitation",
  ]);
});

test("accepts the shared product-neutral development ruleset topology", () => {
  const state = healthyState();
  state.source.rulesets = [
    ...structuredClone(SHARED_SOURCE_BRANCH_RULESETS),
    ...state.source.rulesets.slice(3),
  ];

  const result = auditRepositoryState(state, { phase: "cutover" });
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.warnings.map(({ code }) => code), [
    "human-review-limitation",
  ]);
});

test("requires exactly one matching verified read-only source checkout key", () => {
  const duplicate = healthyState();
  duplicate.source.deployKeys.push(
    structuredClone(duplicate.source.deployKeys[0]),
  );
  assert.deepEqual(errorCodes(duplicate), ["source-key"]);

  const unrelated = healthyState();
  unrelated.source.deployKeys.push({
    title: "Unrelated read-only integration",
    verified: true,
    read_only: true,
  });
  assert.deepEqual(errorCodes(unrelated), []);
});

test("rejects extra and duplicate release or source rulesets", () => {
  const outcomes = [];
  for (const owner of ["release", "source"]) {
    const extra = healthyState();
    extra[owner].rulesets.push({
      name: "Unreviewed policy",
      refs: ["~ALL"],
      bypass: ["User:1042757"],
      rules: ["update"],
    });
    outcomes.push({ owner, variant: "extra", codes: errorCodes(extra) });

    const duplicate = healthyState();
    duplicate[owner].rulesets.push(
      structuredClone(duplicate[owner].rulesets[0]),
    );
    outcomes.push({ owner, variant: "duplicate", codes: errorCodes(duplicate) });
  }
  assert.deepEqual(outcomes, [
    { owner: "release", variant: "extra", codes: ["ruleset-contract"] },
    { owner: "release", variant: "duplicate", codes: ["ruleset-contract"] },
    { owner: "source", variant: "extra", codes: ["source-ruleset-contract"] },
    { owner: "source", variant: "duplicate", codes: ["source-ruleset-contract"] },
  ]);
});

test("requires protected-base anchors instead of head-controlled checks", () => {
  const state = healthyState();
  state.release.workflows = state.release.workflows.filter(
    ({ path }) => path !== ".github/workflows/policy-anchor.yml",
  );
  state.source.workflows = state.source.workflows.filter(
    ({ path }) => path !==
      ".github/workflows/zerglang-release-policy-anchor.yml",
  );
  const releaseReview = state.release.rulesets.find(
    ({ name }) => name === "Reviewed release requests",
  );
  releaseReview.rules = releaseReview.rules.map((rule) =>
    rule.replace("Protected-base release policy", "Release policy")
  );
  const sourceReview = state.source.rulesets.find(
    ({ name }) => name === "Reviewed development changes",
  );
  sourceReview.rules = sourceReview.rules.map((rule) =>
    rule.replace(
      "Protected-base ZergLang release policy",
      "ZergLang release policy",
    )
  );

  assert.deepEqual(errorCodes(state), [
    "ruleset-contract",
    "source-ruleset-contract",
    "workflow-state",
    "workflow-state",
  ]);
});

test("binds the source anchor bytes and protections to default development", () => {
  const wrongDefault = healthyState();
  wrongDefault.source.defaultBranch = "zerglang";
  assert.deepEqual(errorCodes(wrongDefault), ["source-default-branch-contract"]);

  for (const mutate of [
    (dependencies) => { dependencies.pop(); },
    (dependencies) => { dependencies[0].path = ".github/workflows/other.yml"; },
    (dependencies) => { dependencies[0].sha = "moving"; },
    (dependencies) => { dependencies[0].type = "dir"; },
    (dependencies) => { dependencies.push(structuredClone(dependencies[0])); },
  ]) {
    const state = healthyState();
    mutate(state.source.anchorDependencies);
    assert.deepEqual(errorCodes(state), ["source-anchor-dependencies"]);
  }

  for (const mutate of [
    (protection) => { protection.enforceAdmins = false; },
    (protection) => { protection.requireLastPushApproval = false; },
    (protection) => { protection.requireLinearHistory = false; },
    (protection) => { protection.strictStatusChecks = false; },
    (protection) => { protection.requiredStatusChecks = ["ZergLang release policy:15368"]; },
  ]) {
    const state = healthyState();
    mutate(state.source.defaultBranchProtection);
    assert.deepEqual(
      errorCodes(state),
      ["source-default-branch-protection"],
    );
  }

  const reviewed = healthyState().source.rulesets.find(
    ({ name }) => name === "Reviewed development changes",
  );
  assert.deepEqual(reviewed, {
    name: "Reviewed development changes",
    refs: ["refs/heads/development"],
    bypass: ["User:1042757"],
    rules: [
      "pull_request:rebase:1:last-push",
      "required_linear_history",
      "required_status_checks:Protected-base ZergLang release policy:15368:strict",
      "required_status_checks:Protected-base ZergChat release policy:15368:strict",
    ],
  });
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

test("requires the paired ZergChat request workflow during ZergLang cutover", () => {
  const accepted = healthyState();
  const acceptedStates = Object.fromEntries(
    accepted.source.workflows.map(({ path, state }) => [path, state]),
  );
  assert.equal(
    acceptedStates[".github/workflows/zerglang-ide-release.yml"],
    "disabled_manually",
  );
  assert.equal(
    acceptedStates[".github/workflows/zergchat-native-release.yml"],
    "active",
  );
  assert.deepEqual(errorCodes(accepted), []);

  for (const mutate of [
    (workflows) => {
      workflows.find(
        ({ path }) => path === ".github/workflows/zergchat-native-release.yml",
      ).state = "disabled_manually";
    },
    (workflows) => {
      const paired = workflows.find(
        ({ path }) => path === ".github/workflows/zergchat-native-release.yml",
      );
      paired.path = ".github/workflows/unknown-release.yml";
    },
    (workflows) => {
      const index = workflows.findIndex(
        ({ path }) => path === ".github/workflows/zergchat-native-release.yml",
      );
      workflows.splice(index, 1);
    },
  ]) {
    const state = healthyState();
    mutate(state.source.workflows);
    assert.deepEqual(errorCodes(state), ["workflow-state"]);
  }
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
    ({ name }) => name !== "Reviewed development changes",
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

test("keeps source request handoff free of write credentials", () => {
  const state = healthyState();
  state.source.environments["zerglang-release-request"].secrets.push(
    "ZERGLANG_RELEASES_DEPLOY_KEY",
  );
  state.source.repositorySecrets.push("ZERGLANG_RELEASES_DEPLOY_KEY");

  assert.deepEqual(
    auditRepositoryState(state, { phase: "cutover" }).errors,
    [
      {
        code: "source-environment-contract",
        message: "zerglang-release-request must be secret-free and tag-scoped",
      },
      {
        code: "source-repository-secret",
        message: "source request write credentials must be absent",
      },
    ],
  );

  const wrongRefs = healthyState();
  wrongRefs.source.environments["zerglang-release-request"].refs = [
    "branch:zerglang",
  ];
  assert.deepEqual(errorCodes(wrongRefs), ["source-environment-contract"]);
});

test("requires every canonical Pages property independently", () => {
  const mutations = [
    (pages) => { pages.https_enforced = false; },
    (pages) => { pages.build_type = "legacy"; },
    (pages) => { pages.html_url = "https://example.invalid/"; },
    (pages) => { pages.public = false; },
  ];
  for (const mutate of mutations) {
    const state = healthyState();
    mutate(state.release.pages);
    assert.deepEqual(errorCodes(state), ["pages-contract"]);
  }
});

test("fails malformed phases and repository state through the public error type", () => {
  assert.throws(
    () => auditRepositoryState(healthyState(), { phase: "preview" }),
    (error) =>
      error instanceof RepositoryPreflightError &&
      error.name === "RepositoryPreflightError" &&
      error.message === "phase must be cutover or live",
  );
  for (const state of [null, [], { release: null, source: {} }]) {
    assert.throws(
      () => auditRepositoryState(state, { phase: "cutover" }),
      RepositoryPreflightError,
    );
  }
});

test("enforces every environment, workflow, key, and ruleset identity", () => {
  for (const name of Object.keys(RELEASE_ENVIRONMENTS)) {
    const state = healthyState();
    state.release.environments[name].refs = [];
    assert.deepEqual(errorCodes(state), ["environment-contract"]);
  }
  const missingEnvironment = healthyState();
  delete missingEnvironment.release.environments.preview;
  assert.deepEqual(errorCodes(missingEnvironment), ["environment-contract"]);
  const secretEnvironment = healthyState();
  secretEnvironment.release.environments.preview.secrets.push("EXTRA");
  assert.deepEqual(errorCodes(secretEnvironment), ["environment-contract"]);

  const missingReleaseWorkflow = healthyState();
  missingReleaseWorkflow.release.workflows = [];
  assert.deepEqual(errorCodes(missingReleaseWorkflow), ["workflow-state"]);
  const unrelatedWorkflow = healthyState();
  unrelatedWorkflow.release.workflows.unshift({
    path: ".github/workflows/unrelated.yml",
    state: "active",
  });
  assert.equal(errorCodes(unrelatedWorkflow).includes("workflow-state"), false);

  const wrongFeedKey = healthyState();
  wrongFeedKey.release.deployKeys[0].verified = false;
  assert.deepEqual(errorCodes(wrongFeedKey), ["deploy-key"]);
  const wrongFeedTitle = healthyState();
  wrongFeedTitle.release.deployKeys[0].title = "unrelated writer";
  assert.deepEqual(errorCodes(wrongFeedTitle), ["deploy-key"]);
  const readOnlyExtra = healthyState();
  readOnlyExtra.release.deployKeys.push({
    title: "read-only observer",
    verified: true,
    read_only: true,
  });
  assert.equal(errorCodes(readOnlyExtra).includes("deploy-key"), false);

  const wrongSourceKey = healthyState();
  wrongSourceKey.source.deployKeys[0].title = "unrelated key";
  assert.deepEqual(errorCodes(wrongSourceKey), ["source-key"]);
  const unverifiedSourceKey = healthyState();
  unverifiedSourceKey.source.deployKeys[0].verified = false;
  assert.deepEqual(errorCodes(unverifiedSourceKey), ["source-key"]);

  for (const owner of ["release", "source"]) {
    for (const index of healthyState()[owner].rulesets.keys()) {
      for (const field of ["refs", "bypass", "rules"]) {
        const state = healthyState();
        state[owner].rulesets[index][field] =
          state[owner].rulesets[index][field].length === 0 ? ["unexpected"] : [];
        assert.deepEqual(
          errorCodes(state),
          [owner === "release" ? "ruleset-contract" : "source-ruleset-contract"],
        );
      }
    }
  }
});

test("requires exact environment reviewers, self-review, and wait timers", () => {
  for (const mutate of [
    (environment) => { environment.reviewers = []; },
    (environment) => { environment.reviewers = ["Team:42"]; },
    (environment) => { environment.prevent_self_review = true; },
    (environment) => { environment.wait_timer = 5; },
  ]) {
    const state = healthyState();
    mutate(state.release.environments.preview);
    assert.deepEqual(errorCodes(state), ["environment-contract"]);
  }

  const unexpectedReviewer = healthyState();
  unexpectedReviewer.release.environments["zerglang-feed"].reviewers = [
    "User:1042757",
  ];
  assert.deepEqual(errorCodes(unexpectedReviewer), ["environment-contract"]);

  const sourceReviewer = healthyState();
  sourceReviewer.source.environments["zerglang-release-request"].reviewers = [
    "User:1042757",
  ];
  assert.deepEqual(errorCodes(sourceReviewer), ["source-environment-contract"]);
});

test("requires exact source and release tag authority and immutability rules", () => {
  for (const [owner, name, expectedCode] of [
    ["release", "Release tag authority", "ruleset-contract"],
    ["release", "Release tag immutability", "ruleset-contract"],
    ["source", "Desktop release tag authority", "source-ruleset-contract"],
    ["source", "Desktop release tag immutability", "source-ruleset-contract"],
  ]) {
    const missing = healthyState();
    missing[owner].rulesets = missing[owner].rulesets.filter(
      (ruleset) => ruleset.name !== name,
    );
    assert.deepEqual(errorCodes(missing), [expectedCode], name);

    const extraPattern = healthyState();
    extraPattern[owner].rulesets.find(
      (ruleset) => ruleset.name === name,
    ).refs.push("refs/tags/*");
    assert.deepEqual(errorCodes(extraPattern), [expectedCode], name);
  }
});

test("accepts the intentionally shared ZergChat desktop tag patterns", () => {
  const state = healthyState();
  for (const name of [
    "Desktop release tag authority",
    "Desktop release tag immutability",
  ]) {
    const ruleset = state.source.rulesets.find(
      (ruleset) => ruleset.name === name,
    );
    ruleset.refs = [...new Set([
      ...ruleset.refs,
      "refs/tags/zergchat-preview-v*",
      "refs/tags/zergchat-v*",
    ])];
  }

  const result = auditRepositoryState(state, { phase: "cutover" });
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.warnings.map(({ code }) => code), [
    "human-review-limitation",
  ]);
});

test("enforces every bounded release-data branch invariant", () => {
  const mutations = [
    (branch) => { branch.name = "main"; },
    (branch) => { branch.sha = `x${"a".repeat(40)}`; },
    (branch) => { branch.tree_sha = `${"b".repeat(40)}x`; },
    (branch) => { branch.truncated = true; },
    (branch) => { branch.entries = []; },
    (branch) => { branch.entries.push(structuredClone(branch.entries[0])); },
    (branch) => { branch.entries[1] = null; },
    (branch) => { branch.entries[1] = []; },
    (branch) => { branch.entries[0].mode = "100644"; },
    (branch) => { branch.entries[0].type = "blob"; },
    (branch) => { branch.entries[1].path = "outside/policy.mjs"; },
    (branch) => { branch.entries[1].path = ""; },
    (branch) => { branch.entries[1].path = 7; },
    (branch) => { branch.entries[1].mode = "100755"; },
    (branch) => { branch.entries[1].type = "commit"; },
    (branch) => { branch.entries[1].path = `site/${"x".repeat(508)}`; },
    (branch) => { branch.entries[3].mode = "100644"; },
    (branch) => { branch.entries[3].type = "blob"; },
    (branch) => {
      branch.entries = branch.entries.filter(
        ({ path }) => path !== "site/index.html",
      );
    },
  ];
  for (const mutate of mutations) {
    const state = healthyState();
    mutate(state.release.feedBranch);
    assert.deepEqual(errorCodes(state), ["feed-branch-contract"]);
  }

  const exactMinimum = healthyState();
  exactMinimum.release.feedBranch.entries = [
    { path: "site", mode: "040000", type: "tree" },
    { path: "site/.nojekyll", mode: "100644", type: "blob" },
    { path: "site/index.html", mode: "100644", type: "blob" },
  ];
  assert.equal(errorCodes(exactMinimum).includes("feed-branch-contract"), false);

  const exactLimit = healthyState();
  while (exactLimit.release.feedBranch.entries.length < 4_096) {
    const index = exactLimit.release.feedBranch.entries.length;
    exactLimit.release.feedBranch.entries.push({
      path: `site/generated/${index}.json`,
      mode: "100644",
      type: "blob",
    });
  }
  assert.equal(errorCodes(exactLimit).includes("feed-branch-contract"), false);
  exactLimit.release.feedBranch.entries.push({
    path: "site/generated/overflow.json",
    mode: "100644",
    type: "blob",
  });
  assert.deepEqual(errorCodes(exactLimit), ["feed-branch-contract"]);
});

test("uses one authenticated read-only GitHub request boundary", async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    return {
      ok: true,
      status: 200,
      json: async () => ({ enabled: true }),
    };
  };
  const result = await requestGitHub(
    {
      repository: "Epoch-ML/zerglang-releases",
      path: "immutable-releases",
      apiVersion: "2026-03-10",
    },
    { token: "test-token", fetchImpl },
  );
  assert.deepEqual(result, { enabled: true });
  assert.deepEqual(calls, [
    {
      url: "https://api.github.com/repos/Epoch-ML/zerglang-releases/immutable-releases",
      options: {
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: "Bearer test-token",
          "X-GitHub-Api-Version": "2026-03-10",
        },
      },
    },
  ]);
});

test("requests repository metadata without an empty-path trailing slash", async () => {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    return {
      ok: true,
      status: 200,
      json: async () => ({ default_branch: "main" }),
    };
  };

  const result = await requestGitHub(
    { repository: "Epoch-ML/zerg", path: "" },
    { token: "test-token", fetchImpl },
  );

  assert.deepEqual(result, { default_branch: "main" });
  assert.deepEqual(calls, ["https://api.github.com/repos/Epoch-ML/zerg"]);
});

test("handles only an explicitly allowed missing GitHub resource", async () => {
  const fetchImpl = async () => ({
    ok: false,
    status: 404,
    json: async () => ({ message: "Not Found" }),
  });
  assert.equal(
    await requestGitHub(
      {
        repository: "Epoch-ML/zerglang-releases",
        path: "branches/release-data",
        allowNotFound: true,
      },
      { token: "test-token", fetchImpl },
    ),
    null,
  );
  await assert.rejects(
    requestGitHub(
      { repository: "Epoch-ML/zerglang-releases", path: "rulesets" },
      { token: "test-token", fetchImpl },
    ),
    /GitHub API Epoch-ML\/zerglang-releases\/rulesets returned 404/,
  );
  await assert.rejects(
    requestGitHub(
      { repository: "Epoch-ML/zerglang-releases", path: "rulesets" },
      { token: "", fetchImpl },
    ),
    /GH_TOKEN is required for repository preflight/,
  );
  await assert.rejects(
    requestGitHub(
      { repository: "Epoch-ML/zerglang-releases", path: "rulesets" },
      { token: "test-token", fetchImpl: null },
    ),
    /fetchImpl must be a function/,
  );

  const serverFailure = async () => ({
    ok: false,
    status: 500,
    json: async () => ({ message: "failure" }),
  });
  await assert.rejects(
    requestGitHub(
      {
        repository: "Epoch-ML/zerglang-releases",
        path: "branches/release-data",
        allowNotFound: true,
      },
      { token: "test-token", fetchImpl: serverFailure },
    ),
    /returned 500/,
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
    [
      "Epoch-ML/zerglang-releases:environments",
      {
        environments: [{
          name: "zerglang-feed",
          protection_rules: [
            { type: "branch_policy" },
            {
              type: "required_reviewers",
              prevent_self_review: false,
              reviewers: [
                { type: "User", reviewer: { id: 1042757 } },
                { type: "Team", reviewer: { id: 42 } },
              ],
            },
            { type: "wait_timer", wait_timer: 15 },
          ],
        }],
      },
    ],
    [
      "Epoch-ML/zerglang-releases:environments/zerglang-feed/secrets",
      { secrets: [{ name: "Z_SECRET" }, { name: "A_SECRET" }] },
    ],
    [
      "Epoch-ML/zerglang-releases:environments/zerglang-feed/deployment-branch-policies",
      { branch_policies: [{ name: "main", type: "branch" }] },
    ],
    [
      "Epoch-ML/zerglang-releases:actions/secrets",
      { secrets: [{ name: "Z_REPOSITORY" }, { name: "A_REPOSITORY" }] },
    ],
    [
      "Epoch-ML/zerglang-releases:keys",
      [{ title: "feed key", verified: true, read_only: false }],
    ],
    ["Epoch-ML/zerglang-releases:rulesets", [{ id: 2 }, { id: 1 }]],
    [
      "Epoch-ML/zerglang-releases:rulesets/1",
      {
        name: "Reviewed release requests",
        enforcement: "active",
        conditions: { ref_name: { include: ["refs/heads/main"] } },
        bypass_actors: [
          { actor_type: "User", actor_id: 1042757 },
          { actor_type: "DeployKey", actor_id: null },
        ],
        rules: [
          {
            type: "pull_request",
            parameters: {
              allowed_merge_methods: ["rebase"],
              required_approving_review_count: 1,
              require_last_push_approval: true,
            },
          },
          {
            type: "required_status_checks",
            parameters: {
              strict_required_status_checks_policy: true,
              required_status_checks: [
                { context: "Release policy", integration_id: 15368 },
              ],
            },
          },
          { type: "required_linear_history" },
        ],
      },
    ],
    [
      "Epoch-ML/zerglang-releases:rulesets/2",
      {
        name: "Inactive rule",
        enforcement: "evaluate",
        conditions: { ref_name: { include: ["~ALL"] } },
        bypass_actors: [],
        rules: [{ type: "deletion" }],
      },
    ],
    [
      "Epoch-ML/zerg:",
      { default_branch: "development" },
    ],
    ...SOURCE_ANCHOR_DEPENDENCIES.map((dependency) => [
      `Epoch-ML/zerg:contents/${dependency.path}?ref=development`,
      dependency,
    ]),
    [
      "Epoch-ML/zerg:branches/development/protection",
      {
        enforce_admins: { enabled: true },
        required_linear_history: { enabled: true },
        required_pull_request_reviews: {
          require_last_push_approval: true,
        },
        required_status_checks: {
          strict: true,
          checks: [{
            context: "Protected-base ZergLang release policy",
            app_id: 15368,
          }],
        },
      },
    ],
    [
      "Epoch-ML/zerg:actions/workflows",
      { workflows: [{ path: ".github/workflows/zerglang-ide-release.yml", state: "disabled_manually" }] },
    ],
    [
      "Epoch-ML/zerg:environments",
      { environments: [{ name: "zerglang-release-request" }] },
    ],
    [
      "Epoch-ML/zerg:environments/zerglang-release-request/secrets",
      { secrets: [] },
    ],
    [
      "Epoch-ML/zerg:environments/zerglang-release-request/deployment-branch-policies",
      {
        branch_policies: [
          { name: "zerglang-ide-preview-v*", type: "tag" },
          { name: "zerglang-ide-v*", type: "tag" },
        ],
      },
    ],
    ["Epoch-ML/zerg:actions/secrets", { secrets: [] }],
    ["Epoch-ML/zerg:keys", []],
    ["Epoch-ML/zerg:rulesets", [{ id: 3 }]],
    [
      "Epoch-ML/zerg:rulesets/3",
      {
        name: "Development branch history",
        enforcement: "active",
        conditions: { ref_name: { include: ["refs/heads/development"] } },
        bypass_actors: [],
        rules: [{ type: "deletion" }, { type: "non_fast_forward" }],
      },
    ],
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
      environments: {
        "zerglang-feed": {
          secrets: ["A_SECRET", "Z_SECRET"],
          refs: ["branch:main"],
          reviewers: ["Team:42", "User:1042757"],
          prevent_self_review: false,
          wait_timer: 15,
        },
      },
      repositorySecrets: ["A_REPOSITORY", "Z_REPOSITORY"],
      deployKeys: [{ title: "feed key", verified: true, read_only: false }],
      rulesets: [
        {
          name: "Reviewed release requests",
          refs: ["refs/heads/main"],
          bypass: ["DeployKey:any", "User:1042757"],
          rules: [
            "pull_request:rebase:1:last-push",
            "required_linear_history",
            "required_status_checks:Release policy:15368:strict",
          ],
        },
      ],
    },
    source: {
      defaultBranch: "development",
      anchorDependencies: SOURCE_ANCHOR_DEPENDENCIES,
      defaultBranchProtection: {
        enforceAdmins: true,
        requireLastPushApproval: true,
        requireLinearHistory: true,
        strictStatusChecks: true,
        requiredStatusChecks: [
          "Protected-base ZergLang release policy:15368",
        ],
      },
      workflows: [
        {
          path: ".github/workflows/zerglang-ide-release.yml",
          state: "disabled_manually",
        },
      ],
      environments: {
        "zerglang-release-request": {
          secrets: [],
          refs: [
            "tag:zerglang-ide-preview-v*",
            "tag:zerglang-ide-v*",
          ],
          reviewers: [],
          prevent_self_review: null,
          wait_timer: null,
        },
      },
      repositorySecrets: [],
      deployKeys: [],
      rulesets: [
        {
          name: "Development branch history",
          refs: ["refs/heads/development"],
          bypass: [],
          rules: ["deletion", "non_fast_forward"],
        },
      ],
    },
  });
  assert.deepEqual(calls, [...responses.keys()]);
});

test("rejects a non-callable collector boundary before any repository access", async () => {
  await assert.rejects(
    collectRepositoryState({ request: null }),
    (error) =>
      error instanceof RepositoryPreflightError &&
      error.message === "request must be a function",
  );
});
