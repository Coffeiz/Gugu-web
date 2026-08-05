# QQ raw HTTP 发送侧生产验证 PRD

> 状态：🔲 待验证
> 创建：2026-08-06
> 最近更新：2026-08-06
> 关联模块：`backend/agent/gateway/qq.py`（`send_c2c`/`send_group`/`send_file`/`_send_token`/`_qq_request`）
> 关联文档：[`【已完成】PRD-IM-1-im接入稳定性与qq自建websocket.md`](./【已完成】PRD-IM-1-im接入稳定性与qq自建websocket.md)（Phase 3，代码已完成，本 PRD 只跟踪生产环境端到端验证与并发加固）

---

## 0. 实施状态

| 阶段 | 状态 | 说明 |
|---|---|---|
| 代码实现（PRD-IM-1 Phase 3） | ✅ 已完成 | `send_c2c`/`send_group`/`send_file` 已全部改为 raw HTTP 直连 QQ Bot API，botpy 依赖已完全移除；本地 mock 测试覆盖 markdown 回退、401 重试清缓存、token 缓存复用、URL/base64 发文件，`83 passed`。 |
| 真实 QQ 环境端到端验证 | 🔲 待验证 | 文本、Markdown 回退、URL/base64 发文件、群消息四条路径均未在真实 QQ Bot API 上跑过；仅本地 mock 覆盖，无法确认真实响应结构、限流行为和权限报错码与 mock 假设一致。 |
| `_send_tokens` 并发加锁 | 🔲 待做 | 同一 `channel_id` 并发首次请求可能同时判定 token 缓存未命中，重复调用 `_qq_access_token_with_ttl()` 取新 token；不影响正确性（QQ 允许同时存在多个有效 token），但浪费一次调用，高并发下有触发 QQ 侧限流的风险。 |

---

## 1. 背景与目标

[`PRD-IM-1`](./【已完成】PRD-IM-1-im接入稳定性与qq自建websocket.md) Phase 3 把 QQ 发送侧从 botpy 全部改成 raw HTTP 直连（`_qq_request()` + 按 `channel_id` 缓存 access token），并彻底移除了 `qq-botpy` 依赖。这部分代码已经合并、本地测试全过，且实际上是当前生产环境唯一的 QQ 发送路径（没有回退开关）——但当时是在**未经过 3-7 天灰度期就直接实施**的情况下上线的，且从未在真实 QQ Bot API 上做过端到端验证，只有本地 mock 测试覆盖。

把这部分单独拆出来跟踪，是因为：

1. 它不是"要不要做"的问题——代码已经在生产跑着，无法回退到 botpy（依赖已删除）。真正悬而未决的是"验证过没有"。
2. 验证需要真实 QQ Bot 环境（sandbox 或已备案的生产 Bot），跟 PRD-IM-1 其余已完成、已验证的部分放在一起容易让人误以为发送侧也已验证过。
3. `_send_tokens` 无锁这个已知的小风险，修复成本低，适合和验证一起收尾。

### 不做什么

- 不重新引入 botpy 作为回退选项——raw HTTP 已是唯一路径，回退成本高于直接修复。
- 不改变现有 `send_c2c`/`send_group`/`send_file` 对外签名，验证发现的问题优先在现有实现内修，不重新设计协议层。

---

## 2. 功能需求

### FR-QQ-1：真实环境端到端验证（🔲 待验证）

在真实 QQ Bot（优先 sandbox，如无 sandbox 权限则用已备案生产 Bot 的低峰时段）上依次验证：

- 文本消息：C2C 与群聊各发一条，确认 `msg_seq`/`msg_id` 正确、被动回复窗口内成功、超窗口后主动消息降级正常（`_qq_msg_id_invalid` 命中路径）。
- Markdown 回退：对未开通 markdown 权限的 Bot 发送，确认 `_markdown_blocked()` 正确识别真实错误码（`50056`/`40034012`）并回退纯文本，而不是本地 mock 里手工构造的假响应。
- 文件发送：URL 模式与 base64 模式各发一次图片/文件，确认真实响应结构与 `send_file()` 解析逻辑一致。
- 群消息：`_post_group()` 全流程，包括 markdown 回退分支。
- 401 重试：人为让缓存 token 失效（或等待自然过期），确认 `_qq_request()` 清缓存重试一次后成功，且不会死循环（`retry_on_401` 只允许一次）。

