import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import test from "node:test";

import { parse, stringify } from "yaml";

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
const policyCli = fileURLToPath(new URL("./workflow-policy.mjs", import.meta.url));
const releaseWorkflowPath = fileURLToPath(
  new URL("../.github/workflows/release.yml", import.meta.url),
);
const policyWorkflowPath = fileURLToPath(
  new URL("../.github/workflows/policy.yml", import.meta.url),
);

function workflowVariant(source, mutate) {
  const workflow = parse(source);
  mutate(workflow);
  return stringify(workflow);
}

function releaseVariant(mutate) {
  return workflowVariant(releaseWorkflow, mutate);
}

function policyVariant(mutate) {
  return workflowVariant(policyWorkflow, mutate);
}

function cutoverReleaseVariant(mutate = () => {}) {
  return releaseVariant(mutate);
}

function findStep(workflow, jobName, stepName) {
  const step = workflow.jobs[jobName].steps.find(
    (candidate) => candidate.name === stepName,
  );
  assert.ok(step, `fixture step ${jobName}/${stepName} must exist`);
  return step;
}

function replaceEveryJobToken(job, token) {
  return JSON.parse(
    JSON.stringify(job).replaceAll(token, "removed-public-policy-operation"),
  );
}

function diagnosticIdentities(source) {
  return auditWorkflowPolicy(source).map(
    ({ code, job, step }) => `${code}:${job}:${step ?? "job"}`,
  );
}

function canonicalDiagnosticIdentities(source) {
  return auditWorkflowPolicy(source, releaseWorkflow).map(
    ({ code, job, step }) => `${code}:${job}:${step ?? "job"}`,
  );
}

function policyDiagnosticIdentities(source) {
  return auditPolicyWorkflow(source).map(
    ({ code, job, step }) => `${code}:${job}:${step ?? "job"}`,
  );
}

test("rejects empty, malformed, and non-mapping workflow inputs", () => {
  for (const [source, message] of [
    ["", "workflow source must be non-empty text"],
    [" \n\t", "workflow source must be non-empty text"],
    ["jobs: [", "workflow source must be valid YAML"],
    ["- job", "workflow root must be a mapping"],
    ["null", "workflow root must be a mapping"],
    ["42", "workflow root must be a mapping"],
    ["workflow", "workflow root must be a mapping"],
  ]) {
    assert.throws(
      () => auditWorkflowPolicy(source),
      (error) =>
        error instanceof WorkflowPolicyError &&
        error.name === "WorkflowPolicyError" &&
        error.message === message,
    );
  }

  for (const source of [null, false, 42, [], {}]) {
    assert.throws(
      () => auditWorkflowPolicy(source),
      (error) =>
        error instanceof WorkflowPolicyError &&
        error.message === "workflow source must be non-empty text",
    );
  }
});

test("rejects YAML aliases and duplicate keys at the parser boundary", () => {
  assert.throws(
    () => auditWorkflowPolicy("shared: &shared { runs-on: ubuntu }\njobs: { one: *shared }\n"),
    /Alias resolution is disabled/,
  );
  assert.throws(
    () => auditWorkflowPolicy("jobs: {}\njobs: {}\n"),
    (error) =>
      error instanceof WorkflowPolicyError &&
      error.message === "workflow source must be valid YAML",
  );
});

