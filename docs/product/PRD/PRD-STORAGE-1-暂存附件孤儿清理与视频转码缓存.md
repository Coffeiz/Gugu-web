# 暂存附件孤儿清理与视频转码缓存 PRD

> 状态：🔲 待评估（问题已排查确认，方案已对齐，实施步骤已拆解，未开始实现）
> 创建：2026-08-08
> 最近更新：2026-08-08
> 关联模块：`backend/app/core/chat_attach.py`、`backend/app/services/storage/__init__.py`、`backend/app/core/scheduler.py`、`backend/app/core/chat_attach.py`（`prepare_video_media`）
> 背景参考：PRD-LLM-3（`read_file` 视频理解重构）实现过程中，排查视频转码临时文件该放哪里时，顺带发现 `.chat_staging/`/`.voice/` 存储字节从未被真正清理过，是一个独立于视频功能、更早就存在的问题；两个问题的清理机制可以复用同一套"按物理年龄扫存储"基础设施，一并纳入本 PRD。

---

## 0. 实施状态

| 阶段 | 状态 | 说明 |
|---|---|---|
| Phase 0：问题排查 | ✅ 已完成 | 确认 `.chat_staging/`/`.voice/` 存储字节存在真实孤儿泄漏（见第 1 节），且 Redis 数据丢失（容器重建/无持久化）会让泄漏立刻大面积发生，不只是自然 7 天过期这一种触发方式。 |
| Phase 1：方案设计 | ✅ 已完成 | 确定用"定时扫存储、按物理 mtime 判断年龄"的清理任务，不依赖 Redis 状态、不跟进程重启绑定；视频转码缓存复用同一套存储层清理设施，但用 Redis TTL（读时刷新）单独管理生命周期。见第 2、3 节。 |
| Phase 2：实施 | 🔲 待评估 | 见第 5 节实施计划（拆 Phase A 清理任务 / Phase B 转码缓存两个独立 PR）。 |

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

---

## 5. 实施计划

拆两个独立 PR：Phase A（清理任务）不依赖 Phase B（转码缓存），可以先落地、单独上线验证；Phase B 落地时复用 Phase A 已经跑通的清理任务，只是把 `.video_cache/` 加进扫描前缀。

### Phase A：暂存附件按物理年龄定时清理（对应 FR-STORAGE-1-1）

1. **`app/services/storage/__init__.py`**：`StorageBackend` 补一个 `list_dirs`/年龄相关的能力已经有了（`stat()` 返回 `mtime`、`list_keys()` 已存在），本阶段不需要新增存储层接口，直接复用现有的 `list_keys()` + `stat()` + `delete()` 三个方法组合即可。
2. **新增 `app/services/storage/staging_gc.py`**（或直接放 `app/core/chat_attach.py` 底部，视代码量决定）：
   - `async def sweep_expired_staging() -> int`：调 `get_storage().list_keys()` 拿全量 key，用正则/字符串匹配过滤出路径含 `/.chat_staging/` 或 `/.voice/` 的 key（参考 `app/api/v1/config.py:93` 的判断写法：`".chat_staging" in k`）。
   - 对每个命中的 key 调 `stat()`；`mtime` 为 `None`（OSS 极端情况）时跳过、不删（保守，避免误删）。
   - `now_utc().timestamp() - mtime > ttl` 才 `delete(key)`；`.chat_staging/` 用 `chat_attach.TTL`，`.voice/` 用 `chat_attach.TTL_VOICE`（按路径分支取对应 TTL，不要两者统一取一个值）。
   - 返回删除数量，供任务日志/未来做监控埋点用。
3. **并发保护**：函数开头用 `get_redis().set(lock_key, "1", nx=True, ex=<预估最长运行时间，比如 1800>)` 抢锁，抢不到直接 `return 0`（同一时刻只有一个进程真正执行扫描），跑完主动 `delete(lock_key)`（同 `agent/memory` scope 锁的加锁/释放模式，不需要引入新的锁抽象）。
4. **接入 `app/core/scheduler.py`**：在 worker 启动路径里 `@scheduler.register(scheduler.cron(hour=4, minute=0), id="staging_gc", name="暂存附件孤儿清理")` 包一层薄封装调用 `sweep_expired_staging()`；凌晨低峰跑，避开白天的存储 I/O 高峰。
5. **测试**（新增 `tests/test_staging_gc.py`，参考 `tests/test_storage_cleanup.py` 的 `LocalStorageBackend` + `tmp_path` fixture 风格）：
   - 造 3 个 `.chat_staging/` 对象，其中 1 个手动改 mtime 到 TTL 之外（`os.utime`），断言只删了这 1 个。
   - 造 `.voice/` 对象验证走的是 `TTL_VOICE` 而不是普通 `TTL`（构造一个 mtime 落在两个阈值之间的用例）。
   - 非 `.chat_staging/`/`.voice/` 路径下的对象（比如用户正常上传的文件）不受影响，即使 mtime 很老。
   - 并发保护：模拟锁已被占用时 `sweep_expired_staging()` 直接返回 0、不执行任何删除。
