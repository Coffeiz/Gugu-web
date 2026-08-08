# 暂存附件孤儿清理与视频转码缓存 PRD

> 状态：🔲 待评估（Phase A 方案重新设计中，已推翻"定时按物理年龄清理"版本；Phase B 方案不变）
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
| Phase 1'：方案设计 v2（进行中） | 🔲 设计中 | 改为"附件生命周期绑定消息/会话"——只要引用它的消息/会话没删，附件不因为时间流逝失效；元数据从 Redis-only 挪进 DB（Redis 只保留给发送前的草稿阶段用）；`delete_session` 级联清理存储字节与元数据；仍需一个兜底扫描处理草稿孤儿和级联逻辑遗漏。见第 1.4、2、5 节。 |
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

### 1.4 视频转码缓存（新增能力，非 bug）

PRD-LLM-3 的 `prepare_video_media()`（`chat_attach.py`）每次调用都会重新探测（ffprobe）+ 转码（ffmpeg）视频——`read_file` 场景下，用户可能反复让咕咕"再看一遍"同一个视频，每次都要重新跑一次可能耗时数十秒的转码，纯粹浪费 CPU 和等待时间。目标是把转码结果缓存下来，按 `storage_key` 命中直接复用。

---

## 2. 功能需求

### FR-STORAGE-1-1：附件生命周期绑定消息/会话，草稿孤儿定时兜底清理（🔲 设计中，v2）

**核心变化**：附件一旦被某条已发送、已持久化的消息引用，它的存活期跟着"引用它的消息/会话是否还存在"走，不再有固定过期时间；只有从未被任何消息引用的草稿附件，才继续用固定短 TTL 兜底清理。

1. **元数据出 Redis、进 DB**：现在 `get_meta()`/`/thumb`、`/download` 等接口完全依赖 Redis 里 `ex=ttl` 的 JSON 元数据（`chat_attach.py:204`），Redis 一过期或丢数据，历史消息里的附件就"找不到了"——即使存储字节还在也没用。改造后，消息发送时（即 `resolve_for_message` 产生的 `attachments` 真正落进某条持久化消息记录的那一刻）需要把这条附件的完整元数据（name/ext/size/kind/storage_key/mime/duration/img_width/img_height 等）一并写入 DB，作为长期真相来源；Redis 继续用于**发送前的草稿阶段**（上传了但消息还没发出去），语义不变、TTL 不变。
2. **`/thumb`、`/download`、`/preview-pdf` 改为优先查 DB**：Redis 未命中（过期/丢失/本来就是已发送附件）时，回退查 DB 元数据表，只要对应消息/会话没删，附件应该始终可读。
3. **会话/消息删除级联清理存储字节**：`delete_session`（`app/api/v1/agent.py:356`）目前只 `db.delete(session)`，需要扩展为：删除前查出该会话下所有消息引用过的 storage_key（通过新的附件元数据表关联查询），级联 `storage.delete()` 对应对象和元数据行。如果未来支持删单条消息，同样需要级联。
4. **草稿孤儿兜底清理（沿用原思路，缩小适用范围）**：只清理"从未进入任何已发送消息"的 `.chat_staging/`/`.voice/` 对象——判断依据是 DB 附件元数据表里没有对应记录（或有记录但标记为"未发送"）。物理年龄扫描 + 固定短 TTL（沿用现有 7 天，或缩短，见第 4 节待确认问题），逻辑跟 v1 类似但多一步"查 DB 确认未被引用"的过滤，避免误删已经发送、只是元数据还没来得及落库的边界情况。
5. **发送失败时及时清理（新增，补充定时兜底覆盖不到的即时场景）**：现状排查发现，草稿附件目前只有两条清理路径——用户手动点"删除临时文件"（`ProfileGuguPane.vue:58` → `DELETE /agent/attachments`，一次性清空当前用户全部暂存附件，不区分哪些发送成功）和步骤 4 的被动定时兜底，"发送消息失败/中途放弃"这个高频场景完全没有及时清理：
   - 新增按 `attach_id` 删除单个暂存附件的接口（现有 `clear_staged()` 是全量清空，需要一个更细粒度的版本）。
   - 前端在发送消息请求失败时（网络错误/后端返回错误），捕获异常后立刻调用这个接口，删除本次请求关联的 `attach_id` 列表。
   - **明确这只是优化、不能替代定时兜底**：用户上传完附件后直接关闭标签页/浏览器崩溃/断网，没有任何"失败信号"能触发前端清理，这类场景永远需要定时兜底覆盖——及时清理负责降低草稿孤儿的产生速度和用户体感的清晰度（比如设置页能准确反映"是不是真的有残留"），不改变兜底扫描本身是否需要存在。
