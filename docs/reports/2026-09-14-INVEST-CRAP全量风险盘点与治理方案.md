# INVEST：CRAP 全量扫描风险盘点与治理方案

> 报告日期：2026-09-14
> 数据来源：`docs/reports/2026-09-14-VERIFY-PRD-TEST-2-CRAP-FULL.{json,md}`（全量首跑基线）、
> `2026-09-13-VERIFY-PRD-TEST-2-MUTATION-PHASE2.*`（变异基线）、`2026-09-13/14-VERIFY-PRD-TEST-2-CRAP-PHASE0-1.*`（试点对照）
> 性质：风险盘点与治理路线建议，不构成门禁；风险分层规则见 PRD-TEST-2（≥30 高、≥15 中，仅用于排序）

---

## 0. 结论摘要

1. **全量基线**：3,386 个函数中高风险（CRAP≥30）468 个、中风险 293 个、低风险 2,625 个。
2. **高危的主因是「测试够不到」，不是「逻辑太复杂」**：468 个高危里 323 个（69%）覆盖率恰好为 0%；
   CC<20 的占 334 个（71%），CC≥50 的结构级巨型函数只有 27 个。
3. **治理按三层推进**（见 §4）：P0 试点已清零；P1 纯函数快赢批量补测；P2 建设 API 层集成测试夹具
   （一次性基建，覆盖 `backend/app/api` 119 个高危的主阵地）；P3 巨型编排函数跟随重构分期拆解，不硬啃。
4. **变异测试无欠账**：试点范围 89 个变异全部 killed，score 100%，暂无行动项。
5. 已知边界：TS 侧本轮因 pnpm `minimumReleaseAge` 拒绝新鲜 `zod@4.6.4` 锁条目未产出数据
   （包龄过窗后重跑 `--full` 即可）；Python 侧 2 个覆盖率下偶发的时序敏感用例
   （`test_rag_phase5_boundaries.py::test_folder_move_clears_old_scope`、
   `test_scheduled_delivery_targets.py::test_group_delivery_mode_captures_current_qq_group`）
   复跑未复现，若持续触发应单独修测试。

---

## 1. 数据来源与口径

- 命令：`backend/.venv/bin/python scripts/quality/crap_report.py --full`（PRD-TEST-2 报告入口的扩展，
  策略不变：手动周期运行，不接入 CI）。
- 扫描范围：`backend/agent` + `backend/app` 全部 `.py`、`frontend/src` 全部 `.ts/.tsx`
  （排除测试文件与类型声明；`__init__.py` 不计）。
- 覆盖率：整语言测试套件单次运行（pytest `--cov=agent --cov=app --cov-branch`；
  vitest `--coverage.include=src/**`）。Python 本轮 passed；TS 因供应链策略未产出，本轮明细全部来自 Python。
- 可信度边界：全量覆盖率下 2 个时序敏感用例偶发失败（见 §0.5），失败轮仍会提取已生成覆盖率并标注
  failed，此时个别函数覆盖率可能偏低。

## 2. 总体指标

| 指标 | 数值 |
|---|---:|
| 扫描函数总数 | 3,386 |
| 高风险（CRAP≥30） | 468 |
| 中风险（15–30） | 293 |
| 低风险 | 2,625 |
| 明细语言 | Python 761 条（中/高）；TS 0（本轮未产出） |
| 变异测试 | 试点范围 score 100%（89/89 killed），无行动项 |
| 试点对照（budget.py 三函数） | 342→18（高→中）、30.6→9（高→低）、19.1→6（中→低），已提交 `b1911151` |

## 3. 高危结构分析

### 3.1 覆盖分段：主因是测试盲区

| 高危函数覆盖率 | 数量 | 占比 |
|---|---:|---:|
| 0% | 323 | 69% |
| 1–50% | 43 | 9% |
| 50–80% | 80 | 17% |
| 80%+ | 22 | 5% |

0% 覆盖意味着整套件从未执行过这些函数——高危主要反映「盲区」，而不是「写得很烂」。
中风险里另有 93 个 0% 覆盖函数，性质相同。

### 3.2 复杂度分段：结构级巨型函数是少数

| 高危函数 CC | 数量 |
|---|---:|
| <20 | 334 |
| 20–49 | 107 |
| ≥50 | 27 |

CC<20 的高危（334 个）只要补上覆盖即可脱离高危；真正需要重构降复杂度的是 27 个 CC≥50 的巨型函数。

### 3.3 目录分布

| 目录 | 高危数 | 解读 |
|---|---:|---|
| backend/app/api | 119 | API handler 层无集成测试夹具，全层 0% 覆盖为主 |
| backend/agent/tools | 67 | 工具层业务逻辑多，相当部分可纯函数单测 |
| backend/agent/gateway | 36 | 网关流式入口，需 provider/WebSocket 夹具 |
| backend/agent/rag | 36 | 检索管线，已有测试的边缘分支未盖满 |
| backend/app/services | 35 | 混合：可单测逻辑与需 DB 夹具的各半 |
| backend/agent/memory | 33 | 反思/压缩链路，需 provider 夹具 |
| backend/agent/im | 25 | IM 编排，需网关夹具 |
| backend/app/core | 25 | 配置/指标等，部分可纯单测 |
| 其余（context/runtime/sandbox/agent 根） | 59 | — |

### 3.4 Top 20 高危

