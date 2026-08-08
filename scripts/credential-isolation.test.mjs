import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const workflow = await readFile(
  new URL("../.github/workflows/release.yml", import.meta.url),
  "utf8",
);

function job(name, nextName) {
  const start = workflow.indexOf(`  ${name}:`);
  assert.ok(start >= 0, `workflow must define the ${name} job`);
  const end = nextName === undefined
    ? workflow.length
    : workflow.indexOf(`  ${nextName}:`, start + 1);
  assert.ok(end > start, `${nextName} must follow ${name}`);
  return workflow.slice(start, end);
}

test("destroys Apple credentials before executing source-produced binaries", () => {
  const apple = job("apple_sign", "sign_updater_preview");
  const signing = apple.indexOf("Apply preview ad-hoc or fail-closed stable Apple signing");
  const cleanup = apple.indexOf("Delete ephemeral Apple credentials");
  const smoke = apple.indexOf("Smoke-test the final Apple-signed application");

  assert.ok(signing >= 0, "Apple signing must be explicit");
  assert.ok(cleanup > signing, "Apple credentials must be destroyed after signing");
  assert.ok(cleanup < smoke, "source-produced tools must execute only after credential cleanup");
  assert.match(apple.slice(cleanup, smoke), /if: always\(\)/);
});

test("exposes each updater private key only to its signing step", () => {
  for (const [name, nextName, secret] of [
    ["sign_updater_preview", "sign_updater_stable", "ZERGLANG_TAURI_SIGNING_PRIVATE_KEY"],
    [
      "sign_updater_stable",
      "sign_updater",
      "ZERGLANG_STABLE_TAURI_SIGNING_PRIVATE_KEY",
    ],
  ]) {
    const signer = job(name, nextName);
    const steps = signer.indexOf("    steps:");
    const signing = signer.indexOf("      - name: Sign and collect");
    const upload = signer.indexOf("      - uses: actions/upload-artifact", signing);

    assert.ok(steps >= 0 && signing > steps && upload > signing);
    assert.doesNotMatch(signer.slice(0, steps), new RegExp(secret));
    assert.match(signer.slice(signing, upload), new RegExp(secret));
  }
});