6. **安全网：更长周期的全量兜底扫描**：即使有级联清理，仍需要一个低频（比如每周一次）、更长物理年龄阈值（比如 90 天）的扫描，交叉检查 DB 附件表——如果某个 storage_key 仍被未删除的消息/会话引用，跳过删除；否则清理。用来兜住级联逻辑本身的 bug、历史遗留数据、手动 DB 操作等边界情况，不作为主清理路径。
- 并发保护：沿用 `agent/memory` scope 锁的模式（Redis 分布式锁），防止 backend/worker 同时触发扫描。
- 验收标准：一条 30 天前发送、且没有被 `save_uploaded_file` 存进文件库的消息，只要所属会话没被删除，历史气泡里的图片/文件仍能正常加载；会话被删除后，对应存储字节和元数据应在级联清理后消失，不再残留。

### FR-STORAGE-1-2：视频转码结果缓存，读时刷新 TTL（🔲 待评估）

- 转码产物写入存储的新路径（如 `{uid}/.video_cache/{cache_key}.mp4`；`cache_key` 由 `storage_key` 派生，不用 `file.id`——`storage_key` 在文件内容被覆盖上传时会重新生成，天然保证"内容换了、缓存自动失效"，不需要额外的内容哈希/版本号校验）。
- Redis 记一条指针：`storage_key → 转码产物的 cache_key`，`SET ... ex=ttl`（TTL 待定，建议先用跟 `chat_attach.TTL` 一致的 7 天，具体值可根据实际命中率调整）。
- `prepare_video_media()` 转码前先查这条 Redis 指针，命中就直接读缓存产物、跳过探测+转码；**每次命中都对这条 Redis key 执行一次 `EXPIRE` 刷新 TTL**——这是跟 FR-STORAGE-1-1 刻意不同的策略：转码缓存的定位是"避免重复计算"，常被引用的视频应该活得更久，跟"暂存收件箱、固定期限"的产品语义不是一回事，两者不应该用同一套"是否续命"的规则。
- 缓存产物本身的存储层清理仍然复用 FR-STORAGE-1-1 那套按物理年龄扫描的任务（`.video_cache/` 也纳入清理路径前缀），但因为 Redis 指针会在命中时刷新 TTL、mtime 不会因为读取而更新，需要额外考虑："Redis 指针还没过期，但存储层清理任务已经因为长时间没有 PUT 动作+超过物理年龄阈值把文件删了"这种不一致——**建议 FR-STORAGE-1-1 的清理任务在删除 `.video_cache/` 下的对象前，先检查对应 Redis 指针是否还存在且未过期，存在则跳过本次删除**（这是 FR-STORAGE-1-1 里提到、但认为不值得为 `.chat_staging/`/`.voice/` 单独做的"双向校验"，在这里因为 Redis 指针会被主动续期、真实需要用到，值得做；`.chat_staging/`/`.voice/` 的 Redis TTL 不会被刷新，物理年龄和 Redis TTL 天然同步，不需要这一步）。
- 验收标准：同一视频（`storage_key` 不变）第二次 `read_file` 应命中缓存、不重新调用 `_probe_video`/`_compress_video`；文件被覆盖上传后（`storage_key` 变化）不会命中旧缓存。

