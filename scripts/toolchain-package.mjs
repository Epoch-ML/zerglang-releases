#!/usr/bin/env node

import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

import { create, extract, list } from "tar";

const TARGET = "aarch64-apple-darwin";
const MANIFEST_PATH = "share/zerglang/toolchain-manifest.json";
const ARCHIVE_MTIME = new Date("2020-01-01T00:00:00.000Z");
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const SOURCE_SHA_PATTERN = /^[0-9a-f]{40}$/;
const VERSION_PATTERN =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(?:preview|beta|rc)\.(?:0|[1-9]\d*))?$/;
const DEFAULT_MAX_ARCHIVE_BYTES = 2 * 1024 * 1024 * 1024;
const DEFAULT_MAX_ENTRY_COUNT = 200_000;
const DEFAULT_MAX_FILE_BYTES = 2 * 1024 * 1024 * 1024;
const DEFAULT_MAX_UNCOMPRESSED_BYTES = 4 * 1024 * 1024 * 1024;
const REQUIRED_RUNTIME_FILES = new Map([
  ["bin/zlc", "0755"],
  ["bin/zlm", "0755"],
  ["bin/zlsync", "0755"],
  ["bin/zlbench-exec", "0755"],
  ["libexec/zerglang/zlc-core", "0755"],
  ["libexec/zerglang/zlm-driver", "0755"],
  ["libexec/zerglang/zlm-runtime", "0755"],
  ["libexec/zerglang/node/bin/node", "0755"],
  ["libexec/zerglang/zlm-embed.mjs", "0644"],
]);
const REQUIRED_DISTRIBUTION_FILES = new Map([
  ["aot_launcher.c", "0644"],
  ["VERSION", "0644"],
  ["install.sh", "0755"],
  ["libexec/zerglang/verify-toolchain.mjs", "0644"],
  ["share/licenses/node/LICENSE", "0644"],
  ["share/licenses/zerglang/LICENSE", "0644"],
  ["share/licenses/zerglang/LICENSE.md", "0644"],
  ["share/licenses/zerglang/NOTICE", "0644"],
  ["share/licenses/ztc/LICENSE.md", "0644"],
  ["share/licenses/ztc/NOTICE", "0644"],
  ["share/licenses/ztc/RUST_THIRD_PARTY_LICENSES.txt", "0644"],
  ["share/licenses/ztc/THIRD_PARTY_NOTICES.md", "0644"],
  ["share/licenses/ztc/ZLM_EMBED_THIRD_PARTY_LICENSES.txt", "0644"],
  ["share/licenses/zlm-driver/RUST_THIRD_PARTY_LICENSES.txt", "0644"],
  ["share/licenses/zlm-driver/THIRD_PARTY_NOTICES.md", "0644"],
]);

export class ToolchainPackageError extends Error {
  constructor(message) {
    super(message);
    this.name = "ToolchainPackageError";
  }
}

function fail(message) {
  throw new ToolchainPackageError(message);
}

function validatedVersion(value) {
  if (typeof value !== "string" || !VERSION_PATTERN.test(value)) {
    fail("toolchain version must be canonical release SemVer");
  }
  return value;
}

function validatedSourceSha(value) {
  if (typeof value !== "string" || !SOURCE_SHA_PATTERN.test(value)) {
    fail("toolchain source SHA must contain 40 lowercase hexadecimal characters");
  }
  return value;
}

function budget(value, fallback, label) {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < 1) fail(`${label} must be a positive safe integer`);
  return result;
}

function budgets(options) {
  return {
    maxArchiveBytes: budget(
      options.maxArchiveBytes,
      DEFAULT_MAX_ARCHIVE_BYTES,
      "maximum archive bytes",
    ),
    maxEntryCount: budget(
      options.maxEntryCount,
      DEFAULT_MAX_ENTRY_COUNT,
      "maximum archive entry count",
    ),
    maxFileBytes: budget(
      options.maxFileBytes,
      DEFAULT_MAX_FILE_BYTES,
      "maximum archive file bytes",
    ),
    maxUncompressedBytes: budget(
      options.maxUncompressedBytes,
      DEFAULT_MAX_UNCOMPRESSED_BYTES,
      "maximum uncompressed bytes",
    ),
  };
}

