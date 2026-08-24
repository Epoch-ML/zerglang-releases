import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { afterEach, test } from "node:test";

const script = fileURLToPath(new URL("./sign-macos-app.sh", import.meta.url));
const temporaryDirectories = [];
const toolchainExecutables = [
  "bin/zlc",
  "bin/zlm",
  "bin/zlsync",
  "bin/zlbench-exec",
  "libexec/zerglang/zlc-core",
  "libexec/zerglang/zlm-driver",
  "libexec/zerglang/zlm-runtime",
];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function applicationFixture() {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "zerglang-sign-app-"));
  temporaryDirectories.push(temporaryRoot);
  const app = join(temporaryRoot, "ZergLang.app");
  await mkdir(join(app, "Contents", "MacOS"), { recursive: true });
  await writeFile(join(app, "Contents", "Info.plist"), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>com.zergai.zerglang.ide</string>
<key>CFBundleShortVersionString</key><string>0.2.0-preview.1</string>
</dict></plist>
`);
  await writeFile(join(app, "Contents", "MacOS", "ZergLang"), "mach-o fixture\n", {
    mode: 0o755,
  });
  const toolchain = join(app, "Contents", "Resources", "toolchain");
  for (const path of toolchainExecutables) {
    const absolute = join(toolchain, path);
    await mkdir(dirname(absolute), { recursive: true });
    await writeFile(absolute, "mach-o fixture\n", { mode: 0o755 });
  }

  const fakeBin = join(temporaryRoot, "fake-bin");
  await mkdir(fakeBin);
  await writeFile(join(fakeBin, "file"), `#!/bin/sh
echo 'Mach-O 64-bit executable arm64'
`, { mode: 0o755 });
  const codesignLog = join(temporaryRoot, "codesign.log");
  await writeFile(join(fakeBin, "codesign"), `#!/bin/sh
printf '%s\n' "$*" >>"$CODESIGN_LOG"
case " $* " in
  *" -d --entitlements - "*)
    case "$*" in
      *libexec/zerglang/zlc-core|*libexec/zerglang/node/bin/node)
        echo '<key>com.apple.security.cs.allow-jit</key>' >&2
        echo '<key>com.apple.security.cs.allow-unsigned-executable-memory</key>' >&2
        echo '<key>com.apple.security.cs.disable-library-validation</key>' >&2
        ;;
      *bin/zlsync|*bin/zlbench-exec|*libexec/zerglang/zlm-runtime)
        echo '<key>com.apple.security.cs.disable-library-validation</key>' >&2
        ;;
      *) echo '<dict/>' >&2 ;;
    esac
    ;;
  *" -dv "*) echo 'Signature=adhoc' >&2 ;;
esac
exit 0
`, { mode: 0o755 });
  return {
    app,
    codesignLog,
    env: {
      ...process.env,
      CODESIGN_LOG: codesignLog,
      PATH: `${fakeBin}:${process.env.PATH}`,
    },
  };
}

test("signs the IDE's embedded toolchain under the standalone authority split", async () => {
  const fixture = await applicationFixture();
  const result = spawnSync(
    "bash",
    [script, fixture.app, "-", "preview", "0.2.0-preview.1"],
    { encoding: "utf8", env: fixture.env },
  );
  assert.equal(result.status, 0, result.stderr);

  const calls = await readFile(fixture.codesignLog, "utf8");
  assert.match(
    calls,
    /CompilerPreviewEntitlements\.plist .*Resources\/toolchain\/libexec\/zerglang\/zlc-core/,
  );
  assert.doesNotMatch(calls, /Resources\/toolchain\/libexec\/zerglang\/node\/bin\/node/);
  assert.match(calls, /ToolEntitlements\.plist .*Resources\/toolchain\/bin\/zlm/);
  assert.doesNotMatch(
    calls,
    /CompilerPreviewEntitlements\.plist .*Resources\/toolchain\/bin\/zlc(?:\n|$)/,
  );
});
