import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const workflow = await readFile(
  new URL("../.github/workflows/release.yml", import.meta.url),
  "utf8",
);

function job(name, nextName) {
  const start = workflow.indexOf(`  ${name}:`);
  const end = workflow.indexOf(`  ${nextName}:`, start + 1);
  assert.ok(start >= 0 && end > start);
  return workflow.slice(start, end);
}

test("maps protected secret names to the standalone Tauri signer interface", () => {
  for (const [name, nextName, secretPrefix] of [
    ["sign_updater_preview", "sign_updater_stable", "ZERGLANG_TAURI_SIGNING"],
    ["sign_updater_stable", "sign_updater", "ZERGLANG_STABLE_TAURI_SIGNING"],
  ]) {
    const signer = job(name, nextName);
    const signing = signer.slice(signer.indexOf("      - name: Sign and collect"));

    assert.match(
      signing,
      new RegExp(`TAURI_PRIVATE_KEY: \\\${\\{ secrets\\.${secretPrefix}_PRIVATE_KEY \\}\\}`),
    );
    assert.match(
      signing,
      new RegExp(
        `TAURI_PRIVATE_KEY_PASSWORD: \\\${\\{ secrets\\.${secretPrefix}_PRIVATE_KEY_PASSWORD \\}\\}`,
      ),
    );
    assert.match(signing, /\[\[ -n "\$TAURI_PRIVATE_KEY"/);
    assert.match(signing, /npm exec --offline -- tauri signer sign/);
  }
});
