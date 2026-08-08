const suites = Object.freeze({
  "feed-policy": Object.freeze({
    source: "scripts/feed-policy.mjs",
    tests: ["scripts/feed-policy.test.mjs"],
  }),
  "feed-promotion": Object.freeze({
    source: "scripts/feed-promotion.mjs",
    tests: ["scripts/feed-promotion.test.mjs"],
  }),
  "package-macos": Object.freeze({
    source: "scripts/package-macos.mjs",
    tests: ["scripts/source-stage.test.mjs"],
  }),
  "release-payload": Object.freeze({
    source: "scripts/release-payload.mjs",
    tests: [
      "scripts/release-payload-schema.test.mjs",
      "scripts/release-payload.test.mjs",
    ],
  }),
  "release-request": Object.freeze({
    source: "scripts/release-request.mjs",
    tests: [
      "scripts/release-request-boundary.test.mjs",
      "scripts/release-request.test.mjs",
    ],
  }),
  "repository-preflight": Object.freeze({
    source: "scripts/repository-preflight.mjs",
    tests: ["scripts/repository-preflight.test.mjs"],
  }),
  "source-stage": Object.freeze({
    source: "scripts/source-stage.mjs",
    tests: ["scripts/source-stage.test.mjs"],
  }),
  "workflow-policy": Object.freeze({
    source: "scripts/workflow-policy.mjs",
    tests: ["scripts/workflow-policy.test.mjs"],
  }),
});

const selected = process.env.ZERGLANG_MUTATION_TARGET;
if (selected === undefined || !Object.hasOwn(suites, selected)) {
  throw new Error(
    `ZERGLANG_MUTATION_TARGET must be one of: ${Object.keys(suites).join(", ")}`,
  );
}
const suite = suites[selected];

export default {
  mutate: [suite.source],
  testRunner: "command",
  commandRunner: {
    command: `node --test ${suite.tests.join(" ")}`,
  },
  concurrency: 4,
  coverageAnalysis: "off",
  reporters: ["clear-text", "progress"],
  timeoutMS: 60_000,
  tempDirName: `.stryker-tmp/${selected}`,
  cleanTempDir: "always",
};
