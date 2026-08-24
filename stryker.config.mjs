export default {
  mutate: [
    "scripts/cohort-payload.mjs",
    "scripts/feed-promotion.mjs",
    "scripts/feed-policy.mjs",
    "scripts/package-macos.mjs",
    "scripts/release-payload.mjs",
    "scripts/release-request.mjs",
    "scripts/repository-preflight.mjs",
    "scripts/source-stage.mjs",
    "scripts/toolchain-package.mjs",
    "scripts/workflow-policy.mjs",
  ],
  testRunner: "command",
  commandRunner: {
    command: "node --test scripts/*.test.mjs",
  },
  concurrency: 4,
  coverageAnalysis: "off",
  reporters: ["clear-text", "progress"],
  timeoutMS: 60000,
};
