# 暂存附件孤儿清理与视频转码缓存 PRD

> 状态：✅ 已实现（Phase A/B 已完成代码和核心 devserver 验证；仍保留低频自动运行与长期存储趋势观察项）
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
| Phase 1'：方案设计 v3（已定稿） | ✅ 已完成 | 核心是"**DB 是所有权真相来源**"：`chat_attachments` 只有 `draft`/`attached` 两态（无 `DELETING` 中间态），Redis 完全降级为 legacy fallback/lock/cache，不承担任何"这个对象还有没有主人"的判断责任。物理删除统一收口成 `try_delete_storage_if_unreferenced(user_id, storage_key)`，删除前按 `storage_key` 检查引用（对应 PRD-IM-9 的共享 storage_key 场景）；消息创建与所有附件 claim 是同一个 DB 事务；GC/安全网一律"DB 先变化、再碰 storage"。经三轮外部评审收敛，第 2、5 节实施计划已完全同步。见第 1.3、2、5 节。 |
| Phase 2a：Phase A 实施 | ✅ 已完成 | `chat_attachments` 表 + migration；`try_delete_storage_if_unreferenced()`；`stage()`/`stage_sync()` 写 DB（插入失败回滚 storage）；`get_meta*`/`list_staged`/`clear_staged` 改 DB 优先 + Redis legacy fallback；`claim_attachments()` 接进网页/IM 全部三个消息落库入口（同事务、all-or-nothing）；`/thumb`/`download`/`preview-pdf` 走 DB 查询（IDOR 已由 `user_id` 过滤挡住）；`delete_session` 两阶段（DB 优先、显式删附件行不依赖 FK 级联、按引用计数删物理字节，含共享 storage_key 隔离）；新增单附件删除接口（状态守卫）；草稿 GC + 安全网两个定时任务（`app/core/attachment_gc.py`）；前端发送失败时调用清理。过程中顺手修了一个真实的跨事件循环 asyncpg bug（`app/db/session.py` 的 `ensure_engine()` 加了循环检测）。 |
| Phase 2b：Phase B 实施（视频转码缓存） | ✅ 已完成 | `_video_transcode_profile`/`_video_cache_key`/`_video_cache_path`/`_video_cache_alive_key` + `_compress_video_cached()`（single-flight 锁、命中 `SET ... EX` 续期、marker 丢失自愈）；`prepare_video_media()` 新增可选 `storage_key`/`user_id` 参数，`read_video()` 调用点已接入（聊天附件路径不接，行为不变）；独立的 `app/core/video_cache_gc.py` 租约驱动清理任务（跟 Phase A 的草稿 GC/安全网独立组织，只共享底层存储/锁基础设施）。代码和核心 devserver 流程已验证，长期增长趋势仍按第 6.2 节观察。 |

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

**后续更新（2026-08-09）**：针对"引用回复历史媒体会重新下载"这个观察做了可行性验证（实测 QQ，探针已删除），确认可以用平台给的稳定消息标识（QQ 的 `msg_idx`）避免重复下载，详见 [PRD-IM-9-引用消息附件复用](./PRD-IM-9-引用消息附件复用【已完成】.md)。**这不推翻上面"不做 M:N"的结论**——复用方式是"新消息拿到自己独立的 `chat_attachments` 行，只是 `storage_key` 跟原消息那行相同"，不是让两条消息共享同一条附件记录；但代价是安全网清理逻辑需要按 `storage_key` 做引用计数（是否还有其他存活行指着同一个 `storage_key`），不能再只看单条记录自己的归属，这一点需要同步进第 2 节 FR-STORAGE-1-1 的安全网扫描设计。

### 1.5 视频转码缓存（新增能力，非 bug）

PRD-LLM-3 的 `prepare_video_media()`（`chat_attach.py`）每次调用都会重新探测（ffprobe）+ 转码（ffmpeg）视频——`read_file` 场景下，用户可能反复让咕咕"再看一遍"同一个视频，每次都要重新跑一次可能耗时数十秒的转码，纯粹浪费 CPU 和等待时间。目标是把转码结果缓存下来，按 `storage_key` 命中直接复用。

---

## 2. 功能需求

### FR-STORAGE-1-1：附件所有权状态机（DB 为真相来源），Redis 降级为 cache/lock（🔲 设计中，v3 定稿）

**核心模型**：附件在 DB 里只有两个状态，DB 记录决定"这个存储对象是否还有主人"；Redis 完全不参与所有权判断，只用来加速查找/命中缓存/加分布式锁。

```
UPLOAD ──▶ chat_attachment(state=DRAFT)
              │
       消息发送成功 / claim（整条消息 + 所有附件同一个 DB 事务）
              │
              ▼
          ATTACHED ──（消息/会话所在，永久保留，不设 TTL）
              │
       消息/会话被删除：DB 事务内删除 chat_attachments 行 → commit
              │
              ▼
       commit 成功后，对每个 storage_key 尝试物理删除
       （先查是否还有其他存活行指着同一个 storage_key，见步骤 5）
```

**四条不变量，贯穿整个 Phase A，实施时不能违反**：
1. **DB 所有权变化必须先发生，storage 清理永远在 DB commit 之后**——不管是正常删除还是 GC，都是"先在 DB 里让这一行不再存在/不再是 draft，commit 成功，再碰物理字节"，反过来（先删 storage 再改 DB）会在 DB 操作失败时产生"消息还在、字节没了"这种真正的数据损坏，比孤儿泄漏严重得多。
2. **物理删除之前必须确认没有其他存活的 `chat_attachments` 行指着同一个 `storage_key`**——因为 PRD-IM-9（引用消息附件复用，已验证可行、不是假设需求）会让两条独立的消息各自持有一条 `chat_attachments` 行、但共享同一个 `storage_key`。不做这个检查，正常的 `delete_session` 就会删掉另一条还存活消息正在用的字节，安全网完全兜不住（字节已经真的没了）。
3. **消息创建和它所有附件的 claim 必须是同一个 DB 事务**——任何一个附件 claim 失败（`affected_rows != 1`，比如已经被其他请求 claim 走、或者已经被草稿 GC 删除），整条消息事务回滚，不允许出现"消息已存在但只有部分附件被 claim 成功"的半完整状态。
4. **"确认没有其他引用"和"真正删除物理字节"之间，不能有新的共享引用悄悄插进来**——不变量 2 的检查（`SELECT EXISTS ...`）和之后的 `storage.delete()` 本身不是原子的两步。如果 PRD-IM-9 那种"复用已有 `storage_key` 创建一条新附件行"的操作恰好插在这两步中间：先检查时确实没有别的引用了，但检查完、删除前，一个新请求刚好把这个 `storage_key` 复用出了一条新记录——物理字节被删的时候，新记录已经指向了一份不存在的文件。**这条不变量本身不由本 PRD 实现，但本 PRD 必须声明它，作为对 PRD-IM-9 的约束**：任何"读取一条已有 `chat_attachments` 行、复用它的 `storage_key` 建一条新行"的操作，必须保证从"读到源那一刻"到"新行成功 commit"之间，源那一行不会被并发删除掉——具体手段（`SELECT ... FOR UPDATE` 锁住源行、advisory lock、或者别的机制）留给 PRD-IM-9 实施时决定，不在本 PRD 展开；本 PRD 这边的责任是"不会在还有存活引用时删字节"，PRD-IM-9 那边的责任是"新增共享引用时不会让源引用在关键窗口内被删掉"，两边配合才能真正堵住。