6. **上线验证**：先在 devserver 手动跑一次 `sweep_expired_staging()`（复用本次手动清理时验证过的口径：`.chat_staging`/`.voice` 从 1.4G 降到 598M 左右），确认跟手动 `find -mtime +7 -delete` 的结果一致，再挂上定时任务。

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

**Phase A（`tests/test_staging_gc.py`，仿 `tests/test_storage_cleanup.py` 用 `LocalStorageBackend` + `tmp_path`）**：

- [ ] 混合放 3 个 `.chat_staging/` 对象，其中 1 个用 `os.utime` 改到 TTL 之外，`sweep_expired_staging()` 后只有那 1 个被删，另外 2 个还在。
- [ ] `.voice/` 对象走 `TTL_VOICE`：构造一个 mtime 落在「超过 `TTL_VOICE` 但没超过普通 `TTL`」区间的用例（如果两个常量当前相等，先把测试写成显式断言「用的是 `TTL_VOICE` 这个变量」而不是巧合碰到同一个值，防止以后两个 TTL 改成不同值时测试才发现改错了分支）。
- [ ] 非 `.chat_staging/`/`.voice/` 路径下的对象（用户文件库正常上传的文件）即使 mtime 很老也不被清理任务碰。
- [ ] 空存储 / 不存在任何 `.chat_staging`/`.voice` 对象时 `sweep_expired_staging()` 正常返回 `0`，不报错。
- [ ] `stat()` 返回 `mtime=None`（OSS 极端情况）的对象被跳过、不删。
- [ ] 并发保护：Redis 锁已被占用时 `sweep_expired_staging()` 直接返回 `0`、不执行任何 `list_keys()`/`delete()` 调用（mock 锁 `SETNX` 失败）。
- [ ] 返回值：删除数量与实际删除的 key 数一致，可以用来断言/后续接监控。

**Phase B（`tests/test_chat_attach_video.py` 补 `prepare_video_media` 缓存分支 + `test_staging_gc.py` 补 `.video_cache/` 分支）**：

- [ ] 首次调用 `prepare_video_media(..., storage_key=..., user_id=...)` 无缓存，正常走探测+转码，之后能在存储里读到 `.video_cache/{cache_key}.mp4` 和对应 Redis 指针。
- [ ] 同一 `storage_key` 第二次调用命中缓存：mock `_probe_video`/`_compress_video` 断言**没有被调用**，直接返回上次的媒体项。
- [ ] 命中缓存时对应 Redis key 的 TTL 被刷新（断言 `EXPIRE`/`SET ... ex=` 被调用，或前后 `ttl()` 值变化）。
- [ ] `storage_key` 变化（模拟覆盖上传产生新 key）不命中旧缓存，重新走探测+转码。
- [ ] 未传 `storage_key`（聊天附件路径）完全不查/不写缓存，行为跟 Phase A 落地前一致（防止误伤现有聊天附件视频路径）。
- [ ] `sweep_expired_staging()` 对 `.video_cache/` 的双向校验：Redis 指针还在且未过期时，物理 mtime 超期的缓存对象**不删**；Redis 指针已经不存在（或已过期）时正常按物理年龄删除。

### 6.2 手动测试（devserver）

**Phase A 上线前**：

- [ ] 先手动跑一次 `sweep_expired_staging()`（脚本或临时加一个内部 API/CLI 入口），核对删除数量和释放空间与本次人工排查时用 `find -mtime +7` 得到的口径一致（`.chat_staging`/`.voice` 从约 1.4G 降到约 598M）。
- [ ] 挂上定时任务后，观察 `app/core/scheduler.py` 的启动日志确认 `staging_gc` job 被正确注册（`[scheduler] started` 那条日志里能看到 job id）。
- [ ] 手动改一个测试附件的物理 mtime 到 8 天前，等定时任务跑一轮（或手动触发），确认它被清掉；同时确认一个 3 天前的附件不受影响。
- [ ] 确认清理任务运行期间不影响正常的附件暂存/读取（发一张图片给咕咕，清理任务跑的同时正常引用这张图片不受影响）。
- [ ] 观察一次真实的凌晨自动运行（不手动触发），确认定时触发本身工作正常，不只是手动调用路径可用。

**Phase B 上线前**：

- [ ] 让咕咕读一个文件库里的视频（MiniMax M3 模型），记录这次转码耗时。
- [ ] 立刻再让咕咕读同一个视频，确认响应明显更快（跳过了转码），日志里能看到"缓存命中"相关记录（需要在实现里加一条诊断日志，比如 `diag_log_raw("chat_attach.video_cache_hit", ...)`）。
- [ ] 把这个视频文件重命名/覆盖上传替换内容后，再次读取，确认走的是全新转码（没有错误地命中旧缓存）。
- [ ] 手动查 Redis（`GET video_cache:<hash>`、`TTL video_cache:<hash>`）确认命中后 TTL 确实被刷新，不是原地不动。
- [ ] 用一个超过 90MB 触发 mm_file 分支的视频重复上述流程，确认 mm_file 场景下缓存同样生效（不只是 base64 场景测过）。
- [ ] 观察一段时间后 `.video_cache/` 目录的存储占用增长趋势，判断第 4 节里悬而未决的"是否需要配额上限"问题是否需要提前处理。
