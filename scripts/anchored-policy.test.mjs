import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { parse, stringify } from "yaml";

import {
  AnchoredPolicyError,
  auditAnchoredPullRequestData,
} from "./anchored-policy.mjs";

const anchorUrl = new URL("../.github/workflows/policy-anchor.yml", import.meta.url);
const evaluatorUrl = new URL("./anchored-policy.mjs", import.meta.url);
const releaseWorkflow = await readFile(
  new URL("../.github/workflows/release.yml", import.meta.url),
  "utf8",
);
const execFileAsync = promisify(execFile);
const MAX_BOUNDARY_BYTES = 262_144;

function safeInput() {
  return {
    baseSha: "a".repeat(40),
    headSha: "b".repeat(40),
    changedPaths: [".github/workflows/release.yml"],
    candidateMode: "100644",
    candidateSize: Buffer.byteLength(releaseWorkflow),
    candidateWorkflow: releaseWorkflow,
    canonicalWorkflow: releaseWorkflow,
  };
}

function codes(input) {
  return auditAnchoredPullRequestData(input).map(({ code }) => code);
}

async function runEvaluator(arguments_) {
  try {
    const result = await execFileAsync(process.execPath, [
      fileURLToPath(evaluatorUrl),
      ...arguments_,
    ]);
    return { status: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    return {
      status: error.code,
      stdout: error.stdout,
      stderr: error.stderr,
    };
  }
}

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
    "diff --name-only --no-renames -z",
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

test("materializes both sides of a real protected-path rename", async (t) => {
  const repository = await mkdtemp(join(tmpdir(), "zerglang-public-anchor-rename-"));
  t.after(() => rm(repository, { recursive: true, force: true }));
  await execFileAsync("git", ["init", "--quiet", repository]);
  await execFileAsync("git", ["-C", repository, "config", "user.name", "Policy Test"]);
  await execFileAsync("git", ["-C", repository, "config", "user.email", "policy@example.invalid"]);
  await mkdir(join(repository, "scripts"));
  await mkdir(join(repository, "src"));
  await writeFile(join(repository, "scripts/protected.mjs"), "export default true;\n");
  await execFileAsync("git", ["-C", repository, "add", "."]);
  await execFileAsync("git", ["-C", repository, "commit", "--quiet", "-m", "base"]);
  const { stdout: base } = await execFileAsync(
    "git", ["-C", repository, "rev-parse", "HEAD"],
  );
  await execFileAsync("git", [
    "-C", repository, "mv", "scripts/protected.mjs", "src/product.mjs",
  ]);
  await execFileAsync("git", ["-C", repository, "commit", "--quiet", "-m", "rename"]);
  const { stdout: head } = await execFileAsync(
    "git", ["-C", repository, "rev-parse", "HEAD"],
  );
  const { stdout } = await execFileAsync("git", [
    "-C", repository, "diff", "--name-only", "--no-renames", "-z",
    `${base.trim()}...${head.trim()}`,
  ], { encoding: "buffer" });
  assert.deepEqual(stdout.toString("utf8").split("\0").filter(Boolean), [
    "scripts/protected.mjs",
    "src/product.mjs",
  ]);
});

test("audits immutable head workflow bytes and rejects protected policy changes", async () => {
  assert.equal(existsSync(evaluatorUrl), true, "the trusted evaluator must exist");
  const safe = safeInput();
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

test("binds every run program and token context to protected canonical bytes", () => {
  const addedProgram = safeInput();
  const addedWorkflow = parse(releaseWorkflow);
  addedWorkflow.jobs.validate.steps.push({
    name: "Unreviewed program",
    run: "echo injected",
  });
  addedProgram.candidateWorkflow = stringify(addedWorkflow);
  addedProgram.candidateSize = Buffer.byteLength(addedProgram.candidateWorkflow);
  assert.deepEqual(codes(addedProgram), ["candidate-workflow"]);

  const windows = [
    ["build", "Fetch exact source objects with one read key"],
    ["apple_sign", "Apply preview ad-hoc or fail-closed stable Apple signing"],
    ["sign_updater_preview", "Sign only the preview updater archive"],
    ["feed", "Push only the prepared release-data commit"],
  ];
  for (const [jobName, stepName] of windows) {
    const modifiedProgram = safeInput();
    const programWorkflow = parse(releaseWorkflow);
    const programStep = programWorkflow.jobs[jobName].steps.find(
      ({ name }) => name === stepName,
    );
    programStep.run += "\necho injected";
    modifiedProgram.candidateWorkflow = stringify(programWorkflow);
    modifiedProgram.candidateSize = Buffer.byteLength(
      modifiedProgram.candidateWorkflow,
    );
    assert.deepEqual(
      codes(modifiedProgram),
      ["candidate-workflow"],
      `${jobName}/${stepName} run`,
    );

    const tokenContext = safeInput();
    const tokenWorkflow = parse(releaseWorkflow);
    const tokenStep = tokenWorkflow.jobs[jobName].steps.find(
      ({ name }) => name === stepName,
    );
    tokenStep.env.GITHUB_TOKEN = "${{ github.token }}";
    tokenContext.candidateWorkflow = stringify(tokenWorkflow);
    tokenContext.candidateSize = Buffer.byteLength(tokenContext.candidateWorkflow);
    assert.deepEqual(
      codes(tokenContext),
      ["candidate-workflow"],
      `${jobName}/${stepName} token`,
    );
  }

  const relocatedToken = safeInput();
  const relocatedWorkflow = parse(releaseWorkflow);
  const publishTokenStep = relocatedWorkflow.jobs.publish.steps.find(
    (step) => step.env?.GH_TOKEN === "${{ github.token }}",
  );
  delete publishTokenStep.env.GH_TOKEN;
  const appleSigner = relocatedWorkflow.jobs.apple_sign.steps.find(
    ({ name }) => name ===
      "Apply preview ad-hoc or fail-closed stable Apple signing",
  );
  appleSigner.env.GH_TOKEN = "${{ github.token }}";
  relocatedToken.candidateWorkflow = stringify(relocatedWorkflow);
  relocatedToken.candidateSize = Buffer.byteLength(
    relocatedToken.candidateWorkflow,
  );
  assert.deepEqual(codes(relocatedToken), ["candidate-workflow"]);
});

test("fails closed on non-object input and non-canonical immutable SHAs", () => {
  for (const input of [null, [], "candidate", 42]) {
    assert.throws(
      () => auditAnchoredPullRequestData(input),
      (error) =>
        error instanceof AnchoredPolicyError &&
        error.name === "AnchoredPolicyError" &&
        error.message === "anchored pull request data must be an object",
    );
  }

  for (const sha of [
    `x${"a".repeat(40)}`,
    `${"a".repeat(40)}x`,
    "A".repeat(40),
    "a".repeat(39),
    "a".repeat(41),
  ]) {
    for (const field of ["baseSha", "headSha"]) {
      const input = safeInput();
      input[field] = sha;
      assert.deepEqual(auditAnchoredPullRequestData(input), [
        {
          code: "immutable-sha-boundary",
          message: "base and head must be immutable lowercase commit SHAs",
        },
      ]);
    }
  }
});

test("enforces every changed-path boundary without rejecting ordinary product paths", () => {
  const maximumPaths = safeInput();
  maximumPaths.changedPaths = Array.from(
    { length: 256 },
    (_, index) => `docs/${index}`,
  );
  assert.deepEqual(codes(maximumPaths), []);

  const maximumPathLength = safeInput();
  maximumPathLength.changedPaths = ["d".repeat(512)];
  assert.deepEqual(codes(maximumPathLength), []);

  for (const changedPaths of [
    Array.from({ length: 257 }, (_, index) => `docs/${index}`),
    ["d".repeat(513)],
    [42],
    [""],
    ["docs/safe", "bad\0path"],
    ["/absolute"],
    ["docs/../policy"],
    ["docs/same", "docs/same"],
  ]) {
    const input = safeInput();
    input.changedPaths = changedPaths;
    assert.deepEqual(codes(input), ["diff-boundary"]);
  }

  const invalidPath = safeInput();
  invalidPath.changedPaths = ["docs/../policy"];
  assert.deepEqual(auditAnchoredPullRequestData(invalidPath), [
    {
      code: "diff-boundary",
      message: "the candidate diff path list exceeds its public bounds",
    },
  ]);

  for (const productPath of [
    "docs/scripts/example.md",
    "scripted/tool.mjs",
    "keysmith/readme.md",
    ".githubish/workflow.yml",
    "src/product.mjs",
  ]) {
    const input = safeInput();
    input.changedPaths = [productPath];
    assert.deepEqual(codes(input), [], productPath);
  }
});

test("protects every future base policy root but permits only the candidate workflow", () => {
  for (const protectedPath of [
    "package.json",
    "package-lock.json",
    "scripts/new-policy.mjs",
    "keys/new-root.pubkey",
    ".github/workflows/new-policy.yml",
    ".github/CODEOWNERS",
  ]) {
    const input = safeInput();
    input.changedPaths = [protectedPath];
    assert.deepEqual(auditAnchoredPullRequestData(input), [
      {
        code: "protected-policy-change",
        message:
          "protected-base policy code requires a separately audited bootstrap",
      },
    ]);
  }
  assert.deepEqual(codes(safeInput()), []);
});

test("enforces regular candidate blob type, size, bytes, and policy diagnostics", () => {
  for (const mutate of [
    (input) => { input.candidateMode = "100755"; },
    (input) => { input.candidateSize = 0; },
    (input) => { input.candidateSize = -1; },
    (input) => { input.candidateSize = 1.5; },
    (input) => { input.candidateSize = "1"; },
    (input) => { input.candidateSize += 1; },
    (input) => { input.candidateWorkflow = null; },
  ]) {
    const input = safeInput();
    mutate(input);
    assert.deepEqual(codes(input), ["candidate-blob-boundary"]);
  }

  const empty = safeInput();
  empty.candidateWorkflow = "";
  empty.candidateSize = 0;
  assert.deepEqual(auditAnchoredPullRequestData(empty), [
    {
      code: "candidate-blob-boundary",
      message: "candidate release workflow must be one bounded regular Git blob",
    },
  ]);

  const oneByteWorkflow = safeInput();
  oneByteWorkflow.candidateWorkflow = "x";
  oneByteWorkflow.candidateSize = 1;
  assert.deepEqual(codes(oneByteWorkflow), ["candidate-workflow"]);

  const malformed = safeInput();
  malformed.candidateWorkflow = "jobs: [";
  malformed.candidateSize = Buffer.byteLength(malformed.candidateWorkflow);
  assert.deepEqual(auditAnchoredPullRequestData(malformed), [
    {
      code: "candidate-workflow",
      message: "candidate release workflow cannot be audited as YAML data",
    },
  ]);

  const invalidPolicy = safeInput();
  invalidPolicy.candidateWorkflow = "name: incomplete\njobs: {}\n";
  invalidPolicy.candidateSize = Buffer.byteLength(
    invalidPolicy.candidateWorkflow,
  );
  assert.deepEqual(auditAnchoredPullRequestData(invalidPolicy), [
    {
      code: "candidate-workflow",
      message:
        "candidate release workflow violates the protected-base contract",
    },
  ]);

  const maximumWorkflow = `${releaseWorkflow}\n#${" ".repeat(
    MAX_BOUNDARY_BYTES - Buffer.byteLength(releaseWorkflow) - 2,
  )}`;
  const maximum = safeInput();
  maximum.candidateWorkflow = maximumWorkflow;
  maximum.candidateSize = Buffer.byteLength(maximumWorkflow);
  assert.equal(maximum.candidateSize, MAX_BOUNDARY_BYTES);
  assert.deepEqual(codes(maximum), []);

  const oversized = structuredClone(maximum);
  oversized.candidateWorkflow += " ";
  oversized.candidateSize += 1;
  assert.deepEqual(codes(oversized), ["candidate-blob-boundary"]);

  for (const canonicalWorkflow of [
    undefined,
    "",
    `${releaseWorkflow}\n#${" ".repeat(MAX_BOUNDARY_BYTES)}`,
  ]) {
    const invalidCanonical = safeInput();
    invalidCanonical.canonicalWorkflow = canonicalWorkflow;
    assert.deepEqual(codes(invalidCanonical), ["candidate-workflow"]);
  }

  const exactCanonical = safeInput();
  exactCanonical.canonicalWorkflow = maximumWorkflow;
  assert.deepEqual(codes(exactCanonical), []);
});

test("sorts independent boundary diagnostics by stable public code", () => {
  const input = safeInput();
  input.baseSha = "moving";
  input.changedPaths = ["docs/../policy"];
  input.candidateMode = "100755";
  assert.deepEqual(codes(input), [
    "candidate-blob-boundary",
    "diff-boundary",
    "immutable-sha-boundary",
  ]);
});

test("CLI reads bounded files, preserves NUL path records, and exposes exit status", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "zerglang-anchor-policy-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const diffPath = join(directory, "changed-paths.z");
  const candidatePath = join(directory, "candidate.yml");
  const canonicalPath = join(directory, "canonical.yml");
  await writeFile(diffPath, Buffer.alloc(0));
  await writeFile(candidatePath, releaseWorkflow);
  await writeFile(canonicalPath, releaseWorkflow);
  const argumentsFor = (size = Buffer.byteLength(releaseWorkflow)) => [
    "a".repeat(40),
    "b".repeat(40),
    diffPath,
    "100644",
    String(size),
    candidatePath,
    canonicalPath,
  ];

  const valid = await runEvaluator(argumentsFor());
  assert.deepEqual(valid, {
    status: 0,
    stdout: `${JSON.stringify({ diagnostics: [] }, null, 2)}\n`,
    stderr: "",
  });

  await writeFile(diffPath, "scripts/new-policy.mjs\0");
  const protectedChange = await runEvaluator(argumentsFor());
  assert.equal(protectedChange.status, 1);
  assert.deepEqual(JSON.parse(protectedChange.stdout).diagnostics, [
    {
      code: "protected-policy-change",
      message:
        "protected-base policy code requires a separately audited bootstrap",
    },
  ]);
  assert.equal(protectedChange.stderr, "");

  await writeFile(diffPath, "docs/not-terminated.md");
  const unterminated = await runEvaluator(argumentsFor());
  assert.equal(unterminated.status, 1);
  assert.equal(unterminated.stdout, "");
  assert.equal(
    unterminated.stderr,
    "anchored-policy: candidate diff must be NUL terminated\n",
  );

  const wrongArguments = await runEvaluator([]);
  assert.equal(wrongArguments.status, 1);
  assert.equal(wrongArguments.stdout, "");
  assert.equal(
    wrongArguments.stderr,
    "anchored-policy: usage: anchored-policy.mjs BASE_SHA HEAD_SHA DIFF_Z MODE SIZE CANDIDATE.yml CANONICAL.yml\n",
  );

  const directoryInput = join(directory, "not-a-file");
  await mkdir(directoryInput);
  const nonFile = await runEvaluator([
    "a".repeat(40),
    "b".repeat(40),
    directoryInput,
    "100644",
    String(Buffer.byteLength(releaseWorkflow)),
    candidatePath,
    canonicalPath,
  ]);
  assert.equal(nonFile.status, 1);
  assert.equal(
    nonFile.stderr,
    "anchored-policy: candidate diff exceeds its byte boundary\n",
  );
});

test("CLI accepts exact reader ceilings and rejects the first oversized byte", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "zerglang-anchor-ceiling-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const diffPath = join(directory, "changed-paths.z");
  const candidatePath = join(directory, "candidate.yml");
  const canonicalPath = join(directory, "canonical.yml");
  const maximumWorkflow = `${releaseWorkflow}\n#${" ".repeat(
    MAX_BOUNDARY_BYTES - Buffer.byteLength(releaseWorkflow) - 2,
  )}`;
  await writeFile(diffPath, Buffer.alloc(0));
  await writeFile(candidatePath, maximumWorkflow);
  await writeFile(canonicalPath, releaseWorkflow);
  const baseArguments = [
    "a".repeat(40),
    "b".repeat(40),
    diffPath,
    "100644",
    String(MAX_BOUNDARY_BYTES),
    candidatePath,
    canonicalPath,
  ];
  assert.equal((await runEvaluator(baseArguments)).status, 0);

  await writeFile(diffPath, Buffer.alloc(MAX_BOUNDARY_BYTES));
  const exactDiff = await runEvaluator(baseArguments);
  assert.equal(exactDiff.status, 1);
  assert.deepEqual(
    JSON.parse(exactDiff.stdout).diagnostics.map(({ code }) => code),
    ["diff-boundary"],
  );
  assert.equal(exactDiff.stderr, "");

  await writeFile(diffPath, Buffer.alloc(MAX_BOUNDARY_BYTES + 1));
  const oversizedDiff = await runEvaluator(baseArguments);
  assert.equal(oversizedDiff.status, 1);
  assert.equal(oversizedDiff.stdout, "");
  assert.equal(
    oversizedDiff.stderr,
    "anchored-policy: candidate diff exceeds its byte boundary\n",
  );

  await writeFile(diffPath, Buffer.alloc(0));
  await writeFile(candidatePath, `${maximumWorkflow} `);
  const oversizedCandidate = await runEvaluator([
    ...baseArguments.slice(0, 4),
    String(MAX_BOUNDARY_BYTES + 1),
    candidatePath,
    canonicalPath,
  ]);
  assert.equal(oversizedCandidate.status, 1);
  assert.equal(oversizedCandidate.stdout, "");
  assert.equal(
    oversizedCandidate.stderr,
    "anchored-policy: candidate workflow exceeds its byte boundary\n",
  );

  await writeFile(candidatePath, releaseWorkflow);
  await writeFile(canonicalPath, `${maximumWorkflow} `);
  const oversizedCanonical = await runEvaluator([
    ...baseArguments.slice(0, 4),
    String(Buffer.byteLength(releaseWorkflow)),
    candidatePath,
    canonicalPath,
  ]);
  assert.equal(oversizedCanonical.status, 1);
  assert.equal(oversizedCanonical.stdout, "");
  assert.equal(
    oversizedCanonical.stderr,
    "anchored-policy: canonical workflow exceeds its byte boundary\n",
  );
});