**没有 `DELETING` 中间状态（初版草稿曾经设想过，评审后去掉）**：模型只有 `DRAFT`/`ATTACHED` 两态，不引入第三个状态。原因：如果保留 `DELETING`，安全网扫描要额外处理"DB 是 DELETING + storage 还在"（物理删除还没做/失败，需要重试）和"DB 是 DELETING + storage 没了"（物理删除成功但行清理没跑完，该 finalize）这两种新组合，状态机复杂度上升但咕咕现在的体量不需要这种精细的重试队列。改成更直接的语义：删除就是"DB 事务里直接删掉这一行，commit 成功即视为逻辑删除生效"，物理字节清理是 commit 之后的 best-effort 动作，失败了安全网自然能发现（DB 无记录 + storage 有 = 孤儿候选），不需要专门的中间状态来标记"正在删"。

1. **数据模型**：新建 `chat_attachments` 表（`id`/`attach_id`/`user_id`/`message_id`（可空，DRAFT 阶段为空）/`storage_key`/`name`/`ext`/`mime`/`kind`/`size`/`duration`/`img_width`/`img_height`/`state`（仅 `draft`/`attached`）/`created_at`/`attached_at`）。`message_id` 用简单外键，不做多对多关系表——理由见第 1.4 节的 `quoted` 排查结论；`storage_key` 可以被多条 `chat_attachments` 行共享（PRD-IM-9 场景），所以不能给 `storage_key` 加唯一约束。把现在已经确定的业务不变量压进 DB 约束，让实现 bug 尽量在写入时就被挡住，而不是等 GC/安全网才发现：
   - `UNIQUE(user_id, attach_id)`
   - `INDEX(state, created_at)`（草稿 GC 按状态+时间扫描用）
   - `INDEX(user_id, storage_key)`（不变量 2 的引用检查用）
   - `INDEX(message_id)`（`delete_session`/删消息级联用）
   - 应用层保证 `state='draft' ⇒ message_id IS NULL`、`state='attached' ⇒ message_id IS NOT NULL`（如果数据库支持 `CHECK` 约束就直接加上，不支持就在写入路径的条件更新里保证，不单独依赖应用代码"记得"维护这个关系）。
