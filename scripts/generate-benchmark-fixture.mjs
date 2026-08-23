#!/usr/bin/env node

import { createHash, createPrivateKey, createPublicKey } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { gzipSync } from "node:zlib";

import {
  canonicalJson,
  contentIdentity,
  createSignedManifest,
} from "./benchmark-publication.mjs";

const TEST_KEY_ID = "zlbench-ed25519-2026-08-test-only";
const TEST_SEED = Buffer.from(
  "9d61b19deffd5a60ba844af492ec2cc4" +
    "4449c5697b326919703bac031cae7f60",
  "hex",
);
const PKCS8_ED25519_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");
const TEST_PRIVATE_KEY = createPrivateKey({
  key: Buffer.concat([PKCS8_ED25519_PREFIX, TEST_SEED]),
  format: "der",
  type: "pkcs8",
});
const TEST_PRIVATE_KEY_PEM = TEST_PRIVATE_KEY.export({
  format: "pem",
  type: "pkcs8",
});
const TEST_PUBLIC_KEY_PEM = createPublicKey(TEST_PRIVATE_KEY).export({
  format: "pem",
  type: "spki",
});

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function artifact(pathname, role, mediaType, contents) {
  return {
    path: pathname,
    role,
    media_type: mediaType,
    size_bytes: Buffer.byteLength(contents),
    sha256: sha256(contents),
  };
}

function writeTarString(header, offset, length, value) {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.length > length) {
    throw new Error(`test fixture tar value exceeds ${length} bytes: ${value}`);
  }
  bytes.copy(header, offset);
}

function octal(value, length) {
  return `${value.toString(8).padStart(length - 1, "0")}\0`;
}

function tarHeader(name, size) {
  const header = Buffer.alloc(512);
  writeTarString(header, 0, 100, name);
  writeTarString(header, 100, 8, octal(0o644, 8));
  writeTarString(header, 108, 8, octal(0, 8));
  writeTarString(header, 116, 8, octal(0, 8));
  writeTarString(header, 124, 12, octal(size, 12));
  writeTarString(header, 136, 12, octal(0, 12));
  header.fill(0x20, 148, 156);
  header[156] = "0".charCodeAt(0);
  writeTarString(header, 257, 6, "ustar\0");
  writeTarString(header, 263, 2, "00");
  const checksum = header.reduce((total, byte) => total + byte, 0);
  writeTarString(header, 148, 8, `${checksum.toString(8).padStart(6, "0")}\0 `);
  return header;
}

function deterministicTarGzip(files) {
  const chunks = [];
  for (const [name, contents] of [...files.entries()].sort(([left], [right]) =>
    left.localeCompare(right),
  )) {
    const payload = Buffer.from(contents, "utf8");
    chunks.push(tarHeader(name, payload.length), payload);
    const padding = (512 - (payload.length % 512)) % 512;
    if (padding > 0) {
      chunks.push(Buffer.alloc(padding));
    }
  }
  chunks.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(chunks), { level: 9, mtime: 0 });
}

function fixtureRequest(artifacts) {
  const document = {
    schema: "zerglang.benchmark-publication-request/1",
    run_id: "",
    content_sha256: "",
    suite: {
      id: "zl256",
      dataset_id: "a".repeat(64),
      profile_id: "current",
      profile_identity: "b".repeat(64),
      lane: "synthesis",
      view: "current",
    },
    source: {
      repository: "Epoch-ML/zerg",
      ref: "refs/heads/development",
      commit_sha: "c".repeat(40),
      release: null,
    },
    workflow: {
      name: "ZergLang ZL256 benchmarks",
      url: "https://github.com/Epoch-ML/zerg/actions/runs/12345",
      run_id: "12345",
      run_attempt: 1,
      event: "push",
    },
    execution: {
      compiler_id: "c".repeat(40),
      executor_sha256: "d".repeat(64),
      harness_version: "0.2.0",
      command: ["python", "-m", "tools.zlbench", "run"],
      filters: { view: "current" },
      shards: { count: 1, completed: [0] },
    },
    platform: {
      id: "fixture-linux-x86_64",
      os: "linux",
      arch: "x86_64",
      machine: "Deterministic public fixture",
      toolchain: "fixture-c17-portable",
    },
    model: {
      provider: "fixture",
      model: "fixture-model",
      adapter: "fixture-adapter-v1",
      temperature: "0",
      seed: 7,
    },
    timestamps: {
      started_at: "2026-08-23T10:00:00.000Z",
      completed_at: "2026-08-23T10:00:01.000Z",
    },
    status: "complete",
    artifacts,
    disclosure: {
      candidate_source_public: true,
      contamination_warning:
        "Public candidate source may contaminate future model-synthesis evaluations.",
      excluded_material: {
        hidden_tests: true,
        held_out_inputs: true,
        held_out_oracles: true,
        executable_oracle_code: true,
        reference_solutions: true,
      },
    },
    signature: null,
  };
  const identity = contentIdentity(document);
  return { ...document, run_id: identity.run_id, content_sha256: identity.content_sha256 };
}

