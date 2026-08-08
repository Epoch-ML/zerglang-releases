#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

import { parseDocument } from "yaml";

export class WorkflowPolicyError extends Error {
  constructor(message) {
    super(message);
    this.name = "WorkflowPolicyError";
  }
}

function parseWorkflow(source) {
  if (typeof source !== "string" || source.trim() === "") {
    throw new WorkflowPolicyError("workflow source must be non-empty text");
  }
  const document = parseDocument(source, {
    maxAliasCount: 0,
    prettyErrors: false,
    strict: true,
  });
  if (document.errors.length > 0) {
    throw new WorkflowPolicyError("workflow source must be valid YAML");
  }
  const workflow = document.toJS({ maxAliasCount: 0 });
  if (workflow === null || typeof workflow !== "object" || Array.isArray(workflow)) {
    throw new WorkflowPolicyError("workflow root must be a mapping");
  }
  return workflow;
}

export function auditWorkflowPolicy(source) {
  parseWorkflow(source);
  return [];
}

async function main() {
  if (process.argv.length !== 3) {
    throw new WorkflowPolicyError("usage: workflow-policy.mjs WORKFLOW.yml");
  }
  const source = await readFile(process.argv[2], "utf8");
  const diagnostics = auditWorkflowPolicy(source);
  process.stdout.write(`${JSON.stringify({ diagnostics }, null, 2)}\n`);
  if (diagnostics.length > 0) process.exitCode = 1;
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main().catch((error) => {
    console.error(`workflow-policy: ${error.message}`);
    process.exitCode = 1;
  });
}