2. **上传写 storage 再写 DB，插入失败要回滚 storage**：`stage()` 改为 `storage.put()` 成功后立刻 `INSERT chat_attachments(state=draft)`；**新的 `stage()` 调用不再写旧的 Redis meta key**（这是跟"Redis 命中直接用"的旧快路径配套的改动，见步骤 4）。这一步移除了"Redis 丢失导致草稿附件失去所有权凭证"这条路径（之前的 v2 草案只解决了"已发送"半场，这里补齐"草稿"半场），但 `storage.put()` 和 `db.insert()` 仍然是两个系统、不是一个事务——如果 `insert` 失败（DB 异常/连接问题），要 best-effort 把刚写的字节删掉；**这是"物理删除只能走统一入口"这条规则唯一的例外**——此时 DB ownership 从未成功建立过，没有行可查、也没有其他引用需要担心，直接删就是安全的，不需要（也没法）套 `try_delete_storage_if_unreferenced()`。这个回滚本身也可能失败，届时留给安全网按"孤儿候选"兜底（DB 无记录 + storage 有 + 非最近写入）。措辞上不说"彻底堵住"，只说"消除了 Redis 丢失这条路径，跨系统提交的窗口仍然存在，靠尽力回滚 + 安全网兜底"。
3. **发送成功 = claim，整条消息一个事务**：消息真正持久化时，一个 DB 事务内，对每个关联 `attach_id` 执行条件更新 `UPDATE chat_attachments SET state='attached', message_id=? WHERE attach_id=? AND user_id=? AND state='draft'`；**任意一次更新的 `affected_rows != 1`，整个事务回滚**（消息本身也不落库）——不允许消息存在但只有部分附件 claim 成功的半完整状态。转成 `ATTACHED` 之后不再有 TTL，永久保留直到所属消息/会话被删除。
4. **`/thumb`、`/download`、`/preview-pdf`（`app/api/v1/agent.py:68-142`）永远先查 DB，不走"Redis 命中就直接用"的快路径**：`WHERE attach_id=? AND user_id=?`（不能只按 `attach_id` 查，否则是 IDOR）。DB 是所有权真相来源，如果查询顺序反过来（先信 Redis），会出现"DB 里这条附件已经被删除、但 Redis 里的旧 meta 还没过期"时继续把已经不该存在的内容返回给用户的 stale-cache 问题。**Redis 只在 DB 查不到时，作为过渡期的 legacy fallback**——服务上线前用旧 `stage()` 写过的 Redis meta key，仍然可能在过渡期内有效，DB 无记录时兜底查一次 Redis；因为步骤 2 已经改成新数据不再写这种旧格式的 key，这条 fallback 路径会随着旧 Redis key 自然过期而自动消失，不需要专门下线。
5. **物理删除统一收口成一个函数，不允许任何调用方直接 `storage.delete()`**（步骤 2 的插入失败回滚除外，见上）：`try_delete_storage_if_unreferenced(user_id, storage_key)`——先 `SELECT EXISTS(SELECT 1 FROM chat_attachments WHERE user_id=? AND storage_key=?)`（此时 DB 里那条要删的行已经不在了，只看"是否还有别的行存在"），存在就跳过物理删除（还有别的消息在用），不存在才真正 `storage.delete()`。`delete_session`、草稿 GC、单附件删除、安全网清理孤儿候选，全部必须通过这一个函数碰物理字节。**这个"检查再删除"本身不是原子的**，见上面第 4 条不变量——本 PRD 只保证这个函数自己的检查逻辑正确，"检查完之后、真正删除之前不会冒出新引用"这件事依赖调用方（尤其是 PRD-IM-9 那种创建共享引用的操作）配合。
6. **会话/消息删除：DB commit 优先于 storage 删除**：`delete_session`（`app/api/v1/agent.py:356`）目前只 `db.delete(session)`。改造后：① 一个 DB 事务内，删除 session 的同时**直接删除**关联的 `chat_attachments` 行（不标记中间状态，见上面"没有 DELETING"的说明）；② **DB 事务 commit 成功之后**，对每个涉及的 `storage_key` 调步骤 5 的 `try_delete_storage_if_unreferenced(user_id, storage_key)`；③ storage 删除失败只记日志，不回滚 DB、不重试阻塞主流程——**原则：宁可临时泄漏，不可误删**。步骤 9 的安全网负责兜住失败留下的孤儿。
7. **草稿孤儿定时清理，同样遵守"DB 先变化"**：不是"先 `storage.delete()` 再删 DB 行"，而是先用条件删除赢得 DB 所有权——`DELETE FROM chat_attachments WHERE attach_id=? AND state='draft' AND created_at < now() - 48h` 返回 `affected_rows=1` 才说明这一行真的被 GC 拿下了（如果这行此时已经被并发的发送请求 claim 成 `attached`，条件里的 `state='draft'` 不匹配，`affected_rows=0`，GC 直接跳过这一行，不会跟 claim 抢——这就是 GC-vs-claim 竞态的解法：谁先在 DB 层面改变这一行的状态，谁赢，另一方的操作天然是 no-op）；删除成功（`affected_rows=1`）之后才调 `try_delete_storage_if_unreferenced(user_id, storage_key)` 处理物理字节。TTL 定为 48 小时。
8. **发送失败/放弃时的及时清理（状态守卫，不是"失败就删"）**：新增按 `attach_id` 删除单个草稿附件的接口，**删除前必须校验 `state == 'draft'`，非 DRAFT 一律拒绝**（同样走"条件删除、`affected_rows` 判断成败"的模式，不是先查再删的两步）——这是必须的安全条件：HTTP 响应丢失/超时不等于请求真的失败，消息可能已经在服务端提交成功、附件已经被 claim 成 `ATTACHED`。前端在发送请求失败时调用；覆盖不了"上传后直接关标签页/崩溃/断网"这类无信号场景，仍需要步骤 7 的定时兜底，这里只是降低草稿孤儿产生速度的锦上添花，不是主机制。
9. **安全网：低频全量一致性扫描**，DB 与 storage 交叉检查，**两种不一致必须区别处理，不能用同一套"清理"逻辑**：
   - **DB 有记录 + storage 对象缺失** → **完整性异常（integrity violation）**，记录到受限诊断出口，**并补一条 `SystemLog`**（后台「系统日志」页可见，写入前必须过 `redact()`，不能把 `storage_key`/路径等原始信息直接暴露到这个用户可达的出口），**不做自动修复、不删除 DB 记录**——这种情况意味着 storage 被误删/损坏/人工误操作/删除顺序出错，是真实的数据丢失，自动"顺手清理掉 DB 记录"等于把这个事故悄悄掩盖掉。
   - **DB 无记录 + storage 对象存在（非最近写入）** → **孤儿候选**，清理前同样要走步骤 5 的 `try_delete_storage_if_unreferenced(user_id, storage_key)`（按 `storage_key` 查，不是按单条记录判断"有没有 DB 记录"——PRD-IM-9 落地后，同一个 `storage_key` 可能有其他存活行还在用，"这条记录没了"不等于"这个 storage_key 没人用了"）。
   - 频率：每天一次；阈值：90 天。扫描本身只是按索引查询，成本低，选择更高频率是为了更快发现 integrity violation（真实数据丢失信号），本质是 eventual consistency 的最后一道防线，不是主清理路径。
- **组织方式（约束，不规定具体文件）**：草稿清理、安全网扫描、（Phase B 的）视频缓存清理是三种不同生命周期策略（状态驱动 / 消息生命周期驱动 / 租约驱动），清理逻辑应按语义独立组织，不应该塞进一个按路径前缀 if-elif 堆叠多套判断的扫描函数里；可以共享底层 `list_keys`/`stat`/`delete`/锁/调度基础设施，以及步骤 5 的 `try_delete_storage_if_unreferenced()`。
- 并发保护：沿用 `agent/memory` scope 锁的模式（Redis 分布式锁），防止 backend/worker 同时触发同一扫描。
- 验收标准：一条 30 天前发送、且没有被 `save_uploaded_file` 存进文件库的消息，只要所属会话没被删除，历史气泡里的图片/文件仍能正常加载（哪怕 Redis 整体清空）；会话被删除后，DB commit 成功即视为删除生效，对应存储字节按引用计数尽力清理，清理失败由安全网兜底，不阻塞会话删除本身；两条消息共享同一个 `storage_key` 时，删除其中一条不影响另一条仍能正常访问附件。

### FR-STORAGE-1-2：视频转码结果缓存，读时刷新 TTL（🔲 待评估）

- **`cache_key` 必须包含转码 profile 和版本号，不能只用 `storage_key`**（第一轮方案的正确性 bug）：`prepare_video_media(raw, mime, name, model_cfg)` 的转码结果实际上由 `model_cfg`（不同模型的分辨率/码率/体积上限不同）和转码参数本身（codec/CRF/分辨率策略）共同决定，同一个 `storage_key` 换一个模型读、或者以后调整 ffmpeg 参数，产出的文件是不一样的——只用 `storage_key` 当 key 会命中错误的旧缓存。改为：
  ```
  cache_key = sha256(storage_key + transcode_profile + CACHE_VERSION)
  ```
  `transcode_profile` 是从 `model_cfg` 派生的、影响转码结果的关键字段（如目标分辨率上限/码率上限/编码器），`CACHE_VERSION`（如 `"video-v1"`）是一个硬编码常量，以后升级转码算法/参数时改这个常量即可让所有旧缓存自然失效（不需要手动清），等安全网/租约过期自动回收。
