# RAG 质量完整复测报告（2026-08-25）

## 1. 结论摘要

- 使用 devserver 当前真实 Memory 索引，10 个查询、owner + 2 个群作用域，共 30 个 scope-query 组合。
- owner 781 个文档中 778 个有当前 embedding 缓存；两个群作用域当前没有文档向量缓存，因此群作用域实际走 BM25 回退。
- owner 的 BM25 与 hybrid 前 20 名集合完全一致；向量 Top20 与 BM25 的集合重叠较低，说明向量会明显改变排序，但本轮没有人工相关性标注，不能据此断言向量更准。
- `normalized_score >= 0.35` 只作为离线模拟：owner 几乎不过滤，群作用域会过滤约 40%，不适合直接作为全局硬过滤。

## 2. 测试前提

| 项目 | 值 |
|---|---|
| 环境 | devserver（真实配置、只读） |
| Embedding | `bailian:tongyi-embedding-vision-flash:default` |
| 查询数 | 10 |
| 作用域 | 3（owner、两个活跃群作用域；正文和标识不写入） |
| 候选数 | 每个模式最多 Top20；下文逐项展示 Top5 |
| 写入 | 无；不修改记忆、索引、向量或线上阈值 |
| 脚本 | `backend/scripts/diagnostics/rag_quality_retest.py` |

查询集合：`GTA 6`、`画布 卡片`、`项目文件`、`提醒`、`图片搜索`、`记忆`、`最近好玩的游戏`、`搜索工具`、`日历安排`、`当前工作计划`。

## 3. 索引与向量覆盖

| 作用域 | 文档数 | 匹配向量数 | 覆盖率 | 线上策略 |
|---|---:|---:|---:|---|
| owner | 781 | 778 | 99.62% | hybrid 可用 |
| group-1 | 15 | 0 | 0.00% | BM25 回退 |
| group-2 | 11 | 0 | 0.00% | BM25 回退 |

> 群作用域当前没有文档向量缓存，但每次查询仍会生成 query embedding；由于没有候选向量，hybrid 按设计回退 BM25。这是本轮最重要的覆盖缺口。

## 4. 量化结果

| 作用域 | BM25↔Hybrid Top20 Jaccard | BM25↔Vector Top20 Jaccard | normalized ≥ 0.35 | 词法中位数/P95 ms | query embedding 中位数 ms |
|---|---:|---:|---:|---:|---:|
| owner | 100.0% | 17.5% | 196/200 (98.0%) | 4.7/4.9 | 210.6 |
| group-1 | 100.0% | — | 62/101 (61.4%) | 3.2/5.3 | 237.1 |
| group-2 | 100.0% | — | 50/84 (59.5%) | 2.5/4.6 | 221.9 |

指标含义：Top20 Jaccard 只衡量排序集合变化，不代表正确率；本轮没有人工 query-document 相关性标注，因此不虚构 Precision/Recall。

## 5. 完整 Top5 结果（脱敏指纹）

格式：`来源:chunk_fp/raw/norm`；`norm` 为本次候选集合内 hybrid 分数归一化，`*` 表示通过 `>=0.35` 模拟门槛。正文、用户标识和 scope 原值均未输出。

### owner

#### gta（query_fp `404998dca0da`）
- BM25：daily:4137d57aa6eb/18.252；daily:005257ddecbd/16.601；profile:bf8d18932e93/11.190；memory:1af1367e9d48/10.805；daily:9eef7f93e61c/10.669
- Vector：profile:bf8d18932e93/0.814；daily:90f3eb3ea8e6/0.721；daily:cbf6ce44d6ba/0.684；daily:9eef7f93e61c/0.680；daily:2d56ac4fd6a8/0.672
- Hybrid：daily:4137d57aa6eb/0.904/1.000*；daily:005257ddecbd/0.851/0.941*；profile:bf8d18932e93/0.768/0.849*；daily:90f3eb3ea8e6/0.690/0.763*；daily:9eef7f93e61c/0.685/0.757*

