# 暂存附件孤儿清理与视频转码缓存 PRD

> 状态：🔲 待评估（Phase A 方案 v2 经两轮外部评审定稿：DB 状态机为所有权真相来源，Redis 降级为 cache/lock；Phase B 补充了 cache_key 正确性修复与并发锁；均未开始实现）
> 创建：2026-08-08
> 最近更新：2026-08-09
> 关联模块：`backend/app/core/chat_attach.py`、`backend/app/services/storage/__init__.py`、`backend/app/core/scheduler.py`、`backend/app/api/v1/agent.py`（`delete_session`、附件相关接口）、消息/会话数据模型
> 背景参考：PRD-LLM-3（`read_file` 视频理解重构）实现过程中，排查视频转码临时文件该放哪里时，顺带发现 `.chat_staging/`/`.voice/` 存储字节从未被真正清理过，是一个独立于视频功能、更早就存在的问题；两个问题的清理机制可以复用同一套"按物理年龄扫存储"基础设施，一并纳入本 PRD。

---

## 0. 实施状态

| 阶段 | 状态 | 说明 |
|---|---|---|
| Phase 0：问题排查 | ✅ 已完成 | 确认 `.chat_staging/`/`.voice/` 存储字节存在真实孤儿泄漏（见第 1 节），且 Redis 数据丢失（容器重建/无持久化）会让泄漏立刻大面积发生，不只是自然 7 天过期这一种触发方式。 |
| Phase 1：方案设计 v1（已推翻） | ❌ 已废弃 | 曾实现"定时扫存储、按物理 mtime 判断年龄，固定 7 天 TTL"的清理任务（commit `dece7584`），已 revert（commit `e63014a9`）。废弃原因见第 1.4 节：固定 TTL 会让长周期项目里、没有显式存进文件库的历史消息附件"失效"，这不是清理任务的 bug，是这个方案本身的产品语义就不对。 |
| Phase 1'：方案设计 v2（外部评审已定稿） | 🔲 设计中，待实施 | 核心从"附件生命周期绑定消息/会话"进一步收敛为"**DB 是所有权真相来源**"：附件在 DB 里走 `draft → attached → deleting` 状态机，Redis 完全降级为 cache/lock/加速，不再承担任何"这个对象还有没有主人"的判断责任——彻底堵住 Redis 丢失导致孤儿的路径（草稿阶段也不例外，之前 v2 草案漏了这一半）。经过两轮外部评审（含一次关键修正：安全网扫描的两种不一致要分开处理，不能互相当成同一种"清理"）。见第 1.3、2、5 节。 |
| Phase 2：视频转码缓存实施 | 🔲 待评估 | 方案不变（Redis 指针 + 命中续 TTL），见第 2.2（FR-STORAGE-1-2）、第 5 节 Phase B。 |

---

## 1. 背景与问题

### 1.1 `.chat_staging`/`.voice` 孤儿文件泄漏（已确认的真实 bug）

`chat_attach.py` 的暂存机制：

- `stage()`（L182）把附件字节永久写入存储（`storage.put(storage_key, data, ...)`），同时给**元数据**设置 Redis key，`ex=ttl`（普通附件 7 天，语音同）。
- **TTL 只挂在 Redis 元数据上，跟存储里的物理字节完全脱钩**——Redis key 过期只是那条记录消失，不会触发任何回调去删除对应的存储对象。
- `_save_uploaded_file`（`agent/tools/files.py:521` → `_save_one_attach`，L490）把暂存附件存进文件库时，是**读出字节再复制一份**到新位置（`storage.put(final_key, data, ...)`），从未删除 `.chat_staging/` 里的原始副本——即使用户已经明确保存了这个文件，暂存区那份拷贝依然永久留着。
- 唯一的清理入口 `clear_staged()`（`chat_attach.py:311`，挂在 `DELETE /api/v1/attachments`，前端手动触发）是靠 `scan_iter` 遍历 Redis 里**还没过期**的 key 来找到对应 storage_key 的——一旦 Redis key 已经过期，这条路径也看不到、删不掉那个孤儿对象了。

**净效果**：任何一条发给咕咕、没有被用户在 7 天内手动点"清除暂存"的附件（无论是否被 `save_uploaded_file`），字节都会永久留在存储里，没有任何自动机制清理。这是从 `chat_attach.py` 建立起就存在的静默泄漏，不是本次视频改动引入的。

### 1.2 Redis 数据丢失会让泄漏立刻大面积发生

`docker-compose.yml`（L31-39）的 Redis 服务用官方 `redis:7-alpine` 镜像，**没有挂载任何 volume**，也没有开 AOF。容器被重建（重新部署/宿主机重启/`docker-compose down && up`）时，容器内可写层连同任何 RDB 快照一起消失，Redis 起来是全新空实例。