- 转码产物写入存储的路径由 `cache_key` 确定性推导（如 `{uid}/.video_cache/{cache_key}.mp4`），**不需要经过 Redis 指针查找**——路径本身就是可计算的。
- **Redis 只承担"最近是否仍活跃"这一个语义，不承担查找职责**：`video_cache_alive:{uid}:{cache_key} = 1`，`ex=7d`（对齐旧的 `chat_attach.TTL`，不新增一个自定义常量）。**命中时必须用 `SET video_cache_alive:{uid}:{cache_key} 1 EX 7d` 重新整体设置，不能用 `EXPIRE`**——如果 Redis 整体丢失过（本 PRD 明确允许的场景），alive marker 这个 key 根本不存在，对不存在的 key 调 `EXPIRE` 是空操作、不会创建 key；如果只刷新 TTL，会出现"缓存文件明明刚被命中读取，但 marker 依然不存在，下一轮安全网还是会把它当不活跃孤儿清掉"这种违背自愈设计初衷的 bug。`prepare_video_media()` 先按公式算出 `cache_key`，直接尝试 `storage.get(cached_path)`；能读到就是缓存命中（同时 `SET` 重建/续期 alive marker），读不到（文件不存在，或者存在但 marker 已经过期被安全网清理）就重新转码、覆盖写入、重置 alive marker。这样即使 Redis 整体丢失，最多导致"缓存被安全网提前当孤儿清理、下次多转码一次"，不会影响正确性——这正是缓存该有的性质：随时全部丢掉也不影响业务正确性，跟 FR-STORAGE-1-1 里"DB 是所有权真相来源、绝不能丢"的附件语义形成对比。
- **并发多个请求命中同一视频同一 cache_key 时需要 single-flight 锁**：真实场景（同一会话里连续问同一个视频的问题）会触发多个并发请求同时未命中缓存，各自起一个 ffmpeg 转码同一个大文件，浪费 CPU/内存。改为：查缓存未命中 → 用 `video_cache_lock:{cache_key}`（同 `agent/memory` scope 锁模式）尝试加锁 → 加锁成功后**再查一次缓存**（double-check，防止等锁的时候前一个请求已经转码完）→ 仍未命中才真正转码 → 写缓存 → 释放锁；等锁的请求锁释放后同样先查缓存命中就直接用。
- 缓存产物本身的清理复用第 2 节 FR-STORAGE-1-1 里的组织约束，作为独立的"租约驱动"清理策略：物理年龄扫描 `.video_cache/`，删除前检查对应 alive marker 是否存在且未过期，存在则跳过（marker 不存在 或 已过期，正常按物理年龄清理）。
- 验收标准：同一视频、同一 `model_cfg`（`storage_key` 不变）第二次 `read_file` 应命中缓存，仍重新调用轻量 `_probe_video` 但不再调用 `_compress_video`；`storage_key` 变化或 `model_cfg` 对应的 transcode profile 变化都不会命中旧缓存；并发多个请求读同一视频时 `_compress_video` 只应该被真正调用一次。

---

## 3. 非目标

- **不做"重启时清理"**：backend/worker 重启是正常运维操作（发布、扩缩容、崩溃自动拉起），绝大多数情况下 Redis 数据是好的、暂存附件仍然有效；如果重启触发无条件清理，会把用户几分钟前刚发、还没来得及保存的正常附件误删，是比现有孤儿泄漏更严重的数据丢失。清理必须是时间驱动（定时任务），不能跟进程生命周期绑定。
- **不做真正的"双向校验"**（反向检查 Redis 元数据指向的存储对象是否还在）：这种不一致（Redis 说有、存储没有）概率低，且现有代码已经优雅处理——`read_bytes` 读不到会抛异常，调用方已包 try/except 返回友好错误，不构成资源泄漏，不值得为此新增校验逻辑。FR-STORAGE-1-2 里视频缓存的"检查 alive marker 是否存在"是例外，因为那里的 marker 本身会被主动续期，需要靠它判断"是否仍在使用"，跟这里说的"双向校验"目的不同。
- **不做"访问延寿"**：附件生死跟消息/会话是否存在绑定，不跟"最近有没有被读取/查看"绑定——一条附件哪怕从没被再打开过，只要所属消息/会话还在，就应该一直可用；这跟视频转码缓存"常访问就续命"是完全不同的语义，不要混淆（缓存的目的是省计算，附件的目的是让历史消息保持可用）。
- **不做上下文窗口驱动的清理**：附件生命周期不跟模型上下文窗口（滑动窗口/摘要裁剪）绑定——上下文裁剪是"喂给模型看什么"的问题，不代表这条历史消息对用户不重要了；如果按上下文窗口清理，附件失效速度会比现在的固定 7 天还快，是明确要避免的方向。
- **不搭建 Redis 持久化**（AOF/RDB volume 挂载）：这属于基础设施配置变更，超出本 PRD 范围；即使做了 Redis 持久化，FR-STORAGE-1-1 的清理任务仍然需要（自然过期这条路径始终存在，跟 Redis 是否持久化无关）。
- **不引入 `message_attachments` 多对多关系表**：见第 1.4 节排查结论，现状不存在附件跨消息复用的场景，`chat_attachments.message_id` 简单外键足够表达当前的产品事实；转发/消息复制/多消息引用等假设中的未来需求不在本 PRD 设计范围内，出现真实需求时再评估。
- **不假装 DB 和 storage 之间存在事务**：`delete_session` 的级联清理明确是"DB commit 优先、storage 删除是尽力而为的 eventual consistency"，不会去做分布式事务/两阶段提交这类基础设施；storage 删除失败只留给安全网扫描兜底，不阻塞、不重试、不回滚 DB。`storage.put()` 和 `db.insert(draft)` 之间同理，不做分布式事务，只做"insert 失败时 best-effort 回滚 put"。
- **不引入 `DELETING` 中间状态**：`chat_attachments.state` 只有 `draft`/`attached` 两个值，删除是"DB 事务里直接删行、commit 成功即生效"，不设专门的"正在删除中"状态——理由见 FR-STORAGE-1-1 开头的说明，避免安全网扫描要处理"DELETING + storage 还在"（该重试）和"DELETING + storage 没了"（该 finalize）这类新增的状态组合，现在体量不需要这种精细的删除重试队列。

