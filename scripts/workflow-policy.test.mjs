import assert from "node:assert/strict";
import test from "node:test";

import {
  WorkflowPolicyError,
  auditWorkflowPolicy,
} from "./workflow-policy.mjs";

test("accepts a well-formed workflow policy input", () => {
  assert.deepEqual(
    auditWorkflowPolicy("name: Example\njobs:\n  verify:\n    runs-on: ubuntu-24.04\n"),
    [],
  );
});

test("rejects empty, malformed, and non-mapping workflow inputs", () => {
  for (const [source, message] of [
    ["", "workflow source must be non-empty text"],
    ["jobs: [", "workflow source must be valid YAML"],
    ["- job", "workflow root must be a mapping"],
  ]) {
    assert.throws(
      () => auditWorkflowPolicy(source),
      (error) => error instanceof WorkflowPolicyError && error.message === message,
    );
  }
});
