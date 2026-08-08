#!/usr/bin/env bash
set -euo pipefail

if [[ "$#" -ne 4 ]]; then
  echo "usage: $0 APPLICATION.app IDENTITY CHANNEL VERSION" >&2
  exit 2
fi

app="$1"
identity="$2"
channel="$3"
version="$4"
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
plist="$app/Contents/Info.plist"

if [[ ! -d "$app/Contents" || -L "$app" || ! -f "$plist" || -L "$plist" ]]; then
  echo "invalid ZergLang application bundle" >&2
  exit 1
fi
if [[ "$channel" != "preview" && "$channel" != "stable" ]]; then
  echo "channel must be preview or stable" >&2
  exit 1
fi
if [[ "$channel" == "stable" && "$identity" == "-" ]]; then
  echo "stable signing requires a Developer ID identity" >&2
  exit 1
fi
if [[ "$channel" == "preview" && "$identity" != "-" ]]; then
  echo "preview signing must use the ad-hoc identity" >&2
  exit 1
fi
if find "$app" -type l -print -quit | grep -q .; then
  echo "application contains a symbolic link" >&2
  exit 1
fi
if find "$app" \! -type d \! -type f -print -quit | grep -q .; then
  echo "application contains a special filesystem entry" >&2
  exit 1
fi

identifier="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$plist")"
bundle_version="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$plist")"
[[ "$identifier" == "com.zergai.zerglang.ide" ]] || {
  echo "unexpected bundle identifier: $identifier" >&2
  exit 1
}
[[ "$bundle_version" == "$version" ]] || {
  echo "unexpected bundle version: $bundle_version" >&2
  exit 1
}

sign_args=(--force --options runtime --sign "$identity")
if [[ "$channel" == "stable" ]]; then
  sign_args+=(--timestamp)
  compiler_entitlements="$script_dir/CompilerStableEntitlements.plist"
else
  sign_args+=(--timestamp=none)
  compiler_entitlements="$script_dir/CompilerPreviewEntitlements.plist"
fi

signed_macho_count=0
while IFS= read -r -d '' path; do
  if ! file -b "$path" | grep -q 'Mach-O'; then
    continue
  fi
  case "$path" in
    */Contents/Resources/toolchain/bin/zlc)
      codesign "${sign_args[@]}" --entitlements "$compiler_entitlements" "$path"
      ;;
    */Contents/Resources/toolchain/bin/zlsync)
      codesign "${sign_args[@]}" --entitlements "$script_dir/ToolEntitlements.plist" "$path"
      ;;
    *)
      codesign "${sign_args[@]}" "$path"
      ;;
  esac
  signed_macho_count=$((signed_macho_count + 1))
done < <(find "$app/Contents" -type f -print0)
if [[ "$signed_macho_count" -eq 0 ]]; then
  echo "application contains no Mach-O code" >&2
  exit 1
fi

while IFS= read -r -d '' nested; do
  codesign "${sign_args[@]}" "$nested"
done < <(
  find "$app/Contents" -depth -type d \
    \( -name '*.app' -o -name '*.framework' -o -name '*.xpc' \) -print0
)
codesign "${sign_args[@]}" --entitlements "$script_dir/AppEntitlements.plist" "$app"
codesign --verify --deep --strict --verbose=2 "$app"

zlc="$app/Contents/Resources/toolchain/bin/zlc"
zlc_entitlements="$(codesign -d --entitlements - "$zlc" 2>&1)"
grep -F 'com.apple.security.cs.allow-jit' <<<"$zlc_entitlements" >/dev/null
grep -F 'com.apple.security.cs.allow-unsigned-executable-memory' \
  <<<"$zlc_entitlements" >/dev/null
if [[ "$channel" == "stable" ]]; then
  if grep -F 'com.apple.security.cs.disable-library-validation' \
    <<<"$zlc_entitlements" >/dev/null; then
    echo "stable compiler must retain library validation" >&2
    exit 1
  fi
  signature_details="$(codesign -dv --verbose=4 "$app" 2>&1)"
  grep -F 'Authority=Developer ID Application' <<<"$signature_details" >/dev/null
  grep -F 'flags=' <<<"$signature_details" | grep -F 'runtime' >/dev/null
else
  grep -F 'com.apple.security.cs.disable-library-validation' \
    <<<"$zlc_entitlements" >/dev/null
  codesign -dv --verbose=4 "$app" 2>&1 | grep -F 'Signature=adhoc' >/dev/null
fi

echo "Signed $signed_macho_count Mach-O files in $app"