这意味着：只要发生一次容器重建，**当时所有还在暂存期内的附件**（可能是几分钟前刚发的，远没到 7 天）会瞬间失去唯一的存在凭证（Redis 里那条带 storage_key 的元数据），效果跟"提前过期"完全一样——只是全量、瞬时发生，而不是逐渐累积。

**结论**：只要"这个存储对象还有没有主人"这件事完全依赖一个没有持久化保证的 Redis key，无论是自然过期还是 Redis 数据丢失，存储字节都会变成孤儿。清理机制不能依赖 Redis 状态作为判断依据。

### 1.3 固定 TTL 方案 v1 为什么被推翻：`.chat_staging` 不是"发送前的临时区"

v1 把 `.chat_staging/`/`.voice/` 当成纯粹的、发送后即可按固定期限丢弃的暂存区。但代码证明并非如此：

- `GET /agent/attachment/{attach_id}/thumb`、`/download`、`/preview-pdf`（`app/api/v1/agent.py:68-131`）专门用来在**刷新页面后重新渲染历史气泡里的图片/文件**——注释原话："刷新后历史气泡里用户发的图本来只有 attach_id（无 file_id、本地 objectURL 已丢）"。也就是说，只要用户没有显式 `save_uploaded_file` 把附件存进文件库，`.chat_staging/` 里的这份拷贝就是**这条历史消息唯一还能用的附件源**，不是"用完即弃"的中转。
- 这几个接口全部依赖 `get_meta()`，而 `get_meta` 读的是 Redis，TTL 固定 7 天（`chat_attach.py:6`）。
- 净效果：**任何一次周期超过 7 天才回来看的对话**，只要中间发过图片/文件又没有手动存进文件库，历史气泡里的附件必然打不开——这个问题在 v1 之前就已经存在（Redis 元数据 7 天后过期，`get_meta` 返回 None），v1 的存储层清理只是让"存储字节"也跟着 Redis 元数据的 7 天窗口一起消失，跟现有语义对齐，但没有解决、也不该在这个 PRD 范围内被误认为"解决了"这个更大的产品问题。

同时发现 `delete_session`（`app/api/v1/agent.py:356-366`）目前只是 `db.delete(session)`，同样是"删 DB 记录、不清对应存储字节"的模式——这跟 `.chat_staging` 的孤儿问题是同一类根因，适合放在一起重新设计。

**结论**：`.chat_staging` 里已经被某条消息引用的附件，生死应该跟着"引用它的消息/会话是否还在"走，而不是一个跟产品语义无关的固定时间窗口；固定 TTL 只应该用于"从未被任何消息引用"的真正草稿孤儿。

**进一步收敛（第二轮评审）**：只把"已发送附件"挪出 Redis 还不够——草稿阶段本身也有同样的 race：`storage.put()` 写完字节、Redis 元数据还没写成功（或写成功后 Redis 数据丢失）之间的窗口，这个存储对象同样是"无主"的，跟 1.2 节说的问题是同一个根因，只是发生在更早的阶段。既然要解决就该解决彻底：**草稿阶段的元数据也应该以 DB 为准**，Redis 只保留 cache/加速/锁的角色，不再承担任何"这个对象是否有主人"的判断。具体状态机见第 2 节 FR-STORAGE-1-1。

### 1.4 附件是否存在跨消息复用（`quoted` 语义排查）

排查是否需要 `message:attachment` 多对多关系（而不是简单的 `message_id` 外键），关键问题是："删除原始消息/会话后，其他消息是否仍要求独立访问同一个 storage 对象？" 现状排查结论：**不需要**。

附件 meta 里的 `quoted` 字段（`chat_attach.py:851`）出现在 IM 网关代码（`agent/im/media_ingress.py:178`、`agent/gateway/qq.py:247`）——用户在微信/QQ 里引用回复一条带媒体的历史消息时，网关会把被引用消息里的媒体**重新下载、重新 `stage()` 成一个全新的附件**（新 `attach_id`、新 `storage_key`），只是打上 `extra["quoted"]=True` 标记用于前端展示"这条来自引用"。全代码库里没有任何一处"一个 `attach_id`/`storage_key` 被两条消息共同引用"的场景，每条消息的附件都是独立 stage 出来的。

**结论**：坚持简单的 `chat_attachments.message_id` 外键（一条附件属于一条消息），不引入 `message_attachments` 多对多关系表——没有已确认的复用需求，不为假设的未来场景（转发/消息复制/多消息引用）提前设计。

### 1.5 视频转码缓存（新增能力，非 bug）

PRD-LLM-3 的 `prepare_video_media()`（`chat_attach.py`）每次调用都会重新探测（ffprobe）+ 转码（ffmpeg）视频——`read_file` 场景下，用户可能反复让咕咕"再看一遍"同一个视频，每次都要重新跑一次可能耗时数十秒的转码，纯粹浪费 CPU 和等待时间。目标是把转码结果缓存下来，按 `storage_key` 命中直接复用。