---

## 4. 待确认问题

- ~~**`chat_attachments` 表跟现有消息模型怎么关联**~~ **已确认**：`ConversationMessage`（`app/models/__init__.py:407`）没有专门的附件字段，用户上传附件的卡片跟"咕咕发的文件卡片"共用同一个 `files` JSON 列（`agent/gateway/web.py:174-177`，靠卡片里的 `upload: true` 区分）。这个已持久化的卡片（`chat_attach.py:846-854` 定义的结构）**缺 `storage_key`**——DB 里现有数据没法定位存储字节所在位置，不能靠"扩展现有字段"糊弄过去，必须新建独立的 `chat_attachments` 表（`message_id` 外键指向 `conversation_messages.id`）。不需要做一次性历史数据迁移（旧消息的 `files` JSON 本来就没有 `storage_key`，旧附件如果对应的 Redis 元数据还没过期，可以按现有逻辑继续走 Redis 兜底一段时间自然过渡；过期后旧消息的历史附件会显示"已过期"，属于新方案上线前的存量数据，不强求补全）。
- ~~草稿 TTL 具体取多久~~ **已定**：48 小时。草稿是"发出去之前"的中间态，48 小时给了充分缓冲，同时比旧的 7 天大幅收紧暴露窗口。
- ~~安全网扫描的频率~~ **已定**：每天一次（阈值仍是 90 天）。扫描只是按索引查询，成本低；更快发现 integrity violation（真实数据丢失信号）比省一点扫描频率更重要。
- ~~完整性异常触发后具体怎么响应~~ **已定**：除了记录到受限诊断出口，顺带补一条 `SystemLog`（后台「系统日志」页可见），方便运维不用登服务器也能发现——**必须先过 `redact()`**（`app/core/redaction.py` 的规则：任何进 SystemLog/Debug 面板的文案都要脱敏，不能把 `storage_key`/路径等原始信息直接写进去）。
- ~~视频转码缓存 alive marker 的 TTL~~ **已定**：7 天，对齐旧的 `chat_attach.TTL`，减少一个新的自定义常量。
- `.video_cache/` 的转码产物是否需要按用户设置存储配额上限（防止极端情况下缓存本身占用过多空间）？本 PRD 暂不引入，后续如有需要再评估。**观察工具已就绪**（2026-08-09）：使用通用 `storage_category_snapshots` 表，`video_cache_gc` 每次清理跑完后落一条占用快照（对象数+总字节数），管理后台「存储对账」页新增趋势图卡片——之后靠这条曲线的真实走势判断，不用再猜。

---

## 5. 实施计划

拆两个独立 PR：Phase A（清理任务）不依赖 Phase B（转码缓存），可以先落地、单独上线验证；Phase B 落地时复用 Phase A 已经跑通的存储枚举/锁/scheduler 基础设施，新增一段独立组织的视频缓存租约清理逻辑（不是把 `.video_cache/` 塞进 Phase A 那个统一扫描函数）。

### Phase A：附件所有权状态机（对应 FR-STORAGE-1-1 v3 定稿）

> v1（定时按物理 mtime 扫描 + 固定 TTL）已实现过一次并 revert（commit `dece7584` → `e63014a9`），原因见第 1.3 节。以下步骤跟第 2 节 FR-STORAGE-1-1 的 v3 描述（去掉 `DELETING`、统一 `try_delete_storage_if_unreferenced(user_id, storage_key)`、Redis 只做 legacy fallback）保持一致——**这里不重复列出完整的四条不变量和每一步的详细理由，实施前请以第 2 节为准，这里只是对应到具体改动点的清单**。

1. ~~先确认现状~~ **已确认**：`ConversationMessage.files` 只存卡片展示信息、缺 `storage_key`，必须新建独立表，不能靠扩展现有字段，见第 4 节。
2. **新增 `chat_attachments` 表**（字段、索引、约束见第 2 节步骤 1；`state` 只有 `draft`/`attached` 两个值，**没有 `deleting`**）。简单 `message_id` 外键，不做多对多（见第 1.4 节）；`storage_key` 无唯一约束（PRD-IM-9 场景下会被多行共享）。
3. **`stage()` 改为直接写 DB，且不再写旧的 Redis meta key**：`storage.put()` 成功后立刻 `INSERT chat_attachments(state=draft)`；insert 失败 best-effort 回滚刚写的 storage 字节（这是物理删除唯一不走统一入口的例外）。
4. **发送成功时原子 claim，整条消息一个事务**：`resolve_for_message` 产生的消息真正持久化时，对每个关联 `attach_id` 执行条件更新，任意一次 `affected_rows != 1` 整个事务回滚（消息本身也不落库），claim 之后不再有任何 TTL。
5. **`/thumb`、`/download`、`/preview-pdf`（`app/api/v1/agent.py:68-142`）永远先查 DB**：`WHERE attach_id=? AND user_id=?`（禁止只按 `attach_id` 查，避免 IDOR）；DB 查不到才回退查 Redis 的 legacy meta（只覆盖新方案上线前写入的旧数据，会随 TTL 自然消失，不专门下线）。
6. **实现 `try_delete_storage_if_unreferenced(user_id, storage_key)`**：唯一的物理删除入口（步骤 3 的插入回滚除外）；内部 `SELECT EXISTS` 检查是否还有其他存活行引用同一个 `storage_key`，有则跳过、没有才真正 `storage.delete()`。
7. **`delete_session`（`app/api/v1/agent.py:356`）改为「DB 优先、storage 尽力而为」两阶段**：① 一个事务内**直接删除**（不是标记）session 关联的 `chat_attachments` 行；② 事务 commit 成功后，对每个涉及的 `storage_key` 调步骤 6 的函数；③ 失败只记日志不回滚不阻塞，留给步骤 10 的安全网兜底。
8. **草稿孤儿定时清理，先赢 DB 所有权再碰 storage**：`DELETE FROM chat_attachments WHERE attach_id=? AND state='draft' AND created_at < now() - 48h`，`affected_rows=1` 才说明真的拿下了这一行（跟并发的 claim 用条件语句天然互斥，不需要额外加锁）；成功后调步骤 6 的函数处理物理字节。
9. **发送失败时的状态守卫删除**：新增按 `attach_id` 删除单个草稿附件的接口，用条件删除+`affected_rows` 判断是否真的是 `state='draft'`，非 DRAFT 直接失败（防止 HTTP 响应丢失导致的误判把已生效附件删掉）；前端发送失败时调用。仅为优化，步骤 8 的定时兜底仍是主机制。
10. **安全网扫描**（每天一次，90 天阈值）：DB 与 storage 交叉检查，**两种不一致分别处理**——`DB 有记录 + storage 缺失` 记录为 integrity violation（诊断日志 + `SystemLog`，过 `redact()`，不自动删 DB 记录）；`DB 无记录 + storage 存在（非最近写入）` 才是孤儿候选，清理前同样调步骤 6 的函数（按 `storage_key` 查，不是按单条记录判断）。
11. **组织约束**：草稿清理 / 安全网扫描 / （Phase B）视频缓存清理三种不同生命周期策略，按语义独立组织实现，不塞进一个按路径前缀分支的扫描函数；可共享底层 `list_keys`/`stat`/`delete`/锁的基础设施，以及步骤 6 的统一删除函数。
12. **并发保护**：沿用 `agent/memory` scope 锁的模式。
13. **测试**（新增 `tests/test_staging_gc.py`、`chat_attachments` 状态机相关的模型/服务测试、`delete_session` 级联清理的集成测试、单个附件删除接口的状态守卫测试、`try_delete_storage_if_unreferenced()` 的引用计数测试）：见第 6.1 节。
14. **上线验证**：见第 6.2 节。

