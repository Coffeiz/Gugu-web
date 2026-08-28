# PRD-RAG-6：TypeScript 词法检索与评分过滤直接替换

## 1. 状态

**状态：Phase 0–3 已完成。TypeScript worker 已成为生产主链。**

本 PRD 采用组件直接替换，不做 shadow、canary 或双写链路。迁移期间的旧实现只作为
显式回退和排障参考，不能与新实现长期并行维护。

## 2. 背景与目标

当前 RAG 运行链路已经把词法索引迁移到 TypeScript worker，但候选评分、置信度计算、过滤、
去重和预算前的质量筛选仍由 Python 执行。近期基准使用同一批 4063 条真实索引候选、5 个
查询、20 次迭代，结果如下：

| 组件 | 平均单次查询 | P50 | P95 |
|---|---:|---:|---:|
| Python 评分/过滤 | 1550.188 ms | 1549.353 ms | 1592.667 ms |
| Rust 评分/过滤 | 57.396 ms | 55.638 ms | 64.492 ms |
| TypeScript 评分/过滤 | 26.972 ms | 26.514 ms | 29.963 ms |

BM25 预热查询基准为 TypeScript 平均 0.521 ms、Rust 平均 0.163 ms；冷构建分别为
256.647 ms 和 150.929 ms。该结果支持把 BM25 与评分过滤收敛到同一套 TypeScript
worker，但不允许仅凭 benchmark 直接切生产，仍需验证协议、权限、版本、空结果和失败
回退。

目标：

- 用 TypeScript worker 直接替换 Python BM25 与 Python confidence/filter 组件；
- 保持现有候选语义、scope/owner 隔离、revision 失效、去重、多样性和 3000 字符预算；
- Python 继续负责业务文档加载、权限校验、正文回填、snapshot、embedding 混排和上下文注入；
- 通过稳定的本机 JSONL 协议隔离业务编排与检索算法；
- 不把 TypeScript worker 做成网络服务，不在业务环境动态编译或安装依赖。

## 3. 非目标与约束

- 不修改工具权限、RAG 注入位置、snapshot/TTL 或 provider adapter；
- 不引入 shadow/canary/双写作为常驻运行模式；
- 不在 TypeScript 重写 owner/scope 权限事实来源，Python 仍需在回填前再次校验；
- 不把正文、查询文本、附件名、密钥或用户身份写入诊断日志；
- 不删除 ILIKE 全局搜索开关；全局搜索与 Agent RAG 的组件替换边界保持独立；
- 迁移已完成；Rust sidecar、Python BM25 和迁移 ratchet 不再属于运行时或测试链路。

## 4. 目标架构

```text
业务文档 / revision / owner scope
              |
              v
Python：加载、权限初筛、token 输入、正文映射、embedding 混排
              |
              v
TypeScript worker：索引、BM25、confidence、阈值过滤、稳定诊断
              |
              v
Python：候选身份回填、去重/多样性、3000 字符预算、history 注入
```

TypeScript worker 只返回稳定 `source_id`、`content_fingerprint`、版本、rank、分数、
confidence 和统计字段；正文由 Python 从已授权候选映射回填，禁止 worker 成为权限边界。

## 5. 运行时边界

TypeScript worker 已是唯一 lexical 生产实现。`backend/agent/rag/ts_sidecar.py` 负责
JSONL 协议、超时、重启和结构化错误；Python 只负责文档加载、owner/scope 校验、候选
映射、混排和上下文注入。不存在 Rust/Python 词法 fallback，也不再通过迁移 ratchet
切换实现；worker 不可用时由调用方记录明确错误并按既有 RAG 策略处理，不伪装成另一种
词法后端。

## 6. 文件与职责

计划新增或调整：

- `backend/ts/workers/rag/`：TypeScript worker、协议、索引和评分实现；
- `backend/bin/gugu-rag-ts-worker.mjs`：固定运行时构建物；
- `backend/agent/rag/ts_sidecar.py`：Python 侧 JSONL client、超时、重启和结构化错误；
- `backend/agent/rag/index_cache.py`：将词法索引调用切换到 TS client；
- `backend/agent/rag/service.py`：移除生产路径对 Python `filter_confidence` 的直接调用；
- `backend/agent/rag/scoring.py`：迁移完成后删除算法实现，仅保留兼容类型或诊断模型；
- `backend/config.py`、`backend/app/core/config.py`：只保留 TypeScript worker 配置；
- `backend/tests/`：协议、语义等价、权限、故障、重启、预算与性能回归；
- `frontend/package.json` 或 release 目录：固定构建产物和 Node runtime 约束，不能在部署时临时 `npm install`。

## 7. 实施 Todo

### Phase 0：契约与直接替换（✅ 已完成）

- [x] 固定 direct replacement 迁移路线，不引入 shadow/canary；
- [x] 记录当前基线和 Rust/TS/Python benchmark；
- [x] 固定 TypeScript worker 为唯一生产主链；
- [x] 冻结 TS worker JSONL request/response schema、错误码和版本字段。

### Phase 1：TypeScript BM25 直接替换（✅ 已完成）

- [x] 实现 worker 的 replace/search/ping 协议和持久化索引生命周期；
- [x] 保持 Python tokenizer 输出和现有 OR 查询语义；
- [x] 接入 TypeScript BM25 主链，失败返回结构化 worker 错误；
- [x] 完成 owner/scope、revision、空索引、重启恢复和协议测试；
- [x] 验证固定 Node worker 构建物，不在 devserver 运行时编译。

### Phase 2：TypeScript 评分与过滤直接替换（✅ 已完成）

- [x] 迁移 `SCORING_VERSION`、来源质量、query_match、confidence 和阈值策略；
- [x] 接入 `ts_primary`，保持 accepted/rejected/threshold 诊断字段兼容；
- [x] 完成无命中、低分补位、数字查询、短实体和评分协议测试；
- [x] 将评分算法的唯一正常路径收口到 worker。

### Phase 3：生产收口与清理（✅ 已完成）

- [x] 接入 `ts_primary`，Python 只保留业务编排、权限和正文回填；
- [x] 完成 worker 重启、超时、协议损坏、索引 revision 变化测试；
- [x] 固定 Node worker 构建物和 `make rag-ts-build` 构建入口；
- [x] 移除生产路径对 Python BM25 与 Python 评分的直接调用；
- [x] 更新相关 RAG 文档，记录最终边界与回退方式。

## 8. 验收标准

- 同一查询、scope、revision、limit 下，TS 与当前基线的候选身份重叠和排序差异达到冻结阈值；
- 未授权文档永不返回，worker 重启或超时不导致主请求 500；
- warm query P95 不劣于当前 Rust 方案的可接受预算，冷构建不阻塞主请求；
- RAG 自动注入总字符预算仍为 3000，去重、多样性和 history/snapshot 边界不变；
- LoopScope 继续能看到 engine、stage、candidate、accepted、threshold、fallback 和版本诊断；
- 迁移后生产代码不再依赖 Python BM25 与 Python confidence/filter 实现。

## 9. 风险与回退

- TypeScript tokenizer 与当前 Python tokenizer 不一致：先固定 Python token 输入协议，不在迁移中同时改分词；
- Node runtime 或构建物缺失：启动前健康检查失败，保持已验证的 Rust 回退，不伪装成空结果；
- 结果语义漂移：棘轮不得推进，保留 benchmark/回归报告；
- 性能回退：仅允许显式运维回退，不允许代码自动把阶段降回旧值；
- worker 返回正文或未做 scope 校验：视为协议错误，拒绝推进到下一阶段。
