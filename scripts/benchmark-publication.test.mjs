import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, verify as verifyBytes } from "node:crypto";
import { mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  admitPublicationRequest,
  assertPrivateKeyTrusted,
  canonicalJson,
  contentIdentity,
  createSignedManifest,
  publishPagesManifest,
  validateBundle,
  validateDeliveryRequest,
  validatePublicationRequest,
  validateTrustStore,
  verifySignedIndex,
  verifySignedManifest,
} from "./benchmark-publication.mjs";
import { generateBenchmarkFixture } from "./generate-benchmark-fixture.mjs";

const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);
const SHA_C = "c".repeat(40);
const SHA_D = "d".repeat(64);
const CONTAMINATION_WARNING =
  "Public candidate source may contaminate future model-synthesis evaluations.";

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function artifact(pathname, role, contents, mediaType = "application/json") {
  return {
    path: pathname,
    role,
    media_type: mediaType,
    size_bytes: Buffer.byteLength(contents),
    sha256: sha256(contents),
  };
}

function unsignedRequest(artifacts, overrides = {}) {
  const document = {
    schema: "zerglang.benchmark-publication-request/1",
    run_id: "",
    content_sha256: "",
    suite: {
      id: "zl256",
      dataset_id: SHA_A,
      profile_id: "current",
      profile_identity: SHA_B,
      lane: "conformance",
      view: "current",
    },
    source: {
      repository: "Epoch-ML/zerg",
      ref: "refs/heads/development",
      commit_sha: SHA_C,
      release: null,
    },
    workflow: {
      name: "ZergLang ZL256 benchmarks",
      url: "https://github.com/Epoch-ML/zerg/actions/runs/12345",
      run_id: "12345",
      run_attempt: 2,
      event: "push",
    },
    execution: {
      compiler_id: SHA_C,
      executor_sha256: SHA_D,
      harness_version: "0.2.0",
      command: ["python", "-m", "tools.zlbench", "run"],
      filters: { category: ["algorithm", "shared"], view: "current" },
      shards: { count: 4, completed: [0, 1, 2, 3] },
    },
    platform: {
      id: "ubuntu-24.04-x86_64",
      os: "linux",
      arch: "x86_64",
      machine: "GitHub-hosted runner",
      toolchain: "ubuntu-24.04-c17-portable",
    },
    model: null,
    timestamps: {
      started_at: "2026-08-23T10:00:00.000Z",
      completed_at: "2026-08-23T10:02:00.000Z",
    },
    status: "complete",
    artifacts,
    disclosure: {
      candidate_source_public: false,
      contamination_warning: null,
      excluded_material: {
        hidden_tests: true,
        held_out_inputs: true,
        held_out_oracles: true,
        executable_oracle_code: true,
        reference_solutions: true,
      },
    },
    signature: null,
    ...overrides,
  };
  const identity = contentIdentity(document);
  return { ...document, run_id: identity.run_id, content_sha256: identity.content_sha256 };
}

function publicTask({
  taskId,
  caseId,
  executor,
  maturity = "verified",
  synthesisEligible = false,
}) {
  const source = "module benchmark_publication_fixture;\n";
  return {
    schema: "zerglang.benchmark-public-task/1",
    id: taskId,
    revision: 1,
    title: "Publication fixture",
    maturity,
    category: taskId.split("/")[0],
    edition: "core-1",
    preview: "shared",
    domains: ["algorithm"],
    modalities: ["interpreted"],
    tiers: ["interpreter"],
    clauses: [],
    boundaries: [],
    execution: {
      operation: "algorithm",
      selector: "benchmark_publication_fixture.main",
      executors: [executor],
      platforms: ["portable"],
    },
    cases:
      caseId === null
        ? []
        : [
            {
              id: caseId,
              visibility: "public",
              input: { type: "unit" },
              oracle: { kind: "value", value: { type: "unit" } },
            },
          ],
    synthesis: synthesisEligible
      ? {
          eligible: true,
          prompt: "Return the complete candidate.",
          interface: "public value Solution;\n",
          contamination_warning: CONTAMINATION_WARNING,
        }
      : { eligible: false },
    performance: { eligible: false },
    limits: {
      timeout_ms: 1000,
      memory_bytes: "1048576",
      operations: "1000",
    },
    provenance: [
      {
        kind: "original",
        source: "ZergLang",
        license: "CC0-1.0",
      },
    ],
    source: synthesisEligible
      ? { availability: "withheld", reason: "active-synthesis-reference" }
      : {
          availability: "published",
          entry: "main.zl",
          files: [
            {
              path: "main.zl",
              sha256: sha256(source),
              content: source,
            },
          ],
        },
  };
}

