# 暂存附件孤儿清理与视频转码缓存 PRD

> 状态：🔲 待评估（问题已排查确认，方案已对齐，未开始实现）
> 创建：2026-08-08
> 关联模块：`backend/app/core/chat_attach.py`、`backend/app/services/storage/__init__.py`、`backend/app/core/scheduler.py`、`backend/app/core/chat_attach.py`（`prepare_video_media`）
> 背景参考：PRD-LLM-3（`read_file` 视频理解重构）实现过程中，排查视频转码临时文件该放哪里时，顺带发现 `.chat_staging/`/`.voice/` 存储字节从未被真正清理过，是一个独立于视频功能、更早就存在的问题；两个问题的清理机制可以复用同一套"按物理年龄扫存储"基础设施，一并纳入本 PRD。

---

## 0. 实施状态

| 阶段 | 状态 | 说明 |
|---|---|---|
| Phase 0：问题排查 | ✅ 已完成 | 确认 `.chat_staging/`/`.voice/` 存储字节存在真实孤儿泄漏（见第 1 节），且 Redis 数据丢失（容器重建/无持久化）会让泄漏立刻大面积发生，不只是自然 7 天过期这一种触发方式。 |
| Phase 1：方案设计 | ✅ 已完成 | 确定用"定时扫存储、按物理 mtime 判断年龄"的清理任务，不依赖 Redis 状态、不跟进程重启绑定；视频转码缓存复用同一套存储层清理设施，但用 Redis TTL（读时刷新）单独管理生命周期。见第 2、3 节。 |
| Phase 2：实施 | 🔲 待评估 | 见第 6 节实施计划。 |

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

### 1.3 视频转码缓存（新增能力，非 bug）

PRD-LLM-3 的 `prepare_video_media()`（`chat_attach.py`）每次调用都会重新探测（ffprobe）+ 转码（ffmpeg）视频——`read_file` 场景下，用户可能反复让咕咕"再看一遍"同一个视频，每次都要重新跑一次可能耗时数十秒的转码，纯粹浪费 CPU 和等待时间。目标是把转码结果缓存下来，按 `storage_key` 命中直接复用。

---

## 2. 功能需求

### FR-STORAGE-1-1：暂存附件按物理年龄定时清理（🔲 待评估）

- 新增一个定时任务（挂 `app/core/scheduler.py` 现有的 `register`/`cron` 机制），周期建议每天一次。
- 任务逻辑：`list_keys()` 枚举全存储，过滤出路径包含 `.chat_staging/` 或 `.voice/` 的 key（`config.py:93` 已有类似的路径过滤写法可参考），对每个 key 调 `stat()` 拿 `mtime`；`now - mtime` 超过对应 TTL（`chat_attach.TTL`/`chat_attach.TTL_VOICE`，目前都是 7 天）就直接 `storage.delete(key)`。
- **不读 Redis、不依赖任何"这个附件是否还被引用"的状态判断**——纯粹按物理写入时间算年龄。这是刻意的简化：
  - 覆盖"自然过期后 Redis 有没有被清"和"Redis 数据整体丢失"两种触发方式，用同一套逻辑，不需要区分场景。
  - 用户最近读取/查看过某个暂存附件**不会**延长它的寿命——`stat()` 的 mtime 只在写入时打上，`get()` 读取不会更新它；这跟现有 Redis TTL 语义一致（`get_meta()` 读取时也不会刷新 Redis key 的 TTL），是延续既有产品语义（"暂存 7 天，过期不管用没用过都清"），不是行为变化。
- 并发保护：backend/worker 两个进程都会加载 `scheduler.py` 的任务注册，跑之前用 Redis 锁（`SET NX EX`，同 `agent/memory` scope 锁的模式）防止两边同时触发一次全量扫描。
- 验收标准：清理任务运行后，`.chat_staging/`/`.voice/` 下不应存在 `mtime` 超过 TTL 的对象；未过期对象不受影响。

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
- **不改变 `.chat_staging`/`.voice` 的产品语义**：仍然是"暂存 N 天，过期清"，不引入"最近用过就续命"的行为——本 PRD 只是把"7 天后应该被清理"这件事从"完全没人执行"变成"真的会被执行"，不改变用户能感知到的暂存期限。
- **不搭建 Redis 持久化**（AOF/RDB volume 挂载）：这属于基础设施配置变更，超出本 PRD 范围；即使做了 Redis 持久化，FR-STORAGE-1-1 的清理任务仍然需要（自然过期这条路径始终存在，跟 Redis 是否持久化无关）。

---

## 4. 待确认问题

- 视频转码缓存的 TTL 具体取多久：先按 `chat_attach.TTL`（7 天）落地，还是需要更长/更短？建议先上线观察实际命中率和存储占用再调整。
- 清理任务的运行频率：每天一次是否够用，还是需要更高频（比如每小时）？取决于孤儿文件的产生速度和存储成本敏感度，建议先每天一次，观察存储增长曲线后再调整。
- `.video_cache/` 的转码产物是否需要按用户设置存储配额上限（防止极端情况下缓存本身占用过多空间）？本 PRD 暂不引入，后续如有需要再评估。
