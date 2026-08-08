import assert from "node:assert/strict";
import test from "node:test";

import { validateReleaseRequest } from "./release-request.mjs";

const SOURCE_SHA = "0123456789abcdef0123456789abcdef01234567";

function request(overrides = {}) {
  return {
    schema_version: 1,
    product: "ZergLang IDE",
    channel: "preview",
    version: "0.2.0-rc.1",
    release_tag: "zerglang-ide-preview-v0.2.0-rc.1",
    source_repository: "Epoch-ML/zerg",
    source_sha: SOURCE_SHA,
    source_ref: "refs/tags/zerglang-ide-preview-v0.2.0-rc.1",
    requested_at: "2026-08-05T19:00:00.000Z",
    ...overrides,
  };
}

test("accepts and canonicalizes a valid preview request", () => {
  assert.deepEqual(validateReleaseRequest(request()), request());
});

test("accepts preview build metadata in its tag and request filename contract", () => {
  const preview = request({
    version: "0.2.0+arm64.7",
    release_tag: "zerglang-ide-preview-v0.2.0+arm64.7",
    source_ref: "refs/tags/zerglang-ide-preview-v0.2.0+arm64.7",
  });
  assert.equal(
    validateReleaseRequest(preview).release_tag,
    "zerglang-ide-preview-v0.2.0+arm64.7",
  );
});

test("accepts the exact stable tag contract", () => {
  const stable = request({
    channel: "stable",
    version: "1.0.0",
    release_tag: "zerglang-ide-v1.0.0",
    source_ref: "refs/tags/zerglang-ide-v1.0.0",
  });
  assert.deepEqual(validateReleaseRequest(stable), stable);
});

test("rejects prerelease and build metadata on the stable channel", () => {
  for (const version of ["1.0.0-rc.1", "1.0.0+build.7"]) {
    const tag = `zerglang-ide-v${version}`;
    assert.throws(
      () =>
        validateReleaseRequest(
          request({
            channel: "stable",
            version,
            release_tag: tag,
            source_ref: `refs/tags/${tag}`,
          }),
        ),
      /stable versions must use MAJOR\.MINOR\.PATCH/,
    );
  }
});

test("rejects a channel outside the publication allow-list", () => {
  assert.throws(
    () => validateReleaseRequest(request({ channel: "nightly" })),
    /channel must be preview or stable/,
  );
});

test("rejects SemVer with a leading zero", () => {
  assert.throws(
    () => validateReleaseRequest(request({ version: "01.2.3" })),
    /strict SemVer/,
  );
});

test("rejects a moving source ref in place of an immutable SHA", () => {
  assert.throws(
    () => validateReleaseRequest(request({ source_sha: "main" })),
    /40 lowercase hexadecimal/,
  );
});

test("rejects a tag that does not match the channel and version", () => {
  assert.throws(
    () => validateReleaseRequest(request({ release_tag: "zerglang-ide-v0.2.0" })),
    /release_tag must equal/,
  );
});

test("rejects unrecognized fields instead of silently accepting policy", () => {
  assert.throws(
    () => validateReleaseRequest(request({ skip_notarization: true })),
    /unexpected field/,
  );
});

test("rejects a non-canonical source ref", () => {
  assert.throws(
    () => validateReleaseRequest(request({ source_ref: "main" })),
    /source_ref must equal/,
  );
});

test("rejects invalid request timestamps", () => {
  assert.throws(
    () => validateReleaseRequest(request({ requested_at: "yesterday" })),
    /requested_at must be an ISO-8601 UTC timestamp/,
  );
});