function fixtureTask() {
  return {
    schema: "zerglang.benchmark-public-task/1",
    id: "algorithm/answer",
    revision: 1,
    title: "Deterministic publication fixture",
    maturity: "verified",
    category: "algorithm",
    edition: "core-1",
    preview: "shared",
    domains: ["algorithm"],
    modalities: ["interpreted"],
    tiers: ["interpreter"],
    clauses: [],
    boundaries: [],
    execution: {
      operation: "algorithm",
      selector: "benchmark_publication_fixture.answer",
      executors: ["algorithm-interpreter"],
      platforms: ["portable"],
    },
    cases: [
      {
        id: "public-answer",
        visibility: "public",
        input: { type: "unit" },
        oracle: { kind: "value", value: { type: "integer", value: "42" } },
      },
    ],
    synthesis: {
      eligible: true,
      prompt: "Return the complete answer candidate.",
      interface: "public value Solution;\n",
      contamination_warning:
        "Public candidate source may contaminate future model-synthesis evaluations.",
    },
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
    source: {
      availability: "withheld",
      reason: "active-synthesis-reference",
    },
  };
}

export async function generateBenchmarkFixture(destination) {
  const candidate = "algorithm message answer() -> I32 { return 42; }\n";
  const candidatePath = "artifacts/candidates/answer.zl";
  const catalog = `${canonicalJson({
    schema: "zerglang.benchmark-public-catalog/1",
    dataset_id: "a".repeat(64),
    name: "ZL256",
    version: "0.2.0",
    authority: { clauses: [], boundaries: [] },
    tasks: [fixtureTask()],
  })}\n`;
  const synthesis = `${canonicalJson({
    schema: "zerglang.benchmark-public-synthesis/1",
    catalog_id: "a".repeat(64),
    profile_identity: "b".repeat(64),
    candidate_source_public: true,
    contamination_warning:
      "Public candidate source may contaminate future model-synthesis evaluations.",
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
              adapter: "fixture-adapter-v1",
              provider: "fixture",
              model: "fixture-model",
              reasoning: null,
              protocol: "1",
            },
            candidate: {
              artifact_path: candidatePath,
              sha256: sha256(candidate),
              public: true,
              contamination_warning:
                "Public candidate source may contaminate future model-synthesis evaluations.",
            },
          },
        ],
        pass_at_k: { 1: { numerator: "1", denominator: "1" } },
        repair_at_3: {
          correct: 1,
          total: 1,
          rate: { numerator: "1", denominator: "1" },
        },
      },
    ],
  })}\n`;
  const artifactFiles = new Map([
    [candidatePath, candidate],
    ["artifacts/catalog.json", catalog],
    ["artifacts/synthesis.json", synthesis],
  ]);
  const artifacts = [
    artifact(candidatePath, "candidate_source", "text/x-zerglang", candidate),
    artifact("artifacts/catalog.json", "task_catalog", "application/json", catalog),
    artifact("artifacts/synthesis.json", "public_synthesis", "application/json", synthesis),
  ];
  const request = fixtureRequest(artifacts);
  const publication = `${canonicalJson(request)}\n`;
  const bundleFiles = new Map([["publication.json", publication], ...artifactFiles]);
  const archive = deterministicTarGzip(bundleFiles);
  const bundleAsset = `zlbench-${request.run_id}.tar.gz`;
  const manifest = createSignedManifest(request, {
    repository: "Epoch-ML/zerglang-releases",
    bundleAsset,
    bundleSha256: sha256(archive),
    publishedAt: "2026-08-23T10:00:02.000Z",
    keyId: TEST_KEY_ID,
    privateKey: TEST_PRIVATE_KEY_PEM,
  });
  const keys = {
    schema: "zerglang.benchmark-signing-keys/1",
    keys: [
      {
        key_id: TEST_KEY_ID,
        algorithm: "Ed25519",
        public_key_pem: TEST_PUBLIC_KEY_PEM,
        status: "active",
      },
    ],
  };

  await mkdir(path.join(destination, "bundle"), { recursive: true });
  for (const [relativePath, contents] of bundleFiles) {
    const output = path.join(destination, "bundle", ...relativePath.split("/"));
    await mkdir(path.dirname(output), { recursive: true });
    await writeFile(output, contents, { encoding: "utf8", flag: "wx" });
  }
  await writeFile(path.join(destination, bundleAsset), archive, { flag: "wx" });
  await writeFile(path.join(destination, "manifest.json"), `${canonicalJson(manifest)}\n`, {
    encoding: "utf8",
    flag: "wx",
  });
  await writeFile(path.join(destination, "keys.json"), `${canonicalJson(keys)}\n`, {
    encoding: "utf8",
    flag: "wx",
  });
  return { bundleAsset, manifest, request };
}

async function main() {
  if (process.argv.length !== 3) {
    throw new Error("usage: generate-benchmark-fixture.mjs OUTPUT_DIR");
  }
  await generateBenchmarkFixture(process.argv[2]);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(`generate-benchmark-fixture: ${error.message}`);
    process.exitCode = 1;
  });
}