---

## 2. 功能需求

### FR-STORAGE-1-1：附件所有权状态机（DB 为真相来源），Redis 降级为 cache/lock（🔲 设计中，v2 定稿）

**核心模型**：附件在 DB 里有一个显式状态机，DB 记录决定"这个存储对象是否还有主人"；Redis 完全不参与所有权判断，只用来加速查找/命中缓存/加分布式锁。

```
UPLOAD ──▶ chat_attachment(state=DRAFT)
              │
       消息发送成功 / claim
              │
              ▼
          ATTACHED ──（消息/会话所在，永久保留，不设 TTL）
              │
       消息/会话被删除
              │
              ▼
          DELETING（DB 事务内标记）
              │
       DB commit 成功
              │
              ▼
       best-effort storage.delete()（失败不影响 DB 状态，留给安全网兜底）
              │
              ▼
       元数据行清理
```

DRAFT 状态超过短 TTL（未被 claim）→ 草稿孤儿清理直接删。

1. **数据模型**：新建 `chat_attachments` 表（`id`/`attach_id`/`user_id`/`message_id`（可空，DRAFT 阶段为空）/`storage_key`/`name`/`ext`/`mime`/`kind`/`size`/`duration`/`img_width`/`img_height`/`state`/`created_at`/`attached_at`）。`message_id` 用简单外键，不做多对多关系表——理由见第 1.4 节的 `quoted` 排查结论（现状不存在附件跨消息复用）。
2. **上传即写 DB，不再只写 Redis**：`stage()` 时机改为 `storage.put()` 成功后立刻 `INSERT chat_attachments(state=DRAFT)`，Redis 只作为可选的快速查找缓存（可以直接不设，DB 查询本来就够快）。这一步彻底堵住"storage.put 成功、Redis 还没写/丢了"这个窗口——之前的 v2 草案只解决了"已发送"半场，这里补齐"草稿"半场。
3. **发送成功 = claim**：消息真正持久化时，把关联的 `chat_attachments` 行从 `DRAFT` 原子地转成 `ATTACHED`（`WHERE state='draft' AND attach_id=... AND user_id=...`，带条件更新防止竞态），同时写 `message_id`。转成 `ATTACHED` 之后，这条附件不再有任何 TTL，永久保留直到所属消息/会话被删除。
4. **`/thumb`、`/download`、`/preview-pdf`（`app/api/v1/agent.py:68-142`）改为直接查 DB**，**查询必须带 `user_id`**（`WHERE attach_id=? AND user_id=?`，不能只按 `attach_id` 查——否则是新引入的 IDOR，之前设计里漏了这条）。Redis 命中时可以走缓存快路径，未命中一律回退 DB，不存在"彻底找不到"的情况（只要 DB 记录还在）。
5. **会话/消息删除：DB commit 优先于 storage 删除，不假装成一个事务**：`delete_session`（`app/api/v1/agent.py:356`）目前只 `db.delete(session)`。改造后：① 一个 DB 事务内，删除 session 的同时把关联 `chat_attachments` 标记 `DELETING`（或直接级联删除行，取决于要不要保留审计痕迹）；② **DB 事务 commit 成功之后**，再 best-effort 对每个 `storage_key` 调 `storage.delete()`；③ storage 删除失败只记日志，不回滚 DB、不重试阻塞主流程——**原则：宁可临时泄漏，不可误删**（storage 先删、DB 后失败回滚，会导致"消息还在、附件没了"，这是真正的数据丢失，比孤儿字节严重得多）。步骤 7 的安全网负责兜住 storage 删除失败留下的孤儿。
6. **草稿孤儿定时清理**：扫描 `chat_attachments WHERE state='draft' AND created_at < now() - ttl`（**DB 驱动，不再需要"扫 storage → 反查 DB"这种绕路**），对每条命中记录做 `storage.delete()` + 删 DB 行。TTL 建议缩短到 24-48 小时（草稿本来就是"发出去之前"的中间态，见第 4 节）。
7. **发送失败/放弃时的及时清理（状态守卫，不是"失败就删"）**：新增按 `attach_id` 删除单个草稿附件的接口，**删除前必须校验 `state == 'draft'`，非 DRAFT 一律拒绝**——这是必须的安全条件：HTTP 响应丢失/超时不等于请求真的失败，消息可能已经在服务端提交成功、附件已经被 claim 成 `ATTACHED`；如果没有这层状态守卫，客户端一次误判的"发送失败"会把已经生效的正常附件删掉。前端在发送请求失败时调用；覆盖不了"上传后直接关标签页/崩溃/断网"这类无信号场景，仍需要步骤 6 的定时兜底，这里只是降低草稿孤儿产生速度的锦上添花，不是主机制。
8. **安全网：低频全量一致性扫描**，DB 与 storage 交叉检查，**两种不一致必须区别处理，不能用同一套"清理"逻辑**：
   - **DB 有记录（非 DRAFT）+ storage 对象缺失** → **完整性异常（integrity violation）**，只记录 error/metric/告警，**不做自动修复、不删除 DB 记录**——这种情况意味着 storage 被误删/损坏/人工误操作/删除顺序出错，是真实的数据丢失，自动"顺手清理掉 DB 记录"等于把这个事故悄悄掩盖掉。
   - **DB 无记录（或已删除）+ storage 对象存在** → **孤儿候选**，满足年龄/路径前缀等安全条件后允许清理（这是步骤 5 storage 删除失败、或早期历史数据的兜底路径）。
   - 频率建议低（如每周一次），大阈值（如 90 天），本质是 eventual consistency 的最后一道防线，不是主清理路径。
