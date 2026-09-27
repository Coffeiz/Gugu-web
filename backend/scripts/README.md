# 后端脚本分类

在 `backend/` 目录下运行 Python 脚本；例如：

```sh
PYTHONPATH=. .venv/bin/python -m scripts.migrations.migrate_knowledge_timestamps
```

| 目录 | 用途 |
| --- | --- |
| `benchmarks/` | 性能、缓存及 A/B 基准 |
| `checks/` | 静态守卫、结构审计与配置检查 |
| `diagnostics/` | 故障探针和临时诊断 |
| `maintenance/` | Knowledge、记忆等维护操作 |
| `migrations/` | 一次性或版本化数据迁移入口 |
| `quality/` | 质量报告与范围分析 |
| `runtime/` | Docker、systemd 和部署过程调用的运行脚本 |
| `smoke/` | 手动或集成冒烟验证 |
| `testing/` | E2E 测试辅助服务与数据准备 |

运行时被 Dockerfile、Compose、systemd 或 Makefile 调用的脚本应更新对应入口路径；迁移的业务逻辑留在所属应用模块，`migrations/` 只提供可执行入口。