function conformanceFixture() {
  const metadata = {
    catalog_id: SHA_A,
    profile_id: "current",
    profile_identity: SHA_B,
    compiler_id: SHA_C,
    platform_id: "ubuntu-24.04-x86_64",
    toolchain_id: "ubuntu-24.04-c17-portable",
    model_id: null,
  };
  const resultsDocument = {
    schema: "zerglang.benchmark-public-results/1",
    dataset_id: SHA_A,
    profile_identity: SHA_B,
    public_observations: [
      {
        task_id: "shared/answer",
        task_revision: 1,
        case_id: "public-answer",
        executor: "interpreter",
        fixture_maturity: "verified",
        profile_status: "pass",
        edition_status: "pass",
        failure_kind: null,
        diagnostic_code: null,
      },
    ],
    non_public_aggregates: [
      {
        task_id: "shared/answer",
        task_revision: 1,
        executor: "interpreter",
        case_count: 1,
        profile: { pass: 1 },
        edition: { pass: 1 },
        failures: {},
      },
    ],
  };
  const reportDocument = {
    schema: "zerglang.benchmark-public-report/1",
    metadata,
    summary: {
      total: 2,
      profile: { pass: 2 },
      edition: { pass: 2 },
      failures: {},
    },
    results_sha256: sha256(canonicalJson(resultsDocument)),
  };
  const catalogDocument = {
    schema: "zerglang.benchmark-public-catalog/1",
    dataset_id: SHA_A,
    name: "ZL256",
    version: "0.2.0",
    authority: { clauses: [], boundaries: [] },
    tasks: [
      publicTask({
        taskId: "shared/answer",
        caseId: "public-answer",
        executor: "interpreter",
      }),
    ],
  };
  const files = new Map([
    ["artifacts/catalog.json", `${canonicalJson(catalogDocument)}\n`],
    ["artifacts/report.json", `${canonicalJson(reportDocument)}\n`],
    ["artifacts/results.json", `${canonicalJson(resultsDocument)}\n`],
  ]);
  const artifacts = [
    artifact("artifacts/catalog.json", "task_catalog", files.get("artifacts/catalog.json")),
    artifact(
      "artifacts/report.json",
      "public_report",
      files.get("artifacts/report.json"),
    ),
    artifact(
      "artifacts/results.json",
      "public_results",
      files.get("artifacts/results.json"),
    ),
  ];
  return { files, request: unsignedRequest(artifacts) };
}

function performanceFixture() {
  const catalog = JSON.parse(conformanceFixture().files.get("artifacts/catalog.json"));
  const performance = {
    schema: "zerglang.benchmark-public-performance/1",
    metadata: {
      catalog_id: SHA_A,
      profile_id: "current",
      profile_identity: SHA_B,
      compiler_id: SHA_C,
      platform_id: "ubuntu-24.04-x86_64",
      toolchain_id: "ubuntu-24.04-c17-portable",
      model_id: null,
    },
    measurements: [
      {
        task_id: "shared/answer",
        task_revision: 1,
        case_id: "public-answer",
        executor: "interpreter",
        warmup_count: 1,
        sample_count: 2,
        sample_durations_ns: ["10", "12"],
        valid: true,
        median_ns: "11",
        mad_ns: "1",
      },
    ],
  };
  const files = new Map([
    ["artifacts/catalog.json", `${canonicalJson(catalog)}\n`],
    ["artifacts/performance.json", `${canonicalJson(performance)}\n`],
  ]);
  const artifacts = [
    artifact("artifacts/catalog.json", "task_catalog", files.get("artifacts/catalog.json")),
    artifact(
      "artifacts/performance.json",
      "public_performance",
      files.get("artifacts/performance.json"),
    ),
  ];
  const base = unsignedRequest(artifacts);
  return {
    files,
    request: unsignedRequest(artifacts, {
      suite: { ...base.suite, lane: "performance" },
    }),
  };
}