- **组织方式（约束，不规定具体文件）**：草稿清理、安全网扫描、（Phase B 的）视频缓存清理是三种不同生命周期策略（状态驱动 / 消息生命周期驱动 / 租约驱动），清理逻辑应按语义独立组织，不应该塞进一个按路径前缀 if-elif 堆叠多套判断的扫描函数里；可以共享底层 `list_keys`/`stat`/`delete`/锁/调度基础设施。
- 并发保护：沿用 `agent/memory` scope 锁的模式（Redis 分布式锁），防止 backend/worker 同时触发同一扫描。
- 验收标准：一条 30 天前发送、且没有被 `save_uploaded_file` 存进文件库的消息，只要所属会话没被删除，历史气泡里的图片/文件仍能正常加载（哪怕 Redis 整体清空）；会话被删除后，DB commit 成功即视为删除生效，对应存储字节尽力清理，清理失败由安全网兜底，不阻塞会话删除本身。

### FR-STORAGE-1-2：视频转码结果缓存，读时刷新 TTL（🔲 待评估）

- **`cache_key` 必须包含转码 profile 和版本号，不能只用 `storage_key`**（第一轮方案的正确性 bug）：`prepare_video_media(raw, mime, name, model_cfg)` 的转码结果实际上由 `model_cfg`（不同模型的分辨率/码率/体积上限不同）和转码参数本身（codec/CRF/分辨率策略）共同决定，同一个 `storage_key` 换一个模型读、或者以后调整 ffmpeg 参数，产出的文件是不一样的——只用 `storage_key` 当 key 会命中错误的旧缓存。改为：
  ```
  cache_key = sha256(storage_key + transcode_profile + CACHE_VERSION)
  ```
  `transcode_profile` 是从 `model_cfg` 派生的、影响转码结果的关键字段（如目标分辨率上限/码率上限/编码器），`CACHE_VERSION`（如 `"video-v1"`）是一个硬编码常量，以后升级转码算法/参数时改这个常量即可让所有旧缓存自然失效（不需要手动清），等安全网/租约过期自动回收。
- 转码产物写入存储的路径由 `cache_key` 确定性推导（如 `{uid}/.video_cache/{cache_key}.mp4`），**不需要经过 Redis 指针查找**——路径本身就是可计算的。
- **Redis 只承担"最近是否仍活跃"这一个语义，不承担查找职责**：`video_cache_alive:{uid}:{cache_key} = 1`，`ex=ttl`，命中时 `EXPIRE` 刷新。`prepare_video_media()` 先按公式算出 `cache_key`，直接尝试 `storage.get(cached_path)`；能读到就是缓存命中（同时刷新 alive marker 的 TTL），读不到（文件不存在，或者存在但 alive marker 已经过期被安全网清理）就重新转码、覆盖写入、重置 alive marker。这样即使 Redis 整体丢失，最多导致"缓存被安全网提前当孤儿清理、下次多转码一次"，不会影响正确性——这正是缓存该有的性质：随时全部丢掉也不影响业务正确性，跟 FR-STORAGE-1-1 里"DB 是所有权真相来源、绝不能丢"的附件语义形成对比。
- **并发多个请求命中同一视频同一 cache_key 时需要 single-flight 锁**：真实场景（同一会话里连续问同一个视频的问题）会触发多个并发请求同时未命中缓存，各自起一个 ffmpeg 转码同一个大文件，浪费 CPU/内存。改为：查缓存未命中 → 用 `video_cache_lock:{cache_key}`（同 `agent/memory` scope 锁模式）尝试加锁 → 加锁成功后**再查一次缓存**（double-check，防止等锁的时候前一个请求已经转码完）→ 仍未命中才真正转码 → 写缓存 → 释放锁；等锁的请求锁释放后同样先查缓存命中就直接用。
- 缓存产物本身的清理复用第 2 节 FR-STORAGE-1-1 里的组织约束，作为独立的"租约驱动"清理策略：物理年龄扫描 `.video_cache/`，删除前检查对应 alive marker 是否存在且未过期，存在则跳过（marker 不存在 或 已过期，正常按物理年龄清理）。
- 验收标准：同一视频、同一 `model_cfg`（`storage_key` 不变）第二次 `read_file` 应命中缓存、不重新调用 `_probe_video`/`_compress_video`；`storage_key` 变化或 `model_cfg` 对应的 transcode profile 变化都不会命中旧缓存；并发多个请求读同一视频时 `_compress_video` 只应该被真正调用一次。