#### canvas（query_fp `976215f05f54`）
- BM25：pattern:93b54611979f/16.801；pattern:70080dcf24d2/14.910；memory:92418fc8f282/14.906；pattern:c18f300776de/14.373；profile:0b304b2fee1a/14.322
- Vector：pattern:93b54611979f/0.671；pattern:70080dcf24d2/0.664；profile:cf4ce1efc255/0.664；daily:46765a63a4d4/0.656；pattern:2b14b974ba10/0.656
- Hybrid：pattern:93b54611979f/1.000/1.000*；pattern:70080dcf24d2/0.929/0.929*；memory:92418fc8f282/0.902/0.902*；profile:0b304b2fee1a/0.898/0.898*；pattern:c18f300776de/0.853/0.853*

#### project（query_fp `07e577ff8c0d`）
- BM25：pattern:93b54611979f/24.664；profile:0b304b2fee1a/24.605；profile:f9025bcd17c8/21.800；pattern:c0daab1aa1de/20.620；pattern:04b367c12aaa/20.555
- Vector：daily:df9a1ac72208/0.741；pattern:bf96d6876b6c/0.737；profile:e173d5039a39/0.733；pattern:8db81af43aa0/0.722；daily:dd822bce267a/0.718
- Hybrid：profile:0b304b2fee1a/0.978/1.000*；pattern:93b54611979f/0.934/0.955*；daily:07df0b14cf9c/0.853/0.872*；profile:f9025bcd17c8/0.844/0.863*；pattern:04b367c12aaa/0.817/0.835*

#### reminder（query_fp `8f29b3132ccf`）
- BM25：pattern:61d22364eb0e/16.399；pattern:f4a5b87303c9/15.898；daily:4115700ebd77/15.426；daily:53077240a0ed/14.981；pattern:0a802f90f995/14.981
- Vector：daily:52e40e44252a/0.769；daily:4c1ec46dd511/0.762；daily:4115700ebd77/0.755；daily:795b1bf41a00/0.753；pattern:2af786e62420/0.744
- Hybrid：pattern:61d22364eb0e/0.991/1.000*；daily:4115700ebd77/0.964/0.973*；pattern:f4a5b87303c9/0.913/0.921*；pattern:009df3cfe037/0.888/0.895*；pattern:0a802f90f995/0.874/0.882*

#### image（query_fp `74a835731349`）
- BM25：pattern:5a3ed125bc0c/25.977；daily:83e1deeb2d28/19.256；daily:8584fcb4c3c7/18.465；daily:856feb87e907/17.628；daily:aeaaa0ded52c/16.384
- Vector：daily:7c67b02c7a76/0.840；daily:4672dc020100/0.823；profile:7c2bebd9870c/0.820；daily:4c1ec46dd511/0.791；daily:6cd87ea6f7f0/0.777
- Hybrid：pattern:5a3ed125bc0c/0.923/1.000*；daily:8584fcb4c3c7/0.827/0.895*；pattern:50dc05ed0161/0.753/0.815*；daily:83e1deeb2d28/0.747/0.809*；daily:c361d2f841bd/0.717/0.777*

#### memory（query_fp `7a6335b379b9`）
- BM25：pattern:3a86dc84f630/2.582；memory:205c5d9eb713/2.398；memory:74a31e6ab9ba/2.398；daily:5a59b5449c5b/2.250；daily:89ce19ad6ba9/2.111
- Vector：daily:7c67b02c7a76/0.771；daily:4c1ec46dd511/0.770；pattern:0024db946a64/0.746；profile:dcffa2a12f4e/0.742；profile:994086573a16/0.738
- Hybrid：pattern:3a86dc84f630/1.000/1.000*；memory:205c5d9eb713/0.882/0.882*；memory:74a31e6ab9ba/0.865/0.865*；pattern:b387a5f690e5/0.860/0.860*；daily:f5140b973e9a/0.855/0.855*