function synthesisFixture() {
  const candidate = "algorithm message answer() -> I32 { return 42; }\n";
  const candidatePath = "artifacts/candidates/algorithm-answer/0/main.zl";
  const catalogDocument = {
    schema: "zerglang.benchmark-public-catalog/1",
    dataset_id: SHA_A,
    name: "ZL256",
    version: "0.2.0",
    authority: { clauses: [], boundaries: [] },
    tasks: [
      publicTask({
        taskId: "algorithm/answer",
        caseId: null,
        executor: "codex-app-server",
        synthesisEligible: true,
      }),
    ],
  };
  const candidateReference = {
    artifact_path: candidatePath,
    sha256: sha256(candidate),
    public: true,
    contamination_warning: CONTAMINATION_WARNING,
  };
  const synthesisDocument = {
    schema: "zerglang.benchmark-public-synthesis/1",
    catalog_id: SHA_A,
    profile_identity: SHA_B,
    candidate_source_public: true,
    contamination_warning: CONTAMINATION_WARNING,
    tasks: [
      {
        task_id: "algorithm/answer",
        task_revision: 1,
        samples: [
          {
            sample_index: 0,
            attempted: true,
            outcome: "pass",
            single_shot_pass: true,
            repaired_pass: true,
            repair_turns: 0,
            backend: {
              adapter: "codex-app-server",
              provider: "openai",
              model: "gpt-test",
              reasoning: "high",
              protocol: "1.1",
            },
            candidate: candidateReference,
          },
          {
            sample_index: 1,
            attempted: false,
            outcome: "unavailable",
            single_shot_pass: false,
            repaired_pass: false,
            repair_turns: 0,
            backend: null,
            candidate: null,
          },
        ],
        pass_at_k: {
          1: { numerator: "1", denominator: "2" },
          2: { numerator: "1", denominator: "1" },
        },
        repair_at_3: {
          correct: 1,
          total: 2,
          rate: { numerator: "1", denominator: "2" },
        },
      },
    ],
  };
  const files = new Map([
    ["artifacts/catalog.json", `${canonicalJson(catalogDocument)}\n`],
    [candidatePath, candidate],
    ["artifacts/synthesis.json", `${canonicalJson(synthesisDocument)}\n`],
  ]);
  const artifacts = [
    artifact("artifacts/catalog.json", "task_catalog", files.get("artifacts/catalog.json")),
    artifact(candidatePath, "candidate_source", candidate, "text/x-zerglang"),
    artifact(
      "artifacts/synthesis.json",
      "public_synthesis",
      files.get("artifacts/synthesis.json"),
    ),
  ].sort((left, right) => left.path.localeCompare(right.path));
  const base = unsignedRequest(artifacts);
  return {
    files,
    request: unsignedRequest(artifacts, {
      suite: { ...base.suite, lane: "synthesis" },
      model: {
        provider: "openai",
        model: "gpt-test",
        adapter: "codex-app-server",
        temperature: "0",
        seed: 7,
      },
      disclosure: {
        ...base.disclosure,
        candidate_source_public: true,
        contamination_warning: CONTAMINATION_WARNING,
      },
    }),
  };
}

async function makeBundle(fixture = conformanceFixture()) {
  const root = await import("node:fs/promises").then(({ mkdtemp }) =>
    mkdtemp(path.join(tmpdir(), "zlbench-bundle-")),
  );
  await writeFile(
    path.join(root, "publication.json"),
    `${canonicalJson(fixture.request)}\n`,
    "utf8",
  );
  for (const [relativePath, contents] of fixture.files) {
    const absolutePath = path.join(root, relativePath);
    await mkdir(path.dirname(absolutePath), { recursive: true });
    await writeFile(absolutePath, contents, "utf8");
  }
  return root;
}

function keyPair() {
  return generateKeyPairSync("ed25519", {
    privateKeyEncoding: { format: "pem", type: "pkcs8" },
    publicKeyEncoding: { format: "pem", type: "spki" },
  });
}

function signedManifest(request, keys = keyPair(), publishedAt = "2026-08-23T11:00:00.000Z") {
  return {
    keys,
    manifest: createSignedManifest(request, {
      publishedAt,
      repository: "Epoch-ML/zerglang-releases",
      bundleAsset: `zlbench-${request.run_id}.tar.gz`,
      bundleSha256: "e".repeat(64),
      keyId: "zlbench-ed25519-2026-08",
      privateKey: keys.privateKey,
    }),
  };
}

test("canonical JSON has recursively sorted keys and no insignificant whitespace", () => {
  assert.equal(
    canonicalJson({ zebra: 2, alpha: { two: true, one: [3, "x"] } }),
    '{"alpha":{"one":[3,"x"],"two":true},"zebra":2}',
  );
});

test("the committed empty discovery index has a valid pinned-key signature", async () => {
  const [index, signature, trustDocument] = await Promise.all([
    readFile(new URL("../site/benchmarks/index.json", import.meta.url), "utf8"),
    readFile(
      new URL("../site/benchmarks/index.signature.json", import.meta.url),
      "utf8",
    ),
    readFile(new URL("../site/benchmarks/keys.json", import.meta.url), "utf8"),
  ]);
  const indexDocument = JSON.parse(index);
  const verified = verifySignedIndex(
    indexDocument,
    JSON.parse(signature),
    validateTrustStore(JSON.parse(trustDocument)),
  );

  assert.equal(verified.updated_at, "1970-01-01T00:00:00.000Z");
  assert.deepEqual(verified.runs, []);
});

test("validates an immutable, content-addressed complete request", () => {
  const { request } = conformanceFixture();
  const validated = validatePublicationRequest(request);

  assert.equal(validated.content_sha256.length, 64);
  assert.equal(validated.run_id, `run-${validated.content_sha256.slice(0, 32)}`);
  assert.equal(validated.artifacts.length, 3);
  assert.equal(admitPublicationRequest(request).status, "complete");
});

