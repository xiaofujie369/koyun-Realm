#!/usr/bin/env bash
set -Eeuo pipefail

if [[ ${EUID:-$(id -u)} -ne 0 ]]; then
  echo "请使用 root 运行此脚本" >&2
  exit 1
fi

for command_name in curl python3; do
  command -v "$command_name" >/dev/null 2>&1 || {
    echo "缺少命令：$command_name" >&2
    exit 1
  }
done

case "$(uname -m)" in
  x86_64|amd64) arch_pattern='x86_64|amd64' ;;
  aarch64|arm64) arch_pattern='aarch64|arm64' ;;
  *) echo "暂不支持的架构：$(uname -m)" >&2; exit 1 ;;
esac

temp_dir="$(mktemp -d)"
trap 'rm -rf "$temp_dir"' EXIT

echo "正在查询 Realm 最新版本……"
curl -fsSL --retry 3 --connect-timeout 10 \
  https://api.github.com/repos/zhboner/realm/releases/latest \
  -o "$temp_dir/release.json"

asset_info="$(python3 - "$temp_dir/release.json" "$arch_pattern" <<'PY'
import json, re, sys

release_path, arch_pattern = sys.argv[1:]
with open(release_path, encoding="utf-8") as handle:
    release = json.load(handle)

candidates = []
for asset in release.get("assets", []):
    name = asset.get("name", "")
    lower = name.lower()
    if "linux" not in lower or not re.search(arch_pattern, lower):
        continue
    if any(word in lower for word in ("sha256", "checksum", ".sig", "source")):
        continue
    score = 0
    if "gnu" in lower: score += 3
    if "musl" in lower: score += 2
    if lower.endswith((".tar.gz", ".tgz", ".tar.xz", ".zip")): score += 2
    candidates.append((score, name, asset.get("browser_download_url", "")))

if not candidates:
    raise SystemExit("没有找到匹配当前 Linux 架构的 Realm 发布文件")

_, name, url = sorted(candidates, reverse=True)[0]
print(name)
print(url)
PY
)"

asset_name="$(sed -n '1p' <<<"$asset_info")"
asset_url="$(sed -n '2p' <<<"$asset_info")"
[[ -n "$asset_name" && -n "$asset_url" ]] || { echo "无法解析 Realm 下载地址" >&2; exit 1; }

echo "正在下载：$asset_name"
curl -fL --retry 3 --connect-timeout 10 "$asset_url" -o "$temp_dir/$asset_name"
mkdir -p "$temp_dir/extract"

python3 - "$temp_dir/$asset_name" "$temp_dir/extract" <<'PY'
import os, shutil, sys

archive, destination = sys.argv[1:]
try:
    shutil.unpack_archive(archive, destination)
except (shutil.ReadError, ValueError):
    shutil.copy2(archive, os.path.join(destination, "realm"))
PY

realm_file="$(find "$temp_dir/extract" -type f -name realm -print -quit)"
if [[ -z "$realm_file" ]]; then
  realm_file="$(find "$temp_dir/extract" -type f -iname 'realm*' ! -iname '*.md' ! -iname '*.txt' -print -quit)"
fi
[[ -n "$realm_file" ]] || { echo "发布文件中没有找到 Realm 二进制" >&2; exit 1; }

install -m 0755 "$realm_file" /usr/local/bin/realm
/usr/local/bin/realm --version 2>/dev/null || /usr/local/bin/realm -V 2>/dev/null || true
echo "Realm 已安装到 /usr/local/bin/realm"