#### game（query_fp `9ab160726911`）
- BM25：daily:4137d57aa6eb/47.766；daily:005257ddecbd/43.552；daily:1db64e37d558/32.113；daily:74aba3896c49/24.306；daily:f77ad7726f5b/23.993
- Vector：profile:dcffa2a12f4e/0.765；daily:1db64e37d558/0.735；daily:7c67b02c7a76/0.731；profile:7fd7ddff5573/0.730；daily:4c1ec46dd511/0.728
- Hybrid：daily:4137d57aa6eb/0.987/1.000*；daily:005257ddecbd/0.919/0.931*；daily:1db64e37d558/0.803/0.814*；daily:f77ad7726f5b/0.685/0.694*；daily:478ea502cd05/0.653/0.661*

#### search（query_fp `eae0cd2261e8`）
- BM25：pattern:50dc05ed0161/26.702；pattern:8d22ff88289a/23.233；daily:4a2072ec4c6d/23.061；pattern:1f2248f5bd24/22.944；daily:aad2d9d5339d/22.944
- Vector：pattern:50dc05ed0161/0.807；profile:7c2bebd9870c/0.766；daily:4672dc020100/0.760；daily:ac65d26199f2/0.732；daily:e3e860a2a260/0.728
- Hybrid：pattern:50dc05ed0161/1.000/1.000*；pattern:8d22ff88289a/0.879/0.879*；daily:aad2d9d5339d/0.839/0.839*；daily:4a2072ec4c6d/0.836/0.836*；pattern:1f2248f5bd24/0.831/0.831*

#### schedule（query_fp `bdbad28da44b`）
- BM25：daily:ff6890e032fc/37.611；pattern:274022d50885/20.466；daily:e06cbbc1a549/19.652；daily:f374370d15eb/18.604；daily:937b2ecf12d8/17.337
- Vector：pattern:2af786e62420/0.756；pattern:8db81af43aa0/0.743；daily:ff6890e032fc/0.737；daily:52e40e44252a/0.730；daily:4115700ebd77/0.727
- Hybrid：daily:ff6890e032fc/1.000/1.000*；daily:f374370d15eb/0.684/0.684*；pattern:274022d50885/0.666/0.666*；daily:e06cbbc1a549/0.661/0.661*；daily:937b2ecf12d8/0.636/0.636*

#### work（query_fp `ea7ebeb29e16`）
- BM25：daily:6eb25a1287c3/20.451；profile:cd4174612390/20.269；daily:c3979508e73f/20.248；daily:5a1338065226/19.862；pattern:b67405818845/12.426
- Vector：pattern:8db81af43aa0/0.775；daily:c6884a4b85b0/0.739；profile:e173d5039a39/0.735；daily:df9a1ac72208/0.733；pattern:2af786e62420/0.717
- Hybrid：daily:5a1338065226/0.876/1.000*；daily:c3979508e73f/0.844/0.964*；daily:6eb25a1287c3/0.823/0.940*；profile:cd4174612390/0.789/0.901*；pattern:b67405818845/0.701/0.800*

### group-1

#### gta（query_fp `404998dca0da`）
- BM25：memory:daf372b592e9/7.486；memory:7e26a7546ee3/5.063；daily:51f23261b576/3.098；daily:530cb9fc8c25/2.845；daily:8e961930b262/2.168
- Vector：（无）
- Hybrid：memory:daf372b592e9/7.486/1.000*；memory:7e26a7546ee3/5.063/0.676*；daily:51f23261b576/3.098/0.414*；daily:530cb9fc8c25/2.845/0.380*；daily:8e961930b262/2.168/0.290

#### canvas（query_fp `976215f05f54`）
- BM25：daily:c01ddebc2d2c/3.948；daily:312811c05d7d/2.794；daily:97b72ad272ba/1.186；profile:8c2221e03173/1.117；daily:8f67e997ae67/0.920
- Vector：（无）
- Hybrid：daily:c01ddebc2d2c/3.948/1.000*；daily:312811c05d7d/2.794/0.708*；daily:97b72ad272ba/1.186/0.300；profile:8c2221e03173/1.117/0.283；daily:8f67e997ae67/0.920/0.233