test("content identity excludes only its derived fields and signature", () => {
  const { request } = conformanceFixture();
  const alteredDerivedFields = {
    ...request,
    run_id: "run-deadbeefdeadbeefdeadbeefdeadbeef",
    content_sha256: "f".repeat(64),
    signature: { forged: true },
  };

  assert.deepEqual(contentIdentity(alteredDerivedFields), contentIdentity(request));
  assert.notEqual(
    contentIdentity({ ...request, status: "partial" }).content_sha256,
    request.content_sha256,
  );
});

test("rejects unknown policy fields and non-canonical model numbers", () => {
  const { request } = conformanceFixture();
  assert.throws(
    () => validatePublicationRequest({ ...request, publish_hidden: true }),
    /unexpected field: publish_hidden/,
  );
  const model = {
    provider: "openai",
    model: "gpt-test",
    adapter: "responses-v1",
    temperature: 0.2,
    seed: 7,
  };
  assert.throws(
    () => validatePublicationRequest({ ...request, model }),
    /model\.temperature must be a canonical decimal string or null/,
  );
});

test("rejects partial evidence at the public admission boundary", () => {
  const { request } = conformanceFixture();
  const partial = unsignedRequest(request.artifacts, { status: "partial" });
  assert.equal(validatePublicationRequest(partial).status, "partial");
  assert.throws(
    () => admitPublicationRequest(partial),
    /only complete benchmark evidence may be published/,
  );
});

test("orders valid UTC timestamps by instant instead of fractional spelling", () => {
  const { request } = conformanceFixture();
  const timestamps = {
    started_at: "2026-08-23T10:00:00Z",
    completed_at: "2026-08-23T10:00:00.001Z",
  };
  const fractional = unsignedRequest(request.artifacts, { timestamps });

  assert.equal(
    validatePublicationRequest(fractional).timestamps.completed_at,
    "2026-08-23T10:00:00.001Z",
  );
  assert.doesNotThrow(() =>
    signedManifest(fractional, keyPair(), "2026-08-23T10:00:00.002Z"),
  );
});

test("admits only protected source branches or release tags", () => {
  const { request } = conformanceFixture();
  const source = { ...request.source, ref: "refs/heads/zerglang-3" };
  const featureRun = unsignedRequest(request.artifacts, { source });
  assert.equal(validatePublicationRequest(featureRun).source.ref, "refs/heads/zerglang-3");
  assert.throws(
    () => admitPublicationRequest(featureRun),
    /official evidence must come from a protected branch or ZergLang release tag/,
  );
});

test("requires the exact non-public-material exclusions", () => {
  const { request } = conformanceFixture();
  const disclosure = {
    ...request.disclosure,
    excluded_material: {
      ...request.disclosure.excluded_material,
      held_out_oracles: false,
    },
  };
  assert.throws(
    () => validatePublicationRequest(unsignedRequest(request.artifacts, { disclosure })),
    /held_out_oracles must equal true/,
  );
});

test("requires a visible contamination warning whenever candidate source is public", () => {
  const { files, request: publicCandidate } = synthesisFixture();
  assert.equal(validatePublicationRequest(publicCandidate).disclosure.contamination_warning, CONTAMINATION_WARNING);

  assert.throws(
    () =>
      validatePublicationRequest(
        unsignedRequest(publicCandidate.artifacts, {
          suite: publicCandidate.suite,
          model: publicCandidate.model,
          disclosure: {
            ...publicCandidate.disclosure,
            contamination_warning: "Source included.",
          },
        }),
      ),
    /contamination_warning must equal/,
  );
  const conformance = conformanceFixture();
  const candidate = files.get("artifacts/candidates/algorithm-answer/0/main.zl");
  const conformanceArtifacts = [
    ...conformance.request.artifacts,
    artifact(
      "artifacts/candidates/answer.zl",
      "candidate_source",
      candidate,
      "text/x-zerglang",
    ),
  ].sort((left, right) => left.path.localeCompare(right.path));
  assert.throws(
    () =>
      validatePublicationRequest(
        unsignedRequest(conformanceArtifacts, {
          disclosure: publicCandidate.disclosure,
          model: publicCandidate.model,
          suite: conformance.request.suite,
        }),
      ),
    /candidate source is only valid for synthesis publication/,
  );
  assert.match(files.get("artifacts/candidates/algorithm-answer/0/main.zl"), /return 42/);
});