---

## 3. 非目标

- **不做"重启时清理"**：backend/worker 重启是正常运维操作（发布、扩缩容、崩溃自动拉起），绝大多数情况下 Redis 数据是好的、暂存附件仍然有效；如果重启触发无条件清理，会把用户几分钟前刚发、还没来得及保存的正常附件误删，是比现有孤儿泄漏更严重的数据丢失。清理必须是时间驱动（定时任务），不能跟进程生命周期绑定。
- **不做真正的"双向校验"**（反向检查 Redis 元数据指向的存储对象是否还在）：这种不一致（Redis 说有、存储没有）概率低，且现有代码已经优雅处理——`read_bytes` 读不到会抛异常，调用方已包 try/except 返回友好错误，不构成资源泄漏，不值得为此新增校验逻辑。FR-STORAGE-1-2 里视频缓存的"检查 Redis 指针是否存在"是例外，因为那里的 Redis 指针本身会被主动续期，需要靠它判断"是否仍在使用"，跟这里说的"双向校验"目的不同。
- **不做"访问延寿"**：附件生死跟消息/会话是否存在绑定，不跟"最近有没有被读取/查看"绑定——一条附件哪怕从没被再打开过，只要所属消息/会话还在，就应该一直可用；这跟视频转码缓存"常访问就续命"是完全不同的语义，不要混淆（缓存的目的是省计算，附件的目的是让历史消息保持可用）。
- **不做上下文窗口驱动的清理**：附件生命周期不跟模型上下文窗口（滑动窗口/摘要裁剪）绑定——上下文裁剪是"喂给模型看什么"的问题，不代表这条历史消息对用户不重要了；如果按上下文窗口清理，附件失效速度会比现在的固定 7 天还快，是明确要避免的方向。
- **不搭建 Redis 持久化**（AOF/RDB volume 挂载）：这属于基础设施配置变更，超出本 PRD 范围；即使做了 Redis 持久化，FR-STORAGE-1-1 的清理任务仍然需要（自然过期这条路径始终存在，跟 Redis 是否持久化无关）。
- **不引入 `message_attachments` 多对多关系表**：见第 1.4 节排查结论，现状不存在附件跨消息复用的场景，`chat_attachments.message_id` 简单外键足够表达当前的产品事实；转发/消息复制/多消息引用等假设中的未来需求不在本 PRD 设计范围内，出现真实需求时再评估。
- **不假装 DB 和 storage 之间存在事务**：`delete_session` 的级联清理明确是"DB commit 优先、storage 删除是尽力而为的 eventual consistency"，不会去做分布式事务/两阶段提交这类基础设施；storage 删除失败只留给安全网扫描兜底，不阻塞、不重试、不回滚 DB。

---

## 4. 待确认问题

- **`chat_attachments` 表跟现有消息模型怎么关联**：需要先读 `ConversationMessage`（或对应模型）现在怎么持久化 `attachments` 字段（只是 attach_id 列表，还是已经带完整 meta），确定新表要新建成什么样、要不要跟现有字段做一次性数据迁移。
- **草稿 TTL 具体取多久**：建议 24-48 小时（草稿是"发出去之前"的中间态，不该是天级别），具体数值待定。
- **安全网扫描的频率和阈值**：草案给的是"每周一次、90 天阈值"，是否合适取决于步骤 5（会话删除级联清理）本身的可靠性——观察一段时间、看孤儿候选和完整性异常各自的实际发生频率再调整。
- **完整性异常（DB 有记录、storage 缺失）触发后具体怎么响应**：PRD 只定了"记录 error/metric/告警、不自动删 DB 记录"，具体接到哪个监控渠道、要不要人工介入的 SOP，留到实现阶段再定。
- 视频转码缓存 alive marker 的 TTL 具体取多久：建议先跟附件 ATTACHED 前的草稿 TTL 参考值对齐或单独定，上线观察实际命中率和存储占用再调整。
- `.video_cache/` 的转码产物是否需要按用户设置存储配额上限（防止极端情况下缓存本身占用过多空间）？本 PRD 暂不引入，后续如有需要再评估。

---

## 5. 实施计划

拆两个独立 PR：Phase A（清理任务）不依赖 Phase B（转码缓存），可以先落地、单独上线验证；Phase B 落地时复用 Phase A 已经跑通的清理任务，只是把 `.video_cache/` 加进扫描前缀。

