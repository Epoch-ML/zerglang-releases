#!/usr/bin/env node

export class FeedPolicyError extends Error {
  constructor(message) {
    super(message);
    this.name = "FeedPolicyError";
  }
}

export function feedDestinations() {
  throw new FeedPolicyError("feed publication policy is not implemented");
}

export async function stageReleaseFeed() {
  throw new FeedPolicyError("feed publication policy is not implemented");
}
