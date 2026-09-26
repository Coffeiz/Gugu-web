#!/usr/bin/env bash
# 停止旧 app 后导出 PostgreSQL 与 Redis 快照；新版 app 首启时分别导入。
set -euo pipefail

compose_file="${COMPOSE_FILE:-docker-compose.yml}"
project_dir="${COMPOSE_PROJECT_DIR:-$PWD}"
compose=(docker compose --project-directory "$project_dir" -f "$compose_file")

app_id="$("${compose[@]}" ps --all -q app | head -n 1)"
postgres_id="$("${compose[@]}" ps -q postgres | head -n 1)"
redis_id="$("${compose[@]}" ps -q redis | head -n 1)"
app_running="$("${compose[@]}" ps --status running -q app | head -n 1)"
if [[ -z "$app_id" || -z "$postgres_id" || -z "$redis_id" ]]; then
    echo "未找到旧默认 Compose app/postgres/redis 服务；未导出任何数据。" >&2
    exit 1
fi
if [[ -n "$app_running" ]]; then
    echo "请先执行 docker compose stop app，停止 worker/gateway 并暂停新消息，再运行迁移。" >&2
    exit 1
fi

data_source="$(docker inspect --format '{{range .Mounts}}{{if eq .Destination "/data"}}{{.Source}}{{end}}{{end}}' "$app_id")"
if [[ -z "$data_source" || "$data_source" != /* ]]; then
    echo "无法从旧 app 容器确认 /data 的宿主机持久目录；拒绝猜测迁移位置。" >&2
    exit 1
fi

destination="$data_source/updater/legacy-postgres.dump"
redis_destination="$data_source/updater/legacy-redis.rdb"
mkdir -p "$(dirname "$destination")"
chmod 700 "$(dirname "$destination")"
if [[ -e "$destination" || -e "$redis_destination" ]]; then
    echo "迁移备份已存在；为避免覆盖，先人工检查或移走 Gugu-data/updater/legacy-* 文件。" >&2
    exit 1
fi

# 先迁旧应用配置，确保配置合并失败时不会留下数据库导出物并阻断后续重试。
bash "$(dirname "$0")/migrate-compose-env.sh" \
    "$project_dir/backend/.env" "$data_source/.env"

temporary="$(mktemp "$(dirname "$destination")/.legacy-postgres.XXXXXX")"
redis_temporary="$(mktemp "$(dirname "$destination")/.legacy-redis.XXXXXX")"
trap 'rm -f "$temporary" "$redis_temporary"' EXIT
chmod 600 "$temporary"
chmod 600 "$redis_temporary"
echo "正在从旧 PostgreSQL 导出应用数据库（不输出数据库内容）..."
"${compose[@]}" exec -T postgres sh -c 'pg_dump --no-owner --no-privileges -U "$POSTGRES_USER" -d "$POSTGRES_DB"' > "$temporary"
if [[ ! -s "$temporary" ]]; then
    echo "数据库导出结果为空；旧数据库和 Compose 服务未被修改。" >&2
    exit 1
fi
echo "正在从旧 Redis 导出一致性快照（包含尚未处理的 Stream 消息）..."
"${compose[@]}" exec -T redis sh -c 'REDISCLI_AUTH="${GUGU_REDIS_PASSWORD:-}" redis-cli --rdb /tmp/gugu-legacy-redis.rdb >/dev/null'
docker cp "$redis_id:/tmp/gugu-legacy-redis.rdb" "$redis_temporary"
"${compose[@]}" exec -T redis rm -f /tmp/gugu-legacy-redis.rdb
if [[ ! -s "$redis_temporary" ]]; then
    echo "Redis 快照为空；旧数据库、Redis 和 Compose 服务未被修改。" >&2
    exit 1
fi
mv "$temporary" "$destination"
mv "$redis_temporary" "$redis_destination"
trap - EXIT
chmod 600 "$destination"
chmod 600 "$redis_destination"
echo "导出完成：$destination 和 $redis_destination"
echo "备份包含数据库及队列状态，请在迁移验收前妥善保管；脚本不会删除旧服务或卷。"
