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
.PHONY: help start stop restart status logs fg foreground deploy install uninstall update migrate backup clean deps

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
	@./start.sh 2>&1 | head -40 || true
	@echo ""
	@echo "常用：make start | stop | restart | status | logs | fg | deploy | install"
	@echo "venv 路径：$(VENV_BIN)（自动检测）"

# ── 生命周期 ─────────────────────────────────────────────
start:       ## 后台启动
	./start.sh start

stop:        ## 停止
	./start.sh stop

restart:     ## 重启
	./start.sh restart

status:      ## 查状态 + 健康检查
	./start.sh status

logs:        ## 实时跟踪日志
	./start.sh logs

fg:          ## 前台启动（带 --reload，调试用）
	./start.sh foreground

foreground:  ## 同 fg
	./start.sh foreground

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

update:      ## 装依赖 + 跑迁移（不用 git，适合 scp/rsync 部署）
	@$(MAKE) deps
	@$(MAKE) migrate

migrate:     ## 跑数据库迁移（用 venv 绝对路径，不踩 PEP 668）
	@if [ -z "$(VENV_BIN)" ]; then \
		echo "ERROR: 未找到 venv，请先 python3 -m venv .venv"; \
		exit 1; \
	fi
	@echo "  alembic upgrade head ..."
	@$(VENV_BIN)/alembic upgrade head
	@echo "  alembic current: $$($(VENV_BIN)/alembic current 2>/dev/null || true)"

backup:      ## 备份数据库 + uploads + override 配置
	./backup.sh

# ── systemd ──────────────────────────────────────────────
install:     ## 装成 systemd 服务（gugu-backend.service）
	./start.sh install

uninstall:   ## 卸载 systemd 服务
	systemctl stop gugu-backend 2>/dev/null || true
	systemctl disable gugu-backend 2>/dev/null || true
	rm -f /etc/systemd/system/gugu-backend.service
	systemctl daemon-reload
	@echo "已卸载 systemd 服务"

# ── 清理 ─────────────────────────────────────────────────
clean:       ## 清缓存 + 日志 + pid（不删 venv / uploads / override）
	find . -type d -name __pycache__ -exec rm -rf {} + 2>/dev/null || true
	find . -type f -name "*.pyc" -delete 2>/dev/null || true
	rm -f .gugu.pid
	@echo "已清理 Python 缓存和 PID 文件（日志和 venv 保留）"