test("validates the exact bundle inventory and artifact digests", async () => {
  const root = await makeBundle();
  const request = await validateBundle(root);
  assert.equal(request.artifacts[1].path, "artifacts/report.json");

  const reportPath = path.join(root, "artifacts/report.json");
  const report = await readFile(reportPath, "utf8");
  await writeFile(reportPath, report.replace("public-report", "public-reporu"), "utf8");
  await assert.rejects(() => validateBundle(root), /digest mismatch for artifacts\/report\.json/);
});

test("binds public case observations to catalog task revisions and case IDs", async () => {
  const fixture = conformanceFixture();
  const catalog = JSON.parse(fixture.files.get("artifacts/catalog.json"));
  catalog.tasks = [];
  const changed = `${canonicalJson(catalog)}\n`;
  fixture.files.set("artifacts/catalog.json", changed);
  fixture.request = unsignedRequest(
    fixture.request.artifacts.map((item) =>
      item.path === "artifacts/catalog.json"
        ? artifact(item.path, item.role, changed, item.media_type)
        : item,
    ),
  );
  const root = await makeBundle(fixture);

  await assert.rejects(
    () => validateBundle(root),
    /public result does not match a public catalog (?:task revision|case)/,
  );
});

test("binds public performance measurements to catalog public cases", async () => {
  const fixture = performanceFixture();
  const root = await makeBundle(fixture);
  assert.equal((await validateBundle(root)).suite.lane, "performance");

  const performance = JSON.parse(fixture.files.get("artifacts/performance.json"));
  performance.measurements[0].case_id = "held-or-missing";
  const changed = `${canonicalJson(performance)}\n`;
  fixture.files.set("artifacts/performance.json", changed);
  fixture.request = unsignedRequest(
    fixture.request.artifacts.map((item) =>
      item.path === "artifacts/performance.json"
        ? artifact(item.path, item.role, changed, item.media_type)
        : item,
    ),
    { suite: fixture.request.suite },
  );
  const invalidRoot = await makeBundle(fixture);

  await assert.rejects(
    () => validateBundle(invalidRoot),
    /public performance measurement does not match a public catalog case/,
  );
});

test("withholds property evaluators while retaining public diagnostic oracle codes", async () => {
  const diagnosticFixture = conformanceFixture();
  const diagnosticCatalog = JSON.parse(
    diagnosticFixture.files.get("artifacts/catalog.json"),
  );
  diagnosticCatalog.tasks[0].cases[0].oracle = {
    kind: "diagnostic",
    code: "ZL-TEST-0001",
  };
  const diagnosticText = `${canonicalJson(diagnosticCatalog)}\n`;
  diagnosticFixture.files.set("artifacts/catalog.json", diagnosticText);
  diagnosticFixture.request = unsignedRequest(
    diagnosticFixture.request.artifacts.map((item) =>
      item.path === "artifacts/catalog.json"
        ? artifact(item.path, item.role, diagnosticText, item.media_type)
        : item,
    ),
  );
  assert.equal((await validateBundle(await makeBundle(diagnosticFixture))).status, "complete");

  const propertyFixture = conformanceFixture();
  const propertyCatalog = JSON.parse(propertyFixture.files.get("artifacts/catalog.json"));
  propertyCatalog.tasks[0].cases[0].oracle = {
    kind: "property",
    evaluator: "private/oracle.py",
  };
  const propertyText = `${canonicalJson(propertyCatalog)}\n`;
  propertyFixture.files.set("artifacts/catalog.json", propertyText);
  propertyFixture.request = unsignedRequest(
    propertyFixture.request.artifacts.map((item) =>
      item.path === "artifacts/catalog.json"
        ? artifact(item.path, item.role, propertyText, item.media_type)
        : item,
    ),
  );
  const propertyRoot = await makeBundle(propertyFixture);
  await assert.rejects(
    () => validateBundle(propertyRoot),
    /property oracle must withhold executable oracle code/,
  );
});

test("rejects unlisted files and symbolic links", async () => {
  const extraRoot = await makeBundle();
  await writeFile(path.join(extraRoot, "artifacts/hidden-test.json"), "{}\n", "utf8");
  await assert.rejects(() => validateBundle(extraRoot), /unlisted bundle file/);

  const symlinkRoot = await makeBundle();
  await symlink("catalog.json", path.join(symlinkRoot, "artifacts/catalog-link.json"));
  await assert.rejects(() => validateBundle(symlinkRoot), /symbolic links are forbidden/);
});

test("raw case-result records cannot masquerade as the public result projection", async () => {
  const fixture = conformanceFixture();
  const heldLeak =
    '{"schema":"zerglang.benchmark-case-result/2","task_id":"shared/secret","case_id":"held-7","diagnostic":"expected 42"}\n';
  fixture.files.set("artifacts/results.json", heldLeak);
  fixture.request = unsignedRequest(
    fixture.request.artifacts.map((item) =>
      item.path === "artifacts/results.json"
        ? artifact(item.path, item.role, heldLeak, item.media_type)
        : item,
    ),
  );
  const root = await makeBundle(fixture);
  await assert.rejects(
    () => validateBundle(root),
    /public_results must use zerglang\.benchmark-public-results\/1/,
  );
});