function safeRoot(value, label) {
  if (typeof value !== "string" || value.trim() === "") fail(`${label} is required`);
  const root = resolve(value);
  if (root === "/") fail(`${label} is unsafe`);
  return root;
}

function artifactPath(root, absolute) {
  return relative(root, absolute).split(sep).join("/");
}

async function sha256File(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

function normalizedMode(metadata) {
  return (metadata.mode & 0o111) === 0 ? "0644" : "0755";
}

async function scanTree(root, options = {}) {
  const files = [];
  const archivePaths = [];
  let entryCount = 0;
  let uncompressedBytes = 0;
  const limits = budgets(options);
  async function visit(directory) {
    const names = (await readdir(directory)).sort((left, right) =>
      left.localeCompare(right, "en"));
    for (const name of names) {
      const absolute = join(directory, name);
      const path = artifactPath(root, absolute);
      const metadata = await lstat(absolute);
      if (metadata.isSymbolicLink()) fail(`toolchain contains a symbolic link: ${path}`);
      if (!metadata.isDirectory() && !metadata.isFile()) {
        fail(`toolchain contains a special entry: ${path}`);
      }
      entryCount += 1;
      if (entryCount > limits.maxEntryCount) {
        fail(`toolchain entry count exceeds ${limits.maxEntryCount}`);
      }
      archivePaths.push(path);
      if (metadata.isDirectory()) {
        await visit(absolute);
        continue;
      }
      if (metadata.size > limits.maxFileBytes) {
        fail(`toolchain file exceeds ${limits.maxFileBytes} bytes: ${path}`);
      }
      uncompressedBytes += metadata.size;
      if (!Number.isSafeInteger(uncompressedBytes) || uncompressedBytes > limits.maxUncompressedBytes) {
        fail(`toolchain uncompressed bytes exceed ${limits.maxUncompressedBytes}`);
      }
      if (path !== MANIFEST_PATH) {
        files.push({
          mode: normalizedMode(metadata),
          path,
          sha256: await sha256File(absolute),
          size: metadata.size,
          type: "file",
        });
      }
    }
  }
  await visit(root);
  files.sort((left, right) => left.path.localeCompare(right.path, "en"));
  return { archivePaths, entryCount, files, uncompressedBytes };
}

async function requireDirectory(root, label) {
  let metadata;
  try {
    metadata = await lstat(root);
  } catch {
    fail(`${label} does not exist`);
  }
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) fail(`${label} must be a real directory`);
}

function validateComponents(value, version) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail("toolchain manifest components must be an object");
  }
  const names = Object.keys(value).sort();
  if (names.join("\n") !== "node\nzerglang\nztc") {
    fail("toolchain manifest components are not exact");
  }
  for (const name of names) {
    if (typeof value[name] !== "string" || value[name] === "") {
      fail(`toolchain component ${name} must be a non-empty string`);
    }
  }
  if (value.zerglang !== version) fail("toolchain component version does not match");
  return { node: value.node, zerglang: value.zerglang, ztc: value.ztc };
}

async function readManifest(root) {
  const path = join(root, MANIFEST_PATH);
  let metadata;
  try {
    metadata = await lstat(path);
  } catch {
    fail("toolchain manifest does not exist");
  }
  if (metadata.isSymbolicLink() || !metadata.isFile() || metadata.size > 16 * 1024 * 1024) {
    fail("toolchain manifest must be one bounded regular file");
  }
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    fail("toolchain manifest must contain valid JSON");
  }
}

