# RAG 索引 revision 不一致自愈重试 + 内部异常对外文案

日期：2026-09-11
关联：`backend/agent/rag/ts_sidecar.py`、`backend/agent/rag/index_cache.py`、`backend/agent/rag/batch_retriever.py`、`backend/agent/tools/tool_contract.py`、`backend/agent/tools/base.py`、`backend/app/core/rag_index_gc.py`

## 现象

QQ 链路上用户看到工具回执里出现 `TsSidecarUnavailable`，模型据此判断「索引服务挂了 / 知识层为空」，
并进一步劝用户不要重试。真实原因是 TS worker 的 `revision_mismatch` 守卫：同一个 owner 的 worker
`state.revision` 是单槽，会话快照版（`snapshot:4909` 这类）与 DB 投影版
（`ts-jieba-words-v3:conversation:...` 这类）两个命名空间互相推进，缓存里冻结了旧 revision 的索引
对象再拿去查询就会被 worker 拒绝。

devserver 磁盘证据：

- `019eec39-4f5e-…0b640a8`：46 MB、`revision=4909`（快照版）、mtime 14:33:58 —— 正是故障爆发前的那次全量重写。
- `019eec39-4f60-…17bf22`：8 KB、`revision=ts-jieba-words-v3:…`（DB 投影版）、且 `version=0.2.0`。

## 修复

### 一、RAG 层接住 `revision_mismatch` 做一次重建 + 重试

- `TsSidecarUnavailable` 新增 `code` 字段（`ts_sidecar.py`），worker 的机器可读错误码随异常带出，
  调用方不再靠匹配中文文案判断故障类型。
- `KnowledgeIndexCache` 新增 `get(force=True)` 与 `resync()`：`force` 跳过全部复用捷径（快照快路径、
  磁盘恢复、revision 复用、增量合并），按当前 revision 全量 replace 一次；`resync` 先
  `invalidate(include_snapshot=True)`（快照条目正是冻结旧 revision 的那一类，不清就永远走快路径被拒），
  再 `force` 重载。
- `UnifiedQueryRetriever` 捕获 `TsSidecarUnavailable`：仅当 `code == "revision_mismatch"` 时
  `_resync_and_retry` 重同步并按原参数重试**一次**，同时以 `force=True` 强制重传瞬态语料
  （进程内指纹短路此刻不可信）。第二次仍失败则按原错误抛出，不把重试变成风暴；
  非 revision 类错误直接抛出，真实故障不被掩盖。

顺带修掉一个同族隐患：`_request_unlocked` 原先无条件把响应的 `revision` 写进 `self._revision`，
而 `replace_transient` 返回的是**瞬态槽指纹**，会把客户端误标成「持久索引已同步」，让后续查询
退化。现在只有非 `replace_transient` 的响应才更新 `_revision`。

### 二、内部异常对外换人话，类名只进 gugu-diag.log

`tool_contract.internal_error_text()` 维护「已登记内部异常 → 对外人话」映射
（当前仅 `TsSidecarUnavailable` →「知识检索索引正在重建，暂时不可用；请稍后重试，不要重复提交同一查询。」）。
`tools/base.py` 的 dispatch 错误边界对已登记类型只把这句话写进 `_log.error` / `_log_traj` / 模型载荷，
原始异常仍完整进 `diag_log`；未登记类型保持原格式（类名是模型判断「改参数还是等恢复」的唯一线索，不能抹掉）。

### 三、重建/升级后清理旧版本索引

`rag_index_gc` 原先只按 30 天 TTL 清理。现在 `_is_stale_index_dir` 追加版本戳判定：读 `index.json`
头部 8 KB（`version` 是 `JSON.stringify` 的第一个字段，不能为了取版本戳解析几十 MB 文件），
比当前制品版本**严格更旧**即视为死数据直接删——旧制品写下的索引当前 worker 恢复时会判
`version_mismatch` 丢弃重建，不会再有复用价值。只清更旧的版本而不清「不同」：制品回滚时新版本
写下的索引仍然有效，删掉只会让升级回去时所有活跃用户冷重建。取不到制品版本、索引无版本戳，
或版本串解析不出数字段时一律按「未知」处理，只走 TTL，不因比对不了就删数据；
active 目录、`index.json.tmp` 仍受保护。

## 验证

- 单元测试：worker error 响应带 `code`（无 `code` 时为 None）、瞬态响应不覆盖 `_revision`、
  `replace_transient(force=True)` 跳过指纹短路、`worker_artifact_version` 读制品/回退/未知三态、
  resync+retry 只重试一次（第二次仍失败原样抛出、非 revision 错误不重同步）、GC 旧版本删除与
  未知版本/更高版本保留、版本串不可解析时不猜大小、`internal_error_text` 映射与 dispatch 边界的对外文案。
- 后端全量 `2516 passed`。
- devserver 真机：对受影响用户走完整 `search_knowledge`（46 MB 索引）返回 2/3 条结果，engine=typescript，
  无 `TsSidecarUnavailable`。
- devserver 真机探针（临时目录，用后已删）：先用 `rev-A` 建索引再推进到 `rev-B`，拿 `rev-A` 的索引对象查询
  → `TsSidecarUnavailable.code == "revision_mismatch"`；按当前 revision 重建索引对象重试 → `status=ok`、
  `selected=1`，与 `_resync_and_retry` 的重同步语义一致。
- devserver 手动跑一次 `sweep_ts_index_cache()`：删除 77 个目录（76 个遗留 `backend/var/rag-ts-index` 过期目录
  + 1 个 `version=0.2.0` 旧版本索引），当前版本的 46 MB 活跃索引保留。