---

## 3. 非目标

- **不做"重启时清理"**：backend/worker 重启是正常运维操作（发布、扩缩容、崩溃自动拉起），绝大多数情况下 Redis 数据是好的、暂存附件仍然有效；如果重启触发无条件清理，会把用户几分钟前刚发、还没来得及保存的正常附件误删，是比现有孤儿泄漏更严重的数据丢失。清理必须是时间驱动（定时任务），不能跟进程生命周期绑定。
- **不做真正的"双向校验"**（反向检查 Redis 元数据指向的存储对象是否还在）：这种不一致（Redis 说有、存储没有）概率低，且现有代码已经优雅处理——`read_bytes` 读不到会抛异常，调用方已包 try/except 返回友好错误，不构成资源泄漏，不值得为此新增校验逻辑。FR-STORAGE-1-2 里视频缓存的"检查 Redis 指针是否存在"是例外，因为那里的 Redis 指针本身会被主动续期，需要靠它判断"是否仍在使用"，跟这里说的"双向校验"目的不同。
- **不做"访问延寿"**：附件生死跟消息/会话是否存在绑定，不跟"最近有没有被读取/查看"绑定——一条附件哪怕从没被再打开过，只要所属消息/会话还在，就应该一直可用；这跟视频转码缓存"常访问就续命"是完全不同的语义，不要混淆（缓存的目的是省计算，附件的目的是让历史消息保持可用）。
- **不做上下文窗口驱动的清理**：附件生命周期不跟模型上下文窗口（滑动窗口/摘要裁剪）绑定——上下文裁剪是"喂给模型看什么"的问题，不代表这条历史消息对用户不重要了；如果按上下文窗口清理，附件失效速度会比现在的固定 7 天还快，是明确要避免的方向。
- **不搭建 Redis 持久化**（AOF/RDB volume 挂载）：这属于基础设施配置变更，超出本 PRD 范围；即使做了 Redis 持久化，FR-STORAGE-1-1 的清理任务仍然需要（自然过期这条路径始终存在，跟 Redis 是否持久化无关）。

---

## 4. 待确认问题

- **附件元数据表的具体形态**：新建独立的 `chat_attachments` 表，还是复用/扩展现有消息模型里的字段？取决于消息记录现在持久化 `attachments` 时具体存了什么（只是 attach_id 列表，还是已经带完整 meta）——需要先读 `ConversationMessage`（或对应模型）的实际字段再定。
- **草稿孤儿的 TTL 要不要缩短**：现在草稿阶段（未发送）用的还是 7 天，是否偏长？草稿本来就是"发出去之前"的中间态，正常应该是分钟到小时级别，7 天更多是历史遗留值，可以考虑缩短到比如 24-48 小时。
- **安全网扫描的频率和阈值**：第 5 节草案给的是"每周一次、90 天阈值"，是否合适，取决于级联清理逻辑本身的可信度——如果级联清理经过一段时间验证很少漏，阈值可以放宽；如果发现漏得多，可能需要提高频率或缩短阈值先兜住风险。
- 视频转码缓存的 TTL 具体取多久：先按 `chat_attach.TTL`（7 天）落地，还是需要更长/更短？建议先上线观察实际命中率和存储占用再调整。
- `.video_cache/` 的转码产物是否需要按用户设置存储配额上限（防止极端情况下缓存本身占用过多空间）？本 PRD 暂不引入，后续如有需要再评估。

---

## 5. 实施计划

拆两个独立 PR：Phase A（清理任务）不依赖 Phase B（转码缓存），可以先落地、单独上线验证；Phase B 落地时复用 Phase A 已经跑通的清理任务，只是把 `.video_cache/` 加进扫描前缀。

