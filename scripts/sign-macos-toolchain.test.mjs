import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { afterEach, test } from "node:test";

const script = fileURLToPath(new URL("./sign-macos-toolchain.sh", import.meta.url));
const temporaryDirectories = [];
const requiredExecutables = [
  "bin/zlc",
  "bin/zlm",
  "bin/zlsync",
  "bin/zlbench-exec",
  "libexec/zerglang/zlc-core",
  "libexec/zerglang/zlm-driver",
  "libexec/zerglang/zlm-runtime",
  "libexec/zerglang/node/bin/node",
];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function toolchainFixture() {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "zerglang-sign-toolchain-"));
  temporaryDirectories.push(temporaryRoot);
  const root = join(temporaryRoot, "toolchain");
  for (const path of requiredExecutables) {
    const absolute = join(root, path);
    await mkdir(dirname(absolute), { recursive: true });
    await writeFile(absolute, "mach-o fixture\n", { mode: 0o755 });
  }
  // `file` and `codesign` are mocked only at their operating-system process boundary.
  const fakeBin = join(temporaryRoot, "fake-bin");
  await mkdir(fakeBin);
  await writeFile(join(fakeBin, "file"), `#!/bin/sh
for candidate do path="$candidate"; done
if grep -q 'not-mach-o' "$path"; then
  echo 'POSIX shell script, ASCII text executable'
else
  echo 'Mach-O 64-bit executable arm64'
fi
`, { mode: 0o755 });
  const codesignLog = join(temporaryRoot, "codesign.log");
  await writeFile(join(fakeBin, "codesign"), `#!/bin/sh
printf '%s\n' "$*" >>"$CODESIGN_LOG"
case " $* " in
  *" -d --entitlements - "*)
    case "$*" in
      *libexec/zerglang/zlc-core)
        echo '<key>com.apple.security.cs.allow-jit</key>' >&2
        echo '<key>com.apple.security.cs.allow-unsigned-executable-memory</key>' >&2
        if [ "\${FAKE_STABLE:-0}" != 1 ]; then
          echo '<key>com.apple.security.cs.disable-library-validation</key>' >&2
        fi
        ;;
      *libexec/zerglang/node/bin/node)
        echo '<key>com.apple.security.cs.allow-jit</key>' >&2
        echo '<key>com.apple.security.cs.allow-unsigned-executable-memory</key>' >&2
        if [ "\${FAKE_STABLE:-0}" != 1 ]; then
          echo '<key>com.apple.security.cs.disable-library-validation</key>' >&2
        fi
        ;;
      *bin/zlsync|*bin/zlbench-exec|*libexec/zerglang/zlm-runtime)
        if [ "\${FAKE_STABLE:-0}" != 1 ]; then
          echo '<key>com.apple.security.cs.disable-library-validation</key>' >&2
        fi
        ;;
      *) echo '<dict/>' >&2 ;;
    esac
    ;;
  *" -dv "*)
    echo 'Signature=adhoc' >&2
    echo 'Authority=Developer ID Application: Fixture' >&2
    ;;
esac
exit 0
`, { mode: 0o755 });
  return {
    codesignLog,
    env: {
      ...process.env,
      CODESIGN_LOG: codesignLog,
      PATH: `${fakeBin}:${process.env.PATH}`,
    },
    root,
  };
}

test("ad-hoc signs every required Apple Silicon toolchain executable", async () => {
  const fixture = await toolchainFixture();
  const result = spawnSync("bash", [script, fixture.root, "-", "preview"], {
    encoding: "utf8",
    env: fixture.env,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Signed 8 Mach-O files/);
  const codesignCalls = await readFile(fixture.codesignLog, "utf8");
  assert.match(
    codesignCalls,
    /--entitlements .*CompilerPreviewEntitlements\.plist .*libexec\/zerglang\/zlc-core/,
  );
  assert.match(
    codesignCalls,
    /--entitlements .*ToolEntitlements\.plist .*bin\/zlc/,
  );
  assert.match(
    codesignCalls,
    /--entitlements .*NodePreviewEntitlements\.plist .*libexec\/zerglang\/node\/bin\/node/,
  );
  for (const path of ["bin/zlsync", "bin/zlbench-exec", "libexec/zerglang/zlm-runtime"]) {
    assert.match(
      codesignCalls,
      new RegExp(`--entitlements .*PreviewDylibToolEntitlements\\.plist .*${path}`),
    );
  }
  assert.doesNotMatch(
    codesignCalls,
    /CompilerPreviewEntitlements\.plist .*bin\/zlc(?:\n|$)/,
  );
  assert.doesNotMatch(
    codesignCalls,
    /ToolEntitlements\.plist .*libexec\/zerglang\/node\/bin\/node/,
  );
});

test("stable signing gives Node only its bounded V8 runtime authority", async () => {
  const fixture = await toolchainFixture();
  const result = spawnSync(
    "bash",
    [script, fixture.root, "Developer ID Application: Fixture", "stable"],
    { encoding: "utf8", env: { ...fixture.env, FAKE_STABLE: "1" } },
  );
  assert.equal(result.status, 0, result.stderr);

  const codesignCalls = await readFile(fixture.codesignLog, "utf8");
  assert.match(
    codesignCalls,
    /--entitlements .*NodeStableEntitlements\.plist .*libexec\/zerglang\/node\/bin\/node/,
  );
  for (const path of ["bin/zlsync", "bin/zlbench-exec", "libexec/zerglang/zlm-runtime"]) {
    assert.match(
      codesignCalls,
      new RegExp(`--entitlements .*ToolEntitlements\\.plist .*${path}`),
    );
  }
  assert.doesNotMatch(codesignCalls, /NodeStableEntitlements\.plist .*bin\/zlm(?:\n|$)/);
});

test("rejects a required command that cannot receive an Apple code signature", async () => {
  const fixture = await toolchainFixture();
  await writeFile(join(fixture.root, "bin/zlm"), "not-mach-o\n", { mode: 0o755 });

  const result = spawnSync("bash", [script, fixture.root, "-", "preview"], {
    encoding: "utf8",
    env: fixture.env,
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /required executable is not Mach-O: bin\/zlm/);
});