### Phase A：附件所有权状态机（对应 FR-STORAGE-1-1 v2 定稿）

> v1（定时按物理 mtime 扫描 + 固定 TTL）已实现过一次并 revert（commit `dece7584` → `e63014a9`），原因见第 1.3 节。以下是经两轮外部评审收敛后的方案，落地前建议先把第 4 节"`chat_attachments` 表跟现有消息模型怎么关联"定下来。

1. **先确认现状**：读 `ConversationMessage`（或实际的消息模型）现在怎么持久化 `attachments` 字段——是完整 meta 快照，还是只有 attach_id 列表、依赖运行时再查 Redis 补全。
2. **新增 `chat_attachments` 表**（`id`、`attach_id`、`user_id`、`message_id` 可空、`storage_key`、`name`、`ext`、`mime`、`kind`、`size`、`duration`、`img_width`、`img_height`、`state`（`draft`/`attached`/`deleting`）、`created_at`、`attached_at`）。简单 `message_id` 外键，不做多对多（见第 1.4 节）。
3. **`stage()` 改为直接写 DB**：`storage.put()` 成功后立刻 `INSERT chat_attachments(state=draft)`，不再依赖 Redis 作为草稿期间唯一的所有权凭证；Redis 之后只作为可选查找缓存。
4. **发送成功时原子 claim**：`resolve_for_message` 产生的消息真正持久化时，对每个关联 `attach_id` 执行条件更新 `UPDATE chat_attachments SET state='attached', message_id=? WHERE attach_id=? AND user_id=? AND state='draft'`，claim 之后不再有任何 TTL。
5. **`/thumb`、`/download`、`/preview-pdf`（`app/api/v1/agent.py:68-142`）改为查 DB 为主**：查询必须带 `WHERE attach_id=? AND user_id=?`（禁止只按 `attach_id` 查，避免 IDOR）；Redis 可选做查找加速，未命中/不存在都回退 DB。
6. **`delete_session`（`app/api/v1/agent.py:356`）改为「DB 优先、storage 尽力而为」两阶段**：① 一个事务内删除 session、级联标记/删除关联 `chat_attachments` 行；② 事务 commit 成功后再逐个 best-effort `storage.delete()`，失败只记日志不回滚不阻塞、留给步骤 8 的安全网兜底。
7. **草稿孤儿定时清理**：直接查 `chat_attachments WHERE state='draft' AND created_at < now() - ttl`（DB 驱动，不需要"扫 storage 再反查 DB"），命中即 `storage.delete()` + 删行。
8. **发送失败时的状态守卫删除**：新增按 `attach_id` 删除单个草稿附件的接口，**删除前必须校验 `state='draft'`**，非 DRAFT 直接拒绝（防止 HTTP 响应丢失导致的误判把已生效附件删掉）；前端发送失败时调用。仅为优化，步骤 7 的定时兜底仍是主机制。
9. **安全网扫描**（低频、大阈值，如每周一次/90 天）：DB 与 storage 交叉检查，**两种不一致分别处理**——`DB 有记录（非 draft）+ storage 缺失` 记录为 integrity violation（告警，不自动删 DB 记录）；`DB 无记录 + storage 存在（非最近写入）` 才是孤儿候选，允许清理。
10. **组织约束**：草稿清理 / 安全网扫描 / （Phase B）视频缓存清理三种不同生命周期策略，按语义独立组织实现，不塞进一个按路径前缀分支的扫描函数；可共享底层 `list_keys`/`stat`/`delete`/锁的基础设施。
11. **并发保护**：沿用 `agent/memory` scope 锁的模式。
12. **测试**（新增 `tests/test_staging_gc.py`、`chat_attachments` 状态机相关的模型/服务测试、`delete_session` 级联清理的集成测试、单个附件删除接口的状态守卫测试）：见第 6.1 节。
13. **上线验证**：见第 6.2 节。

### Phase B：视频转码结果缓存（对应 FR-STORAGE-1-2）

1. **`app/core/chat_attach.py` 新增缓存 helper**（紧邻 `prepare_video_media`）：
   - `_video_transcode_profile(model_cfg) -> dict`：从 `model_cfg` 派生影响转码结果的关键字段（目标分辨率上限/码率上限/编码器等）。
   - `_video_cache_key(storage_key: str, profile: dict) -> str`：`hashlib.sha256((storage_key + json.dumps(profile, sort_keys=True) + CACHE_VERSION).encode()).hexdigest()`，`CACHE_VERSION` 定义成模块级常量（如 `"video-v1"`）。
   - `_video_cache_alive_key(uid, cache_key) -> str`：如 `f"video_cache_alive:{uid}:{cache_key}"`。