function requireDistributionSurface(files) {
  for (const [path, mode] of [
    ...REQUIRED_RUNTIME_FILES,
    ...REQUIRED_DISTRIBUTION_FILES,
  ]) {
    const entry = files.find((candidate) => candidate.path === path);
    if (entry === undefined || entry.mode !== mode) {
      fail(`toolchain is missing required distribution file: ${path}`);
    }
  }
  for (const prefix of ["include/", "lib/"]) {
    if (!files.some((entry) => entry.path.startsWith(prefix))) {
      fail(`toolchain is missing required distribution tree: ${prefix.slice(0, -1)}`);
    }
  }
}

export async function refreshToolchainManifest(options) {
  const root = safeRoot(options.root, "toolchain root");
  const version = validatedVersion(options.version);
  const sourceSha = validatedSourceSha(options.sourceSha);
  await requireDirectory(root, "toolchain root");
  let components = options.components;
  if (components === undefined) {
    const existing = await readManifest(root);
    components = existing.components;
  }
  components = validateComponents(components, version);
  const inventory = await scanTree(root, options);
  requireDistributionSurface(inventory.files);
  const manifest = {
    components,
    files: inventory.files,
    schema: "zerglang.toolchain-bundle/1",
    source_sha: sourceSha,
    target: TARGET,
    version,
  };
  const path = join(root, MANIFEST_PATH);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o644 });
  await chmod(path, 0o644);
  return { manifest, path };
}

function exactFields(value, expected, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail(`${label} must be an object`);
  }
  const actual = Object.keys(value).sort();
  const fields = [...expected].sort();
  if (actual.join("\n") !== fields.join("\n")) fail(`${label} fields are not exact`);
}

function validateManifest(manifest, version, sourceSha) {
  exactFields(
    manifest,
    ["components", "files", "schema", "source_sha", "target", "version"],
    "toolchain manifest",
  );
  if (manifest.schema !== "zerglang.toolchain-bundle/1") fail("toolchain manifest schema is unsupported");
  if (manifest.version !== version) fail("toolchain manifest version does not match");
  if (manifest.source_sha !== sourceSha) fail("toolchain manifest source SHA does not match");
  if (manifest.target !== TARGET) fail("toolchain manifest target does not match");
  validateComponents(manifest.components, version);
  if (!Array.isArray(manifest.files)) fail("toolchain manifest files must be an array");
  let previous = "";
  const seen = new Set();
  for (const entry of manifest.files) {
    exactFields(entry, ["mode", "path", "sha256", "size", "type"], "toolchain file entry");
    if (
      entry.type !== "file" ||
      (entry.mode !== "0644" && entry.mode !== "0755") ||
      typeof entry.path !== "string" ||
      entry.path === "" ||
      entry.path.startsWith("/") ||
      entry.path.includes("\\") ||
      entry.path.split("/").some((part) => part === "" || part === "." || part === "..") ||
      !SHA256_PATTERN.test(entry.sha256) ||
      !Number.isSafeInteger(entry.size) ||
      entry.size < 0
    ) {
      fail("toolchain manifest contains an invalid file entry");
    }
    if (seen.has(entry.path)) fail(`toolchain manifest contains duplicate path: ${entry.path}`);
    if (previous !== "" && previous.localeCompare(entry.path, "en") >= 0) {
      fail("toolchain manifest file inventory is not in canonical order");
    }
    seen.add(entry.path);
    previous = entry.path;
  }
  requireDistributionSurface(manifest.files);
  return manifest;
}

export async function verifyToolchainTree(options) {
  const root = safeRoot(options.root, "toolchain root");
  const version = validatedVersion(options.version);
  const sourceSha = validatedSourceSha(options.sourceSha);
  await requireDirectory(root, "toolchain root");
  const manifest = validateManifest(await readManifest(root), version, sourceSha);
  const actual = await scanTree(root, options);
  if (manifest.files.length !== actual.files.length) fail("toolchain file inventory does not match");
  for (let index = 0; index < actual.files.length; index += 1) {
    const expected = manifest.files[index];
    const observed = actual.files[index];
    if (expected.path !== observed.path) fail("toolchain file inventory does not match");
    if (expected.mode !== observed.mode) fail(`toolchain file mode does not match: ${observed.path}`);
    if (expected.size !== observed.size || expected.sha256 !== observed.sha256) {
      fail(`toolchain file digest does not match: ${observed.path}`);
    }
  }
  const versionBytes = await readFile(join(root, "VERSION"), "utf8").catch(() => "");
  if (versionBytes !== `${version}\n`) fail("toolchain VERSION does not match");
  return { ...actual, manifest };
}

