#!/usr/bin/env bash
# 一体化镜像单容器端到端验收：按 quick-deploy.md 的裸 docker run 方式启动，
# 验证 /health、首启自动生成管理员密码并真实可用于 Admin 登录、持久化契约
# （DB/用户文件/BYOK 主密钥/Admin 配置卷），随后删除容器、用同一 /data + /config
# 重建，确认数据与凭据仍在。
# 用法：./scripts/e2e-standalone-image.sh [镜像tag]（默认 gugu-web:e2e，需先构建）
set -euo pipefail

IMAGE="${1:-gugu-web:e2e}"
WORK="$(mktemp -d)"
DATA="$WORK/data"
CONFIG="$WORK/config"
PORT="${E2E_PORT:-19595}"
NAME="gugu-e2e-$$"
BASE="http://127.0.0.1:${PORT}"
PASS=0
FAIL=0

cleanup() {
    docker rm -f "$NAME" >/dev/null 2>&1 || true
    # /data 里是 postgres/redis 用户写的文件，宿主普通用户删不掉，借容器清理。
    docker run --rm -v "$WORK:/work" --entrypoint sh "$IMAGE" -c "rm -rf /work/data /work/config" >/dev/null 2>&1 || true
    rm -rf "$WORK"
}
trap cleanup EXIT

check() { # check <描述> <命令...>
    local desc="$1"; shift
    if "$@" >/dev/null 2>&1; then
        echo "  ✓ ${desc}"; PASS=$((PASS + 1))
    else
        echo "  ✗ ${desc}"; FAIL=$((FAIL + 1))
    fi
}

wait_health() {
    for _ in $(seq 1 120); do
        if curl -sf "${BASE}/health" >/dev/null 2>&1; then return 0; fi
        sleep 2
    done
    return 1
}

admin_login() { # admin_login <密码>：Admin 登录接口返回 200 视为通过
    curl -sf -o /dev/null -X POST "${BASE}/api/v1/admin/auth/login" \
        -H 'Content-Type: application/json' \
        -d "{\"username\":\"admin\",\"password\":\"$1\"}"
}

mkdir -p "$DATA" "$CONFIG"

echo "== 第一次启动（按文档裸 docker run）=="
docker run -d --name "$NAME" -p "${PORT}:9595" \
    -v "$DATA:/data" -v "$CONFIG:/config" \
    -e SECRET_KEY=e2e-secret-key-for-standalone-image \
    -e GUGU_DB_PASSWORD=e2e-db-password \
    "$IMAGE" >/dev/null

echo "-- 等待 /health（首启含 initdb + 迁移，最长 240s）--"
if wait_health; then echo "  ✓ /health 200"; PASS=$((PASS + 1)); else echo "  ✗ /health 超时"; FAIL=$((FAIL + 1)); docker logs "$NAME" | tail -40; fi

check "应用进程齐全（nginx CMD 托管 uvicorn/worker/gateway）" bash -c "docker logs '$NAME' 2>&1 | grep -q '启动: nginx'"
ADMIN_PW1="$(docker logs "$NAME" 2>&1 | grep -oP '(?<=密码：)\S+' | tail -1 || true)"
check "首启自动生成管理员密码并打印日志" bash -c "[[ -n '${ADMIN_PW1}' ]]"
check "生成密码持久化到 /data/.env" docker exec "$NAME" grep -q "ADMIN_PASSWORD=" /data/.env
# 真实登录覆盖整条链路：.env 加载 → Pydantic 优先级 → Admin auth。
check "admin + 随机密码可登录后台" admin_login "${ADMIN_PW1}"
# 注意：负向断言不能包进 bash -c（子进程看不到本 shell 的 admin_login 函数，
# command not found 被取反会假绿），直接查 HTTP 状态码。
_WRONG_STATUS="$(curl -s -o /dev/null -w '%{http_code}' -X POST "${BASE}/api/v1/admin/auth/login" \
    -H 'Content-Type: application/json' \
    -d '{"username":"admin","password":"wrong-password"}')"
check "错误密码被拒绝（401）" [ "${_WRONG_STATUS}" = "401" ]
check "PostgreSQL 数据目录落卷" docker exec "$NAME" test -s /data/postgres/PG_VERSION
check "BYOK 主密钥落卷" docker exec "$NAME" test -f /data/byok/.byok-master-key

echo "== 写入标记数据 =="
docker exec "$NAME" sh -c "echo e2e-marker > /data/users/e2e-marker.txt"
echo e2e-config-marker > "$CONFIG/e2e-marker.txt"
check "标记文件写入成功" docker exec "$NAME" grep -q e2e-marker /data/users/e2e-marker.txt

echo "== 删除容器，用同一 /data + /config 重建 =="
docker rm -f "$NAME" >/dev/null
docker run -d --name "$NAME" -p "${PORT}:9595" \
    -v "$DATA:/data" -v "$CONFIG:/config" \
    -e SECRET_KEY=e2e-secret-key-for-standalone-image \
    -e GUGU_DB_PASSWORD=e2e-db-password \
    "$IMAGE" >/dev/null

echo "-- 等待二次启动 /health --"
if wait_health; then echo "  ✓ /health 200"; PASS=$((PASS + 1)); else echo "  ✗ /health 超时"; FAIL=$((FAIL + 1)); docker logs "$NAME" | tail -40; fi

check "用户文件在重建后仍在" docker exec "$NAME" grep -q e2e-marker /data/users/e2e-marker.txt
check "/config 卷内容在重建后仍在" docker exec "$NAME" grep -q e2e-config-marker /config/e2e-marker.txt
check "PostgreSQL 数据复用（不重新 initdb）" bash -c "! docker logs '$NAME' 2>&1 | grep -q '首次启动：初始化内置 PostgreSQL'"
check "管理员密码不随重建轮换（未重新生成）" bash -c "! docker logs '$NAME' 2>&1 | grep -q '密码：'"
check "同一随机密码重建后仍可登录" admin_login "${ADMIN_PW1}"

echo
echo "通过 ${PASS} 项，失败 ${FAIL} 项"
[ "$FAIL" -eq 0 ]