### Phase A：附件生命周期绑定消息/会话（对应 FR-STORAGE-1-1 v2）

> v1（定时按物理 mtime 扫描 + 固定 TTL）已实现过一次并 revert（commit `dece7584` → `e63014a9`），原因见第 1.3 节。以下是 v2 草案，落地前建议先把第 4 节"附件元数据表的具体形态"这个待确认问题定下来。

1. **先确认现状**：读 `ConversationMessage`（或实际的消息模型）现在怎么持久化 `attachments` 字段——是完整 meta 快照，还是只有 attach_id 列表、依赖运行时再查 Redis 补全。这决定第 2 步是"新建表"还是"抽取已有数据"。
2. **新增附件元数据表**（如 `chat_attachments`：`attach_id`、`user_id`、`session_id`、`message_id`、`storage_key`、`name`、`ext`、`mime`、`kind`、`size`、`duration`、`img_width`、`img_height`、`created_at`）：消息真正发送落库时，把 `resolve_for_message` 已经查到的 meta 写进这张表，跟消息/会话建立外键关联。
3. **`/thumb`、`/download`、`/preview-pdf`（`app/api/v1/agent.py:68-142`）改造**：`get_meta()` 优先查 Redis（草稿阶段快路径），未命中时回退查新的 DB 表（已发送附件的长期真相来源）。
4. **`delete_session`（`app/api/v1/agent.py:356`）加级联清理**：删除前查出该会话下所有关联的 `storage_key`，`db.delete(session)` 之后（或同一事务内）对每个 key 调 `storage.delete()`，并删除对应的附件元数据行（若用外键 `ON DELETE CASCADE` 可以让 DB 自动处理元数据行，存储字节仍需要应用层显式删除）。
5. **草稿孤儿兜底清理**（沿用 v1 的 `list_keys()` + `stat()` + `delete()` 思路，新增一步过滤）：`sweep_expired_staging()` 扫 `.chat_staging/`/`.voice/`，对每个超过短 TTL 的 key，先查步骤 2 的元数据表确认它**没有**被任何消息引用，确认后才删除——避免误删"已发送但表还没来得及写"的边界情况（比如可以要求 Redis 元数据和 DB 元数据在写入 DB 后才允许被这个任务碰）。
6. **发送失败时及时清理**：新增按 `attach_id` 删除单个暂存附件的接口（`clear_staged()` 全量清空之外的细粒度版本）；前端在发送消息失败时立刻调用，删除本次请求关联的草稿附件。降低草稿孤儿产生速度，但不能覆盖"上传后直接关标签页/崩溃/断网"这类没有失败信号的场景，步骤 5 的定时兜底依然需要。
7. **安全网扫描**（低频、大阈值）：定期交叉检查 DB 附件表和实际存储对象，两个方向都要看：① DB 有记录但存储对象已经不存在（级联删除漏了存储层，或者反过来数据不一致）；② 存储对象存在但 DB 无记录、且不是最近写入的草稿（真孤儿，兜底删除）。
8. **并发保护**：沿用 `agent/memory` scope 锁的模式。
9. **测试**（新增 `tests/test_staging_gc.py`、附件元数据表相关的模型测试、`delete_session` 级联清理的集成测试、单个附件删除接口的测试）：见第 6.1 节。
10. **上线验证**：见第 6.2 节。

### Phase B：视频转码结果缓存（对应 FR-STORAGE-1-2）

1. **`app/core/chat_attach.py` 新增缓存读写 helper**（紧邻 `prepare_video_media`）：
   - `_video_cache_key(storage_key: str) -> str`：从 `storage_key` 派生一个安全的 Redis key 后缀（比如对 `storage_key` 做 `hashlib.sha256` 摘要，避免中文/特殊字符直接拼进 Redis key）。
   - `_video_cache_redis_key(storage_key) -> str`：如 `f"video_cache:{_video_cache_key(storage_key)}"`。
