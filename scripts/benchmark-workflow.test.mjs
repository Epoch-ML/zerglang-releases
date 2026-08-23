import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const benchmarkWorkflow = await readFile(
  new URL("../.github/workflows/benchmark-publication.yml", import.meta.url),
  "utf8",
);
const ideWorkflow = await readFile(
  new URL("../.github/workflows/release.yml", import.meta.url),
  "utf8",
);
const pagesBootstrapWorkflow = await readFile(
  new URL("../.github/workflows/pages-bootstrap.yml", import.meta.url),
  "utf8",
);

test("benchmark publication is isolated from IDE tags and signing credentials", () => {
  assert.match(benchmarkWorkflow, /benchmark-requests\/\*\.json/);
  assert.match(benchmarkWorkflow, /zlbench-\$\{RUN_ID\}/);
  assert.match(benchmarkWorkflow, /ZERGLANG_BENCHMARK_SIGNING_PRIVATE_KEY/);
  assert.match(benchmarkWorkflow, /ZERGLANG_BENCHMARK_SIGNING_KEY_ID/);
  assert.doesNotMatch(benchmarkWorkflow, /TAURI|APPLE_CERTIFICATE|zerglang-ide-v/);
});

test("source artifact retrieval binds the exact successful workflow attempt", () => {
  assert.match(benchmarkWorkflow, /actions\/runs\/\$WORKFLOW_RUN_ID\/attempts\/\$WORKFLOW_RUN_ATTEMPT/);
  assert.match(benchmarkWorkflow, /\.head_sha == \$source_sha/);
  assert.match(benchmarkWorkflow, /\[\[ "\$conclusion" == "success" \]\]/);
  assert.match(
    benchmarkWorkflow,
    /\.path == "\.github\/workflows\/zerglang-benchmarks\.yml"/,
  );
  assert.match(benchmarkWorkflow, /artifact-ids: \$\{\{ needs\.validate\.outputs\.artifact_id \}\}/);
  assert.match(benchmarkWorkflow, /artifact_digest/);
  assert.match(
    benchmarkWorkflow,
    /actions\/create-github-app-token@[0-9a-f]{40} # v3/,
  );
  assert.match(benchmarkWorkflow, /for attempt in \{1\.\.30\}/);
  assert.match(benchmarkWorkflow, /source workflow did not conclude successfully/);
});

test("publisher rejects replacement and verifies release bytes before Pages mutation", () => {
  const releaseCheck = benchmarkWorkflow.indexOf('gh release view "$RELEASE_TAG"');
  const releaseCreate = benchmarkWorkflow.indexOf('gh release create "$RELEASE_TAG"');
  const compare = benchmarkWorkflow.indexOf('cmp "$local_path" "$verify_dir/$asset_name"');
  const publishPages = benchmarkWorkflow.indexOf("benchmark-publication.mjs publish-pages");

  assert.ok(releaseCheck >= 0, "publisher must check for an existing immutable release");
  assert.ok(releaseCreate > releaseCheck, "publisher must reject a duplicate before release creation");
  assert.ok(compare > releaseCreate, "publisher must retrieve and compare its release assets");
  assert.ok(publishPages > compare, "Pages must update only after every release asset is verified");
  assert.match(benchmarkWorkflow, /--bundle \.\.\/handoff\/incoming/);
});

test("IDE and benchmark Pages mutations share a non-canceling publication lock", () => {
  for (const workflow of [ideWorkflow, benchmarkWorkflow, pagesBootstrapWorkflow]) {
    assert.match(workflow, /group: zerglang-publication/);
    assert.match(workflow, /cancel-in-progress: false/);
  }
});

test("Pages bootstrap is manual-only and deploys the reviewed site tree", () => {
  assert.match(pagesBootstrapWorkflow, /workflow_dispatch:/);
  assert.doesNotMatch(pagesBootstrapWorkflow, /\n\s+push:/);
  assert.match(pagesBootstrapWorkflow, /path: site/);
  assert.match(
    pagesBootstrapWorkflow,
    /actions\/deploy-pages@[0-9a-f]{40} # v5/,
  );
});

test("every third-party workflow action is pinned to an immutable commit", () => {
  for (const workflow of [ideWorkflow, benchmarkWorkflow, pagesBootstrapWorkflow]) {
    const actions = [...workflow.matchAll(/uses:\s+[^\s@]+@([^\s#]+)/g)];
    assert.ok(actions.length > 0, "workflow must use at least one reviewed action");
    for (const action of actions) {
      assert.match(action[1], /^[0-9a-f]{40}$/);
    }
  }
});

test("bundle packaging is reproducible and does not mutate incoming evidence", () => {
  assert.match(benchmarkWorkflow, /tar --sort=name/);
  assert.match(benchmarkWorkflow, /--mtime='UTC 1970-01-01'/);
  assert.match(benchmarkWorkflow, /--owner=0 --group=0 --numeric-owner/);
  assert.match(benchmarkWorkflow, /gzip -n/);
  assert.match(benchmarkWorkflow, /bundle_tar="\$PWD\/handoff\/payload\/\$\{bundle_asset%\.gz\}"/);
  assert.match(benchmarkWorkflow, /-cf "\$bundle_tar" \./);
  assert.match(benchmarkWorkflow, /node scripts\/benchmark-publication\.mjs validate-bundle/);
});

test("every benchmark schema is closed and versioned independently", async () => {
  const expected = new Map([
    ["benchmark-publication-request.schema.json", "zerglang.benchmark-publication-request/1"],
    ["benchmark-publication-delivery.schema.json", "zerglang.benchmark-publication-delivery/1"],
    ["benchmark-publication.schema.json", "zerglang.benchmark-publication/1"],
    ["benchmark-index.schema.json", "zerglang.benchmark-index/1"],
    ["benchmark-index-signature.schema.json", "zerglang.benchmark-index-signature/1"],
    ["public-results.schema.json", "zerglang.benchmark-public-results/1"],
    ["public-report.schema.json", "zerglang.benchmark-public-report/1"],
    ["public-performance.schema.json", "zerglang.benchmark-public-performance/1"],
    ["public-synthesis.schema.json", "zerglang.benchmark-public-synthesis/1"],
    ["public-catalog.schema.json", "zerglang.benchmark-public-catalog/1"],
    ["public-task.schema.json", "zerglang.benchmark-public-task/1"],
  ]);
  for (const [filename, schemaName] of expected) {
    const schema = JSON.parse(
      await readFile(new URL(`../schemas/${filename}`, import.meta.url), "utf8"),
    );
    assert.equal(schema.$schema, "https://json-schema.org/draft/2020-12/schema");
    assert.equal(schema.properties.schema.const, schemaName);
    assert.equal(schema.additionalProperties, false);
    assert.ok(schema.required.length >= 3, `${filename} must require its identity and payload`);
  }
});
