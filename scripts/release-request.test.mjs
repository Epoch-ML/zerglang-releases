import assert from "node:assert/strict";
import test from "node:test";

import { validateReleaseRequest } from "./release-request.mjs";

const SOURCE_SHA = "0123456789abcdef0123456789abcdef01234567";

function request(overrides = {}) {
  return {
    channel: "preview",
    products: ["ide", "toolchain"],
    schema: "zerglang.release-request/2",
    version: "0.2.0-rc.1",
    release_tag: "zerglang-preview-v0.2.0-rc.1",
    source_repository: "Epoch-ML/zerg",
    source_sha: SOURCE_SHA,
    source_ref: "refs/tags/zerglang-preview-v0.2.0-rc.1",
    requested_at: "2026-08-05T19:00:00.000Z",
    ...overrides,
  };
}

test("accepts and canonicalizes a valid preview request", () => {
  assert.deepEqual(validateReleaseRequest(request()), request());
});

test("rejects preview build metadata from the canonical cohort identity", () => {
  const preview = request({
    version: "0.2.0+arm64.7",
    release_tag: "zerglang-preview-v0.2.0+arm64.7",
    source_ref: "refs/tags/zerglang-preview-v0.2.0+arm64.7",
  });
  assert.throws(
    () => validateReleaseRequest(preview),
    /preview versions must use preview, beta, or rc/,
  );
});

test("accepts the exact stable tag contract", () => {
  const stable = request({
    channel: "stable",
    version: "1.0.0",
    release_tag: "zerglang-v1.0.0",
    source_ref: "refs/tags/zerglang-v1.0.0",
  });
  assert.deepEqual(validateReleaseRequest(stable), stable);
});

test("rejects prerelease and build metadata on the stable channel", () => {
  for (const version of ["1.0.0-rc.1", "1.0.0+build.7"]) {
    const tag = `zerglang-v${version}`;
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

test("bounds every release SemVer number to the shared JavaScript-safe profile", () => {
  const maximum = "9007199254740991";
  const accepted = request({
    version: `${maximum}.${maximum}.${maximum}-rc.${maximum}`,
    release_tag: `zerglang-preview-v${maximum}.${maximum}.${maximum}-rc.${maximum}`,
    source_ref: `refs/tags/zerglang-preview-v${maximum}.${maximum}.${maximum}-rc.${maximum}`,
  });
  assert.equal(validateReleaseRequest(accepted).version, accepted.version);

  for (const version of [
    "9007199254740992.0.0-rc.1",
    "0.9007199254740992.0-rc.1",
    "0.0.9007199254740992-rc.1",
    "0.0.0-rc.9007199254740992",
  ]) {
    const tag = `zerglang-preview-v${version}`;
    assert.throws(
      () => validateReleaseRequest(request({
        version,
        release_tag: tag,
        source_ref: `refs/tags/${tag}`,
      })),
      /safe integer|canonical release SemVer/,
    );
  }
});

test("rejects a moving source ref in place of an immutable SHA", () => {
  assert.throws(
    () => validateReleaseRequest(request({ source_sha: "main" })),
    /40 lowercase hexadecimal/,
  );
});

test("rejects a tag that does not match the channel and version", () => {
  assert.throws(
    () => validateReleaseRequest(request({ release_tag: "zerglang-v0.2.0" })),
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

test("uses the same four-digit nonzero UTC year profile as the updater", () => {
  assert.equal(
    validateReleaseRequest(request({ requested_at: "0001-01-01T00:00:00.000Z" })).requested_at,
    "0001-01-01T00:00:00.000Z",
  );
  assert.equal(
    validateReleaseRequest(request({ requested_at: "9999-12-31T23:59:59.999Z" })).requested_at,
    "9999-12-31T23:59:59.999Z",
  );
  for (const requested_at of [
    "0000-01-01T00:00:00.000Z",
    "+010000-01-01T00:00:00.000Z",
    "2026-02-29T00:00:00.000Z",
    "2026-08-05T19:00:00Z",
  ]) {
    assert.throws(
      () => validateReleaseRequest(request({ requested_at })),
      /ISO-8601 UTC timestamp/,
    );
  }
});

test("rejects reordered, partial, duplicate, or expanded product sets", () => {
  for (const products of [
    ["toolchain", "ide"],
    ["ide"],
    ["ide", "ide"],
    ["ide", "toolchain", "server"],
  ]) {
    assert.throws(
      () => validateReleaseRequest(request({ products })),
      /products must equal ide, toolchain/,
    );
  }
});
