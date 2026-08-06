#!/usr/bin/env bash
# 本地/devserver 手动跑 e2e：读 frontend/.env.e2e.local（不提交 git）里的测试账号，
# 跑指定的 spec（不传参数就跑全部）。用法：
#   cp .env.e2e.local.example .env.e2e.local   # 只需做一次，填好账号密码
#   ./e2e/run-local.sh e2e/chat.spec.ts
set -euo pipefail
cd "$(dirname "$0")/.."

ENV_FILE=".env.e2e.local"
if [ ! -f "$ENV_FILE" ]; then
  echo "找不到 $ENV_FILE——先 cp .env.e2e.local.example .env.e2e.local，再填账号密码" >&2
  exit 1
fi
set -a
# shellcheck disable=SC1090
source "$ENV_FILE"
set +a

if [ -z "${PLAYWRIGHT_USERNAME:-}" ] || [ -z "${PLAYWRIGHT_PASSWORD:-}" ]; then
  echo "$ENV_FILE 里 PLAYWRIGHT_USERNAME/PLAYWRIGHT_PASSWORD 还没填" >&2
  exit 1
fi

npx playwright test "$@"
