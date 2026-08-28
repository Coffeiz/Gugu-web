# ============================================================
#  Gugu 后端管理 Makefile
#  本质上是 start.sh 的便捷封装，常用命令更短更好记。
#  完整能力见 ./start.sh --help 或 ./start.sh（无参数）。
#
#  ✅ 不用 git：适合 scp/rsync 直接传文件的部署方式
#  ✅ 所有 venv 工具都用绝对路径（$(VENV_BIN)/xxx），
#     不依赖 venv 是否激活，避开 PEP 668 / 系统包污染问题
# ============================================================

SHELL := /bin/bash
.SILENT:
.PHONY: help start stop restart status logs fg foreground dev-web dev-worker deploy install uninstall update makeupdate migrate storage-migrate backup clean deps deps-dev rag-ts-build sandbox-acl-plan sandbox-acl-apply sandbox-acl-prepare compose-up

# 沙盒 ACL 默认不自动修改宿主机权限；只有显式 SANDBOX_ACL=1 才执行。
SANDBOX_ACL ?= 0
ROOTLESS_USERS_ROOT ?= $(abspath ../Gugu-data/users)
# sudo make 时 id -un 会变成 root；Rootless Docker 仍属于原登录用户。
ROOTLESS_LOGIN ?= $(or $(RUN_USER),$(SUDO_USER),$(shell id -un))
COMPOSE_FILE ?= ../docker-compose.yml

# ── venv 路径自动检测 ───────────────────────────────────
# 优先用 .venv，找不到退到 venv
ifneq ($(wildcard .venv/bin/alembic),)
  VENV_BIN := .venv/bin
else ifneq ($(wildcard venv/bin/alembic),)
  VENV_BIN := venv/bin
else
  VENV_BIN :=
endif

# ── 默认目标 ─────────────────────────────────────────────
help:        ## 显示帮助
	@echo "常用：make start | stop | restart | status | logs | fg | dev-web | dev-worker | deploy | install"
	@echo "开发：make dev-web（Web 热重载）| make deps-dev && make dev-worker（Worker 热重载）"
	@echo "生产：make install 后 make start | stop | restart | status 管理 Python/FastAPI、IM、sandboxd；TS RAG 由 Python 按需复用固定制品"
	@echo "沙盒：make sandbox-acl-plan；make install SANDBOX_ACL=1 显式初始化 Rootless ACL"
	@echo "Compose：make compose-up；make compose-up SANDBOX_ACL=1 同时初始化 ACL 并开启 sandbox profile"
	@echo "开发：GUGU_SERVICE_MODE=local make start | stop | restart | status 强制使用本地 PID 模式"
	@echo "venv 路径：$(VENV_BIN)（自动检测）"

# ── 生命周期 ─────────────────────────────────────────────
start:       ## 后台启动
	@$(MAKE) sandbox-acl-prepare
	./start.sh start

stop:        ## 停止
	./start.sh stop

restart:     ## 重启
	@$(MAKE) sandbox-acl-prepare
	./start.sh restart

status:      ## 查状态 + 健康检查
	./start.sh status

logs:        ## 实时跟踪日志
	./start.sh logs

fg:          ## 前台启动（带 --reload，调试用）
	./start.sh foreground

foreground:  ## 同 fg
	./start.sh foreground

dev-web:     ## 开发 Web 热重载（前台运行，Ctrl+C 停止）
	./start.sh foreground

dev-worker:  ## 开发 Worker 热重载（需先停掉同机 systemd worker）
	@if [ -z "$(VENV_BIN)" ]; then \
		echo "ERROR: 未找到 venv，请先 python3 -m venv .venv"; \
		exit 1; \
	fi
	@if [ ! -x "$(VENV_BIN)/watchfiles" ]; then \
		echo "ERROR: 未找到 watchfiles，请先执行 make deps-dev"; \
		exit 1; \
	fi
	@echo "监听 app/ agent/ onboarding/ worker.py；Ctrl+C 停止。"
	@$(VENV_BIN)/watchfiles --filter python "$(VENV_BIN)/python -m worker" app agent onboarding worker.py

# ── 部署 / 维护 ──────────────────────────────────────────
deploy:      ## 一键部署（备份 + 装依赖 + 跑迁移 + 前端 build + 重启）
	./deploy.sh