test("fails closed when release workflow containers have invalid YAML types", () => {
  for (const [source, message] of [
    ["on: null\njobs: {}\n", "workflow triggers must be a mapping"],
    ["on: workflow_dispatch\njobs: {}\n", "workflow triggers must be a mapping"],
    ["on: []\njobs: {}\n", "workflow triggers must be a mapping"],
    ["on: {}\njobs: null\n", "workflow jobs must be a mapping"],
    ["on: {}\njobs: invalid\n", "workflow jobs must be a mapping"],
    ["on: {}\njobs: []\n", "workflow jobs must be a mapping"],
    [
      releaseVariant((workflow) => {
        workflow.jobs.validate = [];
      }),
      "validate job must be a mapping",
    ],
    [
      releaseVariant((workflow) => {
        workflow.jobs.validate = null;
      }),
      "validate job must be a mapping",
    ],
    [
      releaseVariant((workflow) => {
        workflow.jobs.validate = "invalid";
      }),
      "validate job must be a mapping",
    ],
    [
      releaseVariant((workflow) => {
        workflow.jobs.validate.needs = 7;
      }),
      "job needs must be a string or string array",
    ],
    [
      releaseVariant((workflow) => {
        workflow.jobs.validate.needs = ["build", 7];
      }),
      "job needs must be a string or string array",
    ],
    [
      releaseVariant((workflow) => {
        workflow.jobs.sign_updater.steps = {};
      }),
      "sign_updater job steps must be an array",
    ],
    [
      releaseVariant((workflow) => {
        workflow.jobs.sign_updater.steps = [false];
      }),
      "sign_updater step 1 must be a mapping",
    ],
    [
      releaseVariant((workflow) => {
        workflow.jobs.sign_updater.steps = [null];
      }),
      "sign_updater step 1 must be a mapping",
    ],
    [
      releaseVariant((workflow) => {
        workflow.jobs.sign_updater.steps = ["invalid"];
      }),
      "sign_updater step 1 must be a mapping",
    ],
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

test("binds run programs and every workflow context to canonical base bytes", () => {
  assert.deepEqual(canonicalDiagnosticIdentities(releaseWorkflow), []);

  const addedProgram = releaseVariant((workflow) => {
    workflow.jobs.validate.steps.push({ name: "Injected", run: "echo injected" });
  });
  assert.deepEqual(canonicalDiagnosticIdentities(addedProgram), [
    "run-program-boundary:workflow:job",
  ]);

  const modifiedProgram = releaseVariant((workflow) => {
    findStep(
      workflow,
      "apple_sign",
      "Apply preview ad-hoc or fail-closed stable Apple signing",
    ).run += "\necho injected";
  });
  assert.deepEqual(canonicalDiagnosticIdentities(modifiedProgram), [
    "run-program-boundary:workflow:job",
  ]);

  for (const [jobName, stepName] of [
    ["build", "Fetch exact source objects with one read key"],
    ["apple_sign", "Apply preview ad-hoc or fail-closed stable Apple signing"],
    ["sign_updater_preview", "Sign only the preview updater archive"],
    ["feed", "Push only the prepared release-data commit"],
  ]) {
    const tokenContext = releaseVariant((workflow) => {
      findStep(workflow, jobName, stepName).env.GITHUB_TOKEN =
        "${{ github.token }}";
    });
    assert.deepEqual(canonicalDiagnosticIdentities(tokenContext), [
      "token-context-boundary:workflow:job",
    ], `${jobName}/${stepName}`);
  }

  const relocatedToken = releaseVariant((workflow) => {
    const publishTokenStep = workflow.jobs.publish.steps.find(
      (step) => step.env?.GH_TOKEN === "${{ github.token }}",
    );
    delete publishTokenStep.env.GH_TOKEN;
    findStep(
      workflow,
      "apple_sign",
      "Apply preview ad-hoc or fail-closed stable Apple signing",
    ).env.GH_TOKEN = "${{ github.token }}";
  });
  assert.deepEqual(canonicalDiagnosticIdentities(relocatedToken), [
    "token-context-boundary:workflow:job",
  ]);
});

test("accepts a release-data feed and a fresh credential-free signed smoke job", () => {
  assert.deepEqual(diagnosticIdentities(cutoverReleaseVariant()), []);
});

test("rejects feed authority that can write main or execute pulled policy", () => {
  const writesMain = cutoverReleaseVariant((workflow) => {
    const push = findStep(
      workflow,
      "feed",
      "Push only the prepared release-data commit",
    );
    push.run = push.run.replaceAll("release-data", "main");
  });
  assert.ok(
    diagnosticIdentities(writesMain).includes("feed-authority:feed:job"),
  );

  const executesPulledPolicy = cutoverReleaseVariant((workflow) => {
    findStep(
      workflow,
      "feed",
      "Prepare the monotonic release-data commit",
    ).run = "git pull --ff-only origin main\nnode data/scripts/feed-policy.mjs";
  });
  assert.ok(
    diagnosticIdentities(executesPulledPolicy).includes(
      "feed-policy-boundary:feed:Prepare the monotonic release-data commit",
    ),
  );

  for (const step of [
    { run: "git pull --ff-only origin main" },
    { run: "node data/scripts/feed-policy.mjs" },
    { run: "echo inert", "working-directory": "data" },
  ]) {
    const oneEscape = cutoverReleaseVariant((workflow) => {
      workflow.jobs.feed.steps.push({ name: "Pulled policy escape", ...step });
    });
    assert.ok(
      diagnosticIdentities(oneEscape).includes(
        "feed-policy-boundary:feed:Pulled policy escape",
      ),
    );
  }
});

test("requires the feed environment, read-only token, and one bounded deploy key", () => {
  const wrongEnvironment = cutoverReleaseVariant((workflow) => {
    workflow.jobs.feed.environment = "preview";
  });
  assert.ok(
    diagnosticIdentities(wrongEnvironment).includes(
      "environment-boundary:feed:job",
    ),
  );

  const writeToken = cutoverReleaseVariant((workflow) => {
    workflow.jobs.feed.permissions.contents = "write";
  });
  assert.ok(
    diagnosticIdentities(writeToken).includes("permission-boundary:feed:job"),
  );

  const secondKeyWindow = cutoverReleaseVariant((workflow) => {
    workflow.jobs.feed.steps.push({
      name: "Second feed credential",
      env: { FEED_DEPLOY_KEY: "${{ secrets.ZERGLANG_FEED_DEPLOY_KEY }}" },
      run: "echo duplicate",
    });
  });
  assert.ok(
    diagnosticIdentities(secondKeyWindow).includes(
      "feed-credential-contract:feed:job",
    ),
  );

  for (const token of [
    "unset FEED_DEPLOY_KEY",
    "policy/scripts/feed-promotion.mjs push",
    "release-data",
  ]) {
    const weakenedPush = cutoverReleaseVariant((workflow) => {
      const push = findStep(
        workflow,
        "feed",
        "Push only the prepared release-data commit",
      );
      push.run = push.run.replace(token, "removed");
    });
    assert.ok(
      diagnosticIdentities(weakenedPush).includes(
        "feed-credential-contract:feed:Push only the prepared release-data commit",
      ),
    );
  }

  const wrongSecret = cutoverReleaseVariant((workflow) => {
    const push = findStep(
      workflow,
      "feed",
      "Push only the prepared release-data commit",
    );
    push.env.FEED_DEPLOY_KEY = "${{ secrets.UNRELATED_KEY }}";
  });
  assert.ok(
    diagnosticIdentities(wrongSecret).includes(
      "feed-credential-contract:feed:job",
    ),
  );

  const wrongCanonicalValue = cutoverReleaseVariant((workflow) => {
    const push = findStep(
      workflow,
      "feed",
      "Push only the prepared release-data commit",
    );
    push.env.FEED_DEPLOY_KEY =
      "prefix-${{ secrets.ZERGLANG_FEED_DEPLOY_KEY }}";
  });
  assert.deepEqual(diagnosticIdentities(wrongCanonicalValue), [
    "feed-credential-contract:feed:job",
    "feed-credential-contract:feed:Push only the prepared release-data commit",
  ]);

  const relocatedFeedKey = cutoverReleaseVariant((workflow) => {
    const push = findStep(
      workflow,
      "feed",
      "Push only the prepared release-data commit",
    );
    push.env.FEED_DEPLOY_KEY = "ordinary-text";
    workflow.jobs.validate.steps.push({
      name: "Relocated feed credential",
      env: {
        FEED_DEPLOY_KEY: "${{ secrets.ZERGLANG_FEED_DEPLOY_KEY }}",
      },
      run: "echo inert",
    });
  });
  assert.deepEqual(diagnosticIdentities(relocatedFeedKey), [
    "feed-credential-contract:feed:job",
  ]);
});

test("rejects product execution on the Apple signer and credentials on signed smoke", () => {
  const executesProduct = cutoverReleaseVariant((workflow) => {
    workflow.jobs.apple_sign.steps.push({
      name: "Execute signed compiler",
      run: "$zlc run --tier=jit answer.zl",
    });
  });
  assert.ok(
    diagnosticIdentities(executesProduct).includes(
      "product-execution-boundary:apple_sign:Execute signed compiler",
    ),
  );

  const credentialedSmoke = cutoverReleaseVariant((workflow) => {
    workflow.jobs.signed_smoke.environment = "stable";
    findStep(
      workflow,
      "signed_smoke",
      "Verify final Apple signatures and notarization",
    ).env = {
      APPLE_KEY: "${{ secrets.ZERGLANG_APPLE_API_PRIVATE_KEY }}",
    };
  });
  assert.ok(
    diagnosticIdentities(credentialedSmoke).includes(
      "environment-boundary:signed_smoke:job",
    ),
  );
  assert.ok(
    diagnosticIdentities(credentialedSmoke).includes(
      "signed-smoke-credential:signed_smoke:Verify final Apple signatures and notarization",
    ),
  );

  for (const run of [
    "zlc answer.zl",
    "run --tier=interpreter answer.zl",
    "run --tier=jit answer.zl",
    "build --emit=object answer.zl",
  ]) {
    const oneExecution = cutoverReleaseVariant((workflow) => {
      workflow.jobs.apple_sign.steps.push({
        name: "One product execution",
        run,
      });
    });
    assert.ok(
      diagnosticIdentities(oneExecution).includes(
        "product-execution-boundary:apple_sign:One product execution",
      ),
    );
  }

  const wrongAppleEnvironment = cutoverReleaseVariant((workflow) => {
    workflow.jobs.apple_sign.environment = "preview";
  });
  assert.ok(
    diagnosticIdentities(wrongAppleEnvironment).includes(
      "environment-boundary:apple_sign:job",
    ),
  );
});

test("binds source checkout and Rust gates through public workflow diagnostics", () => {
  const broadFetch = cutoverReleaseVariant((workflow) => {
    const sourceCheckout = findStep(
      workflow,
      "build",
      "Fetch exact source objects with one read key",
    );
    sourceCheckout.run = sourceCheckout.run.replace(
      'git -C source-git fetch --no-tags --depth=1 origin "$EXPECTED_SHA"',
      "git -C source fetch origin --all",
    );
  });
  assert.ok(
    diagnosticIdentities(broadFetch).includes("job-contract:build:job"),
  );

  const missingComponents = cutoverReleaseVariant((workflow) => {
    const tools = findStep(workflow, "build", "Install pinned build tools");
    tools.run = tools.run.replace("--component clippy,rustfmt", "");
  });
  assert.ok(
    diagnosticIdentities(missingComponents).includes("job-contract:build:job"),
  );
});

test("accepts order-independent dependencies but rejects alternate environment shapes", () => {
  const equivalent = releaseVariant((workflow) => {
    workflow.jobs.apple_sign.needs.reverse();
  });
  assert.deepEqual(diagnosticIdentities(equivalent), []);

  const alternateShapes = releaseVariant((workflow) => {
    workflow.jobs.build.environment = { name: "zerglang-source-read" };
    workflow.jobs.sign_updater_preview.environment = { name: "preview" };
    workflow.jobs.sign_updater_stable.environment = {
      name: "zerglang-updater-stable",
    };
  });
  assert.ok(
    diagnosticIdentities(alternateShapes).includes(
      "environment-boundary:build:job",
    ),
  );
  assert.ok(
    diagnosticIdentities(alternateShapes).includes(
      "environment-boundary:sign_updater_preview:job",
    ),
  );
  assert.ok(
    diagnosticIdentities(alternateShapes).includes(
      "environment-boundary:sign_updater_stable:job",
    ),
  );
});

test("rejects every additional job, including reusable workflow calls", () => {
  const extraJob = releaseVariant((workflow) => {
    workflow.jobs.documentation = {
      "runs-on": "ubuntu-24.04",
      permissions: { contents: "read" },
      metadata: null,
    };
  });
  assert.ok(diagnosticIdentities(extraJob).includes("job-contract:workflow:job"));

  const reusableCall = releaseVariant((workflow) => {
    workflow.jobs.hidden_release = {
      uses: "example/hostile/.github/workflows/release.yml@main",
      secrets: "inherit",
      permissions: { contents: "write" },
    };
  });
  assert.ok(
    diagnosticIdentities(reusableCall).includes("job-contract:workflow:job"),
  );

  for (const [field, value] of [
    ["uses", "example/hostile/.github/workflows/release.yml@main"],
    ["secrets", "inherit"],
  ]) {
    const reusableField = releaseVariant((workflow) => {
      workflow.jobs.validate[field] = value;
    });
    assert.ok(
      diagnosticIdentities(reusableField).includes("job-contract:validate:job"),
      field,
    );
  }
});

test("rejects every secret outside the exact credential allowlist", () => {
  const hostile = releaseVariant((workflow) => {
    workflow.jobs.validate.steps.push({
      name: "Package with an unrelated credential",
      env: { TOKEN: "${{ secrets.UNRELATED_SERVICE_TOKEN }}" },
      run: "node scripts/package-macos.mjs",
    });
  });
  assert.ok(
    diagnosticIdentities(hostile).includes(
      "credential-allowlist:validate:Package with an unrelated credential",
    ),
  );
});

test("requires only the immutable request-file dispatch trigger", () => {
  for (const hostile of [
    releaseVariant((workflow) => {
      delete workflow.on;
    }),
    releaseVariant((workflow) => {
      workflow.on.push = {};
    }),
    releaseVariant((workflow) => {
      workflow.on.workflow_dispatch = null;
    }),
    releaseVariant((workflow) => {
      workflow.on.workflow_dispatch = "manual";
    }),
    releaseVariant((workflow) => {
      workflow.on.workflow_dispatch = [];
    }),
    releaseVariant((workflow) => {
      workflow.on.workflow_dispatch.inputs = null;
    }),
    releaseVariant((workflow) => {
      workflow.on.workflow_dispatch.inputs = "request_file";
    }),
    releaseVariant((workflow) => {
      workflow.on.workflow_dispatch.inputs = [];
    }),
    releaseVariant((workflow) => {
      workflow.on.workflow_dispatch.inputs.extra = { required: false };
    }),
  ]) {
    assert.deepEqual(diagnosticIdentities(hostile), [
      "trigger-contract:workflow:job",
    ]);
  }
});

test("requires every release job, dependency edge, and public operation", () => {
  const contracts = {
    validate: {
      needs: ["unexpected"],
      tokens: [
        "request_file",
        "git log --diff-filter=A",
        "the request addition commit must add only this request",
        "refs/tags/$RELEASE_TAG",
      ],
    },
    build: {
      needs: ["validate", "unexpected"],
      tokens: [
        'git -C source-git fetch --no-tags --depth=1 origin \\"$EXPECTED_SHA\\"',
        '\\"$EXPECTED_REF:$EXPECTED_REF\\"',
        'git -C source-git archive \\"$ZERGLANG_SOURCE_SHA\\"',
        "--component clippy,rustfmt",
        "createUpdaterArtifacts = false",
        "zerglang-unsigned-source-stage",
      ],
    },
    apple_sign: {
      needs: ["build"],
      tokens: ["zerglang-platform-signed"],
    },
    signed_smoke: {
      needs: ["apple_sign"],
      tokens: [
        "codesign --verify",
        "xcrun stapler validate",
        "spctl --assess",
        "run --tier=interpreter",
        "run --tier=jit",
        "build --emit=object",
      ],
    },
    sign_updater_preview: {
      needs: ["validate"],
      tokens: ["zerglang-release-payload"],
    },
    sign_updater_stable: {
      needs: ["apple_sign"],
      tokens: ["zerglang-release-payload"],
    },
    sign_updater: {
      needs: ["sign_updater_preview"],
      tokens: [],
    },
    publish: {
      needs: ["sign_updater"],
      tokens: [
        "--draft",
        "--verify-tag",
        "--draft=false",
        ".immutable",
        "zerglang-canonical-release",
        "latest.json",
      ],
    },
    feed: {
      needs: ["publish"],
      tokens: [
        "release-data",
        "policy/scripts/feed-promotion.mjs",
        "zerglang-canonical-release",
        "actions/upload-pages-artifact",
      ],
    },
    deploy_pages: {
      needs: ["validate"],
      tokens: ["actions/deploy-pages"],
    },
    verify_live: {
      needs: ["deploy_pages"],
      tokens: ["https://epoch-ml.github.io/zerglang-releases", "latest.json"],
    },
  };

  for (const [jobName, contract] of Object.entries(contracts)) {
    const missing = releaseVariant((workflow) => {
      delete workflow.jobs[jobName];
    });
    assert.deepEqual(diagnosticIdentities(missing), [
      `job-contract:${jobName}:job`,
    ]);

    const wrongNeeds = releaseVariant((workflow) => {
      workflow.jobs[jobName].needs = contract.needs;
    });
    assert.ok(
      diagnosticIdentities(wrongNeeds).includes(`job-contract:${jobName}:job`),
      `${jobName} must reject a changed dependency graph`,
    );

    for (const token of contract.tokens) {
      const missingOperation = releaseVariant((workflow) => {
        workflow.jobs[jobName] = replaceEveryJobToken(
          workflow.jobs[jobName],
          token,
        );
      });
      assert.ok(
        diagnosticIdentities(missingOperation).includes(
          `job-contract:${jobName}:job`,
        ),
        `${jobName} must require ${token}`,
      );
    }
  }
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

test("reports canonical, non-canonical, and mixed secrets at workflow scope", () => {
  const canonical = releaseVariant((workflow) => {
    workflow.env = {
      TOKEN: "${{ secrets.UNRELATED_SERVICE_TOKEN }}",
    };
  });
  assert.deepEqual(diagnosticIdentities(canonical), [
    "secret-outside-step-env:workflow:job",
  ]);

  const nonCanonical = releaseVariant((workflow) => {
    workflow.env = {
      TOKEN: "${{ secrets['UNRELATED_SERVICE_TOKEN'] }}",
    };
  });
  assert.deepEqual(diagnosticIdentities(nonCanonical), [
    "secret-expression-boundary:workflow:job",
  ]);

  const mixed = releaseVariant((workflow) => {
    workflow.env = {
      CANONICAL: "${{ secrets.UNRELATED_SERVICE_TOKEN }}",
      COMPUTED: "${{ secrets[format('{0}', 'TOKEN')] }}",
    };
  });
  assert.deepEqual(diagnosticIdentities(mixed), [
    "secret-expression-boundary:workflow:job",
  ]);
});

test("requires every credential-bearing job to use its protected environment", () => {
  for (const [jobName, environment] of [
    ["build", "preview"],
    ["sign_updater_preview", "zerglang-updater-stable"],
    ["sign_updater_stable", "preview"],
  ]) {
    const hostile = releaseVariant((workflow) => {
      workflow.jobs[jobName].environment = environment;
    });
    assert.deepEqual(diagnosticIdentities(hostile), [
      `environment-boundary:${jobName}:job`,
    ]);
  }

  for (const environment of [null, ["preview"]]) {
    const hostile = releaseVariant((workflow) => {
      workflow.jobs.sign_updater_preview.environment = environment;
    });
    assert.deepEqual(diagnosticIdentities(hostile), [
      "environment-boundary:sign_updater_preview:job",
    ]);
  }
});

test("reports secrets anywhere outside the consuming step env", () => {
  for (const mutate of [
    (step) => {
      step.run += "\necho '${{ secrets.ZERGLANG_APPLE_API_KEY_ID }}'";
    },
    (step) => {
      step.with = {
        token: "${{ secrets.ZERGLANG_APPLE_API_KEY_ID }}",
      };
    },
  ]) {
    const hostile = releaseVariant((workflow) => {
      mutate(workflow.jobs.validate.steps[0]);
    });
    assert.deepEqual(diagnosticIdentities(hostile), [
      "secret-outside-step-env:validate:Require protected main",
    ]);
  }
});

test("rejects a secret repeated outside the same consuming step env", () => {
  for (const exposeOutsideEnv of [
    (step, expression) => {
      step.run += `\necho '${expression}'`;
    },
    (step, expression) => {
      step.with = { token: expression };
    },
  ]) {
    const hostile = releaseVariant((workflow) => {
      const step = workflow.jobs.validate.steps[0];
      const expression = "${{ secrets.ZERGLANG_APPLE_API_KEY_ID }}";
      step.env = { APPLE_KEY_ID: expression };
      exposeOutsideEnv(step, expression);
    });
    assert.deepEqual(diagnosticIdentities(hostile), [
      "apple-credential-contract:apple_sign:job",
      "secret-outside-step-env:validate:Require protected main",
    ]);
  }
});

test("recognizes compact, padded, nested, and array-contained secret expressions", () => {
  for (const secretExpression of [
    "${{secrets.ZERGLANG_APPLE_API_KEY_ID}}",
    "${{   secrets.ZERGLANG_APPLE_API_KEY_ID   }}",
  ]) {
    const hostile = releaseVariant((workflow) => {
      workflow.jobs.validate.steps[0].with = {
        nested: [{ token: secretExpression }],
      };
    });
    assert.deepEqual(diagnosticIdentities(hostile), [
      "secret-outside-step-env:validate:Require protected main",
    ]);
  }
});

test("rejects bracketed, computed, mixed-case, and bare secret contexts", () => {
  for (const expression of [
    "${{ secrets['ZERGLANG_APPLE_API_KEY_ID'] }}",
    "${{ secrets [ 'ZERGLANG_APPLE_API_KEY_ID' ] }}",
    "${{ SeCrEtS.ZERGLANG_APPLE_API_KEY_ID }}",
    "${{ secrets[format('{0}_{1}', 'ZERGLANG', 'KEY')] }}",
    "${{ toJSON(secrets) }}",
    "prefix-${{\n secrets['ZERGLANG_APPLE_API_KEY_ID']\n}}-suffix",
  ]) {
    const hostile = releaseVariant((workflow) => {
      workflow.jobs.validate.steps[0].env = { LEAK: expression };
    });
    assert.ok(
      diagnosticIdentities(hostile).includes(
        "secret-expression-boundary:validate:Require protected main",
      ),
      expression,
    );
  }
});

test("does not mistake prose, quoted strings, or longer identifiers for contexts", () => {
  for (const value of [
    "secrets.DEPLOY_KEY is documentation, not an expression",
    "${{ 'secrets' }}",
    "${{ mysecrets.DEPLOY_KEY }}",
    "${{ _secrets.DEPLOY_KEY }}",
    "${{ secrets2.DEPLOY_KEY }}",
    "${{ 'don''t expose secrets or }} here' }}",
    "${{ 'quoted }} delimiter' }}-${{ 'still safe' }}",
    "plain secrets.DEPLOY_KEY }}",
    "secrets.DEPLOY_KEY prose-${{ 'safe' }}",
    "${{ 'safe' }} plain secrets.DEPLOY_KEY }}",
    "${{ 'unterminated safe literal",
    "${{ secrets.DEPLOY_KEY }",
    "${{ secrets.DEPLOY_KEY }x",
    "https://example.test/secrets.DEPLOY_KEY",
  ]) {
    const equivalent = releaseVariant((workflow) => {
      workflow.jobs.validate.steps[0].env = { SAFE_TEXT: value };
    });
    assert.deepEqual(diagnosticIdentities(equivalent), [], value);
  }
});

test("finds secret contexts across quoted and adjacent expressions", () => {
  for (const expression of [
    "${{ 'don''t' || secrets.ZERGLANG_APPLE_API_KEY_ID }}",
    "${{ 'quoted }} delimiter' || secrets.ZERGLANG_APPLE_API_KEY_ID }}",
    "${{ 'first expression is safe' }}-${{ true && secrets.ZERGLANG_APPLE_API_KEY_ID }}",
    "${{ true && secrets.ZERGLANG_APPLE_API_KEY_ID }}",
    "${{ secrets.ZERGLANG_APPLE_API_KEY_ID || true }}",
    "${{secrets}}",
    "${{ 'quoted''' || secrets.ZERGLANG_APPLE_API_KEY_ID }}",
  ]) {
    const hostile = releaseVariant((workflow) => {
      workflow.jobs.validate.steps[0].env = { LEAK: expression };
    });
    assert.ok(
      diagnosticIdentities(hostile).includes(
        "secret-expression-boundary:validate:Require protected main",
      ),
      expression,
    );
  }
});

test("reports the public step identity for nameless secret-bearing steps", () => {
  const hostile = releaseVariant((workflow) => {
    workflow.jobs.validate.steps.unshift({
      run: "echo '${{ secrets.ZERGLANG_APPLE_API_KEY_ID }}'",
    });
  });
  assert.deepEqual(diagnosticIdentities(hostile), [
    "secret-outside-step-env:validate:step 1",
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

test("rejects every download, verification, and payload operation in an updater key window", () => {
  for (const operation of [
    "curl https://example.invalid/file",
    "wget https://example.invalid/file",
    "tar -tzf payload.tar.gz",
    "sha256sum payload.tar.gz",
    "minisign -Vm payload.tar.gz",
    "node scripts/release-payload.mjs",
  ]) {
    const hostile = releaseVariant((workflow) => {
      const step = findStep(
        workflow,
        "sign_updater_preview",
        "Sign only the preview updater archive",
      );
      step.run += `\n${operation}`;
    });
    assert.deepEqual(diagnosticIdentities(hostile), [
      "updater-secret-window:sign_updater_preview:Sign only the preview updater archive",
    ]);
  }
});

test("recognizes each updater credential independently at an exact command boundary", () => {
  for (const secretName of [
    "ZERGLANG_TAURI_SIGNING_PRIVATE_KEY",
    "ZERGLANG_TAURI_SIGNING_PRIVATE_KEY_PASSWORD",
    "ZERGLANG_STABLE_TAURI_SIGNING_PRIVATE_KEY",
    "ZERGLANG_STABLE_TAURI_SIGNING_PRIVATE_KEY_PASSWORD",
  ]) {
    const signerJob = secretName.includes("STABLE")
      ? "sign_updater_stable"
      : "sign_updater_preview";
    const hostile = releaseVariant((workflow) => {
      workflow.jobs.validate.steps.push({
        name: `Isolated ${secretName}`,
        env: { SINGLE_SECRET: `\${{ secrets.${secretName} }}` },
        run: "curl",
      });
    });
    assert.deepEqual(diagnosticIdentities(hostile), [
      `updater-credential-contract:${signerJob}:job`,
      `updater-secret-window:validate:Isolated ${secretName}`,
    ]);
  }
});

test("recognizes an updater network command after a shell command boundary", () => {
  const hostile = releaseVariant((workflow) => {
    workflow.jobs.validate.steps.push({
      name: "Updater key across a shell boundary",
      env: {
        SINGLE_SECRET:
          "${{ secrets.ZERGLANG_TAURI_SIGNING_PRIVATE_KEY_PASSWORD }}",
      },
      run: "echo ready; curl",
    });
  });
  assert.deepEqual(diagnosticIdentities(hostile), [
    "updater-credential-contract:sign_updater_preview:job",
    "updater-secret-window:validate:Updater key across a shell boundary",
  ]);
});

test("rejects archive and metadata packaging in an Apple credential window", () => {
  for (const operation of [
    "node scripts/package-macos.mjs",
    "cp source/platform-metadata.json output/platform-metadata.json",
  ]) {
    const hostile = releaseVariant((workflow) => {
      const step = findStep(
        workflow,
        "apple_sign",
        "Apply preview ad-hoc or fail-closed stable Apple signing",
      );
      step.run += `\n${operation}`;
    });
    assert.deepEqual(diagnosticIdentities(hostile), [
      "apple-secret-window:apple_sign:Apply preview ad-hoc or fail-closed stable Apple signing",
    ]);
  }
});

test("recognizes one Apple credential without relying on companion secrets", () => {
  const hostile = releaseVariant((workflow) => {
    workflow.jobs.validate.steps.push({
      name: "Isolated Apple credential",
      env: {
        APPLE_KEY: "${{ secrets.ZERGLANG_APPLE_API_PRIVATE_KEY }}",
      },
      run: "node scripts/package-macos.mjs",
    });
  });
  assert.deepEqual(diagnosticIdentities(hostile), [
    "apple-credential-contract:apple_sign:job",
    "apple-secret-window:validate:Isolated Apple credential",
  ]);
});

test("reports the wrong channel signer mapping", () => {
  const hostile = releaseWorkflow.replace(
    "secrets.ZERGLANG_TAURI_SIGNING_PRIVATE_KEY_PASSWORD",
    "secrets.ZERGLANG_STABLE_TAURI_SIGNING_PRIVATE_KEY_PASSWORD",
  );
  assert.deepEqual(diagnosticIdentities(hostile), [
    "updater-credential-contract:sign_updater_preview:job",
    "updater-credential-contract:sign_updater_preview:Sign only the preview updater archive",
    "updater-credential-contract:sign_updater_stable:job",
  ]);
});

test("requires exactly one updater signer step per channel", () => {
  for (const jobName of ["sign_updater_preview", "sign_updater_stable"]) {
    const missing = releaseVariant((workflow) => {
      const signer = workflow.jobs[jobName].steps.findIndex((step) =>
        typeof step.name === "string" && step.name.startsWith("Sign only the")
      );
      workflow.jobs[jobName].steps.splice(signer, 1);
    });
    assert.deepEqual(diagnosticIdentities(missing), [
      `updater-credential-contract:${jobName}:job`,
    ]);

    const duplicate = releaseVariant((workflow) => {
      const signer = workflow.jobs[jobName].steps.find((step) =>
        typeof step.name === "string" && step.name.startsWith("Sign only the")
      );
      workflow.jobs[jobName].steps.push(structuredClone(signer));
    });
    assert.deepEqual(diagnosticIdentities(duplicate), [
      `updater-credential-contract:${jobName}:job`,
    ]);
  }
});

test("requires each channel signer to receive both exact keys, sign once, and unset", () => {
  const cases = [
    (step) => {
      step.env.TAURI_PRIVATE_KEY = "${{ secrets.ZERGLANG_STABLE_TAURI_SIGNING_PRIVATE_KEY }}";
    },
    (step) => {
      step.env.TAURI_PRIVATE_KEY_PASSWORD = "ordinary-text";
    },
    (step) => {
      step.run = step.run.replace(
        "npm exec --offline -- tauri signer sign release-input/ZergLang.app.tar.gz",
        "echo skipped-signing",
      );
    },
    (step) => {
      step.run = step.run.replace(
        "unset TAURI_PRIVATE_KEY TAURI_PRIVATE_KEY_PASSWORD",
        "echo kept-credentials",
      );
    },
  ];
  for (const mutate of cases) {
    const hostile = releaseVariant((workflow) => {
      mutate(findStep(
        workflow,
        "sign_updater_preview",
        "Sign only the preview updater archive",
      ));
    });
    assert.ok(
      diagnosticIdentities(hostile).includes(
        "updater-credential-contract:sign_updater_preview:Sign only the preview updater archive",
      ),
    );
  }
});

test("fails the signer contract when a credential-bearing step has no shell program", () => {
  for (const run of [null, 42]) {
    const hostile = releaseVariant((workflow) => {
      findStep(
        workflow,
        "sign_updater_preview",
        "Sign only the preview updater archive",
      ).run = run;
    });
    assert.deepEqual(diagnosticIdentities(hostile), [
      "updater-credential-contract:sign_updater_preview:Sign only the preview updater archive",
    ]);
  }
});

test("reports an unpinned action, mutable publication, and synthetic dispatch", () => {
  const unpinned = releaseWorkflow.replace(
    "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1",
    "actions/checkout@v7",
  );
  assert.deepEqual(diagnosticIdentities(unpinned), [
    "action-contract:validate:job",
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

test("requires draft creation independently from final undrafting", () => {
  const hostile = releaseVariant((workflow) => {
    const step = findStep(
      workflow,
      "publish",
      "Create or resume the exact immutable GitHub Release",
    );
    step.run = step.run.replace(
      '--title "$release_title" --notes "$release_body" --draft',
      '--title "$release_title" --notes "$release_body"',
    );
  });
  assert.deepEqual(diagnosticIdentities(hostile), [
    "job-contract:publish:job",
  ]);
});

test("requires every GitHub-owned action to use a lowercase 40-character commit", () => {
  for (const uses of [
    "actions/checkout@v7",
    `actions/checkout@${"a".repeat(39)}`,
    `actions/checkout@${"a".repeat(41)}`,
    `actions/checkout@${"A".repeat(40)}`,
  ]) {
    const hostile = releaseVariant((workflow) => {
      workflow.jobs.validate.steps[1].uses = uses;
    });
    assert.deepEqual(diagnosticIdentities(hostile), [
      "action-contract:validate:job",
      `unpinned-action:validate:uses ${uses}`,
    ]);
  }

  const thirdParty = releaseVariant((workflow) => {
    workflow.jobs.sign_updater.steps.push({
      uses: "example/hostile-action@0123456789abcdef0123456789abcdef01234567",
    });
  });
  assert.ok(
    diagnosticIdentities(thirdParty).includes("action-contract:sign_updater:job"),
  );
});

test("requires exact workflow and per-job permissions", () => {
  const topLevelWrite = releaseVariant((workflow) => {
    workflow.permissions = { contents: "write" };
  });
  assert.ok(
    diagnosticIdentities(topLevelWrite).includes(
      "permission-boundary:workflow:job",
    ),
  );

  for (const [jobName, permissions] of [
    ["validate", { contents: "write" }],
    ["sign_updater", { contents: "write" }],
    ["publish", { contents: "read" }],
    ["deploy_pages", { pages: "write", "id-token": "write", contents: "write" }],
  ]) {
    const hostile = releaseVariant((workflow) => {
      workflow.jobs[jobName].permissions = permissions;
    });
    assert.ok(
      diagnosticIdentities(hostile).includes(
        `permission-boundary:${jobName}:job`,
      ),
      jobName,
    );
  }
});

test("requires every approved job's exact runner, permissions, environment, and actions", () => {
  const jobNames = Object.keys(parse(releaseWorkflow).jobs);
  for (const jobName of jobNames) {
    const wrongRunner = releaseVariant((workflow) => {
      workflow.jobs[jobName]["runs-on"] = "mutation-runner";
    });
    assert.ok(
      diagnosticIdentities(wrongRunner).includes(`job-contract:${jobName}:job`),
      `${jobName} runner`,
    );

    const wrongPermissions = releaseVariant((workflow) => {
      workflow.jobs[jobName].permissions = {
        ...workflow.jobs[jobName].permissions,
        actions: "read",
      };
    });
    assert.ok(
      diagnosticIdentities(wrongPermissions).includes(
        `permission-boundary:${jobName}:job`,
      ),
      `${jobName} permissions`,
    );

    const wrongEnvironment = releaseVariant((workflow) => {
      workflow.jobs[jobName].environment = "mutation-environment";
    });
    assert.ok(
      diagnosticIdentities(wrongEnvironment).includes(
        `environment-boundary:${jobName}:job`,
      ),
      `${jobName} environment`,
    );

    const extraAction = releaseVariant((workflow) => {
      workflow.jobs[jobName].steps.push({
        uses: "example/hostile-action@0123456789abcdef0123456789abcdef01234567",
      });
    });
    assert.ok(
      diagnosticIdentities(extraAction).includes(`action-contract:${jobName}:job`),
      `${jobName} actions`,
    );
  }
});

test("requires the exact action sequence and checkout configuration per job", () => {
  const injectedAction = releaseVariant((workflow) => {
    workflow.jobs.apple_sign.steps.unshift({
      uses: "example/hostile-action@0123456789abcdef0123456789abcdef01234567",
    });
  });
  assert.ok(
    diagnosticIdentities(injectedAction).includes("action-contract:apple_sign:job"),
  );

  const persistedCredentials = releaseVariant((workflow) => {
    workflow.jobs.apple_sign.steps[0].with["persist-credentials"] = true;
  });
  assert.ok(
    diagnosticIdentities(persistedCredentials).includes(
      "action-contract:apple_sign:job",
    ),
  );

  const duplicateCheckout = releaseVariant((workflow) => {
    workflow.jobs.validate.steps.push(structuredClone(workflow.jobs.validate.steps[1]));
  });
  assert.ok(
    diagnosticIdentities(duplicateCheckout).includes("action-contract:validate:job"),
  );
});

test("binds each Apple and source credential globally to one exact step", () => {
  const duplicateApple = releaseVariant((workflow) => {
    workflow.jobs.apple_sign.steps.push({
      name: "Second Apple export",
      env: {
        APPLE_KEY: "${{ secrets.ZERGLANG_APPLE_API_PRIVATE_KEY }}",
      },
      run: "curl https://example.invalid/upload",
    });
  });
  assert.ok(
    diagnosticIdentities(duplicateApple).includes(
      "apple-credential-contract:apple_sign:job",
    ),
  );

  const duplicateSource = releaseVariant((workflow) => {
    workflow.jobs.build.steps.push({
      name: "Second source export",
      env: { SOURCE_KEY: "${{ secrets.ZERG_SOURCE_DEPLOY_KEY }}" },
      run: "curl https://example.invalid/upload",
    });
  });
  assert.ok(
    diagnosticIdentities(duplicateSource).includes(
      "source-credential-contract:build:job",
    ),
  );

  for (const mutate of [
    (workflow, step) => {
      step.name = "Renamed source credential step";
    },
    (workflow, step) => {
      step.env.RENAMED_SOURCE_KEY = step.env.SOURCE_DEPLOY_KEY;
      delete step.env.SOURCE_DEPLOY_KEY;
    },
    (workflow, step) => {
      step.env.SOURCE_DEPLOY_KEY =
        "prefix-${{ secrets.ZERG_SOURCE_DEPLOY_KEY }}";
    },
  ]) {
    const relocatedField = releaseVariant((workflow) => {
      const step = findStep(
        workflow,
        "build",
        "Fetch exact source objects with one read key",
      );
      mutate(workflow, step);
    });
    assert.deepEqual(diagnosticIdentities(relocatedField), [
      "source-credential-contract:build:job",
    ]);
  }

  const relocatedJob = releaseVariant((workflow) => {
    const index = workflow.jobs.build.steps.findIndex(
      (step) => step.name === "Fetch exact source objects with one read key",
    );
    const [step] = workflow.jobs.build.steps.splice(index, 1);
    workflow.jobs.validate.steps.push(step);
  });
  assert.deepEqual(diagnosticIdentities(relocatedJob), [
    "job-contract:build:job",
    "source-credential-contract:build:job",
  ]);
});

test("destroys the source deploy key before credential-free materialization", () => {
  for (const mutate of [
    (step) => {
      step.run = step.run.replace("trap cleanup EXIT", "echo no-cleanup-trap");
    },
    (step) => {
      step.run = step.run.replace("unset SOURCE_DEPLOY_KEY", "echo key-still-exported");
    },
    (step) => {
      step.run = step.run.replace('rm -f "$key_path"', "echo key-file-remains");
    },
    (step) => {
      step.run += "\ngit -C source-git checkout --detach \"$EXPECTED_SHA\"";
    },
    (step) => {
      step.run += "\ngit -C staging checkout --detach \"$EXPECTED_SHA\"";
    },
  ]) {
    const hostile = releaseVariant((workflow) => {
      mutate(findStep(
        workflow,
        "build",
        "Fetch exact source objects with one read key",
      ));
    });
    assert.ok(
      diagnosticIdentities(hostile).includes(
        "source-credential-window:build:Fetch exact source objects with one read key",
      ),
    );
  }
});

test("sorts multiple diagnostics by their public identity", () => {
  const hostile = releaseVariant((workflow) => {
    workflow.jobs.validate.steps.push({
      uses: "actions/checkout@v7",
      with: { token: "${{ secrets.ZERGLANG_APPLE_API_KEY_ID }}" },
    });
  });
  assert.deepEqual(diagnosticIdentities(hostile), [
    "action-contract:validate:job",
    "secret-outside-step-env:validate:uses actions/checkout@v7",
    "unpinned-action:validate:uses actions/checkout@v7",
  ]);
});

test("sorts same-code diagnostics by their public step identity", () => {
  const hostile = releaseVariant((workflow) => {
    workflow.jobs.validate.steps.push(
      { uses: "actions/z-last@v1" },
      { uses: "actions/a-first@v1" },
    );
  });
  assert.deepEqual(diagnosticIdentities(hostile), [
    "action-contract:validate:job",
    "unpinned-action:validate:uses actions/a-first@v1",
    "unpinned-action:validate:uses actions/z-last@v1",
  ]);
});

test("sorts a job-level signer diagnostic before its step diagnostic", () => {
  const hostile = releaseVariant((workflow) => {
    workflow.jobs.sign_updater_preview.steps.push({
      name: "Extra partial signer",
      env: {
        TAURI_PRIVATE_KEY:
          "${{ secrets.ZERGLANG_TAURI_SIGNING_PRIVATE_KEY }}",
      },
      run: "echo incomplete signer",
    });
  });
  assert.deepEqual(diagnosticIdentities(hostile), [
    "updater-credential-contract:sign_updater_preview:job",
    "updater-credential-contract:sign_updater_preview:Extra partial signer",
  ]);
});

test("requires pull-request CI to execute every public policy gate", () => {
  assert.deepEqual(
    auditPolicyWorkflow(policyWorkflow).map(
      ({ code, job, step }) => `${code}:${job}:${step ?? "job"}`,
    ),
    [],
  );

  const incomplete = policyWorkflow.replace(
    "node scripts/workflow-policy.mjs .github/workflows/release.yml",
    "true",
  );
  assert.deepEqual(
    auditPolicyWorkflow(incomplete).map(
      ({ code, job, step }) => `${code}:${job}:${step ?? "job"}`,
    ),
    ["policy-ci-contract:policy:job"],
  );
});

test("requires the exact policy-CI trigger, branch, permissions, and secret-free boundary", () => {
  const variants = [
    policyVariant((workflow) => {
      delete workflow.on;
    }),
    policyVariant((workflow) => {
      workflow.on.push = {};
    }),
    policyVariant((workflow) => {
      workflow.on.pull_request = null;
    }),
    policyVariant((workflow) => {
      workflow.on.pull_request = "main";
    }),
    policyVariant((workflow) => {
      workflow.on.pull_request = [];
    }),
    policyVariant((workflow) => {
      workflow.on.pull_request.branches = "main";
    }),
    policyVariant((workflow) => {
      workflow.on.pull_request.branches.push("release");
    }),
    policyVariant((workflow) => {
      workflow.permissions = "read-all";
    }),
    policyVariant((workflow) => {
      workflow.permissions = null;
    }),
    policyVariant((workflow) => {
      workflow.permissions = ["contents:read"];
    }),
    policyVariant((workflow) => {
      workflow.permissions.contents = "write";
    }),
    policyVariant((workflow) => {
      workflow.permissions.actions = "read";
    }),
    policyVariant((workflow) => {
      workflow.jobs.policy.env = {
        TOKEN: "${{ secrets.ZERGLANG_APPLE_API_KEY_ID }}",
      };
    }),
    policyVariant((workflow) => {
      workflow.jobs.policy.steps.push({
        run: "echo safe",
        env: { TOKEN: "${{secrets.ZERGLANG_APPLE_API_KEY_ID}}" },
      });
    }),
    policyVariant((workflow) => {
      workflow.jobs.policy.env = {
        TOKEN: "${{ secrets['ZERGLANG_APPLE_API_KEY_ID'] }}",
      };
    }),
    policyVariant((workflow) => {
      workflow.jobs.policy.env = {
        TOKEN: "${{ SeCrEtS[format('{0}', 'KEY')] }}",
      };
    }),
  ];
  for (const hostile of variants) {
    assert.deepEqual(policyDiagnosticIdentities(hostile), [
      "policy-ci-contract:policy:job",
    ]);
  }

  const equivalent = policyVariant((workflow) => {
    workflow.jobs.policy.metadata = null;
  });
  assert.deepEqual(policyDiagnosticIdentities(equivalent), []);
});

test("requires the exact policy job set and pinned action configuration", () => {
  const variants = [
    policyVariant((workflow) => {
      workflow.jobs.hidden = {
        uses: "example/hostile/.github/workflows/release.yml@main",
        secrets: "inherit",
        permissions: { contents: "write" },
      };
    }),
    policyVariant((workflow) => {
      workflow.jobs.policy.steps.unshift({
        uses: "example/hostile@0123456789abcdef0123456789abcdef01234567",
      });
    }),
    policyVariant((workflow) => {
      workflow.jobs.policy.steps[0].with["persist-credentials"] = true;
    }),
    policyVariant((workflow) => {
      workflow.jobs.policy["runs-on"] = "ubuntu-latest";
    }),
    policyVariant((workflow) => {
      workflow.jobs.policy.steps.push({ run: "echo inert" });
    }),
    policyVariant((workflow) => {
      workflow.jobs.policy.uses =
        "example/hostile/.github/workflows/release.yml@main";
    }),
    policyVariant((workflow) => {
      workflow.jobs.policy.secrets = "inherit";
    }),
    policyVariant((workflow) => {
      workflow.jobs.policy.environment = "protected";
    }),
    policyVariant((workflow) => {
      workflow.jobs.policy.permissions = { contents: "read" };
    }),
  ];
  for (const hostile of variants) {
    assert.deepEqual(policyDiagnosticIdentities(hostile), [
      "policy-ci-contract:policy:job",
    ]);
  }
});

test("requires the policy job and every exact public CI operation", () => {
  const missingJob = policyVariant((workflow) => {
    delete workflow.jobs.policy;
  });
  assert.deepEqual(policyDiagnosticIdentities(missingJob), [
    "policy-ci-contract:policy:job",
  ]);

  const invalidJob = policyVariant((workflow) => {
    workflow.jobs.policy = [];
  });
  assert.throws(
    () => auditPolicyWorkflow(invalidJob),
    (error) =>
      error instanceof WorkflowPolicyError &&
      error.message === "policy job must be a mapping",
  );

  for (const token of [
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
  ]) {
    const hostile = policyWorkflow.replaceAll(
      token,
      "removed-public-policy-operation",
    );
    assert.deepEqual(
      policyDiagnosticIdentities(hostile),
      ["policy-ci-contract:policy:job"],
      `policy CI must require ${token}`,
    );
  }
});

test("fails closed when policy workflow containers have invalid YAML types", () => {
  for (const [source, message] of [
    ["on: null\njobs: {}\n", "policy workflow triggers must be a mapping"],
    ["on: pull_request\njobs: {}\n", "policy workflow triggers must be a mapping"],
    ["on: []\njobs: {}\n", "policy workflow triggers must be a mapping"],
    ["on: {}\njobs: null\n", "policy workflow jobs must be a mapping"],
    ["on: {}\njobs: invalid\n", "policy workflow jobs must be a mapping"],
    ["on: {}\njobs: []\n", "policy workflow jobs must be a mapping"],
  ]) {
    assert.throws(
      () => auditPolicyWorkflow(source),
      (error) => error instanceof WorkflowPolicyError && error.message === message,
    );
  }
});

test("CLI selects the release or policy audit and exposes exit status as a gate", () => {
  const releaseResult = spawnSync(
    process.execPath,
    [policyCli, releaseWorkflowPath],
    { encoding: "utf8" },
  );
  assert.equal(releaseResult.status, 0);
  assert.equal(releaseResult.stderr, "");
  assert.deepEqual(JSON.parse(releaseResult.stdout), { diagnostics: [] });

  const policyResult = spawnSync(
    process.execPath,
    [policyCli, policyWorkflowPath, "--policy-ci"],
    { encoding: "utf8" },
  );
  assert.equal(policyResult.status, 0);
  assert.equal(policyResult.stderr, "");
  assert.deepEqual(JSON.parse(policyResult.stdout), { diagnostics: [] });
});

test("CLI returns one for policy violations in either mode", async () => {
  const directory = await mkdtemp(`${tmpdir()}/zerglang-workflow-policy-`);
  try {
    const releasePath = `${directory}/release.yml`;
    const policyPath = `${directory}/policy.yml`;
    await writeFile(
      releasePath,
      releaseVariant((workflow) => {
        workflow.on.workflow_dispatch.inputs = {};
      }),
    );
    await writeFile(
      policyPath,
      policyVariant((workflow) => {
        workflow.permissions.contents = "write";
      }),
    );

    const releaseResult = spawnSync(process.execPath, [policyCli, releasePath], {
      encoding: "utf8",
    });
    assert.equal(releaseResult.status, 1);
    assert.deepEqual(JSON.parse(releaseResult.stdout).diagnostics.map(
      ({ code, job }) => `${code}:${job}`,
    ), ["trigger-contract:workflow"]);

    const policyResult = spawnSync(
      process.execPath,
      [policyCli, policyPath, "--policy-ci"],
      { encoding: "utf8" },
    );
    assert.equal(policyResult.status, 1);
    assert.deepEqual(JSON.parse(policyResult.stdout).diagnostics.map(
      ({ code, job }) => `${code}:${job}`,
    ), ["policy-ci-contract:policy"]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("CLI rejects invalid arguments and malformed workflow input", async () => {
  for (const args of [
    [],
    [releaseWorkflowPath, "--unknown-mode"],
    [releaseWorkflowPath, "--policy-ci", "extra"],
  ]) {
    const result = spawnSync(process.execPath, [policyCli, ...args], {
      encoding: "utf8",
    });
    assert.equal(result.status, 1);
    assert.match(
      result.stderr,
      /^workflow-policy: usage: workflow-policy\.mjs WORKFLOW\.yml \[--policy-ci]\n$/,
    );
    assert.equal(result.stdout, "");
  }

  const directory = await mkdtemp(`${tmpdir()}/zerglang-workflow-policy-`);
  try {
    const malformedPath = `${directory}/malformed.yml`;
    await writeFile(malformedPath, "jobs: [\n");
    const result = spawnSync(process.execPath, [policyCli, malformedPath], {
      encoding: "utf8",
    });
    assert.equal(result.status, 1);
    assert.equal(
      result.stderr,
      "workflow-policy: workflow source must be valid YAML\n",
    );
    assert.equal(result.stdout, "");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
