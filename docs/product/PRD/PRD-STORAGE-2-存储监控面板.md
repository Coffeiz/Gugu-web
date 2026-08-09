# 存储监控面板 设计笔记

> 状态：✅ 已实现（2026-08-09）
> 创建：2026-08-09
> 关联模块：`backend/app/core/storage_snapshots.py`（新）、`backend/app/core/video_cache_gc.py`、`backend/app/api/v1/ops_admin.py`、`backend/app/models/__init__.py`（`StorageCategorySnapshot`）、`frontend/src/views/Admin/Ops/Storage.vue`（新）
> 背景：PRD-STORAGE-1 落地过程中发现"要不要给 `.video_cache/` 加配额上限"这类问题完全没有观察数据支撑；现有「存储对账」页是一致性核查工具（幽灵记录/孤儿文件，一致性视角），不是用量看板，两种关注点不该混在一起。

## 0. 实现落地（跟第 3、4 节设计的差异记录）

- **放在「运维」导航分组下的独立页面**（`/storage-monitor`，路由名 `AdminStorageMonitor`），跟「存储对账」（`/storage-audit`）并列，不是嵌进对账页——符合第 1 节的定位。
- **第 4 节的通用快照表建议照做**：`storage_category_snapshots(id, category, taken_at, object_count, total_bytes)`，替换掉最初按 PRD-STORAGE-1 落地时先做的专用 `video_cache_snapshots` 表（该表上线不到一天、无真实数据，migration 直接删表重建，未做数据迁移）。
- **落地了 3.1 节里"零成本能算"的三类**：`user_files`（`SUM(files.size_bytes)`）、`chat_staging_draft`/`chat_staging_attached`（`SUM(chat_attachments.size) GROUP BY state`）+ 已有的 `video_cache`（`video_cache_gc` 扫描顺带算）。新增 `app/core/storage_snapshots.py` 承担前三类的定时任务（`storage_usage_snapshot`）。
- **SQL 类三个类别新增实时查询接口，概览卡片不依赖快照历史**：`GET /admin/ops/storage-live-totals` 直接调用 `storage_snapshots.compute_sql_totals()`（`record_sql_snapshots()` 内部也是调这个函数、多一步落快照，两者共用同一份计算逻辑，不是两套口径）。原因：这三类本来就是毫秒级的 SQL 汇总，没理由让面板卡片必须等定时任务落过至少一次快照才有数字——`video_cache` 因为只能靠扫存储算、成本跟清理任务本身相当，继续用"最新一次清理快照"，前端卡片标注"上次清理后"。**"概览数字"和"趋势线"因此拆成两个独立的空状态判断**：没有历史快照时趋势图区域显示"还没有数据"，但概览卡片（除 `video_cache` 外）照常显示实时数字，不会互相卡住。
- **磁盘剩余空间已落地（仅 Local 后端）**：`GET /admin/ops/storage-snapshots` 响应里带一个 `disk` 字段，`app.core.config.get_settings().storage.backend == "oss"` 时直接返回 `null`（OSS 是按量计费的对象存储，没有"盘满"概念，硬展示一个数字反而误导）；Local 后端用 `shutil.disk_usage()` 拿 `total/used/free`，前端超过 85% 用量时卡片变警告色。
- **定时任务时间统一从 0 点起跑**：`attachment_draft_gc` 0:00 → `attachment_safety_net` 0:30 → `video_cache_gc` 1:00 → `storage_usage_snapshot` 1:15，保留原来的错峰间隔，只是整体前移，不再用 4~5 点这个随意选的起点。
- **3.2 节的"扫存储成本较高"三类（`.agent/`/`.thumbs/`/`avatars/`）和"未分类兜底桶"暂未实现，但已经测过要不要做增量扫描**：在 devserver 上实测 `list_keys()` 全量扫描——当前 **1252 个对象，耗时 0.076 秒**。这个量级下全量扫描本身几乎零成本，"增量/差异扫描"是在解决一个目前不存在的性能问题，暂不做；如果对象总数以后涨到百万级（尤其是切到 OSS 之后，每次 LIST API 调用有实际次数成本），再回来做"高水位时间戳、只处理新对象"这类增量方案，或者引入 OSS 的 Object Inventory（存储清单）功能。
  - 顺带发现：用"路径前缀匹配"粗判"未分类"对象并不可靠——测试脚本简单按 `.chat_staging/`/`.voice/`/`.video_cache/`/`.agent/`/`.thumbs/`/`avatars/` 这几个特殊前缀过滤，剩下约 263 个"未匹配"对象，但这些其实绝大部分是用户文件库的正常文件（`files.storage_key` 记录着，只是路径不在任何"特殊前缀"下）。真正实现"未分类兜底桶"时，必须拿全量 `list_keys()` 结果去掉「能在 `files.storage_key` 或 `chat_attachments.storage_key` 里查到」的部分，而不是只做字符串前缀匹配，否则会把正常的用户文件库内容误报成"未分类"。
