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

function job(name, nextName) {
  const start = workflow.indexOf(`  ${name}:`);
  assert.ok(start >= 0, `workflow must define the ${name} job`);
  const end = nextName === undefined
    ? workflow.length
    : workflow.indexOf(`  ${nextName}:`, start + 1);
  assert.ok(end > start, `${nextName} must follow ${name}`);
  return workflow.slice(start, end);
}

test("manual recovery selects one existing immutable request and its protected tag", () => {
  const trigger = workflow.slice(workflow.indexOf("on:"), workflow.indexOf("concurrency:"));
  const validation = job("validate", "build");

  assert.match(trigger, /workflow_dispatch:/);
  assert.match(trigger, /request_file:/);
  assert.doesNotMatch(trigger, /\n\s{6}(?:channel|version|source_sha):/);
  assert.doesNotMatch(trigger, /\n\s{2}push:/);
  assert.match(validation, /GITHUB_REF.*refs\/heads\/main/);
  assert.match(validation, /git log --diff-filter=A --format=%H/);
  assert.match(validation, /the request addition commit must add only this request/);
  assert.match(validation, /cmp .*request-at-addition/);
  assert.match(validation, /refs\/tags\/\$RELEASE_TAG/);
  assert.match(validation, /release tag targets .*expected.*REQUEST_COMMIT/i);
});

test("source, Apple, and updater signing execute on isolated trust boundaries", () => {
  const build = job("build", "apple_sign");
  const apple = job("apple_sign", "sign_updater");
  const updater = job("sign_updater", "publish");

  assert.match(build, /Build without release signing credentials/);
  assert.match(build, /--no-sign/);
  assert.match(build, /zerglang-unsigned-source-stage/);
  assert.doesNotMatch(build, /TAURI_SIGNING_PRIVATE_KEY/);
  assert.doesNotMatch(build, /ZERGLANG_APPLE_(?:CERTIFICATE|API_PRIVATE_KEY)/);

  assert.match(apple, /Sign and notarize on a fresh runner/);
  assert.match(apple, /needs:[\s\S]*?- validate[\s\S]*?- build/);
  assert.match(apple, /ZERGLANG_APPLE_CERTIFICATE/);
  assert.match(apple, /zerglang-platform-signed/);
  assert.doesNotMatch(apple, /TAURI_SIGNING_PRIVATE_KEY/);

  assert.match(updater, /Sign the finished updater archive on a fresh runner/);
  assert.match(updater, /needs:[\s\S]*?- validate[\s\S]*?- apple_sign/);
  assert.match(updater, /zerglang-updater-stable/);
  assert.match(updater, /zerglang-updater-preview/);
  assert.match(updater, /ZERGLANG_STABLE_TAURI_SIGNING_PRIVATE_KEY/);
  assert.match(updater, /secrets\.ZERGLANG_TAURI_SIGNING_PRIVATE_KEY/);
  assert.match(updater, /keys\/zerglang-stable-updater\.pubkey/);
  assert.match(updater, /keys\/zerglang-preview-updater\.pubkey/);
  assert.match(updater, /cmp --silent .*updater\.pubkey/);
  assert.doesNotMatch(updater, /ZERGLANG_APPLE_(?:CERTIFICATE|API_PRIVATE_KEY)/);
  assert.doesNotMatch(updater, /SOURCE_DEPLOY_KEY/);
});

test("publication is draft-first, resumable, exact, and immutable before promotion", () => {
  const publish = job("publish", "feed");

  assert.match(publish, /Create or resume the exact immutable GitHub Release/);
  assert.match(publish, /--draft/);
  assert.match(publish, /--verify-tag/);
  assert.match(publish, /expected exactly six immutable release assets/);
  assert.match(publish, /latest\.json/);
  assert.match(publish, /unexpected asset/);
  assert.match(publish, /duplicate asset names/);
  assert.match(publish, /gh release upload/);
  assert.match(publish, /Existing draft release asset bytes do not match/);
  assert.match(publish, /--draft=false/);
  assert.match(publish, /\.immutable.*true/);
  assert.match(publish, /refusing feed promotion/);
  assert.match(publish, /Existing immutable release will be verified from its public bytes/);
  assert.match(publish, /Download and verify canonical public release assets/);
  assert.match(publish, /\.browser_download_url/);
  assert.match(publish, /\.digest/);
  assert.match(publish, /--proto '=https'/);
  assert.match(publish, /Upload canonical verified release payload/);

  const immutableCheck = publish.indexOf("refusing feed promotion");
  const canonicalDownload = publish.indexOf("Download and verify canonical public release assets");
  assert.ok(immutableCheck >= 0 && canonicalDownload > immutableCheck);
});

test("the Pages feed consumes only canonical bytes and verifies the live HTTPS result", () => {
  const publish = job("publish", "feed");
  const feed = job("feed", "deploy_pages");
  const deploy = job("deploy_pages", "verify_live");
  const verify = job("verify_live");

  assert.match(publish, /name: zerglang-canonical-release/);
  assert.match(feed, /name: zerglang-canonical-release/);
  assert.match(feed, /scripts\/feed-policy\.mjs/);
  assert.match(feed, /git pull --ff-only origin main/);
  assert.match(feed, /git diff --exit-code/);
  assert.match(feed, /upload-pages-artifact/);
  assert.match(deploy, /actions\/deploy-pages/);
  assert.match(verify, /https:\/\/epoch-ml\.github\.io\/zerglang-releases/);
  assert.match(verify, /--proto '=https'/);
  assert.match(verify, /cmp .*latest\.json/);
});
