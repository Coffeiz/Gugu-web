# 测试清单人工复核

> 来源：docs/reports/2026-08-31-TEST-INVENTORY.json  
> 详细测试名称见：[测试清单详细测试项](./2026-08-31-TEST-INVENTORY-DETAILS.md)。  
> 用途：确认测试资产的职责、实际覆盖内容、owner 和 skip 例外。

## 当前结论

- [x] 已补全自动归类规则，清单中的 `other` 文件数为 0。
- [x] 已按领域报告确认业务 owner 和责任边界；没有满足三项完全一致条件的合并候选，因此不移动目录。
- [x] 已确认所有实际 skip 的 CI 策略和替代覆盖。
- [x] 已将稳定 E2E 与实验 E2E 分开，CI 不再执行含环境数据 skip 的文件拖拽/文件库阶段用例。
- [x] 已复核清单并同步更新 PRD Phase 0/2/3 和 `docs/devlog/`。

## A. 职责域汇总

详细文件归属、层级和 owner 以 JSON 快照为准；以下是当前自动归类结果。

| 职责域 | 文件数 | 主要覆盖内容 | 自动 owner |
|---|---:|---|---|
| context | 43 | 上下文组装、历史过滤、缓存前缀和连续对话 | backend/context |
| agent-provider | 34 | Agent 主循环、Provider、工具、技能和模型配置 | backend/agent-provider |
| storage | 44 | 文件、附件、路径迁移、下载和 I/O | backend/storage |
| im | 32 | IM 消息、交互协议、通知和表情 | backend/im |
| memory-rag | 34 | 搜索、RAG、记忆存储和索引指标 | backend/memory-rag |
| security | 24 | 账号、管理员、配置覆盖和新手引导 | backend/security |
| terminal-runtime | 27 | Shell、进程、systemd、Trace 和运行时 | backend/terminal-runtime |
| frontend-ui | 27 | 前端组件、日历、交互、样式和质量检查 | frontend/frontend-ui |
| schedule | 10 | 时区、日期、定时任务和版本归属 | backend/schedule |
| mind-project | 23 | Mind、画布和项目相关测试 | backend/mind-project |

## B. skip 例外

| 完成 | 文件 | 层级 | 职责域 | 实际覆盖内容 | 触发条件 | 建议 CI 策略 | 后续动作 |
|---|---|---|---|---|---|---|---|
| [x] | backend/tests/test_shell_sandbox.py | L1 | terminal-runtime | Shell 沙箱路径、链接和文件系统安全边界 | 当前平台不支持软链接/硬链接时动态跳过 | 平台支持时必须执行 | 保留动态 skip，补平台矩阵记录 |
| [x] | frontend/e2e/file-drag-runtime.spec.ts | L3 | storage | 文件拖拽、批量移动和失败回滚 | 没有可拖拽文件卡 | 使用固定文件 fixture | 后续接入独立文件 fixture |
| [x] | frontend/e2e/filesystem-phases.spec.ts | L3 | storage | 文件库选择、右键菜单、回收站和窄屏布局 | 测试账号无目录、文件不足或无回收站 | 使用独立测试账号或 mock 数据 | 后续固定测试数据，减少环境 skip |

## 复核结论

- 复核人：Codex
- 复核日期：2026-08-31
- 保留项：平台能力动态 skip；文件 E2E 的数据前置 skip
- 合并项：
- 删除项：
- 移出 CI 项：
- 需要进入 Phase 1/2 的事项：为文件 E2E 增加确定性测试数据 fixture，逐步减少环境数据 skip

## C. E2E 执行入口

| 入口 | 文件范围 | 用途 |
|---|---|---|
| `npm run test:e2e:stable` | smoke、calendar、chat、file-lifecycle、Mind、定时任务、terminals | CI 稳定关键路径 |
| `npm run test:e2e:experimental` | file-drag-runtime、filesystem-phases | 本地或专项环境，允许当前数据前置 skip |