2. **`prepare_video_media()` 改造**（新增可选参数 `storage_key: str | None = None`、`user_id: str | None = None`，两者都传才启用缓存；`resolve_for_message`/`read_video` 两个调用方都能传，聊天附件路径 `attach_id` 每次不同、天然没有稳定 key，可以先只给 `read_video` 接）：
   - 算出 `cache_key`，直接尝试 `storage.get({uid}/.video_cache/{cache_key}.mp4)`；能读到就是命中，跳过探测+转码，同时 `EXPIRE` 刷新 alive marker TTL。
   - 未命中（文件不存在，包括被安全网清理的情况）→ 先用 `video_cache_lock:{cache_key}` 加锁（`agent/memory` scope 锁模式）→ 加锁后 **double-check 再读一次缓存**（防止等锁期间前一个请求已经转码完）→ 仍未命中才真正探测+转码 → 转码成功后 `put` 到缓存路径、`SET` alive marker（`ex=ttl`）→ 释放锁。
3. **`agent/tools/file_readers.py` 的 `read_video`**：调用 `prepare_video_media` 时补上 `storage_key=file.storage_key, user_id=file.user_id`。
4. **Phase A 组织约束下的视频缓存清理**（独立的租约驱动清理逻辑，不塞进草稿/安全网清理里）：扫描 `.video_cache/`，删除前查一次对应 alive marker（`GET`，不 `EXPIRE`），marker 存在则跳过；marker 不存在或已过期则按物理年龄正常清理。
5. **测试**：
   - `prepare_video_media` 缓存命中：mock `_compress_video`/`_probe_video`，第一次调用产生缓存，第二次调用同一 `storage_key`+`model_cfg` 断言没有再调 `_probe_video`/`_compress_video`。
   - `storage_key` 变化、或 `model_cfg` 对应 transcode profile 变化（同 `storage_key`），都不命中旧缓存。
   - 命中缓存时对应 alive marker 的 TTL 被刷新。
   - 并发两个请求同时读同一个未缓存视频：mock `_compress_video` 断言只被调用一次（single-flight 锁生效）。
   - alive marker 存在但物理缓存文件不存在（如被外部误删）：`prepare_video_media` 应该自动重新转码，而不是直接报错或返回损坏结果；成功后重建 marker。
   - 视频缓存清理对 `.video_cache/` 的行为：alive marker 还在且未过期时，物理 mtime 超期的缓存对象**不删**；marker 不存在（或已过期）时按物理年龄正常清理。
6. **上线验证**：devserver 上让咕咕连续两次读同一个视频，通过日志或手动查 Redis（`GET video_cache_alive:<uid>:<cache_key>`）确认第二次命中缓存、没有再触发 ffmpeg 转码。

---

## 6. 测试目标

### 6.1 自动化测试

**Phase A**：

- [ ] 消息发送成功时，关联的 `chat_attachments` 行原子地从 `draft` 转成 `attached`，`message_id` 正确写入。
- [ ] `/thumb`、`/download`、`/preview-pdf`：Redis 未命中/不存在时，能从 DB 正确回退拿到 meta 并返回内容（模拟"7 天后再打开历史消息"场景）；查询必须带 `user_id` 过滤——用另一个用户的身份查同一个 `attach_id` 应该拿不到（IDOR 回归测试）。
- [ ] `delete_session`：会话下有 2 条消息各引用 1 个附件，删除会话后，两个附件的存储对象和 `chat_attachments` 行都应该消失；不属于这个会话的附件不受影响。
- [ ] 草稿孤儿清理：`state='draft'` 且超过草稿 TTL 的行会被清理（含存储对象）；`state='attached'` 的行即使物理 mtime 同样很老也**不会**被草稿清理碰到。
- [ ] 单个附件删除接口的状态守卫：`state='draft'` 时删除成功，对应存储对象和 DB 行都消失；`state='attached'` 时删除请求应该被拒绝（不能因为前端误判"发送失败"就删掉已生效的附件）；删除一个不存在或不属于当前用户的 `attach_id` 应该返回明确错误而不是静默成功。
- [ ] **发送成功但 HTTP 响应丢失/超时的竞态**：模拟消息已经在服务端提交成功（附件已 claim 成 `attached`）之后，客户端仍然发出单附件删除请求——断言删除被拒绝，附件和存储对象都还在。
- [ ] **GC 扫描与发送 claim 同时发生的竞态**：草稿孤儿清理判断某条记录"超过 TTL、可以删"和消息发送把同一条记录 claim 成 `attached` 并发执行时，最终结果不能是"消息已经引用了一个被删掉的附件"（用条件更新/行锁保证互斥，测试断言两者不会同时成功）。
- [ ] **DB commit 失败时 storage 字节不能提前被删**：`delete_session` 的 DB 事务失败（模拟异常）时，不应该有任何 `storage.delete()` 被调用。
- [ ] **storage 删除失败不阻塞 session 删除**：`storage.delete()` 抛异常时，`delete_session` 本身仍应成功返回（DB 层面已完成），且这个失败应该能被后续安全网扫描识别为孤儿候选。
- [ ] 空存储 / 无草稿孤儿时清理任务正常返回 `0`，不报错；`stat()` 返回 `mtime=None` 时跳过不删。
- [ ] 并发保护：Redis 锁已被占用时清理任务直接返回、不执行任何删除。
- [ ] 安全网扫描：`DB 有记录（非 draft）+ storage 缺失` 应该被标记为 integrity violation（只告警，不清理、不删 DB 记录）；`DB 无记录 + storage 存在且非最近写入` 才作为孤儿候选允许清理——两种情况的处理动作必须不同，不能用同一段代码路径。