- **操作型指标（清理任务战果、安全网异常趋势，见 3.3 节）暂未实现**——同样是后续可以复用同一张表或新增一张 `job_run_stats` 表的增量工作，不阻塞当前这版上线。

## 1. 定位

新建一个独立的"存储监控"页面，跟「存储对账」并列，不是它的子功能：

| | 存储对账（已有） | 存储监控（本设计） |
|---|---|---|
| 关注点 | 一致性：DB 记录和物理对象对不对得上 | 用量：占了多少、涨得快不快 |
| 触发方式 | 点按钮现扫现查 | 定时任务算好，面板读缓存结果，画趋势图 |
| 典型问题 | "有没有幽灵记录/孤儿文件" | "存储是不是快满了、哪类东西涨得最快" |

## 2. 现状：没有统一的用量视角

现有的"用量"计算只覆盖用户文件库这一类，而且是请求时临时算的，不是持久化指标：

```python
# app/services/files/upload.py：只在上传时为了判断配额才算一次
select(func.sum(File.size_bytes)).where(File.user_id == user_id)
```

`.chat_staging/`、`.voice/`、`.video_cache/`、`.agent/`（记忆）、`.thumbs/`（缩略图）、`avatars/`（头像）——这些完全没有任何统一的用量指标，出了问题（比如某类静默膨胀）只能等磁盘快满了才会被发现。

## 3. 放哪些数据：全面但不碰隐私

**原则**：只展示聚合数字（数量、字节数、趋势），不展示任何能定位到具体用户在存什么内容的信息（文件名、缩略图、用户名和其存储量的对应关系）——那类需求属于「存储对账」现有的幽灵/孤儿排查场景，不该出现在这个面板里。

### 3.1 能直接用现有 DB 列算、零额外扫描成本

这几类都已经有汇总列，一条 `SUM()` SQL 秒出结果，不需要碰存储层：

- **用户文件库总量**：`SUM(files.size_bytes)`（可选按 space/project 再拆一层，但不落到具体文件）
- **聊天附件总量，按状态拆分**：`SUM(chat_attachments.size) GROUP BY state`——这个特别有价值：**草稿态占用 vs 已发送占用分开看**，能直接反映草稿孤儿清理任务是不是真的在起作用（如果"草稿占用"曲线只涨不跌，说明清理任务可能挂了）
- **视频转码缓存总量**：已经在做（`video_cache_snapshots`）

### 3.2 得靠定时任务扫存储才能算、有成本

这几类完全没有 DB 记录能对应实际字节数，只能 `list_keys()` + `stat()` 扫一遍——不能放进用户请求路径实时算，必须走定时任务算好、存进快照表：

- `.agent/`（AI 记忆存储）
- `.thumbs/`（缩略图缓存）
- `avatars/`（用户头像）
- **"未分类/其他"桶**：所有不匹配以上任何已知前缀的对象——这一项很重要，是"有没有新的泄漏类型我们还不知道"的兜底信号，没有这一项，总量对不上时会很难查

### 3.3 趋势与健康信号（比单纯的当前用量更有价值）