function archiveName(version) {
  return `zerglang-toolchain-${version}-${TARGET}.tar.gz`;
}

async function requireFreshOutput(path, label) {
  if (path === "/") fail(`${label} is unsafe`);
  try {
    await lstat(path);
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  fail(`${label} must not already exist`);
}

export async function packageToolchain(options) {
  const root = safeRoot(options.root, "toolchain root");
  const outputPath = safeRoot(options.outputPath, "toolchain archive output");
  const version = validatedVersion(options.version);
  const sourceSha = validatedSourceSha(options.sourceSha);
  if (basename(outputPath) !== archiveName(version)) {
    fail(`toolchain archive must be named ${archiveName(version)}`);
  }
  if (outputPath.startsWith(`${root}${sep}`)) fail("toolchain archive output must be outside its input");
  await requireFreshOutput(outputPath, "toolchain archive output");
  const verified = await verifyToolchainTree({ ...options, root, version, sourceSha });
  await mkdir(dirname(outputPath), { recursive: true });
  await create(
    {
      cwd: root,
      file: outputPath,
      gzip: true,
      mtime: ARCHIVE_MTIME,
      noDirRecurse: true,
      portable: true,
      strict: true,
    },
    verified.archivePaths,
  );
  const metadata = await lstat(outputPath);
  const limits = budgets(options);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > limits.maxArchiveBytes) {
    await rm(outputPath, { force: true });
    fail(`toolchain archive exceeds ${limits.maxArchiveBytes} bytes`);
  }
  return {
    entryCount: verified.entryCount,
    outputPath,
    size: metadata.size,
    uncompressedBytes: verified.uncompressedBytes,
  };
}

function normalizeArchivePath(path) {
  if (
    typeof path !== "string" ||
    path === "" ||
    path.length > 4096 ||
    path.includes("\0") ||
    path.includes("\\") ||
    path.startsWith("/")
  ) {
    fail("toolchain archive contains an unsafe path");
  }
  const normalized = path.endsWith("/") ? path.slice(0, -1) : path;
  const parts = normalized.split("/");
  if (parts.some((part) => part === "" || part === "." || part === "..")) {
    fail("toolchain archive contains an unsafe path");
  }
  return normalized;
}

function archiveValidator(options) {
  const limits = budgets(options);
  const seen = new Set();
  const types = new Map();
  let entryCount = 0;
  let uncompressedBytes = 0;
  return {
    accept(entry) {
      const path = normalizeArchivePath(entry.path);
      if (seen.has(path)) fail(`toolchain archive contains duplicate path: ${path}`);
      if (entry.type !== "File" && entry.type !== "Directory") {
        fail(`toolchain archive contains unsupported entry: ${path}`);
      }
      const type = entry.type === "File" ? "file" : "directory";
      const parts = path.split("/");
      for (let index = 1; index < parts.length; index += 1) {
        const ancestor = parts.slice(0, index).join("/");
        if (types.get(ancestor) === "file") fail(`toolchain archive hierarchy conflicts at ${ancestor}`);
      }
      if (type === "file" && [...seen].some((candidate) => candidate.startsWith(`${path}/`))) {
        fail(`toolchain archive hierarchy conflicts at ${path}`);
      }
      if (type === "directory" && entry.size !== 0) {
        fail(`toolchain archive directory declares bytes: ${path}`);
      }
      if (type === "file" && (!Number.isSafeInteger(entry.size) || entry.size < 0)) {
        fail(`toolchain archive file has invalid size: ${path}`);
      }
      entryCount += 1;
      if (entryCount > limits.maxEntryCount) fail(`toolchain archive entry count exceeds ${limits.maxEntryCount}`);
      if (type === "file") {
        if (entry.size > limits.maxFileBytes) fail(`toolchain archive file exceeds ${limits.maxFileBytes} bytes`);
        uncompressedBytes += entry.size;
        if (!Number.isSafeInteger(uncompressedBytes) || uncompressedBytes > limits.maxUncompressedBytes) {
          fail(`toolchain archive uncompressed bytes exceed ${limits.maxUncompressedBytes}`);
        }
      }
      seen.add(path);
      types.set(path, type);
      return true;
    },
    result() {
      return { entryCount, uncompressedBytes };
    },
  };
}