### Phase B：视频转码结果缓存（对应 FR-STORAGE-1-2）

1. **`app/core/chat_attach.py` 新增缓存 helper**（紧邻 `prepare_video_media`）：
   - `_video_transcode_profile(model_cfg) -> dict`：从 `model_cfg` 派生影响转码结果的关键字段（目标分辨率上限/码率上限/编码器等）。
   - `_video_cache_key(storage_key: str, profile: dict) -> str`：`hashlib.sha256((storage_key + json.dumps(profile, sort_keys=True) + CACHE_VERSION).encode()).hexdigest()`，`CACHE_VERSION` 定义成模块级常量（如 `"video-v1"`）。
   - `_video_cache_alive_key(uid, cache_key) -> str`：如 `f"video_cache_alive:{uid}:{cache_key}"`。
2. **`prepare_video_media()` 改造**（新增可选参数 `storage_key: str | None = None`、`user_id: str | None = None`，两者都传才启用缓存；`resolve_for_message`/`read_video` 两个调用方都能传，聊天附件路径 `attach_id` 每次不同、天然没有稳定 key，可以先只给 `read_video` 接）：
   - 算出 `cache_key`，直接尝试 `storage.get({uid}/.video_cache/{cache_key}.mp4)`；能读到就是命中，跳过重复的 ffmpeg 转码，但仍重新执行轻量 ffprobe，以便重新校验时长和 payload 规则；同时 **`SET video_cache_alive:{uid}:{cache_key} 1 EX 7d`**（不是 `EXPIRE`——marker 可能因为 Redis 整体丢失而不存在，`EXPIRE` 对不存在的 key 是空操作，必须用 `SET` 无条件重建/续期）。
   - 未命中（文件不存在，包括被安全网清理的情况）→ 先用 `video_cache_lock:{cache_key}` 加锁（`agent/memory` scope 锁模式）→ 加锁后 **double-check 再读一次缓存**（防止等锁期间前一个请求已经转码完）→ 仍未命中才真正探测+转码 → 转码成功后 `put` 到缓存路径、`SET` alive marker（`ex=7d`）→ 释放锁。
3. **`agent/tools/file_readers.py` 的 `read_video`**：调用 `prepare_video_media` 时补上 `storage_key=file.storage_key, user_id=file.user_id`。
4. **独立的视频缓存租约清理**（复用 Phase A 的 `list_keys`/`stat`/`delete`/分布式锁/scheduler 基础设施，但是一段独立组织的清理逻辑，不塞进草稿清理或安全网扫描里）：扫描 `.video_cache/`，删除前查一次对应 alive marker（`GET`，不刷新），marker 存在则跳过；marker 不存在或已过期则按物理年龄正常清理。
5. **测试**：
   - `prepare_video_media` 缓存命中：mock `_compress_video`/`_probe_video`，第一次调用产生缓存，第二次调用同一 `storage_key`+`model_cfg` 断言仍会调 `_probe_video` 但不会再调 `_compress_video`。
   - `storage_key` 变化、或 `model_cfg` 对应 transcode profile 变化（同 `storage_key`），都不命中旧缓存。
   - 命中缓存时对应 alive marker 被重建/续期（断言调的是 `SET ... EX`，不是 `EXPIRE`）。
   - **alive marker 因 Redis 丢失而不存在、但物理缓存文件还在**：命中读取后，marker 应该被重新创建出来（断言 `GET` 能拿到值，而不是断言"TTL 变化"——因为 key 本来就不存在，没有旧 TTL 可比）。这是本轮新增的用例，专门覆盖"用 EXPIRE 会静默失效"这个 bug。
   - 并发两个请求同时读同一个未缓存视频：mock `_compress_video` 断言只被调用一次（single-flight 锁生效）。
   - alive marker 存在但物理缓存文件不存在（如被外部误删）：`prepare_video_media` 应该自动重新转码，而不是直接报错或返回损坏结果；成功后重建 marker。
   - 视频缓存清理对 `.video_cache/` 的行为：alive marker 还在且未过期时，物理 mtime 超期的缓存对象**不删**；marker 不存在（或已过期）时按物理年龄正常清理。
6. **上线验证**：devserver 上让咕咕连续两次读同一个视频，通过日志或手动查 Redis（`GET video_cache_alive:<uid>:<cache_key>`）确认第二次命中缓存、没有再触发 ffmpeg 转码；再手动 `FLUSHALL` 一次 Redis 后立刻再读一次，确认缓存文件仍能命中（走 storage 直接读），且 marker 被重新创建出来。