#### project（query_fp `07e577ff8c0d`）
- BM25：daily:312811c05d7d/6.606；daily:49ec5b1bad9b/6.024；profile:8c2221e03173/4.848；memory:daf372b592e9/3.779；daily:8f67e997ae67/3.617
- Vector：（无）
- Hybrid：daily:312811c05d7d/6.606/1.000*；daily:49ec5b1bad9b/6.024/0.912*；profile:8c2221e03173/4.848/0.734*；memory:daf372b592e9/3.779/0.572*；daily:8f67e997ae67/3.617/0.548*

#### reminder（query_fp `8f29b3132ccf`）
- BM25：daily:9f461b2423b7/1.018；daily:8f67e997ae67/0.893；daily:64806d285ddf/0.867；daily:530cb9fc8c25/0.685；daily:8e961930b262/0.685
- Vector：（无）
- Hybrid：daily:9f461b2423b7/1.018/1.000*；daily:8f67e997ae67/0.893/0.877*；daily:64806d285ddf/0.867/0.851*；daily:530cb9fc8c25/0.685/0.673*；daily:8e961930b262/0.685/0.673*

#### image（query_fp `74a835731349`）
- BM25：daily:c01ddebc2d2c/9.225；daily:97b72ad272ba/7.862；daily:312811c05d7d/5.739；profile:8c2221e03173/4.234；daily:8f67e997ae67/3.037
- Vector：（无）
- Hybrid：daily:c01ddebc2d2c/9.225/1.000*；daily:97b72ad272ba/7.862/0.852*；daily:312811c05d7d/5.739/0.622*；profile:8c2221e03173/4.234/0.459*；daily:8f67e997ae67/3.037/0.329

#### memory（query_fp `7a6335b379b9`）
- BM25：memory:daf372b592e9/0.998；memory:7e26a7546ee3/0.983；daily:51f23261b576/0.682；daily:530cb9fc8c25/0.654；daily:8e961930b262/0.621
- Vector：（无）
- Hybrid：memory:daf372b592e9/0.998/1.000*；memory:7e26a7546ee3/0.983/0.985*；daily:51f23261b576/0.682/0.683*；daily:530cb9fc8c25/0.654/0.655*；daily:8e961930b262/0.621/0.623*

#### game（query_fp `9ab160726911`）
- BM25：memory:daf372b592e9/19.337；memory:7e26a7546ee3/8.775；daily:8e961930b262/6.177；daily:530cb9fc8c25/3.802；daily:97b72ad272ba/3.409
- Vector：（无）
- Hybrid：memory:daf372b592e9/19.337/1.000*；memory:7e26a7546ee3/8.775/0.454*；daily:8e961930b262/6.177/0.319；daily:530cb9fc8c25/3.802/0.197；daily:97b72ad272ba/3.409/0.176

#### search（query_fp `eae0cd2261e8`）
- BM25：daily:c01ddebc2d2c/5.799；daily:312811c05d7d/5.335；daily:8f67e997ae67/4.271；daily:9f461b2423b7/4.033；memory:daf372b592e9/3.549
- Vector：（无）
- Hybrid：daily:c01ddebc2d2c/5.799/1.000*；daily:312811c05d7d/5.335/0.920*；daily:8f67e997ae67/4.271/0.736*；daily:9f461b2423b7/4.033/0.695*；memory:daf372b592e9/3.549/0.612*

#### schedule（query_fp `bdbad28da44b`）
- BM25：memory:daf372b592e9/3.931；daily:49ec5b1bad9b/2.410；daily:597d1cd028e8/2.410；memory:7e26a7546ee3/1.751；daily:c01ddebc2d2c/1.657
- Vector：（无）
- Hybrid：memory:daf372b592e9/3.931/1.000*；daily:49ec5b1bad9b/2.410/0.613*；daily:597d1cd028e8/2.410/0.613*；memory:7e26a7546ee3/1.751/0.445*；daily:c01ddebc2d2c/1.657/0.421*