test("rejects held-out visibility from every public JSON projection", async () => {
  const fixture = conformanceFixture();
  const leak = `${canonicalJson({
    schema: "zerglang.benchmark-public-task/1",
    case: { visibility: "held-out", input: { value: 42 } },
  })}\n`;
  fixture.files.set("artifacts/task.json", leak);
  fixture.request = unsignedRequest(
    [
      ...fixture.request.artifacts,
      artifact("artifacts/task.json", "task_projection", leak),
    ].sort((left, right) => left.path.localeCompare(right.path)),
  );
  const root = await makeBundle(fixture);

  await assert.rejects(() => validateBundle(root), /held-out visibility is forbidden/);
});

test("public report digest must bind the aggregate-safe public results", async () => {
  const fixture = conformanceFixture();
  const report = JSON.parse(fixture.files.get("artifacts/report.json"));
  report.results_sha256 = "0".repeat(64);
  const changed = `${canonicalJson(report)}\n`;
  fixture.files.set("artifacts/report.json", changed);
  fixture.request = unsignedRequest(
    fixture.request.artifacts.map((item) =>
      item.path === "artifacts/report.json"
        ? artifact(item.path, item.role, changed, item.media_type)
        : item,
    ),
  );
  const root = await makeBundle(fixture);
  await assert.rejects(
    () => validateBundle(root),
    /public report does not bind public results/,
  );
});

test("admits aggregate-safe synthesis and binds every public candidate exactly once", async () => {
  const fixture = synthesisFixture();
  const root = await makeBundle(fixture);

  assert.equal((await validateBundle(root)).suite.lane, "synthesis");

  const synthesis = JSON.parse(fixture.files.get("artifacts/synthesis.json"));
  synthesis.tasks[0].samples[1].attempted = true;
  synthesis.tasks[0].samples[1].outcome = "wrong";
  synthesis.tasks[0].samples[1].backend = {
    ...synthesis.tasks[0].samples[0].backend,
  };
  synthesis.tasks[0].samples[1].candidate = {
    ...synthesis.tasks[0].samples[0].candidate,
  };
  const duplicate = `${canonicalJson(synthesis)}\n`;
  fixture.files.set("artifacts/synthesis.json", duplicate);
  fixture.request = unsignedRequest(
    fixture.request.artifacts.map((item) =>
      item.path === "artifacts/synthesis.json"
        ? artifact(item.path, item.role, duplicate, item.media_type)
        : item,
    ),
    {
      suite: fixture.request.suite,
      model: fixture.request.model,
      disclosure: fixture.request.disclosure,
    },
  );
  const duplicateRoot = await makeBundle(fixture);
  await assert.rejects(
    () => validateBundle(duplicateRoot),
    /candidate artifact must be referenced exactly once/,
  );
});

test("rejects raw synthesis reports and candidate digest substitution", async () => {
  const rawFixture = synthesisFixture();
  const raw = JSON.parse(rawFixture.files.get("artifacts/synthesis.json"));
  raw.schema = "zerglang.benchmark-synthesis-report/1";
  delete raw.candidate_source_public;
  delete raw.contamination_warning;
  const rawText = `${canonicalJson(raw)}\n`;
  rawFixture.files.set("artifacts/synthesis.json", rawText);
  rawFixture.request = unsignedRequest(
    rawFixture.request.artifacts.map((item) =>
      item.path === "artifacts/synthesis.json"
        ? artifact(item.path, item.role, rawText, item.media_type)
        : item,
    ),
    {
      suite: rawFixture.request.suite,
      model: rawFixture.request.model,
      disclosure: rawFixture.request.disclosure,
    },
  );
  const rawRoot = await makeBundle(rawFixture);
  await assert.rejects(
    () => validateBundle(rawRoot),
    /public_synthesis must use zerglang\.benchmark-public-synthesis\/1/,
  );

  const digestFixture = synthesisFixture();
  const synthesis = JSON.parse(digestFixture.files.get("artifacts/synthesis.json"));
  synthesis.tasks[0].samples[0].candidate.sha256 = "f".repeat(64);
  const digestText = `${canonicalJson(synthesis)}\n`;
  digestFixture.files.set("artifacts/synthesis.json", digestText);
  digestFixture.request = unsignedRequest(
    digestFixture.request.artifacts.map((item) =>
      item.path === "artifacts/synthesis.json"
        ? artifact(item.path, item.role, digestText, item.media_type)
        : item,
    ),
    {
      suite: digestFixture.request.suite,
      model: digestFixture.request.model,
      disclosure: digestFixture.request.disclosure,
    },
  );
  const digestRoot = await makeBundle(digestFixture);
  await assert.rejects(
    () => validateBundle(digestRoot),
    /candidate digest does not match/,
  );
});

