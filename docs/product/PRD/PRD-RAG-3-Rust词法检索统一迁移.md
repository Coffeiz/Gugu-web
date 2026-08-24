# PRD-RAG-3：Rust 词法检索统一迁移

## 1. 状态

**状态：实施中**

## 2. 背景与目标

当前 RAG 的 Python BM25 在每次缓存重建时需要遍历文档、构建词频表，并在查询时扫描候选文档。真实数据测试表明，冷启动和高并发下存在明显的 CPU 与内存开销。项目已经完成 Rust/Tantivy sidecar 原型，因此本阶段将词法检索统一迁移到 Rust。

目标：

- Rust/Tantivy 成为唯一 BM25 词法检索实现；
- 运行时只消费经过 release pipeline 验证的固定二进制制品，不在业务环境自行构建 Rust；
- Docker 部署统一消费 Linux 制品，首期只维护 `x86_64-unknown-linux-musl`；
- Python 继续负责分词、权限、owner/scope 过滤、业务文档加载、向量混排和 ILIKE 回退；
- 保持当前 OR 查询语义、结果排序、scope 隔离和 revision 失效机制；
- 不把正文、密钥或用户输入写入日志；sidecar 只通过本机 JSONL stdin/stdout 通信；
- 可配置关闭 Rust sidecar，使用已有 ILIKE 兼容路径。

## 3. 范围

### 3.1 本阶段包含

- Rust sidecar Python client 与进程生命周期管理；
- 持久化知识索引和全局搜索的 Rust lexical backend；
- Memory/Project 等非数据库 RAG 来源的 Rust lexical backend；
- revision、owner、source、scope 过滤；
- sidecar 不可用时的 ILIKE 回退或无词法结果降级；
- 单元、协议、权限隔离、重启恢复和性能回归测试；
- 删除 Python BM25 类及其生产调用方。

### 3.2 本阶段不包含

- embedding 模型与向量索引迁移；
- 改造业务文档生成、权限模型和索引写入协议；
- 用 Rust 替代 Jieba 分词。现阶段 Python 仅保留统一分词器，以保持召回语义兼容；
- 为 sidecar 增加网络监听、跨机器服务发现或 Docker 沙箱。

## 4. 目标架构

```text
业务文档/权限/scope
        |
        v
Python tokenizer + RustLexicalIndex / RustSidecarClient
        |
        +--> Tantivy Rust sidecar：索引、BM25、Top-K
        |
        +--> 不可用时：全局搜索走 ILIKE；RAG 记录降级原因并继续向量路径
        |
        v
hybrid_results / UnifiedRecallService
```

Python 不再保存 BM25 的词频、倒排词典或文档扫描状态。sidecar 只返回稳定 chunk id、score、source_type 和 document_version，正文始终由 Python 根据已验证的 owner/scope 文档映射回填。

## 5. 实施 Todo

### Phase 1：接口与配置

- [x] 固化 Rust/Tantivy JSONL `ping/replace/search` 协议；
- [x] 新增 `RustSidecarClient` 和可重启的单进程生命周期；
- [x] 增加启用开关、sidecar 命令、索引目录和超时配置；
- [x] 统一 `RustLexicalIndex` 接口，隔离业务层与具体实现。

### Phase 2：缓存与持久化索引迁移

- [x] 将 `KnowledgeIndexCache` 从 Python BM25 切换为 Rust lexical index；
- [x] 保留现有 indexed_at revision 检测和 scope-first 过滤；
- [x] 将 `search_persistent_index` 接入 Rust 查询并处理 revision mismatch；
- [x] 全局搜索继续支持 `index`/`ilike` 开关，Rust 不可用时明确回退并记录诊断。

### Phase 3：RAG 来源迁移

- [x] 迁移 MemoryRetriever、ProjectRetriever 的临时索引路径；
- [x] 保留 embedding 混排、来源优先级、去重和输出预算；
- [x] 清理生产代码中的 `BM25` 直接依赖；
- [x] 保留 Python tokenizer 作为兼容边界，并将其独立到 tokenizer 模块。

### Phase 4：清理与回归

- [x] 删除 Python BM25 生产实现和过时 import；保留部署期 `LegacyBM25` 临时回退；
- [x] 增加 Rust 侧 OR 语义、owner 隔离、revision 和空索引测试；
- [x] 增加 Python 侧 scope、sidecar 重启、故障回退测试；
- [x] 增加 Rust unavailable、超时、协议错误的回退测试；
- [x] 比较 Python BM25、Tantivy、ILIKE 的召回重叠和 P50/P95；
- [ ] 清理探针、临时 corpus 和生成物。

### Phase 5：灰度与上线

- [x] 在 devserver Linux 宿主机使用 Rust `1.98.0` 完成 `x86_64-unknown-linux-gnu` 验证构建，写入 `backend/bin/gugu-rag-sidecar` 并通过版本检查；
- [x] 在 devserver 真实数据库索引上完成 sidecar 协议 smoke test、Rust persistent search 和 Global Search 业务路径测试；
- [ ] release pipeline 在 Linux/Docker 构建并签核固定版本 `x86_64-unknown-linux-musl` sidecar，写入镜像或 `backend/bin/gugu-rag-sidecar`；
- [ ] devserver 同步/安装 musl 验证制品，并确认实际后端进程使用新实现；
- [ ] 以 `ilike` 默认、Rust opt-in 灰度，观察错误率、回退率、召回重叠和延迟；
- [ ] 验证通过后将 Rust 设为默认，保留 ILIKE 紧急开关。

## 6. 验收标准

- 相同 owner、scope、query、limit 下，Rust 结果与现有 BM25 的 Top-K 召回重叠达到既定阈值；
- owner/scope 不匹配的文档不可被返回；revision 不匹配不会返回旧索引结果；
- sidecar 重启后可以从持久化目录恢复，断开时不拖垮主请求；
- global search 可切换 ILIKE，Rust 故障不导致接口 500；
- Rust warm query P95 明显低于 Python BM25，且 sidecar 内存占用在配置上限内；
- Python 生产代码不再包含 BM25 算法实现，测试与 benchmark 不再依赖旧类。

## 7. 风险与回退

- Jieba 与 Tantivy tokenizer 不一致：暂时由 Python 生成兼容 token 字符串，后续单独评估 Rust 分词；
- sidecar 二进制未随发布制品提供：保持 `ilike`，禁止在没有可执行文件时误报 Rust 已启用；
- 首期部署架构固定为 Linux x86_64；未来需要 ARM Docker 主机时再增加 `aarch64-unknown-linux-musl` 制品，不在业务侧动态判断或编译；
- sidecar 协议或索引异常：按来源记录降级原因，global search 使用 ILIKE；
- 任何权限和 scope 过滤都在 Python 和 sidecar 双重执行，不能只信任 sidecar 返回值。