#### work（query_fp `ea7ebeb29e16`）
- BM25：daily:530cb9fc8c25/8.343；daily:97b72ad272ba/7.774；daily:8f67e997ae67/4.070；memory:daf372b592e9/4.033；memory:7e26a7546ee3/3.707
- Vector：（无）
- Hybrid：daily:530cb9fc8c25/8.343/1.000*；daily:97b72ad272ba/7.774/0.932*；daily:8f67e997ae67/4.070/0.488*；memory:daf372b592e9/4.033/0.483*；memory:7e26a7546ee3/3.707/0.444*

### group-2

#### gta（query_fp `404998dca0da`）
- BM25：daily:1f9a670f34a2/3.111；daily:3392b597adb2/2.919；daily:90cbf9b7e5bf/2.279；memory:9bd5c5cbc72e/1.184；memory:2a9b876be5a6/1.140
- Vector：（无）
- Hybrid：daily:1f9a670f34a2/3.111/1.000*；daily:3392b597adb2/2.919/0.938*；daily:90cbf9b7e5bf/2.279/0.733*；memory:9bd5c5cbc72e/1.184/0.381*；memory:2a9b876be5a6/1.140/0.366*

#### canvas（query_fp `976215f05f54`）
- BM25：memory:84074b1803f0/7.030；profile:38affb532b43/1.688；memory:2a9b876be5a6/1.283；profile:ac148c6e78d3/1.055；daily:3392b597adb2/0.905
- Vector：（无）
- Hybrid：memory:84074b1803f0/7.030/1.000*；profile:38affb532b43/1.688/0.240；memory:2a9b876be5a6/1.283/0.182；profile:ac148c6e78d3/1.055/0.150；daily:3392b597adb2/0.905/0.129

#### project（query_fp `07e577ff8c0d`）
- BM25：profile:ac148c6e78d3/6.146；profile:38affb532b43/5.920；memory:3b62428d82d9/5.772；memory:9bd5c5cbc72e/4.303；memory:84074b1803f0/2.895
- Vector：（无）
- Hybrid：profile:ac148c6e78d3/6.146/1.000*；profile:38affb532b43/5.920/0.963*；memory:3b62428d82d9/5.772/0.939*；memory:9bd5c5cbc72e/4.303/0.700*；memory:84074b1803f0/2.895/0.471*

#### reminder（query_fp `8f29b3132ccf`）
- BM25：daily:90cbf9b7e5bf/1.554；daily:1f9a670f34a2/1.220；memory:2a9b876be5a6/1.194；memory:84074b1803f0/1.121；profile:38affb532b43/0.829
- Vector：（无）
- Hybrid：daily:90cbf9b7e5bf/1.554/1.000*；daily:1f9a670f34a2/1.220/0.785*；memory:2a9b876be5a6/1.194/0.769*；memory:84074b1803f0/1.121/0.722*；profile:38affb532b43/0.829/0.534*

#### image（query_fp `74a835731349`）
- BM25：profile:ac148c6e78d3/6.116；profile:38affb532b43/5.378；daily:1f9a670f34a2/4.205；daily:90cbf9b7e5bf/3.653；memory:84074b1803f0/2.608
- Vector：（无）
- Hybrid：profile:ac148c6e78d3/6.116/1.000*；profile:38affb532b43/5.378/0.879*；daily:1f9a670f34a2/4.205/0.688*；daily:90cbf9b7e5bf/3.653/0.597*；memory:84074b1803f0/2.608/0.426*

#### memory（query_fp `7a6335b379b9`）
- BM25：memory:3b62428d82d9/1.272；daily:7efa99fc3f46/1.242；memory:84074b1803f0/1.207；memory:9bd5c5cbc72e/1.172；memory:2a9b876be5a6/1.086
- Vector：（无）
- Hybrid：memory:3b62428d82d9/1.272/1.000*；daily:7efa99fc3f46/1.242/0.976*；memory:84074b1803f0/1.207/0.949*；memory:9bd5c5cbc72e/1.172/0.921*；memory:2a9b876be5a6/1.086/0.854*

