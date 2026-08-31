# TEST-RAG：TS Data Runtime + BM25 真实数据测试报告

> 测试日期：2026-08-28
> 测试环境：devserver（当前运行版本）
> 测试数据：个人 owner 的真实数据库数据
> 测试目的：验证 TS Data Runtime 读取、TS BM25 建索引与查询的实际耗时
> 数据保护：本文不记录 owner 标识、账号信息、正文、文件名或查询结果内容

---

## 1. 测试结论

TS Data Runtime + BM25 适合继续作为 **RAG 专用检索链路**：

- 数据读取完成后，BM25 热查询约为 `1.4–2.2ms`，明显低于 Python `ILIKE` 的 `68–92ms`。
- 首次索引构建约 `663.7ms`，是冷启动阶段的主要成本；索引应由常驻 TS worker 预热，不应落在普通聊天请求上。
- Data Runtime 的缓存命中约 `0.1ms`，可以有效避免同一 revision 的重复数据库读取。
- 当前不建议把这套链路直接替换全局搜索。全局搜索仍包含业务排序、分组、摘要、拼音匹配和 UI 展示协议，Python `ILIKE` 继续保留。

本次测试没有修改业务代码，也没有改变 devserver 服务配置。

## 2. 测试范围与口径

本次测试分为两条链路：

### 2.1 Python 基线

直接调用现有全局搜索核心 `_run_ilike_search`，使用同一 owner 和四个固定中文查询词，每个查询重复 5 次，记录中位数和返回对象数量。

该基线测量的是完整的 Python 全局搜索逻辑，包括多个业务表查询、结果分组、排序和摘要处理。

### 2.2 TS RAG 链路

按以下顺序执行：

```text
TS Data Runtime
    ↓
读取 project / file / conversation / knowledge / canvas
    ↓
转换为 RAG canonical document
    ↓
TS RAG worker replace，构建 BM25 倒排索引
    ↓
BM25 search
```

TS 侧每个来源最多读取 2000 条记录；本次实际加载 4340 条记录。索引构建完成后，对相同查询集合各执行 5 次热查询。

因此，Python 和 TS 的耗时可以用于判断链路成本，但不能把两者的返回数量直接视为结果正确性等价证明。TS Data Runtime 当前是 RAG 读层，不是全局搜索 API 的完整实现。

## 3. 真实数据规模

| 来源 | 读取记录数 |
| --- | ---: |
| project | 57 |
| file | 244 |
| conversation | 1912 |
| knowledge | 2000 |
| canvas | 127 |
| **合计** | **4340** |

Knowledge 达到本次读取上限 2000 条，报告中的总量不是数据库全量规模，而是本次 RAG 批次实际送入索引的规模。

## 4. Python ILIKE 基线

查询使用相同的四个通用中文词，每个查询执行 5 次，以下为中位数：

| 查询类别 | ILIKE 中位数 | 中位返回对象数 |
| --- | ---: | ---: |
| 查询 A | 68.0ms | 18 |
| 查询 B | 91.8ms | 15 |
| 查询 C | 68.3ms | 19 |
| 查询 D | 70.4ms | 18 |

Python ILIKE 的耗时包含全局搜索当前的业务逻辑，不只是数据库单条读取。

## 5. TS Data Runtime + BM25

### 5.1 冷读与建索引

| 阶段 | 耗时 |
| --- | ---: |
| Data Runtime 冷读全部来源 | 121.6ms |
| TS BM25 首次建索引 | 663.7ms |
| 实际索引记录数 | 4340 |

首次完整准备成本约为 `785.3ms`。其中索引构建是主要成本，不能作为常驻 worker 热查询性能使用。

### 5.2 BM25 热查询

| 查询类别 | BM25 中位数 | 返回结果数 |
| --- | ---: | ---: |
| 查询 A | 2.2ms | 10 |
| 查询 B | 1.6ms | 10 |
| 查询 C | 1.4ms | 10 |
| 查询 D | 1.4ms | 10 |

BM25 热查询约为 Python ILIKE 的 `1/30–1/60`，但二者结果上限和排序规则不同，不能直接据此宣称全局搜索结果完全等价。

### 5.3 Data Runtime 缓存

同一 owner、同一来源和同一 revision 下连续执行两次缓存读取：

| 阶段 | 耗时 |
| --- | ---: |
| 首次缓存填充 | 72.3ms |
| 第二次缓存命中 | 0.1ms |
| 缓存条目数 | 5 |

缓存键按 owner、scope、source、分页参数和 revision 区分。缓存命中只复用读取结果，不改变 BM25 索引的 revision 语义。

## 6. 性能解释

### 6.1 为什么冷读没有体现 BM25 优势

冷读阶段包含三个不同成本：

1. PostgreSQL 查询和 DTO 转换。
2. RAG 文档转换和批量传输。
3. worker 内存索引构建。

其中第三项只应在 worker 启动、索引 revision 变化或增量 patch 时发生。若每轮聊天都重新 replace，BM25 的热查询优势会被索引构建成本抵消。

### 6.2 为什么常驻后明显更快

常驻 worker 已经持有：

- Jieba/tokenizer 初始化状态；
- 文档数组；
- 倒排 posting；
- 文档长度、词频和文档频率统计；
- 当前 revision。

查询只需要对已有倒排结构打分和排序，不再重复读取数据库或重建索引，因此查询耗时稳定在毫秒级。

## 7. 采用边界

### 保留并采用

- RAG 的 project、file、conversation、knowledge、canvas 数据读取使用 TS Data Runtime。
- RAG 词法检索使用常驻 TS worker 的 BM25。
- revision 不变时复用内存索引和 Data Runtime 缓存。
- source/chunk 发生变化时使用增量 patch，避免无变化 replace。
- worker 进程结束时显式关闭数据库客户端和资源。

### 暂不迁移

- 顶栏全局搜索。
- 文件库、项目、对话等面向 UI 的专用搜索接口。
- Python 全局搜索的 `ILIKE`、拼音匹配、业务分组和摘要协议。

这些功能需要单独完成 TS 搜索协议、结果兼容性和回归测试，不能仅因为 Data Runtime 读取更快就直接替换。

## 8. 后续优化建议

1. 继续保持 TS RAG worker 常驻，并在服务启动后异步预热活跃 owner。
2. 将索引构建指标拆分为文档转换、tokenize、posting 构建和持久化写入。
3. 对 source/chunk digest 做增量 patch，只发送变化 chunk 的 upsert/delete。
4. 当索引 revision 未变化时，直接复用完整索引，不发送 replace。
5. 为 4340 条以上的 owner 数据增加更大批次和内存占用测试。
6. 保持 Python `ILIKE` 作为全局搜索实现，直到 TS 侧具备完整的排序、分组、摘要和拼音兼容测试。

## 9. 可复现性

本次测试使用临时只读 benchmark harness：

- 从 devserver 当前配置读取数据库连接，不输出连接信息；
- 在数据库中验证个人 owner 存在后执行；
- 只输出记录数、耗时和结果数量；
- 测试结束后删除本地和 devserver 临时脚本；
- 未写入数据库、未重启服务、未修改运行配置。