2. **`prepare_video_media()` 改造**（新增可选参数 `storage_key: str | None = None`，`resolve_for_message`/`read_video` 两个调用方都能传）：
   - 有 `storage_key` 时，函数开头先查 Redis 指针；命中就 `get_storage().get(cached_path)` 读缓存产物直接走 base64/mm_file 判断（复用现有的最终 payload 三分逻辑，不用重新探测/转码），命中同时 `EXPIRE` 刷新 TTL。
   - 未命中或没传 `storage_key`（比如聊天附件路径 `attach_id` 每次都不同，天然没有稳定 key 可缓存，可以先只给 `read_video` 接，聊天附件路径不接）走原有探测+转码逻辑；转码成功后，把产物 `put` 到 `{uid}/.video_cache/{cache_key}.mp4`，再 `SET` 一条 Redis 指针带 TTL。
   - **注意**：`prepare_video_media` 当前不知道 `user_id`（只有 `raw`/`mime`/`name`/`model_cfg`），缓存路径需要 `{uid}/...` 前缀，需要额外传 `user_id` 参数——两个调用方（`resolve_for_message` 有 `user_id`、`read_video` 有 `file.user_id`）都能提供，属于最小的签名扩展。
3. **`agent/tools/file_readers.py` 的 `read_video`**：调用 `prepare_video_media` 时补上 `storage_key=file.storage_key, user_id=file.user_id`。
4. **Phase A 的 `sweep_expired_staging()` 扩展**：新增 `.video_cache/` 前缀扫描分支，删除前先查一次对应 Redis 指针（`GET`，不用 `EXPIRE`），指针存在则跳过本次删除（见 FR-STORAGE-1-2 的双向校验说明）；这是 `.video_cache/` 特有的分支，`.chat_staging/`/`.voice/` 不做这一步。
5. **测试**：
   - `prepare_video_media` 缓存命中：mock `_compress_video`/`_probe_video`，第一次调用产生缓存，第二次调用同一 `storage_key` 断言没有再调 `_probe_video`/`_compress_video`。
   - `storage_key` 变化（模拟覆盖上传后重新暂存/上传）不命中旧缓存。
   - 缓存命中时验证对应 Redis key 的 TTL 被刷新（`ttl()` 前后对比，或 mock `EXPIRE` 调用次数）。
   - `sweep_expired_staging()` 对 `.video_cache/` 的双向校验：Redis 指针还在时不删物理年龄超期的对象；指针已经不在时正常删除。
6. **上线验证**：devserver 上让咕咕连续两次读同一个视频，通过日志或手动查 Redis（`GET video_cache:<hash>`）确认第二次命中缓存、没有再触发 ffmpeg 转码。

---

## 6. 测试目标

### 6.1 自动化测试

**Phase A**：

- [ ] 消息发送时，附件元数据表被正确写入一条记录，字段跟 `resolve_for_message` 查到的 meta 一致。
- [ ] `/thumb`、`/download`、`/preview-pdf`：Redis 元数据过期/不存在时，能从 DB 表正确回退拿到 meta 并返回内容（模拟"7 天后再打开历史消息"场景）。
- [ ] `delete_session`：会话下有 2 条消息各引用 1 个附件，删除会话后，两个附件的存储对象和元数据行都应该消失；不属于这个会话的附件不受影响。
- [ ] 草稿孤儿清理：`.chat_staging/` 下一个从未被任何消息引用、且超过草稿 TTL 的对象会被清理；一个已经被某条消息引用（DB 表里有记录）但物理 mtime 同样超过草稿 TTL 的对象**不会**被清理。
- [ ] 单个附件删除接口：按 `attach_id` 删除后，对应的存储对象和 Redis 元数据都消失，同用户/同请求下的其他草稿附件不受影响；删除一个不存在或已经不属于当前用户的 `attach_id` 应该返回明确的错误而不是静默成功。
- [ ] 空存储 / 无草稿孤儿时清理任务正常返回 `0`，不报错；`stat()` 返回 `mtime=None` 时跳过不删。
- [ ] 并发保护：Redis 锁已被占用时清理任务直接返回、不执行任何删除。
- [ ] 安全网扫描：DB 有记录但存储对象缺失、存储对象存在但 DB 无记录且非最近写入，两种不一致场景都能被正确识别（不要求这一步一定要做删除动作，先要求能正确识别/上报）。

