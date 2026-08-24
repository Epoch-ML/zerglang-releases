import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("commits two distinct canonical updater trust roots", async () => {
  const preview = await readFile(
    new URL("../keys/zerglang-preview-updater.pubkey", import.meta.url),
  );
  const stable = await readFile(
    new URL("../keys/zerglang-stable-updater.pubkey", import.meta.url),
  );
  assert.notDeepEqual(preview, stable);
  for (const key of [preview, stable]) {
    const decoded = Buffer.from(key.toString("utf8").trim(), "base64").toString("utf8");
    assert.match(decoded, /untrusted comment: minisign public key:/);
    assert.match(decoded, /\nRWQ[A-Za-z0-9+/=]+\n$/);
  }
  assert.equal(
    createHash("sha256").update(stable).digest("hex"),
    "c173ac67c11b90089ab53b41a8d988108eccad0346118b50a8d28e5a84f7c9c4",
  );
});
