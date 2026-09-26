#!/usr/bin/env bash
# 将旧默认 Compose 的 backend/.env 并入新版 /data/.env；新版已有值优先。
set -euo pipefail
umask 077

source_env="${1:?用法：migrate-compose-env.sh <旧 backend/.env> <新版 /data/.env>}"
target_env="${2:?用法：migrate-compose-env.sh <旧 backend/.env> <新版 /data/.env>}"

if [[ "$source_env" == "$target_env" ]]; then
  echo "旧应用配置与持久化配置路径相同，无需迁移。"
  exit 0
fi
if [[ ! -f "$source_env" || -L "$source_env" ]]; then
  echo "未找到普通文件形式的旧 backend/.env，跳过应用配置迁移。"
  exit 0
fi

target_dir="$(dirname "$target_env")"
mkdir -p "$target_dir"
temp_file="$(mktemp "$target_dir/.gugu-env-migration.XXXXXX")"
count_file="$(mktemp "$target_dir/.gugu-env-count.XXXXXX")"
cleanup() { rm -f -- "$temp_file" "$count_file"; }
trap cleanup EXIT

if [[ ! -e "$target_env" ]]; then
  cp -- "$source_env" "$temp_file"
  added="$(awk '
    function key_of(line, key) {
      key = line
      sub(/^[[:space:]]*/, "", key)
      sub(/^export[[:space:]]+/, "", key)
      if (key !~ /^[A-Za-z_][A-Za-z0-9_]*=/) return ""
      sub(/=.*/, "", key)
      return key
    }
    { if (key_of($0) != "") count++ }
    END { print count + 0 }
  ' "$source_env")"
else
  if [[ ! -f "$target_env" || -L "$target_env" ]]; then
    echo "新版持久化配置不是普通文件，拒绝合并。" >&2
    exit 1
  fi
  awk -v countfile="$count_file" -v targetfile="$target_env" '
    function key_of(line, key) {
      key = line
      sub(/^[[:space:]]*/, "", key)
      sub(/^export[[:space:]]+/, "", key)
      if (key !~ /^[A-Za-z_][A-Za-z0-9_]*=/) return ""
      sub(/=.*/, "", key)
      return key
    }
    FILENAME == targetfile {
      print
      key = key_of($0)
      if (key != "") seen[key] = 1
      next
    }
    {
      key = key_of($0)
      if (key != "" && !seen[key]) {
        print
        seen[key] = 1
        added++
      }
    }
    END { print added + 0 > countfile }
  ' "$target_env" "$source_env" > "$temp_file"
  added="$(<"$count_file")"
  if [[ "$added" == 0 ]]; then
    echo "旧 backend/.env 没有新版配置中缺失的键，无需合并。"
    exit 0
  fi
  stamp="$(date -u +%Y%m%dT%H%M%SZ)"
  backup_file="$(mktemp "${target_env}.pre-migration-${stamp}.XXXXXX")"
  cp -- "$target_env" "$backup_file"
  chmod 600 "$backup_file"
  echo "已将原持久化配置备份到带时间戳文件（权限 0600）。"
fi

chmod 600 "$temp_file"
mv -f -- "$temp_file" "$target_env"
echo "旧 backend/.env 有 $added 个缺失配置键已合并到新版持久化配置；已有值保留，文件权限为 0600。"