deps:        ## 装依赖（用 venv 绝对路径，避开系统 pip）
	@if [ -z "$(VENV_BIN)" ]; then \
		echo "ERROR: 未找到 venv，请先 python3 -m venv .venv"; \
		exit 1; \
	fi
	@echo "  pip install -r requirements.txt ..."
	@$(VENV_BIN)/pip install -r requirements.txt

deps-dev:    ## 装开发/测试依赖（包含 Worker 热重载 watcher）
	@if [ -z "$(VENV_BIN)" ]; then \
		echo "ERROR: 未找到 venv，请先 python3 -m venv .venv"; \
		exit 1; \
	fi
	@echo "  pip install -r requirements-dev.txt ..."
	@$(VENV_BIN)/pip install -r requirements-dev.txt

rag-ts-build: ## 构建固定的 TypeScript RAG worker 制品（不在运行时编译）
	@CI=1 pnpm --dir ts install --frozen-lockfile --prod --ignore-scripts --reporter=silent
	@cd ts && \
	case "$$(uname -s):$$(uname -m)" in \
		Linux:x86_64) npm install --no-save --include=optional --ignore-scripts --no-fund --no-audit @node-rs/jieba@2.0.1 @node-rs/jieba-linux-x64-gnu@2.0.1 ;; \
		Linux:aarch64|Linux:arm64) npm install --no-save --include=optional --ignore-scripts --no-fund --no-audit @node-rs/jieba@2.0.1 @node-rs/jieba-linux-arm64-gnu@2.0.1 ;; \
		Darwin:x86_64) npm install --no-save --include=optional --ignore-scripts --no-fund --no-audit @node-rs/jieba@2.0.1 @node-rs/jieba-darwin-x64@2.0.1 ;; \
		Darwin:arm64) npm install --no-save --include=optional --ignore-scripts --no-fund --no-audit @node-rs/jieba@2.0.1 @node-rs/jieba-darwin-arm64@2.0.1 ;; \
		esac
	@ts/node_modules/.bin/esbuild ts/workers/rag/src/index.ts --platform=node --format=esm --bundle --banner:js='#!/usr/bin/env node' --external:@node-rs/jieba --external:@node-rs/jieba/* --outfile=bin/gugu-rag-ts-worker.mjs
	@rm -rf bin/node_modules
	@cp -R ts/node_modules bin/node_modules
	@chmod 755 bin/gugu-rag-ts-worker.mjs
	@node bin/gugu-rag-ts-worker.mjs --version

update:      ## 装依赖 + 跑数据库和文件存储迁移（不用 git，适合 scp/rsync 部署）
	@$(MAKE) deps
	@$(MAKE) migrate
	@$(MAKE) storage-migrate

makeupdate: update ## update 的兼容别名，便于业务端一键升级

rootless-workspace-plan: ## 输出 Rootless Docker workspace ACL 计划（默认不修改权限）
	@if [ -z "$(ROOTLESS_WORKSPACE)" ]; then \
		echo "ERROR: 请传入 ROOTLESS_WORKSPACE=/path/to/workspace"; exit 1; \
	fi
	@$(VENV_BIN)/python scripts/prepare_rootless_workspace.py "$(ROOTLESS_WORKSPACE)" $(if $(ROOTLESS_LOGIN),--login "$(ROOTLESS_LOGIN)",)

rootless-workspace-apply: ## 显式应用 Rootless Docker workspace ACL（需部署权限）
	@if [ -z "$(ROOTLESS_WORKSPACE)" ]; then \
		echo "ERROR: 请传入 ROOTLESS_WORKSPACE=/path/to/workspace"; exit 1; \
	fi
	@$(VENV_BIN)/python scripts/prepare_rootless_workspace.py "$(ROOTLESS_WORKSPACE)" $(if $(ROOTLESS_LOGIN),--login "$(ROOTLESS_LOGIN)",) --apply

sandbox-acl-plan: ## 输出所有用户 Shell 目录的 Rootless ACL 计划（默认不修改权限）
	@if [ -z "$(VENV_BIN)" ]; then echo "ERROR: 未找到 venv，请先创建 .venv"; exit 1; fi
	@$(VENV_BIN)/python scripts/prepare_rootless_users.py "$(ROOTLESS_USERS_ROOT)" --login "$(ROOTLESS_LOGIN)"

sandbox-acl-apply: ## 显式应用所有用户 Shell 目录的 Rootless ACL（需部署权限）
	@if [ "$(SANDBOX_ACL)" != "1" ]; then \
		echo "ERROR: 权限初始化默认关闭；请使用 SANDBOX_ACL=1 make sandbox-acl-apply"; \
		exit 1; \
	fi
	@if [ -z "$(VENV_BIN)" ]; then echo "ERROR: 未找到 venv，请先创建 .venv"; exit 1; fi
	@$(VENV_BIN)/python scripts/prepare_rootless_users.py "$(ROOTLESS_USERS_ROOT)" --login "$(ROOTLESS_LOGIN)" --apply

sandbox-acl-prepare: ## 按 SANDBOX_ACL 选择是否在启动前应用 ACL（默认跳过）
	@if [ "$(SANDBOX_ACL)" = "1" ]; then \
		$(MAKE) sandbox-acl-apply SANDBOX_ACL=1 ROOTLESS_USERS_ROOT="$(ROOTLESS_USERS_ROOT)" ROOTLESS_LOGIN="$(ROOTLESS_LOGIN)"; \
	elif [ "$(SANDBOX_ACL)" != "0" ]; then \
		echo "ERROR: SANDBOX_ACL 只能是 0 或 1"; exit 1; \
	fi

compose-up: ## 启动 Compose；SANDBOX_ACL=1 时先初始化 ACL 并启用 sandbox profile
	@$(MAKE) sandbox-acl-prepare
	@if [ "$(SANDBOX_ACL)" = "1" ]; then \
		docker compose -f "$(COMPOSE_FILE)" --profile sandbox up -d; \
	else \
		docker compose -f "$(COMPOSE_FILE)" up -d; \
	fi

storage-migrate:      ## 幂等迁移本地文件存储到同级 Gugu-data/users
	@set -e; \
	if [ "$$(id -u)" -eq 0 ] && systemctl list-unit-files 2>/dev/null | grep -q '^gugu-backend.service'; then \
	  ./start.sh stop; \
	  $(VENV_BIN)/python scripts/migrate_storage_root.py --apply; \
	  ./start.sh install; \
	else \
	  $(VENV_BIN)/python scripts/migrate_storage_root.py --apply; \
	fi

migrate:     ## 跑数据库迁移（用 venv 绝对路径，不踩 PEP 668）
	@if [ -z "$(VENV_BIN)" ]; then \
		echo "ERROR: 未找到 venv，请先 python3 -m venv .venv"; \
		exit 1; \
	fi
	@echo "  alembic upgrade head ..."
	@$(VENV_BIN)/alembic upgrade head
	@echo "  alembic current: $$($(VENV_BIN)/alembic current 2>/dev/null || true)"

backup:      ## 备份数据库 + Gugu-data/users + override 配置
	./backup.sh

# ── systemd ──────────────────────────────────────────────
install:     ## 装成 systemd 服务（sandboxd + web + IM worker + IM supervisor）
	@$(MAKE) sandbox-acl-prepare
	./start.sh install

uninstall:   ## 卸载 systemd 服务（四个核心服务）
	for s in gugu-sandboxd gugu-backend gugu-worker gugu-supervisor; do \
	  systemctl stop $$s 2>/dev/null || true; \
	  systemctl disable $$s 2>/dev/null || true; \
	  rm -f /etc/systemd/system/$$s.service; \
	done
	systemctl daemon-reload
	@echo "已卸载 systemd 核心服务（gugu-sandboxd / gugu-backend / gugu-worker / gugu-supervisor）；实时事件服务留待 Phase 6 回迁"

# ── 清理 ─────────────────────────────────────────────────
clean:       ## 清缓存 + 日志 + pid（不删 venv / Gugu-data/users / override）
	find . -type d -name __pycache__ -exec rm -rf {} + 2>/dev/null || true
	find . -type f -name "*.pyc" -delete 2>/dev/null || true
	rm -f .gugu.pid
	@echo "已清理 Python 缓存和 PID 文件（日志和 venv 保留）"