test("signs the release binding and rejects manifest tampering", () => {
  const { request } = conformanceFixture();
  const { keys, manifest } = signedManifest(request);
  const trust = {
    "zlbench-ed25519-2026-08": {
      public_key_pem: keys.publicKey,
      status: "active",
    },
  };

  assert.equal(verifySignedManifest(manifest, trust).request.run_id, request.run_id);
  const tampered = {
    ...manifest,
    publication: { ...manifest.publication, bundle_sha256: "0".repeat(64) },
  };
  assert.throws(() => verifySignedManifest(tampered, trust), /signature verification failed/);
  assert.throws(() => verifySignedManifest(manifest, {}), /untrusted benchmark signing key/);
});

test("retired benchmark keys verify history but cannot sign new releases", () => {
  const { request } = conformanceFixture();
  const { keys, manifest } = signedManifest(request);
  const trust = validateTrustStore({
    schema: "zerglang.benchmark-signing-keys/1",
    keys: [
      {
        algorithm: "Ed25519",
        key_id: "zlbench-ed25519-2026-08",
        public_key_pem: keys.publicKey,
        status: "retired",
      },
    ],
  });

  assert.equal(verifySignedManifest(manifest, trust).request.run_id, request.run_id);
  assert.throws(
    () =>
      assertPrivateKeyTrusted(
        "zlbench-ed25519-2026-08",
        keys.privateKey,
        trust,
      ),
    /retired benchmark signing key cannot sign new releases/,
  );
});

test("publishes append-only Pages manifests and advances a lane pointer", async () => {
  const { request } = conformanceFixture();
  const { keys, manifest } = signedManifest(request);
  const bundleRoot = await makeBundle();
  const siteRoot = await import("node:fs/promises").then(({ mkdtemp }) =>
    mkdtemp(path.join(tmpdir(), "zlbench-pages-")),
  );
  const trust = {
    "zlbench-ed25519-2026-08": {
      public_key_pem: keys.publicKey,
      status: "active",
    },
  };

  const entry = await publishPagesManifest(siteRoot, manifest, trust, bundleRoot, {
    keyId: "zlbench-ed25519-2026-08",
    privateKey: keys.privateKey,
  });
  assert.equal(entry.run_id, request.run_id);
  const index = JSON.parse(
    await readFile(path.join(siteRoot, "benchmarks/index.json"), "utf8"),
  );
  const latest = JSON.parse(
    await readFile(path.join(siteRoot, "benchmarks/latest/zl256/conformance.json"), "utf8"),
  );
  const indexSignature = JSON.parse(
    await readFile(path.join(siteRoot, "benchmarks/index.signature.json"), "utf8"),
  );
  assert.equal(index.runs.length, 1);
  assert.equal(indexSignature.schema, "zerglang.benchmark-index-signature/1");
  assert.equal(indexSignature.index_sha256, sha256(canonicalJson(index)));
  assert.equal(indexSignature.key_id, "zlbench-ed25519-2026-08");
  assert.equal(
    verifyBytes(
      null,
      Buffer.from(canonicalJson(index)),
      keys.publicKey,
      Buffer.from(indexSignature.value, "base64"),
    ),
    true,
  );
  assert.equal(index.runs[0].manifest_sha256, sha256(`${canonicalJson(manifest)}\n`));
  assert.equal(
    index.runs[0].public_artifact_base,
    `/benchmarks/runs/${request.run_id}/artifacts/`,
  );
  assert.equal(latest.run_id, request.run_id);
  assert.equal(
    JSON.parse(
      await readFile(
        path.join(siteRoot, `benchmarks/runs/${request.run_id}/artifacts/report.json`),
        "utf8",
      ),
    ).schema,
    "zerglang.benchmark-public-report/1",
  );

  await writeFile(
    path.join(siteRoot, "benchmarks/index.json"),
    `${canonicalJson({ ...index, runs: [] })}\n`,
    "utf8",
  );
  await assert.rejects(
    () => publishPagesManifest(siteRoot, manifest, trust, bundleRoot, {
      keyId: "zlbench-ed25519-2026-08",
      privateKey: keys.privateKey,
    }),
    /index digest does not match its signature/,
  );
  await writeFile(
    path.join(siteRoot, "benchmarks/index.json"),
    `${canonicalJson(index)}\n`,
    "utf8",
  );

  await assert.rejects(
    () => publishPagesManifest(siteRoot, manifest, trust, bundleRoot),
    /run is already published and cannot be overwritten/,
  );
});