验收标准：以上 5 类场景各至少成功跑通一次，并在 [`docs/ops/known-issues.md`](../../ops/known-issues.md) 记录真实响应体结构与 mock 假设的任何出入。

### FR-QQ-2：`_send_tokens` 并发加锁（🔲 待做）

`_send_token()` 当前是纯内存字典读写，无锁保护。同一 `channel_id` 下多个协程并发调用、同时判定缓存未命中时，会各自发起一次 `_qq_access_token_with_ttl()` 请求。

预期行为：按 `channel_id` 加一把轻量协程锁（`asyncio.Lock`，字典存 `channel_id -> Lock`），确保同一 `channel_id` 同时只有一个协程在刷新 token，其余等待锁释放后直接复用刚写入的缓存。

验收标准：并发单测模拟同一 `channel_id` 同时 10 次调用 `_send_token()`，断言底层 `_qq_access_token_with_ttl()` 只被调用一次。

---

## 3. 技术方案

### 3.1 端到端验证

不改代码，只是在真实环境跑一遍 FR-QQ-1 列出的场景并记录结果。如果发现真实响应结构与现有解析逻辑不一致，再按发现的具体问题修代码（不在本 PRD 预先设计）。

### 3.2 `_send_tokens` 加锁

```python
_send_token_locks: dict[str, asyncio.Lock] = {}

async def _send_token(channel_id: str) -> tuple[str, str]:
    cached = _send_tokens.get(channel_id)
    now = time.time()
    if cached and now < cached["expires_at"] - _QQ_TOKEN_SAFETY_MARGIN:
        return cached["token"], cached["base"]
    lock = _send_token_locks.setdefault(channel_id, asyncio.Lock())
    async with lock:
        # 双重检查：等锁期间可能已被另一协程刷新
        cached = _send_tokens.get(channel_id)
        if cached and now < cached["expires_at"] - _QQ_TOKEN_SAFETY_MARGIN:
            return cached["token"], cached["base"]
        ...（原有取 token 逻辑）
```

`_send_token_locks` 字典本身不会清理（channel_id 数量等于绑定的 Bot 数，量级很小，可接受）。

---

## 4. 验证与上线

- FR-QQ-1 是人工端到端验证，不是自动化测试能覆盖的范围；每类场景验证完在本文档对应行打勾并记录日期。
- FR-QQ-2 补一个并发单测（mock `_qq_access_token_with_ttl` 用 `asyncio.sleep` 模拟慢请求，断言只被调用一次），跑本地全量确认不引入回归。
- 上线方式：FR-QQ-2 是纯内部加锁，无外部行为变化，直接合并；FR-QQ-1 不涉及代码改动，验证过程本身就是"上线"。
- 需要盯的日志关键字：`agent.gateway.qq._qq_request` 的 `diag_log_raw` 输出（非 2xx 响应）、`QQAPIError` 的 `status`/`body`（脱敏后）。

---

## 5. 风险与待确认问题

| 风险 | 影响 | 对策 |
|---|---|---|
| 真实响应结构与 mock 假设不一致 | 发送在真实环境静默失败或误判 markdown 权限 | FR-QQ-1 逐场景验证，发现即修 |
| `_send_tokens` 并发重复取 token | 浪费调用、高并发下可能触发 QQ 限流 | FR-QQ-2 加锁 |
| sandbox 环境行为与生产不完全一致 | sandbox 验证通过不代表生产一定没问题 | 优先用 sandbox 验证协议正确性，生产低峰时段再抽样验证一次高风险路径（markdown 回退、文件发送） |

待确认：

- 🔲 是否有可用的 QQ sandbox Bot，还是只能用生产 Bot 低峰时段验证。
- 🔲 markdown 权限被拒的真实错误码是否与 `_markdown_blocked()` 硬编码的 `50056`/`40034012` 完全一致。
