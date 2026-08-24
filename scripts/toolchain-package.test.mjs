import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, test } from "node:test";

import {
  extractToolchainArchive,
  packageToolchain,
  refreshToolchainManifest,
  verifyToolchainTree,
} from "./toolchain-package.mjs";

const temporaryDirectories = [];
const sourceSha = "0123456789abcdef0123456789abcdef01234567";
const version = "0.2.0-preview.1";
const required = [
  "bin/zlc",
  "bin/zlm",
  "bin/zlsync",
  "bin/zlbench-exec",
  "libexec/zerglang/zlc-core",
  "libexec/zerglang/zlm-driver",
  "libexec/zerglang/zlm-runtime",
  "libexec/zerglang/node/bin/node",
  "libexec/zerglang/zlm-embed.mjs",
];
const distributionFiles = [
  "aot_launcher.c",
  "libexec/zerglang/verify-toolchain.mjs",
  "share/licenses/node/LICENSE",
  "share/licenses/zerglang/LICENSE",
  "share/licenses/zerglang/LICENSE.md",
  "share/licenses/zerglang/NOTICE",
  "share/licenses/ztc/LICENSE.md",
  "share/licenses/ztc/NOTICE",
  "share/licenses/ztc/RUST_THIRD_PARTY_LICENSES.txt",
  "share/licenses/ztc/THIRD_PARTY_NOTICES.md",
  "share/licenses/ztc/ZLM_EMBED_THIRD_PARTY_LICENSES.txt",
  "share/licenses/zlm-driver/RUST_THIRD_PARTY_LICENSES.txt",
  "share/licenses/zlm-driver/THIRD_PARTY_NOTICES.md",
  "include/zerglang/zerglang.h",
  "lib/libzerglang.a",
];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "zerglang-toolchain-package-"));
  temporaryDirectories.push(root);
  const toolchainRoot = join(root, "toolchain");
  for (const path of required) {
    const absolute = join(toolchainRoot, path);
    await mkdir(dirname(absolute), { recursive: true });
    await writeFile(absolute, `bytes for ${path}\n`);
    await chmod(absolute, path.endsWith(".mjs") ? 0o644 : 0o755);
  }
  for (const path of distributionFiles) {
    const absolute = join(toolchainRoot, path);
    await mkdir(dirname(absolute), { recursive: true });
    await writeFile(absolute, `bytes for ${path}\n`, { mode: 0o644 });
  }
  await writeFile(join(toolchainRoot, "VERSION"), `${version}\n`);
  await writeFile(join(toolchainRoot, "install.sh"), "#!/bin/sh\nexit 0\n");
  await chmod(join(toolchainRoot, "install.sh"), 0o755);
  await refreshToolchainManifest({
    root: toolchainRoot,
    components: { node: "22.23.2", zerglang: version, ztc: "0.4.0" },
    sourceSha,
    version,
  });
  return { root, toolchainRoot };
}

test("refreshes, verifies, packages, and safely extracts one closed toolchain", async () => {
  const bundle = await fixture();
  const verified = await verifyToolchainTree({
    root: bundle.toolchainRoot,
    sourceSha,
    version,
  });
  assert.equal(verified.manifest.schema, "zerglang.toolchain-bundle/1");
  assert.equal(verified.manifest.files.length, required.length + distributionFiles.length + 2);
  assert.deepEqual(
    verified.manifest.files.map((entry) => entry.path),
    [...required, ...distributionFiles, "VERSION", "install.sh"].sort((left, right) =>
      left.localeCompare(right, "en")),
  );

  const archivePath = join(
    bundle.root,
    `zerglang-toolchain-${version}-aarch64-apple-darwin.tar.gz`,
  );
  const packaged = await packageToolchain({
    root: bundle.toolchainRoot,
    outputPath: archivePath,
    sourceSha,
    version,
  });
  assert.equal(packaged.outputPath, archivePath);
  assert.ok(packaged.entryCount >= verified.manifest.files.length);

  const outputRoot = join(bundle.root, "extracted");
  const extracted = await extractToolchainArchive({
    archivePath,
    outputDirectory: outputRoot,
    sourceSha,
    version,
  });
  assert.equal(
    await readFile(join(outputRoot, "bin/zlm"), "utf8"),
    "bytes for bin/zlm\n",
  );
  assert.equal(extracted.manifest.source_sha, sourceSha);
});

test("manifest verification detects content, mode, inventory, and provenance changes", async () => {
  for (const mutation of [
    async (root) => writeFile(join(root, "bin/zlm"), "tampered"),
    async (root) => chmod(join(root, "bin/zlm"), 0o644),
    async (root) => writeFile(join(root, "unlisted"), "extra"),
  ]) {
    const bundle = await fixture();
    await mutation(bundle.toolchainRoot);
    await assert.rejects(
      verifyToolchainTree({ root: bundle.toolchainRoot, sourceSha, version }),
      /digest|mode|inventory/,
    );
  }
  const bundle = await fixture();
  await assert.rejects(
    verifyToolchainTree({ root: bundle.toolchainRoot, sourceSha: "a".repeat(40), version }),
    /source SHA does not match/,
  );
});

test("manifest refresh requires the complete installer, SDK, verifier, and licenses", async () => {
  for (const [path, message] of [
    ["aot_launcher.c", /missing required distribution file: aot_launcher\.c/],
    ["install.sh", /missing required distribution file: install\.sh/],
    ["libexec/zerglang/verify-toolchain.mjs", /missing required distribution file: libexec/],
    ["include/zerglang/zerglang.h", /missing required distribution tree: include/],
    ["lib/libzerglang.a", /missing required distribution tree: lib/],
    ["share/licenses/node/LICENSE", /missing required distribution file: share\/licenses/],
  ]) {
    const bundle = await fixture();
    await rm(join(bundle.toolchainRoot, path));
    await assert.rejects(
      refreshToolchainManifest({
        root: bundle.toolchainRoot,
        components: { node: "22.23.2", zerglang: version, ztc: "0.4.0" },
        sourceSha,
        version,
      }),
      message,
    );
  }
});

test("toolchain boundaries reject symbolic links, unsafe output, and wrong archive identity", async () => {
  const linked = await fixture();
  await symlink("zlm", join(linked.toolchainRoot, "bin/alias"));
  await assert.rejects(
    refreshToolchainManifest({
      root: linked.toolchainRoot,
      components: { node: "22.23.2", zerglang: version, ztc: "0.4.0" },
      sourceSha,
      version,
    }),
    /symbolic link/,
  );

  const bundle = await fixture();
  await assert.rejects(
    packageToolchain({
      root: bundle.toolchainRoot,
      outputPath: join(bundle.root, "wrong-name.tar.gz"),
      sourceSha,
      version,
    }),
    /must be named zerglang-toolchain/,
  );
  await assert.rejects(
    extractToolchainArchive({
      archivePath: join(bundle.root, "missing.tar.gz"),
      outputDirectory: "/",
      sourceSha,
      version,
    }),
    /output directory is unsafe/,
  );
});
