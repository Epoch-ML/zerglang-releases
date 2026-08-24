#!/usr/bin/env node

import { lstat, mkdir, readdir, rm } from "node:fs/promises";
import { basename, dirname, join, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

import { create, extract, list } from "tar";

const ARCHIVE_MTIME = new Date("2020-01-01T00:00:00.000Z");
const DEFAULT_MAX_ARCHIVE_BYTES = 1_073_741_824;
const DEFAULT_MAX_ENTRY_COUNT = 16_384;
const DEFAULT_MAX_FILE_BYTES = 536_870_912;
const DEFAULT_MAX_UNCOMPRESSED_BYTES = 2_147_483_648;

function requirePath(value, message) {
  if (typeof value !== "string" || value.trim() === "") throw new Error(message);
  return resolve(value.trim());
}

function requireBudget(value, fallback, description) {
  const budget = value ?? fallback;
  if (!Number.isSafeInteger(budget) || budget <= 0) {
    throw new Error(`${description} must be a positive safe integer`);
  }
  return budget;
}

function budgetsFrom(options) {
  return {
    maxArchiveBytes: requireBudget(
      options.maxArchiveBytes,
      DEFAULT_MAX_ARCHIVE_BYTES,
      "maximum archive bytes",
    ),
    maxEntryCount: requireBudget(
      options.maxEntryCount,
      DEFAULT_MAX_ENTRY_COUNT,
      "maximum archive entry count",
    ),
    maxFileBytes: requireBudget(
      options.maxFileBytes,
      DEFAULT_MAX_FILE_BYTES,
      "maximum archive file bytes",
    ),
    maxUncompressedBytes: requireBudget(
      options.maxUncompressedBytes,
      DEFAULT_MAX_UNCOMPRESSED_BYTES,
      "maximum archive uncompressed bytes",
    ),
  };
}

function addEntryToBudget(state, path, type, size, budgets) {
  state.entryCount += 1;
  if (state.entryCount > budgets.maxEntryCount) {
    throw new Error(`archive entry count exceeds ${budgets.maxEntryCount}`);
  }
  if (type !== "file") return;
  if (!Number.isSafeInteger(size) || size < 0) {
    throw new Error(`archive file has an invalid size: ${path}`);
  }
  if (size > budgets.maxFileBytes) {
    throw new Error(`archive file exceeds ${budgets.maxFileBytes} bytes: ${path}`);
  }
  state.uncompressedBytes += size;
  if (
    !Number.isSafeInteger(state.uncompressedBytes)
    || state.uncompressedBytes > budgets.maxUncompressedBytes
  ) {
    throw new Error(
      `archive uncompressed size exceeds ${budgets.maxUncompressedBytes} bytes`,
    );
  }
}

async function sortedTree(root, budgets) {
  const paths = [];
  const state = { entryCount: 0, uncompressedBytes: 0 };
  async function visit(absolutePath, relativePath) {
    const metadata = await lstat(absolutePath);
    if (metadata.isSymbolicLink()) {
      throw new Error(`source application contains a symbolic link: ${relativePath}`);
    }
    if (!metadata.isDirectory() && !metadata.isFile()) {
      throw new Error(`source application contains a special entry: ${relativePath}`);
    }
    addEntryToBudget(
      state,
      relativePath,
      metadata.isFile() ? "file" : "directory",
      metadata.size,
      budgets,
    );
    paths.push(relativePath);
    if (!metadata.isDirectory()) return;
    const names = (await readdir(absolutePath)).sort((left, right) =>
      left.localeCompare(right, "en"));
    for (const name of names) await visit(join(absolutePath, name), join(relativePath, name));
  }
  await visit(root, basename(root));
  return { paths, ...state };
}

function normalizeArchivePath(path) {
  if (
    typeof path !== "string"
    || path.length === 0
    || path.length > 4096
    || path.includes("\0")
    || path.includes("\\")
    || path.startsWith("/")
  ) {
    throw new Error("archive path must remain under ZergLang.app/");
  }
  const normalized = path.endsWith("/") ? path.slice(0, -1) : path;
  const segments = normalized.split("/");
  if (
    segments[0] !== "ZergLang.app"
    || segments.some((segment) => segment === "" || segment === "." || segment === "..")
  ) {
    throw new Error("archive path must remain under ZergLang.app/");
  }
  return normalized;
}

function makeArchiveValidator(budgets) {
  const seen = new Set();
  const entryTypes = new Map();
  const state = { entryCount: 0, uncompressedBytes: 0 };
  return {
    accept(entry) {
      const path = normalizeArchivePath(entry.path);
      if (seen.has(path)) throw new Error(`archive contains a duplicate path: ${path}`);
      seen.add(path);
      if (entry.type !== "File" && entry.type !== "Directory") {
        throw new Error(`archive entries must be regular files or directories: ${path}`);
      }
      const type = entry.type === "File" ? "file" : "directory";
      const segments = path.split("/");
      for (let index = 1; index < segments.length; index += 1) {
        const ancestor = segments.slice(0, index).join("/");
        if (entryTypes.get(ancestor) === "file") {
          throw new Error(`archive path hierarchy conflicts at ${ancestor}`);
        }
      }
      if (
        type === "file"
        && [...seen].some((seenPath) => seenPath.startsWith(`${path}/`))
      ) {
        throw new Error(`archive path hierarchy conflicts at ${path}`);
      }
      entryTypes.set(path, type);
      if (entry.type === "Directory" && entry.size !== 0) {
        throw new Error(`archive directory declares non-zero bytes: ${path}`);
      }
      addEntryToBudget(state, path, type, entry.size, budgets);
      return true;
    },
    result() {
      if (!seen.has("ZergLang.app")) {
        throw new Error("archive must contain exactly one ZergLang.app root");
      }
      if (entryTypes.get("ZergLang.app") !== "directory") {
        throw new Error("archive ZergLang.app root must be a directory");
      }
      return { ...state };
    },
  };
}

async function assertFreshOutputDirectory(outputDirectory) {
  if (outputDirectory === "/") throw new Error("extraction output directory is unsafe");
  try {
    await lstat(outputDirectory);
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  throw new Error("extraction output directory must not already exist");
}

export async function packageMacApplication(options) {
  const budgets = budgetsFrom(options);
  const applicationPath = requirePath(options.applicationPath, "application path is required");
  const outputPath = requirePath(options.outputPath, "archive output path is required");
  let applicationMetadata;
  try {
    applicationMetadata = await lstat(applicationPath);
  } catch {
    throw new Error("application path must be one existing .app directory");
  }
  if (
    !applicationPath.endsWith(".app")
    || !applicationMetadata.isDirectory()
    || applicationMetadata.isSymbolicLink()
  ) {
    throw new Error("application path must be one existing .app directory");
  }
  if (outputPath === applicationPath || outputPath.startsWith(applicationPath + sep)) {
    throw new Error("archive output must be outside the application");
  }
  if (!outputPath.endsWith(".app.tar.gz")) {
    throw new Error("archive output must end with .app.tar.gz");
  }

  const tree = await sortedTree(applicationPath, budgets);
  await mkdir(dirname(outputPath), { recursive: true });
  await create({
    cwd: dirname(applicationPath),
    file: outputPath,
    gzip: { level: 9 },
    mtime: ARCHIVE_MTIME,
    noDirRecurse: true,
    portable: true,
    preservePaths: false,
  }, tree.paths);
  const archiveMetadata = await lstat(outputPath);
  if (archiveMetadata.size > budgets.maxArchiveBytes) {
    await rm(outputPath, { force: true });
    throw new Error(`archive exceeds ${budgets.maxArchiveBytes} bytes`);
  }
  return {
    entryCount: tree.entryCount,
    outputPath,
    uncompressedBytes: tree.uncompressedBytes,
  };
}

export async function extractSourceApplication(options) {
  const budgets = budgetsFrom(options);
  const archivePath = requirePath(options.archivePath, "source archive path is required");
  const outputDirectory = requirePath(
    options.outputDirectory,
    "extraction output directory is required",
  );
  if (archivePath === outputDirectory || archivePath.startsWith(outputDirectory + sep)) {
    throw new Error("extraction output directory is unsafe");
  }
  const archiveMetadata = await lstat(archivePath);
  if (!archiveMetadata.isFile() || archiveMetadata.isSymbolicLink()) {
    throw new Error("source archive must be one regular non-symlink file");
  }
  if (archiveMetadata.size > budgets.maxArchiveBytes) {
    throw new Error(`archive exceeds ${budgets.maxArchiveBytes} bytes`);
  }

  const inspection = makeArchiveValidator(budgets);
  list({
    file: archivePath,
    onentry: (entry) => inspection.accept(entry),
    preservePaths: false,
    strict: true,
    sync: true,
  });
  const inspected = inspection.result();

  await assertFreshOutputDirectory(outputDirectory);
  await mkdir(outputDirectory);
  try {
    const extraction = makeArchiveValidator(budgets);
    await extract({
      cwd: outputDirectory,
      file: archivePath,
      filter: (_path, entry) => extraction.accept(entry),
      preservePaths: false,
      strict: true,
    });
    const extracted = extraction.result();
    if (
      extracted.entryCount !== inspected.entryCount
      || extracted.uncompressedBytes !== inspected.uncompressedBytes
    ) {
      throw new Error("archive changed between validation and extraction");
    }
    const applicationPath = join(outputDirectory, "ZergLang.app");
    const tree = await sortedTree(applicationPath, budgets);
    if (
      tree.entryCount !== inspected.entryCount
      || tree.uncompressedBytes !== inspected.uncompressedBytes
    ) {
      throw new Error("extracted application does not match the validated archive");
    }
    return { applicationPath, ...inspected };
  } catch (error) {
    await rm(outputDirectory, { recursive: true, force: true });
    throw error;
  }
}

async function main() {
  if (process.argv.length !== 4) {
    throw new Error("usage: package-macos.mjs APPLICATION.app OUTPUT.app.tar.gz");
  }
  const result = await packageMacApplication({
    applicationPath: process.argv[2],
    outputPath: process.argv[3],
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main().catch((error) => {
    console.error(`package-macos: ${error.message}`);
    process.exitCode = 1;
  });
}
