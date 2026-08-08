export default {
  mutate: [
    "scripts/feed-policy.mjs",
    "scripts/package-macos.mjs",
    "scripts/release-payload.mjs",
    "scripts/release-request.mjs",
    "scripts/source-stage.mjs",
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