**Phase B（`tests/test_chat_attach_video.py` 补 `prepare_video_media` 缓存分支 + `test_staging_gc.py` 补 `.video_cache/` 分支）**：

- [ ] 首次调用 `prepare_video_media(..., storage_key=..., user_id=...)` 无缓存，正常走探测+转码，之后能在存储里读到 `.video_cache/{cache_key}.mp4` 和对应 Redis 指针。
- [ ] 同一 `storage_key` 第二次调用命中缓存：mock `_probe_video`/`_compress_video` 断言**没有被调用**，直接返回上次的媒体项。
- [ ] 命中缓存时对应 Redis key 的 TTL 被刷新（断言 `EXPIRE`/`SET ... ex=` 被调用，或前后 `ttl()` 值变化）。
- [ ] `storage_key` 变化（模拟覆盖上传产生新 key）不命中旧缓存，重新走探测+转码。
- [ ] 未传 `storage_key`（聊天附件路径）完全不查/不写缓存，行为跟 Phase A 落地前一致（防止误伤现有聊天附件视频路径）。
- [ ] `sweep_expired_staging()` 对 `.video_cache/` 的双向校验：Redis 指针还在且未过期时，物理 mtime 超期的缓存对象**不删**；Redis 指针已经不存在（或已过期）时正常按物理年龄删除。

### 6.2 手动测试（devserver）

**Phase A 上线前**：

- [ ] 发一张图片给咕咕（正常发送，非草稿），刷新页面，确认气泡里的图片正常显示（走的是新的 Redis→DB 回退路径，不是靠 objectURL）。
- [ ] 手动把这条附件的 Redis 元数据删掉（模拟过期/重启丢失），再刷新，确认图片依然正常显示（证明真的从 DB 拿到了 meta，不是巧合还没过期）。
- [ ] 删除这条消息所在的整个会话，检查存储里对应的 storage_key 确实被删除了（不再残留孤儿字节）。
- [ ] 上传一张图片但**不发送**（只调用暂存接口），等草稿 TTL 过期后跑一次清理任务，确认这个从未发送的草稿被清理掉了。
- [ ] 挂上定时任务后，观察 `app/core/scheduler.py` 的启动日志确认相关 job 被正确注册。
- [ ] 观察一次真实的低峰自动运行（不手动触发），确认定时触发本身工作正常，不只是手动调用路径可用。

**Phase B 上线前**：

- [ ] 让咕咕读一个文件库里的视频（MiniMax M3 模型），记录这次转码耗时。
- [ ] 立刻再让咕咕读同一个视频，确认响应明显更快（跳过了转码），日志里能看到"缓存命中"相关记录（需要在实现里加一条诊断日志，比如 `diag_log_raw("chat_attach.video_cache_hit", ...)`）。
- [ ] 把这个视频文件重命名/覆盖上传替换内容后，再次读取，确认走的是全新转码（没有错误地命中旧缓存）。
- [ ] 手动查 Redis（`GET video_cache:<hash>`、`TTL video_cache:<hash>`）确认命中后 TTL 确实被刷新，不是原地不动。
- [ ] 用一个超过 90MB 触发 mm_file 分支的视频重复上述流程，确认 mm_file 场景下缓存同样生效（不只是 base64 场景测过）。
- [ ] 观察一段时间后 `.video_cache/` 目录的存储占用增长趋势，判断第 4 节里悬而未决的"是否需要配额上限"问题是否需要提前处理。
