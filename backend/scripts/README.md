# 后端脚本目录约定

`backend/scripts/` 只存放可执行入口、开发/运维辅助工具和测试辅助程序，不承载 Agent、API、服务层或数据模型的业务实现。脚本若需要稳定的业务逻辑，应调用 `backend/app/`、`backend/agent/` 中的实现；不要在脚本里复制一份业务规则。

## 目录职责

| 目录 | 职责与边界 |
| --- | --- |
| `benchmarks/` | 可重复的性能、缓存和 A/B 基准；记录输入条件与测量口径，结论报告放 `docs/reports/`。不是回归测试。 |
| `checks/` | 快速、确定性的静态守卫、架构/安全边界审计和配置检查；适合本地或 CI 自动执行，不应访问真实用户数据或调用真实模型。 |
| `diagnostics/` | 故障探针、线上问题复现和 provider 行为调查；可能读取真实数据或访问外部服务，因此默认人工运行，不纳入常规 pytest/CI。每个探针须说明副作用、真实数据边界、所需显式开关和输出位置。稳定发现应沉淀到 `backend/tests/`。 |
| `maintenance/` | Knowledge、索引、记忆等既有数据的维护操作；说明目标范围、影响和恢复方法。能预演时默认先 dry-run，写操作必须有明确参数，不得静默批量改数据。 |
| `migrations/` | 数据格式或存储布局迁移的可执行入口；实际转换逻辑留在所属应用模块。迁移应幂等、可重跑、对不支持的数据明确失败，并说明备份/回滚边界。 |
| `quality/` | CRAP、mutation 等质量分析工具及其范围配置/脚本测试；报告写到 `docs/reports/` 或调用者明确指定的位置。 |
| `runtime/` | Docker、Compose、systemd、entrypoint 或 Makefile 调用的部署/运行脚本；修改或移动后必须同步所有调用入口及镜像 COPY 路径。 |
| `smoke/` | 人工或集成环境的冒烟验证，用于确认服务链路可用；不替代单元/集成回归测试。 |
| `testing/` | E2E 所需的 mock 服务、测试数据准备等辅助程序；断言和回归用例放 `backend/tests/`。 |

`scripts/__init__.py` 让脚本可作为 `scripts.<目录>.<模块>` 导入或通过 `python -m` 执行。新增脚本时先选已有职责目录；确有不同且长期稳定的职责再新建目录，并同步更新本表。不要按临时任务、日期或个人姓名创建目录。

## 编写与运行约束

- Python 脚本遵守后端 Python 规范：标准库、第三方、本地导入分组；复杂逻辑使用类型注解。CLI 入口放在 `main()` 和 `if __name__ == "__main__"` 下；ASGI mock 服务等被其他进程导入的模块应只暴露所需接口。禁止 import 时连接数据库、调用网络或修改文件。
- 从 `backend/` 目录使用仓库虚拟环境运行；优先模块形式，保证包导入路径稳定：

  ```sh
  cd backend
  PYTHONPATH=. .venv/bin/python -m scripts.migrations.migrate_knowledge_timestamps
  PYTHONPATH=. .venv/bin/python -m scripts.checks.check_ownership
  ```

  Shell 入口使用明确的 `sh`/`bash` 调用。若运行时由 Dockerfile、systemd、Compose、entrypoint 或 Makefile 调用，以这些入口的实际工作目录和路径为准，并在修改脚本位置时一并更新它们。

- 默认只读、范围最小。需要写数据库、用户文件、索引或宿主机权限时，CLI 必须把目标说清楚；尽量提供只读预演，只有显式 `--apply`/`--write` 等参数才执行变更。危险操作需要目标范围校验，不能接受 `/`、home 根目录或模糊的通配范围。
- `backend/.env`、`backend/config.override.json` 及其他用户运行配置默认只读。脚本、测试与探针不得创建、清空、重写或以本地副本覆盖它们；测试使用临时目录或显式 mock 配置路径。用户输入、聊天正文、附件名、凭据和完整模型响应不得进入普通日志或报告；按项目规范使用 `fingerprint()`、脱敏错误与受限诊断日志。
- 访问真实 provider、devserver、真实数据库或用户数据必须由用途明确的人工诊断脚本承担，并要求明确的目标参数/授权开关；设置超时和调用上限。普通 checks、smoke、testing 不应意外产生外部调用或费用。
- 输出文件必须写到明确、窄范围的目标：临时/含真实内容的探针输出放在 gitignore 的 `scripts/diagnostics/local/`；经脱敏、适合留档的结论放根目录 `docs/reports/`。禁止把测试产物、真实 run、密钥或用户数据写入源码目录并提交。
- 脚本报告应记录运行命令、环境和限制，区分合成数据与真实数据、估算与 provider 实测。任何结论若可转成稳定断言，应补充 `backend/tests/` 覆盖，而不是让一次性脚本承担回归门禁。
- 每个 CLI 对无效参数、缺失配置、权限不足和外部服务失败给出非零退出码及可操作但不泄露敏感值的错误；不要吞错后返回成功，也不要通过 fallback 掩盖真实故障。

## 放置判断

- 生产请求会调用的逻辑 → `app/` 或 `agent/`，不是 `scripts/`。
- 自动回归断言 → `backend/tests/`；E2E 的服务/fixture 辅助程序 → `scripts/testing/`。
- 本地结构/安全门禁 → `scripts/checks/`。
- 需要复现真实问题或观察 provider → `scripts/diagnostics/`，并明确真实数据与副作用。
- 数据修补 → 优先作为受审查的迁移模块实现，由 `scripts/migrations/` 提供可执行入口；临时、管理员手动执行的索引/记忆维护放 `scripts/maintenance/`。
- 人工性能比较 → `scripts/benchmarks/`；部署生命周期中自动执行 → `scripts/runtime/`。