| CRAP | CC | Cov | 函数 | 位置 |
|---:|---:|---:|---|---|
| 10712 | 103 | 0% | `_generate_unlocked` | `backend/agent/gateway/web.py:544` |
| 9312 | 96 | 0% | `_run_stream_unlocked` | `backend/agent/runner.py:633` |
| 8556 | 92 | 0% | `dispatch_im_message` | `backend/agent/im/loop.py:695` |
| 8010 | 89 | 0% | `_run_collect_unlocked` | `backend/agent/runner.py:177` |
| 5550 | 74 | 0% | `perception_stats` | `backend/app/api/v1/agent_perception.py:44` |
| 5067 | 309 | 63% | `_run_loop` | `backend/agent/core.py:802` |
| 3192 | 56 | 0% | `stream` | `backend/agent/gateway/web.py:44` |
| 2550 | 50 | 0% | `_record_builder_sources` | `backend/agent/runtime/loopscope_trace/context.py:92` |
| 2550 | 50 | 0% | `get_session_messages` | `backend/app/api/v1/agent.py:888` |
| 1980 | 44 | 0% | `terminal_websocket` | `backend/app/api/v1/terminals.py:209` |
| 1640 | 40 | 0% | `_run_index_search` | `backend/app/api/v1/search.py:394` |
| 1560 | 39 | 0% | `execute` | `backend/agent/sandbox/docker.py:428` |
| 1560 | 39 | 0% | `summary` | `backend/app/core/opsmetrics.py:157` |
| 1406 | 37 | 0% | `test_search` | `backend/app/api/v1/config.py:825` |
| 1260 | 35 | 0% | `_execute_job_locked` | `backend/agent/memory/im_reflection.py:225` |
| 1190 | 34 | 0% | `record_passive_im_message` | `backend/agent/im/loop.py:405` |
| 1122 | 33 | 0% | `reflect` | `backend/agent/memory/reflection.py:509` |
| 992 | 31 | 0% | `reconcile` | `backend/app/scheduled_tasks.py:144` |
| 930 | 30 | 0% | `_apply_output` | `backend/agent/memory/im_reflection.py:651` |
| 887 | 68 | 44% | `batch_canvas_operations` | `backend/app/services/canvas/batch.py:72` |

### 3.5 巨型函数（CC≥50，27 个）

完整的 27 个见 JSON 报告；值得单列的高亮：

- **0% 覆盖的巨型函数**（最高优先级信号，复杂度与盲区叠加）：`_generate_unlocked`(103)、
  `_run_stream_unlocked`(96)、`dispatch_im_message`(92)、`_run_collect_unlocked`(89)、
  `perception_stats`(74)、`stream`(56)、`_record_builder_sources`(50)、`get_session_messages`(50)。
- **高 CC 但覆盖尚可**（重构候选，测试已部分护住）：`_run_loop`(309, 63%)、
  `reconcile_local_directory`(102, 82%)、`search`(92, 88%)、`dispatch`(69, 85%)、
  `sanitize_messages`(52, 86%)、`compact_context`(50, 89%)。

## 4. 治理方案（分期建议）

**总原则**：PRD-TEST-2 策略不变——CRAP 是周期性手动质量信号，不是门禁；治理目标是
「盲区可见、新代码不增债、结构性复杂度跟随重构消化」，不为清零而清零。

### P0（已完成）：试点清零

budget.py 三个函数处理已提交（`b1911151`），作为方法验证：补测试可直接消掉覆盖型高危，
抽 helper 可消掉复杂度型高危。

### P1（快赢）：纯函数盲区批量补测

- 圈选方式：CRAP-FULL JSON 中 `coverage=0%` 且 `CC<20`、不依赖网络/DB/provider 的纯逻辑函数
  （典型：`backend/agent/tools` 的参数归一化与格式化、`backend/app/core` 的纯工具函数、
  rag 的打分/过滤分支）。
- 预期：334 个 CC<20 高危中可单测的部分能以每函数一个测试文件节的成本批量摘除。
- 验收：复跑 `--full`，高危总数显著下降且 0% 覆盖高危占比下降。

### P2（基建）：API 层集成测试夹具

- `backend/app/api` 的 119 个高危几乎全部因为「没有轻量方式发起带鉴权的 ASGI 请求」。
- 建设一次 `httpx.AsyncClient + ASGITransport + 内存 SQLite` 的标准夹具后，同一套基建
  可以批量覆盖 handler 层，是投入产出比最高的一块基建。
- 完成后 API 层高危预计从 119 收敛到真正需要外部依赖的少数端点。

### P3（跟随重构）：巨型编排函数

- CC≥50 的 27 个函数集中在 gateway/runner/core/im loop——它们是 agent 主循环与平台网关，
  任何拆解都是高风险变更，必须夹具先行（依赖 P1/P2 的测试底盘）。
- 不建议单独立项硬啃；跟随各自的业务重构分期消化，每次拆解以「CC 下降且行为等价
  （全量测试 + LoopScope 对照）」为验收。
- 优先关注 §3.5 中「0% 覆盖 + 高 CC」叠加的 8 个（盲区与复杂度双高）。

### 防增债

- CRAP-FULL 按迭代节奏手动复跑，与 2026-09-14 基线对照；新增高危应有明确理由或随手补测。
- 不把 CRAP 接入 CI（PRD-TEST-2 既定策略，策略变更需先更新 PRD 并评审）。

## 5. 已知边界

- TS 侧数据缺席：pnpm `minimumReleaseAge` 拒绝 `zod@4.6.4`（提交 `7abe0ab0f` 工具链变更引入），
  包龄过窗后重跑 `--full --overwrite` 补齐。
- 低风险（2,625 个）仅计数不落明细；需要时重跑脚本可完整重算。
- 覆盖率口径是「整测试套件执行到的行」，不含手工/线上路径；0% ≠ 死代码，只代表自动化测试盲区。

## 6. 复现

```bash
backend/.venv/bin/python scripts/quality/crap_report.py --full          # 全量
backend/.venv/bin/python scripts/quality/crap_report.py                 # 试点对照
backend/.venv/bin/python scripts/quality/mutation_report.py --language both  # 变异
```