---

## 6. 测试目标

### 6.1 自动化测试

**Phase A**：

- [x] 消息发送成功时，关联的 `chat_attachments` 行原子地从 `draft` 转成 `attached`，`message_id` 正确写入。
- [x] **Claim all-or-nothing**：一条消息带 3 个附件，模拟其中 1 个 claim 失败（比如已经被并发请求 claim 走，`affected_rows=0`）——断言整个事务回滚：消息本身不落库，另外 2 个附件也仍然是 `draft` 状态，不会出现"消息存在但只有部分附件是 attached"的半完整结果。
- [x] `/thumb`、`/download`、`/preview-pdf`：Redis 未命中/不存在时，能从 DB 正确回退拿到 meta 并返回内容（模拟"7 天后再打开历史消息"场景）；查询必须带 `user_id` 过滤——用另一个用户的身份查同一个 `attach_id` 应该拿不到（IDOR 回归测试）。
- [x] `delete_session`：会话下有 2 条消息各引用 1 个附件，删除会话后，两个附件的存储对象和 `chat_attachments` 行都应该消失；不属于这个会话的附件不受影响。
- [x] **共享 `storage_key` 时的删除隔离（P0，对应 PRD-IM-9 的复用场景）**：两条独立消息（分属不同会话）的 `chat_attachments` 行指向同一个 `storage_key`；删除其中一个会话后，断言：① 那条消息的 `chat_attachments` 行被删；② 物理 `storage_key` **没有**被删除（因为另一条还活着）；③ 另一条消息仍能正常通过 `/thumb`/`/download` 访问附件。再删除第二条消息所在会话后，这次断言物理字节才真正被删除。
- [x] `try_delete_storage_if_unreferenced()` 单测：`storage_key` 还有其他存活 `chat_attachments` 行时不删物理对象，返回"跳过"；没有任何存活行时才真正删除，返回"已删除"。
- [x] **不变量 4（检查-删除竞态，本 PRD 侧的边界测试）**：这个竞态的根本解法在 PRD-IM-9（复用时锁住源行），但本 PRD 至少要测"检查那一刻"的正确性——mock `SELECT EXISTS` 返回结果与实际 `storage.delete()` 执行之间插入一次并发 `INSERT`（模拟新引用出现），断言 `try_delete_storage_if_unreferenced()` 自身的检查逻辑没有 bug（比如没有用陈旧的检查结果做二次判断）；同时在测试注释里明确标注"这个测试不能证明整体竞态已解决，完整解决依赖 PRD-IM-9 落地时对源行加锁"，避免以后有人误以为这一条测试通过就代表问题已经解决。
- [x] 草稿孤儿清理：`state='draft'` 且超过草稿 TTL 的行会被清理（含存储对象）；`state='attached'` 的行即使物理 mtime 同样很老也**不会**被草稿清理碰到。
- [x] 单个附件删除接口的状态守卫：`state='draft'` 时删除成功，对应存储对象和 DB 行都消失；`state='attached'` 时删除请求应该被拒绝（不能因为前端误判"发送失败"就删掉已生效的附件）；删除一个不存在或不属于当前用户的 `attach_id` 应该返回明确错误而不是静默成功。
- [x] **发送成功但 HTTP 响应丢失/超时的竞态**：模拟消息已经在服务端提交成功（附件已 claim 成 `attached`）之后，客户端仍然发出单附件删除请求——断言删除被拒绝，附件和存储对象都还在。
- [x] **GC 扫描与发送 claim 同时发生的竞态**：草稿孤儿清理用条件删除（`DELETE ... WHERE state='draft' AND ...`）和消息发送用条件更新（`UPDATE ... WHERE state='draft' AND ...`）并发操作同一行——谁先改变这一行的 `state`，谁的条件语句先命中、`affected_rows=1`，另一方的条件语句因为 `state` 已经不是 `draft` 而 `affected_rows=0`、天然是 no-op。测试断言：最终结果只能是"消息正常引用附件"或"附件被 GC 干净清理、消息发送失败"两者之一，不会出现"消息引用了一个已被删除的附件"。
- [x] **`storage.put()` 成功但 `db.insert(draft)` 失败时的回滚**：mock DB insert 抛异常，断言 `stage()` 会 best-effort 调 `storage.delete()` 把刚写的字节清理掉；再 mock 这次回滚也失败，断言不会抛出未处理异常掩盖原始错误（回滚失败只记日志，原始 insert 异常正常向上抛）。
- [x] **DB commit 失败时 storage 字节不能提前被删**：`delete_session` 的 DB 事务失败（模拟异常）时，不应该有任何 `storage.delete()` 被调用。
- [x] **storage 删除失败不阻塞 session 删除**：`storage.delete()` 抛异常时，`delete_session` 本身仍应成功返回（DB 层面已完成），且这个失败应该能被后续安全网扫描识别为孤儿候选。
- [x] 空存储 / 无草稿孤儿时清理任务正常返回 `0`，不报错；`stat()` 返回 `mtime=None` 时跳过不删。
- [x] 并发保护：Redis 锁已被占用时清理任务直接返回、不执行任何删除。
- [x] 安全网扫描：`DB 有记录（非 draft）+ storage 缺失` 应该被标记为 integrity violation（写诊断日志 + 一条 `SystemLog`，不清理、不删 DB 记录）；`DB 无记录 + storage 存在且非最近写入` 才作为孤儿候选允许清理——两种情况的处理动作必须不同，不能用同一段代码路径。
- [x] integrity violation 写入 `SystemLog` 的文案必须过 `redact()`：断言写入内容不包含原始 `storage_key`/文件系统路径等敏感信息（复用 `app/core/redaction.py` 现有的脱敏正则做断言）。

**Phase B（`tests/test_chat_attach_video.py` 补 `prepare_video_media` 缓存分支 + `test_staging_gc.py` 补 `.video_cache/` 分支）**：