**Phase B（`tests/test_chat_attach_video.py` 补 `prepare_video_media` 缓存分支 + `test_staging_gc.py` 补 `.video_cache/` 分支）**：

- [ ] 首次调用 `prepare_video_media(..., storage_key=..., user_id=...)` 无缓存，正常走探测+转码，之后能在存储里读到 `.video_cache/{cache_key}.mp4` 和对应 alive marker。
- [ ] 同一 `storage_key`+同一 `model_cfg` 第二次调用命中缓存：mock `_probe_video`/`_compress_video` 断言**没有被调用**，直接返回上次的媒体项。
- [ ] 命中缓存时对应 alive marker 的 TTL 被刷新（断言 `EXPIRE` 被调用，或前后 `ttl()` 值变化）。
- [ ] `storage_key` 变化、或同 `storage_key` 但 `model_cfg` 对应 transcode profile 变化，都不命中旧缓存，重新走探测+转码。
- [ ] 未传 `storage_key`/`user_id`（聊天附件路径）完全不查/不写缓存，行为跟 Phase A 落地前一致（防止误伤现有聊天附件视频路径）。
- [ ] **并发 single-flight**：两个请求同时读同一个未缓存的视频（同 `storage_key`+`model_cfg`），mock `_compress_video` 断言**只被调用一次**，另一个请求应该等锁释放后直接读到缓存产物。
- [ ] **alive marker 存在但物理缓存文件已不存在**（模拟被外部/安全网误删）：`prepare_video_media` 应该自动判定未命中、重新转码，不应该报错或返回损坏内容；成功后重建 marker。
- [ ] 视频缓存清理对 `.video_cache/` 的行为：alive marker 还在且未过期时，物理 mtime 超期的缓存对象**不删**；marker 不存在（或已过期）时正常按物理年龄删除。

### 6.2 手动测试（devserver）

**Phase A 上线前**：

- [ ] 发一张图片给咕咕（正常发送，非草稿），刷新页面，确认气泡里的图片正常显示（走的是 DB 查询路径，不是靠 objectURL）。
- [ ] 手动把 Redis 整个 flush 掉（模拟容器重建/数据丢失），再刷新这条历史消息，确认图片依然正常显示（证明真的从 DB 拿到了 meta，跟 Redis 状态无关——包括草稿阶段刚上传、还没发送成功的附件也应该在 DB 里能查到）。
- [ ] 删除这条消息所在的整个会话，检查存储里对应的 storage_key 确实被删除了（不再残留孤儿字节），`chat_attachments` 表里对应行也应该消失。
- [ ] 上传一张图片但**不发送**（只调用暂存接口），等草稿 TTL 过期后跑一次清理任务，确认这个从未发送的草稿被清理掉了；再上传一张、正常发送、发送成功后手动改数据库把这张图的 mtime/created_at 改到 TTL 之外，确认它**不会**被草稿清理误删（因为已经是 `attached` 状态）。
- [ ] 挂上定时任务后，观察 `app/core/scheduler.py` 的启动日志确认相关 job 被正确注册。
- [ ] 观察一次真实的低峰自动运行（不手动触发），确认定时触发本身工作正常，不只是手动调用路径可用。

**Phase B 上线前**：

- [ ] 让咕咕读一个文件库里的视频（MiniMax M3 模型），记录这次转码耗时。
- [ ] 立刻再让咕咕读同一个视频，确认响应明显更快（跳过了转码），日志里能看到"缓存命中"相关记录（需要在实现里加一条诊断日志，比如 `diag_log_raw("chat_attach.video_cache_hit", ...)`）。
- [ ] 把这个视频文件重命名/覆盖上传替换内容后，再次读取，确认走的是全新转码（没有错误地命中旧缓存）。
- [ ] 手动查 Redis（`GET video_cache_alive:<uid>:<hash>`、`TTL ...`）确认命中后 TTL 确实被刷新，不是原地不动。
- [ ] 用一个超过 90MB 触发 mm_file 分支的视频重复上述流程，确认 mm_file 场景下缓存同样生效（不只是 base64 场景测过）。
- [ ] 观察一段时间后 `.video_cache/` 目录的存储占用增长趋势，判断第 4 节里悬而未决的"是否需要配额上限"问题是否需要提前处理。
