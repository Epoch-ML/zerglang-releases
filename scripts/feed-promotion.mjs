#!/usr/bin/env node

import { pathToFileURL } from "node:url";

export class FeedPromotionError extends Error {
  constructor(message) {
    super(message);
    this.name = "FeedPromotionError";
  }
}

export async function prepareFeedPromotion() {
  return {
    status: "unchanged",
    parent: "0".repeat(40),
    commit: "0".repeat(40),
    changedPaths: [],
  };
}

export async function pushFeedPromotion() {
  return {
    status: "unchanged",
    commit: "0".repeat(40),
  };
}

async function main() {
  const operation = process.argv[2];
  if (operation !== "prepare" && operation !== "push") {
    throw new FeedPromotionError(
      "usage: feed-promotion.mjs prepare|push ...",
    );
  }
  const operationFunction = operation === "prepare"
    ? prepareFeedPromotion
    : pushFeedPromotion;
  process.stdout.write(`${JSON.stringify(await operationFunction())}\n`);
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main().catch((error) => {
    console.error(`feed-promotion: ${error.message}`);
    process.exitCode = 1;
  });
}