#### game（query_fp `9ab160726911`）
- BM25：memory:84074b1803f0/5.784；memory:9bd5c5cbc72e/5.447；profile:38affb532b43/5.141；profile:ac148c6e78d3/3.736；memory:3b62428d82d9/3.526
- Vector：（无）
- Hybrid：memory:84074b1803f0/5.784/1.000*；memory:9bd5c5cbc72e/5.447/0.942*；profile:38affb532b43/5.141/0.889*；profile:ac148c6e78d3/3.736/0.646*；memory:3b62428d82d9/3.526/0.610*

#### search（query_fp `eae0cd2261e8`）
- BM25：profile:ac148c6e78d3/7.715；profile:38affb532b43/6.159；daily:90cbf9b7e5bf/4.299；memory:84074b1803f0/4.112；memory:3b62428d82d9/2.629
- Vector：（无）
- Hybrid：profile:ac148c6e78d3/7.715/1.000*；profile:38affb532b43/6.159/0.798*；daily:90cbf9b7e5bf/4.299/0.557*；memory:84074b1803f0/4.112/0.533*；memory:3b62428d82d9/2.629/0.341

#### schedule（query_fp `bdbad28da44b`）
- BM25：profile:38affb532b43/6.065；daily:90cbf9b7e5bf/1.627；memory:2a9b876be5a6/1.335；daily:1f9a670f34a2/0.951；summary:ac2ceac70789/0.878
- Vector：（无）
- Hybrid：profile:38affb532b43/6.065/1.000*；daily:90cbf9b7e5bf/1.627/0.268；memory:2a9b876be5a6/1.335/0.220；daily:1f9a670f34a2/0.951/0.157；summary:ac2ceac70789/0.878/0.145

#### work（query_fp `ea7ebeb29e16`）
- BM25：profile:ac148c6e78d3/8.172；memory:3b62428d82d9/7.025；daily:90cbf9b7e5bf/5.236；memory:84074b1803f0/3.391；profile:38affb532b43/3.189
- Vector：（无）
- Hybrid：profile:ac148c6e78d3/8.172/1.000*；memory:3b62428d82d9/7.025/0.860*；daily:90cbf9b7e5bf/5.236/0.641*；memory:84074b1803f0/3.391/0.415*；profile:38affb532b43/3.189/0.390*

## 6. 质量限制方案讨论

### 不建议

- 不跨 BM25、cosine、hybrid 直接比较 raw score；三者量纲和候选集合不同。
- 不只用 `normalized_score >= 0.35` 做全局硬过滤；本轮 owner 几乎不过滤，而群作用域会过滤约 40%，且没有标注证明被过滤项一定不相关。

### 建议两阶段方案

1. 每个 scope、每种检索策略独立计算 raw score；hybrid 只在候选向量完整时启用，否则明确标记 BM25 fallback。
2. 使用 normalized score 做相对门槛，同时加入检索器专属绝对下限；低于任一门槛不注入，但至少保留最高分 1 条。
3. 先 dry-run 记录分数分布、过滤数量和用户追问，再用人工标注校准 BM25/vector/hybrid 各自的绝对下限。
4. 先补齐群作用域文档向量缓存，再评估群聊 hybrid；当前群聊数据不能证明 embedding 质量。
5. 灰度顺序：只记录 → owner 过滤 → 群 scope 有向量且有标注后再独立校准。

建议初始保护规则（未上线）：

```text
keep = top_score
    or (normalized_score >= 0.35 and absolute_score >= retriever_floor)
    or (候选数很少且没有明显负相关信号)
```

`retriever_floor` 必须按 BM25、vector、hybrid 分开维护；owner/group 只影响校准参数，不改变权限边界。

## 7. 限制与后续

- 本轮是覆盖常见语义的诊断集，不是人工标注集；集合重叠率不能当成 Precision/Recall。
- owner 有 1 个文档缺少匹配向量，需继续查明其来源和缓存失效原因。
- 两个群作用域没有文档向量缓存，需在群记忆索引更新/管理员重建时补建 scope vectors。
- 下一轮建议建立 30～50 条脱敏 query-document 标注，测 Precision@5/10、Recall@20、过滤误杀率和注入字符成本。

