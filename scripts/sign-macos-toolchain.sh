#!/usr/bin/env bash
set -euo pipefail

if [[ "$#" -lt 3 || "$#" -gt 4 ]]; then
  echo "usage: $0 TOOLCHAIN_ROOT IDENTITY CHANNEL [complete|embedded]" >&2
  exit 2
fi

root="$1"
identity="$2"
channel="$3"
profile="${4:-complete}"
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [[ ! -d "$root" || -L "$root" || "$root" == "/" ]]; then
  echo "invalid ZergLang toolchain root" >&2
  exit 1
fi
if [[ "$channel" != "preview" && "$channel" != "stable" ]]; then
  echo "channel must be preview or stable" >&2
  exit 1
fi
if [[ "$profile" != "complete" && "$profile" != "embedded" ]]; then
  echo "toolchain profile must be complete or embedded" >&2
  exit 1
fi
if [[ "$channel" == "stable" && "$identity" == "-" ]]; then
  echo "stable toolchain signing requires a Developer ID identity" >&2
  exit 1
fi
if [[ "$channel" == "preview" && "$identity" != "-" ]]; then
  echo "preview toolchain signing must use the ad-hoc identity" >&2
  exit 1
fi
if find "$root" -type l -print -quit | grep -q .; then
  echo "toolchain contains a symbolic link" >&2
  exit 1
fi
if find "$root" \! -type d \! -type f -print -quit | grep -q .; then
  echo "toolchain contains a special filesystem entry" >&2
  exit 1
fi

required=(
  bin/zlc
  bin/zlm
  bin/zlsync
  bin/zlbench-exec
  libexec/zerglang/zlc-core
  libexec/zerglang/zlm-driver
  libexec/zerglang/zlm-runtime
)
if [[ "$profile" == "complete" ]]; then
  required+=(libexec/zerglang/node/bin/node)
fi
for path in "${required[@]}"; do
  [[ -f "$root/$path" && ! -L "$root/$path" ]] || {
    echo "toolchain is missing required executable: $path" >&2
    exit 1
  }
  if ! file -b "$root/$path" | grep -q 'Mach-O'; then
    echo "required executable is not Mach-O: $path" >&2
    exit 1
  fi
done

sign_args=(--force --options runtime --sign "$identity")
if [[ "$channel" == "stable" ]]; then
  sign_args+=(--timestamp)
  compiler_entitlements="$script_dir/CompilerStableEntitlements.plist"
  node_entitlements="$script_dir/NodeStableEntitlements.plist"
  dylib_tool_entitlements="$script_dir/ToolEntitlements.plist"
else
  sign_args+=(--timestamp=none)
  compiler_entitlements="$script_dir/CompilerPreviewEntitlements.plist"
  node_entitlements="$script_dir/NodePreviewEntitlements.plist"
  dylib_tool_entitlements="$script_dir/PreviewDylibToolEntitlements.plist"
fi

signed_count=0
while IFS= read -r -d '' path; do
  if ! file -b "$path" | grep -q 'Mach-O'; then
    continue
  fi
  case "$path" in
    "$root/libexec/zerglang/zlc-core")
      codesign "${sign_args[@]}" --entitlements "$compiler_entitlements" "$path"
      ;;
    "$root/libexec/zerglang/node/bin/node")
      codesign "${sign_args[@]}" --entitlements "$node_entitlements" "$path"
      ;;
    "$root/bin/zlsync"|\
    "$root/bin/zlbench-exec"|\
    "$root/libexec/zerglang/zlm-runtime")
      codesign "${sign_args[@]}" --entitlements "$dylib_tool_entitlements" "$path"
      ;;
    "$root/bin/zlc"|\
    "$root/bin/zlm"|\
    "$root/libexec/zerglang/zlm-driver")
      codesign "${sign_args[@]}" --entitlements "$script_dir/ToolEntitlements.plist" "$path"
      ;;
    *)
      codesign "${sign_args[@]}" "$path"
      ;;
  esac
  codesign --verify --strict --verbose=2 "$path"
  signed_count=$((signed_count + 1))
