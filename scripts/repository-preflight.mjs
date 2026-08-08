#!/usr/bin/env node

import { pathToFileURL } from "node:url";

export class RepositoryPreflightError extends Error {
  constructor(message) {
    super(message);
    this.name = "RepositoryPreflightError";
  }
}

export function auditRepositoryState() {
  return { errors: [], warnings: [] };
}

export async function collectRepositoryState() {
  return {};
}

async function main() {
  const phase = process.argv[2];
  if (phase !== "cutover" && phase !== "live") {
    throw new RepositoryPreflightError(
      "usage: repository-preflight.mjs cutover|live",
    );
  }
  const result = auditRepositoryState(
    await collectRepositoryState(),
    { phase },
  );
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (result.errors.length > 0) process.exitCode = 1;
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main().catch((error) => {
    console.error(`repository-preflight: ${error.message}`);
    process.exitCode = 1;
  });
}