- [x] 首次调用 `prepare_video_media(..., storage_key=..., user_id=...)` 无缓存，正常走探测+转码，之后能在存储里读到 `.video_cache/{cache_key}.mp4` 和对应 alive marker。
- [x] 同一 `storage_key`+同一 `model_cfg` 第二次调用命中缓存：mock `_probe_video`/`_compress_video` 断言 `_probe_video` 仍被调用、`_compress_video` 不再被调用，直接返回缓存媒体项。
- [x] 命中缓存时对应 alive marker 用 `SET ... EX` 重建/续期，**不是 `EXPIRE`**（断言调用的 Redis 方法，`EXPIRE` 对不存在的 key 是空操作，会导致 Redis 丢失后缓存"自愈"失败）。
- [x] alive marker 不存在（模拟 Redis flush）但物理缓存文件还在：命中读取后 marker 被重新创建（`GET` 能拿到值）。
- [x] `storage_key` 变化、或同 `storage_key` 但 `model_cfg` 对应 transcode profile 变化，都不命中旧缓存，重新走探测+转码。
- [x] 未传 `storage_key`/`user_id`（聊天附件路径）完全不查/不写缓存，行为跟 Phase A 落地前一致（防止误伤现有聊天附件视频路径）。
- [x] **并发 single-flight**：两个请求同时读同一个未缓存的视频（同 `storage_key`+`model_cfg`），mock `_compress_video` 断言**只被调用一次**，另一个请求应该等锁释放后直接读到缓存产物。
- [x] **alive marker 存在但物理缓存文件已不存在**（模拟被外部/安全网误删）：`prepare_video_media` 应该自动判定未命中、重新转码，不应该报错或返回损坏内容；成功后重建 marker。
- [x] 视频缓存清理对 `.video_cache/` 的行为：alive marker 还在且未过期时，物理 mtime 超期的缓存对象**不删**；marker 不存在（或已过期）时正常按物理年龄删除。

### 6.2 手动测试（devserver）

**Phase A 上线前**：

- [x] 发一张图片给咕咕（正常发送，非草稿），刷新页面，确认气泡里的图片正常显示（走的是 DB 查询路径，不是靠 objectURL）。
- [x] 手动把 Redis 整个 flush 掉（模拟容器重建/数据丢失），再刷新这条历史消息，确认图片依然正常显示（证明真的从 DB 拿到了 meta，跟 Redis 状态无关——包括草稿阶段刚上传、还没发送成功的附件也应该在 DB 里能查到）。**已在 devserver 验证**（2026-08-09）：`redis-cli FLUSHALL`（691 → 0 keys）后确认该附件的 legacy Redis key 已不存在、DB 行（`state=attached`）和物理文件均完好，浏览器刷新后图片正常显示。
- [x] 删除这条消息所在的整个会话，检查存储里对应的 storage_key 确实被删除了（不再残留孤儿字节），`chat_attachments` 表里对应行也应该消失。（`storage_key` 共享场景——两条消息共用同一份字节、删一条不影响另一条——目前只有自动化测试覆盖；PRD-IM-9 落地前没有可以手动触发共享场景的入口，等 IM-6 上线后再补一条手动验证。）
- [x] 上传一张图片但**不发送**（只调用暂存接口），等草稿 TTL 过期后跑一次清理任务，确认这个从未发送的草稿被清理掉了；再上传一张、正常发送、发送成功后手动改数据库把这张图的 mtime/created_at 改到 TTL 之外，确认它**不会**被草稿清理误删（因为已经是 `attached` 状态）。
- [x] 挂上定时任务后，观察 `app/core/scheduler.py` 的启动日志确认相关 job 被正确注册。**已在 devserver 验证**（2026-08-09）：`logs/gugu-worker.log` 最新一次 worker 重启日志显示 `[scheduler] started · 3 builtin jobs: ['attachment_draft_gc', 'attachment_safety_net', 'video_cache_gc']`，三个任务全部正确注册。
- [ ] 观察一次真实的低峰自动运行（不手动触发），确认定时触发本身工作正常，不只是手动调用路径可用。

**Phase B 上线前**：

- [x] 让咕咕读一个文件库里的视频（MiniMax M3 模型），记录这次转码耗时。**已在 devserver 用真实文件库视频验证**（2026-08-09，脚本直调 `_compress_video_cached`，非经完整对话流程）：186.1MB/1080p/14.7Mbps/103.9s 的视频，首次转码耗时 **66.49s**，转码后 59.6MB。
- [x] 立刻再让咕咕读同一个视频，确认响应明显更快（跳过了转码），日志里能看到"缓存命中"相关记录（需要在实现里加一条诊断日志，比如 `diag_log_raw("chat_attach.video_cache_hit", ...)`）。**已验证**：补上了漏掉的 `diag_log_raw("chat_attach.video_cache_hit", ...)` 诊断日志（之前实现时漏加）；第二次调用耗时 **0.04s**（加速比 1656x），`logs/gugu-diag.log` 确认命中记录；alive marker TTL 604800s（7 天）符合设计。
- [x] 把这个视频文件重命名/覆盖上传替换内容后，再次读取，确认走的是全新转码（没有错误地命中旧缓存）。**已在 devserver 脚本验证**（2026-08-09）：同一份视频字节用不同 `storage_key`（模拟覆盖上传后重新生成的 key）调用，确认真的触发了一次全新转码（65.08s），没有误命中旧缓存。
- [x] 手动查 Redis（`GET video_cache_alive:<uid>:<hash>`、`TTL ...`）确认命中后 TTL 确实被刷新，不是原地不动。**已验证**：命中前 TTL 604375s → 命中后 604800s（满 7 天），确认真的被刷新。
- [x] 用一个超过 90MB 触发 mm_file 分支的视频重复上述流程，确认 mm_file 场景下缓存同样生效（不只是 base64 场景测过）。**已用 devserver 真实 MiniMax API key 验证**：186MB 源文件转码后 59.6MB，落在 (45MB,90MB] 区间，正确走 mm_file 分支，真实上传到 MiniMax Files API 成功拿到 `file_id`；确认转码步骤命中了缓存（耗时主要花在重新上传，这是设计范围内的行为——缓存只覆盖 ffmpeg 转码，不缓存 mm_file 上传结果）。
- [ ] 观察一段时间后 `.video_cache/` 目录的存储占用增长趋势，判断第 4 节里悬而未决的"是否需要配额上限"问题是否需要提前处理。**已采集基线快照**（2026-08-09）：当前 2 个对象，共 119.1MB；这只是单次快照，真正的"增长趋势"需要过一段时间后再采一次做对比，暂不勾选完成。