test("Pages excludes candidate source and never indexes a partial run directory", async () => {
  const generated = await import("node:fs/promises").then(({ mkdtemp }) =>
    mkdtemp(path.join(tmpdir(), "zlbench-pages-bundle-")),
  );
  await generateBenchmarkFixture(generated);
  const manifest = JSON.parse(await readFile(path.join(generated, "manifest.json"), "utf8"));
  const trust = validateTrustStore(
    JSON.parse(await readFile(path.join(generated, "keys.json"), "utf8")),
  );
  const siteRoot = await import("node:fs/promises").then(({ mkdtemp }) =>
    mkdtemp(path.join(tmpdir(), "zlbench-pages-partial-")),
  );
  const runRoot = path.join(siteRoot, `benchmarks/runs/${manifest.request.run_id}`);
  await mkdir(path.join(runRoot, "artifacts"), { recursive: true });
  await writeFile(path.join(runRoot, "artifacts/report.json"), "partial\n", "utf8");

  await assert.rejects(
    () => publishPagesManifest(siteRoot, manifest, trust, path.join(generated, "bundle")),
    /partial or conflicting run directory already exists/,
  );
  await assert.rejects(
    () => readFile(path.join(siteRoot, "benchmarks/index.json"), "utf8"),
    /ENOENT/,
  );
  await assert.rejects(
    () => readFile(path.join(runRoot, "artifacts/candidates/answer.zl"), "utf8"),
    /ENOENT/,
  );
});

test("Pages rejects artifact tampering before creating a run or index", async () => {
  const fixture = conformanceFixture();
  const bundleRoot = await makeBundle(fixture);
  const { keys, manifest } = signedManifest(fixture.request);
  const trust = { "zlbench-ed25519-2026-08": keys.publicKey };
  const siteRoot = await import("node:fs/promises").then(({ mkdtemp }) =>
    mkdtemp(path.join(tmpdir(), "zlbench-pages-tamper-")),
  );
  await writeFile(path.join(bundleRoot, "artifacts/report.json"), "{}\n", "utf8");

  await assert.rejects(
    () => publishPagesManifest(siteRoot, manifest, trust, bundleRoot),
    /size mismatch for artifacts\/report\.json/,
  );
  await assert.rejects(
    () => readFile(path.join(siteRoot, "benchmarks/index.json"), "utf8"),
    /ENOENT/,
  );
  await assert.rejects(
    () =>
      readFile(
        path.join(siteRoot, `benchmarks/runs/${fixture.request.run_id}/manifest.json`),
        "utf8",
      ),
    /ENOENT/,
  );
});

test("validates an immutable source-artifact delivery locator", () => {
  const { request } = conformanceFixture();
  const delivery = {
    schema: "zerglang.benchmark-publication-delivery/1",
    run_id: request.run_id,
    source_repository: "Epoch-ML/zerg",
    source_sha: SHA_C,
    workflow_run_id: "12345",
    workflow_run_attempt: 2,
    artifact_id: "998877",
    artifact_name: `zlbench-publication-${request.run_id}`,
    artifact_digest: `sha256:${SHA_D}`,
    requested_at: "2026-08-23T10:03:00.000Z",
  };

  assert.equal(validateDeliveryRequest(delivery).artifact_id, "998877");
  assert.throws(
    () => validateDeliveryRequest({ ...delivery, artifact_id: "latest" }),
    /artifact_id must be a positive decimal identifier/,
  );
});

test("generates the same minimal signed public bundle for site ingestion", async () => {
  const first = await import("node:fs/promises").then(({ mkdtemp }) =>
    mkdtemp(path.join(tmpdir(), "zlbench-fixture-a-")),
  );
  const second = await import("node:fs/promises").then(({ mkdtemp }) =>
    mkdtemp(path.join(tmpdir(), "zlbench-fixture-b-")),
  );
  await generateBenchmarkFixture(first);
  await generateBenchmarkFixture(second);

  const request = await validateBundle(path.join(first, "bundle"));
  const manifestText = await readFile(path.join(first, "manifest.json"), "utf8");
  const secondManifestText = await readFile(path.join(second, "manifest.json"), "utf8");
  const trust = validateTrustStore(
    JSON.parse(await readFile(path.join(first, "keys.json"), "utf8")),
  );
  const verified = verifySignedManifest(JSON.parse(manifestText), trust);

  assert.equal(manifestText, secondManifestText);
  assert.equal(verified.request.run_id, request.run_id);
  assert.equal(request.run_id, "run-2ef167cf94a1d3a4c7395719b40155df");
  assert.equal(verified.request.disclosure.contamination_warning, CONTAMINATION_WARNING);
  assert.equal(
    await readFile(path.join(first, "bundle/artifacts/candidates/answer.zl"), "utf8"),
    "algorithm message answer() -> I32 { return 42; }\n",
  );
});