- **总占用趋势**（所有类别加总，一条线）+ **分类别趋势**（每类一条线，能看出"最近涨得快的是哪一类"）
- **对象数趋势**（不只是字节数——"很多小文件"和"几个大文件"是不同的问题信号）
- **清理任务的"战果"趋势**：`attachment_gc`/`video_cache_gc` 每次跑返回的删除数量，如果也存进快照表，能画出"每晚清理了多少"这条线——这条线如果突然归零，往往意味着清理任务本身挂了，是很好的健康监控信号，而不是等存储真的涨满了才发现
- **安全网发现的 integrity violation 数量趋势**（Phase A 已经在算，只是目前只写诊断日志+`SystemLog`，没有存进可视化的时间序列）——这是"有没有数据丢失事故正在发生"的信号，同样值得画成趋势而不是只靠人工翻日志
- **磁盘剩余空间**（仅当 storage backend 是 Local 时才有意义；OSS 是对象存储没有"盘满"概念）——这是最终极的"还能撑多久"问题，跟前面的分类用量放在一起看才完整：应用层看到"占用在涨"，磁盘层看到"还剩多少"，两者结合才能回答"要不要现在处理"

### 3.4 刻意不做的

- 不展示任何用户的具体存储量排行/画像（哪怕匿名化）——这类"谁占用最多"的分析，如果将来真有配额滥用排查的需求，应该做成一个单独的、访问受限更严格的工具，不放进面向"整体健康度"的常规监控面板里，避免功能定位混淆。
- 不展示文件名/内容/缩略图——这是「存储对账」幽灵/孤儿排查场景的职责，不重复。

## 4. 架构建议：一张通用快照表，不是每类一张

现在已经有 `video_cache_snapshots(id, taken_at, object_count, total_bytes)`，如果照搬这个模式给每个类别各建一张表，以后每加一类监控就要加一次表+migration。建议现在就重构成通用表：

```
storage_category_snapshots(
    id, category (varchar), taken_at, object_count, total_bytes
)
```

`category` 取值如 `video_cache` / `chat_staging_draft` / `chat_staging_attached` / `agent_memory` / `thumbs` / `avatars` / `uncategorized`。所有类别共用同一张表、同一套写入函数、同一个前端查询接口（按 `category` 过滤或一次性拿全部类别画多条线）。`video_cache_snapshots` 现有数据做一次性迁移（写入时补上 `category='video_cache'`）。

清理任务的"战果"和安全网的"发现数量"这两类操作型指标，是否也塞进同一张表（比如 `category='attachment_gc_deleted'`、`category='safety_net_violations'`），还是单独一张 `job_run_stats` 表，需要再权衡——前者复用现成基础设施成本低，后者语义更清晰（"占用了多少"和"这次操作做了什么"本质是两种不同的指标类型，混进同一张表的 `category` 枚举里会让这张表的字段含义变得模糊：`object_count`/`total_bytes` 对操作型指标来说命名就不太贴切）。倾向于分开成两张表，具体等要实现的时候再定。

## 5. 待确认问题

- ~~"未分类/其他"桶的扫描成本~~ **已实测**：devserver 上 `list_keys()` 全量扫描 1252 个对象耗时 0.076 秒，当前量级下做增量扫描没有必要，见第 0 节。
- ~~磁盘剩余空间这个指标怎么取~~ **已定**：`shutil.disk_usage(cfg.storage.local_path)`，仅 Local 后端展示，OSS 返回 `null`，见第 0 节。
- 定时任务扫描频率：现在 `video_cache_gc`/`storage_usage_snapshot` 是每天一次，`.agent/`/`.thumbs/`/`avatars/`/"未分类兜底桶"这几类还没实现，要不要同样每天跑，还是可以更低频（比如每周），取决于这些类别的实际增长速度——目前没有数据支撑，等实现后先跑一段时间观察。
- "未分类兜底桶"的正确实现方式：不能只靠路径前缀匹配（见第 0 节踩到的坑），必须交叉排除 `files.storage_key`/`chat_attachments.storage_key` 这两个已知集合，具体用一次性拉全量 storage_key 集合做内存 set 差集，还是分批查 DB，等实现时再定（当前对象量级下一次性拉全量到内存完全没问题）。