export async function extractToolchainArchive(options) {
  const outputDirectory = safeRoot(options.outputDirectory, "toolchain extraction output directory");
  await requireFreshOutput(outputDirectory, "toolchain extraction output directory");
  const version = validatedVersion(options.version);
  const sourceSha = validatedSourceSha(options.sourceSha);
  const archivePath = safeRoot(options.archivePath, "toolchain archive");
  if (basename(archivePath) !== archiveName(version)) {
    fail(`toolchain archive must be named ${archiveName(version)}`);
  }
  let metadata;
  try {
    metadata = await lstat(archivePath);
  } catch {
    fail("toolchain archive does not exist");
  }
  const limits = budgets(options);
  if (
    metadata.isSymbolicLink() ||
    !metadata.isFile() ||
    metadata.size < 1 ||
    metadata.size > limits.maxArchiveBytes
  ) {
    fail("toolchain archive must be one bounded regular file");
  }
  const digestBefore = await sha256File(archivePath);
  const validator = archiveValidator(options);
  await list({
    file: archivePath,
    onentry(entry) {
      validator.accept(entry);
    },
    strict: true,
  });
  const measured = validator.result();
  await mkdir(outputDirectory, { recursive: false });
  try {
    await extract({
      cwd: outputDirectory,
      file: archivePath,
      filter(path, entry) {
        normalizeArchivePath(path);
        return entry.type === "File" || entry.type === "Directory";
      },
      preservePaths: false,
      strict: true,
      unlink: true,
    });
    if (await sha256File(archivePath) !== digestBefore) fail("toolchain archive changed during extraction");
    const verified = await verifyToolchainTree({
      ...options,
      root: outputDirectory,
      sourceSha,
      version,
    });
    return { ...measured, manifest: verified.manifest, outputDirectory };
  } catch (error) {
    await rm(outputDirectory, { recursive: true, force: true });
    throw error;
  }
}

async function main() {
  const operation = process.argv[2];
  if (operation === "refresh" && process.argv.length === 6) {
    await refreshToolchainManifest({
      root: process.argv[3],
      version: process.argv[4],
      sourceSha: process.argv[5],
    });
    return;
  }
  if (operation === "verify" && process.argv.length === 6) {
    await verifyToolchainTree({
      root: process.argv[3],
      version: process.argv[4],
      sourceSha: process.argv[5],
    });
    return;
  }
  if (operation === "package" && process.argv.length === 7) {
    await packageToolchain({
      root: process.argv[3],
      outputPath: process.argv[4],
      version: process.argv[5],
      sourceSha: process.argv[6],
    });
    return;
  }
  if (operation === "extract" && process.argv.length === 7) {
    await extractToolchainArchive({
      archivePath: process.argv[3],
      outputDirectory: process.argv[4],
      version: process.argv[5],
      sourceSha: process.argv[6],
    });
    return;
  }
  fail("usage: toolchain-package.mjs refresh|verify ROOT VERSION SHA | " +
    "package ROOT ARCHIVE VERSION SHA | extract ARCHIVE ROOT VERSION SHA");
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main().catch((error) => {
    console.error(`toolchain-package: ${error.message}`);
    process.exitCode = 1;
  });
}
