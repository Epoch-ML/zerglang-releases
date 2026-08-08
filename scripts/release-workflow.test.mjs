import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const workflow = await readFile(
  new URL("../.github/workflows/release.yml", import.meta.url),
  "utf8",
);

test("authenticates the GitHub metadata request used for strict SSH host keys", () => {
  const checkoutStep = workflow.slice(
    workflow.indexOf("- name: Check out the exact source commit and tag"),
    workflow.indexOf("- name: Verify source commit and release tag"),
  );

  assert.match(checkoutStep, /GH_TOKEN: \$\{\{ github\.token \}\}/);
  assert.match(
    checkoutStep,
    /--header ['"]Authorization: Bearer \$GH_TOKEN['"]/,
  );
  assert.match(checkoutStep, /https:\/\/api\.github\.com\/meta/);
});