done < <(find "$root" -type f -print0)

if [[ "$signed_count" -eq 0 ]]; then
  echo "toolchain contains no Mach-O code" >&2
  exit 1
fi

zlc_core="$root/libexec/zerglang/zlc-core"
zlc_entitlements="$(codesign -d --entitlements - "$zlc_core" 2>&1)"
grep -F 'com.apple.security.cs.allow-jit' <<<"$zlc_entitlements" >/dev/null
grep -F 'com.apple.security.cs.allow-unsigned-executable-memory' \
  <<<"$zlc_entitlements" >/dev/null
if [[ "$channel" == "stable" ]]; then
  if grep -F 'com.apple.security.cs.disable-library-validation' \
    <<<"$zlc_entitlements" >/dev/null; then
    echo "stable compiler must retain library validation" >&2
    exit 1
  fi
  codesign -dv --verbose=4 "$zlc_core" 2>&1 \
    | grep -F 'Authority=Developer ID Application' >/dev/null
else
  grep -F 'com.apple.security.cs.disable-library-validation' \
    <<<"$zlc_entitlements" >/dev/null
  codesign -dv --verbose=4 "$zlc_core" 2>&1 | grep -F 'Signature=adhoc' >/dev/null
fi

node="$root/libexec/zerglang/node/bin/node"
if [[ -f "$node" ]]; then
  node_entitlements_output="$(codesign -d --entitlements - "$node" 2>&1)"
  grep -F 'com.apple.security.cs.allow-jit' <<<"$node_entitlements_output" >/dev/null
  grep -F 'com.apple.security.cs.allow-unsigned-executable-memory' \
    <<<"$node_entitlements_output" >/dev/null
  if [[ "$channel" == "stable" ]]; then
    if grep -F 'com.apple.security.cs.disable-library-validation' \
      <<<"$node_entitlements_output" >/dev/null; then
      echo "stable Node runtime must retain library validation" >&2
      exit 1
    fi
  else
    grep -F 'com.apple.security.cs.disable-library-validation' \
      <<<"$node_entitlements_output" >/dev/null
  fi
fi

for path in \
  bin/zlc \
  bin/zlm \
  libexec/zerglang/zlm-driver; do
  tool_entitlements="$(codesign -d --entitlements - "$root/$path" 2>&1)"
  for entitlement in \
    com.apple.security.cs.allow-jit \
    com.apple.security.cs.allow-unsigned-executable-memory \
    com.apple.security.cs.disable-library-validation; do
    if grep -F "$entitlement" <<<"$tool_entitlements" >/dev/null; then
      echo "$path has unnecessary compiler entitlement: $entitlement" >&2
      exit 1
    fi
  done
done

for path in \
  bin/zlsync \
  bin/zlbench-exec \
  libexec/zerglang/zlm-runtime; do
  dylib_entitlements_output="$(codesign -d --entitlements - "$root/$path" 2>&1)"
  for entitlement in \
    com.apple.security.cs.allow-jit \
    com.apple.security.cs.allow-unsigned-executable-memory; do
    if grep -F "$entitlement" <<<"$dylib_entitlements_output" >/dev/null; then
      echo "$path has unnecessary compiler entitlement: $entitlement" >&2
      exit 1
    fi
  done
  if [[ "$channel" == "stable" ]]; then
    if grep -F 'com.apple.security.cs.disable-library-validation' \
      <<<"$dylib_entitlements_output" >/dev/null; then
      echo "stable $path must retain library validation" >&2
      exit 1
    fi
  else
    grep -F 'com.apple.security.cs.disable-library-validation' \
      <<<"$dylib_entitlements_output" >/dev/null
  fi
done

echo "Signed $signed_count Mach-O files in $root"
