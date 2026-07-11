# P2-b 错误处理规则（立规则版 · 2026-07-11）

> 目的：给后端「外部 I/O / 适配器 / 后台任务」的异常处理立一套**分类 + 处理约定**，
> 供后续按链路逐个收债时对照。**先立规则、再改代码**——本文档不含代码改动。
> 原则底线（沿用计划）：**不搞「所有 except 必须写日志」**（噪声）；按类别决定日志/重试/可见性。
> 关联：[[gugu-tool-error-redaction]]、[[gugu-p2-refactor-plan]] 步骤 5；脱敏机制见 docs/security/安全-工具错误信息脱敏.md。

## 0. 现状一句话

全后端 287 个 `except Exception`、42 个具体 except、105 处 `str(e)`、**只有 1 个自定义异常** `ToolContractError`。
根因 = **错误分类的类型载体缺失**：外部 I/O 与适配器全部裸抛 `RuntimeError` 或盲 `except Exception`，
三类错误（可预期 / 可重试 / 未知）无类型可依。已有两处「标杆」值得抽成模板（见 §4）。

## 1. 错误三分类（唯一权威口径）

| 类别 | 定义 | 例子 | 日志级别 | 重试 | 用户可见 | 传播 |
|---|---|---|---|---|---|---|
| **可预期 Expected** | 业务上合法的失败，非故障 | 文件不存在、输入非法、权限不足、余额不足、内容被平台拒 | 不记 / INFO | **否** | 友好业务文案 | 就地返回结构化错误，不上抛 |
| **可重试 Retryable** | 外部依赖的**瞬时**故障，重试可能成功 | 网络超时、连接重置、HTTP 5xx、限流 429、SDK 瞬时解析错 | 重试用尽才 WARNING | **是**（有界退避） | 重试用尽后降级文案 | 用尽后上抛或降级 |
| **未知 Unknown** | 编程错误 / 未预期状态 | KeyError、AttributeError、TypeError、断言失败、字段拼错 | **必 ERROR + traceback** | 通用「内部错误」文案 | **绝不静默吞** | 让其崩到边界统一兜底（见 §3） |

**判定要点**：
- 分类看**错误性质**，不看「在哪抛的」。同一个 `except Exception` 里可能三类都有 → 不能一刀切处理。
- 外部依赖返回的 **4xx**（认证失败/参数错/被拒）= **可预期或永久**，**不是可重试**。只有超时/5xx/连接错/429 才重试。
- 拿不准是不是编程错误时，**按未知处理**（记 ERROR + traceback），宁可吵不可瞎。

## 2. 类型载体：三个异常基类（建议新增）

当前只有 `ToolContractError`。建议在 `app/core/errors.py`（新）建最小层次，外部边界统一抛这三类，替代裸 `RuntimeError` + 盲 catch：

```
class AppError(Exception): ...                 # 根，携带 code / 用户文案 / 是否已脱敏
class ExpectedError(AppError): ...             # 可预期：业务失败，携带面向用户的 message
class RetryableError(AppError): ...            # 可重试：瞬时外部故障，携带 attempt 上下文
# 未知不新建类——就是「其余一切」，由边界的 except Exception 兜底（见 §3）
```

- 适配器/外部 I/O 封装层**主动判别**后抛 `ExpectedError` / `RetryableError`；判别不了的**原样上抛**，交边界当未知处理。
- `AppError.message` 存**已脱敏、可直接给用户/模型**的文案；原始细节只进服务端日志。

## 3. 边界兜底（未知错误的唯一归宿）

未知错误不在中途 catch，让它冒泡到**链路边界**，由边界统一：**记 ERROR+traceback（原始）→ 脱敏后给外部 → 记指标**。
每条链路有且只有一个这样的边界：

| 链路 | 边界位置 | 现状 |
|---|---|---|
| Agent 工具 | `agent/tools/base.py:301-315` dispatch | ✅ **标杆**，已 catch→traceback→sanitize→traj |
| Agent 对话主循环 | `agent/core.py:376` | ⚠️ 过宽：吞编程错误成「开小背」，只留 120 字截断、无 traceback |
| IM 适配器（每平台入站 worker） | 各 adapter 的 worker 循环 | ⚠️ 散落 print 吞掉，无统一边界 |
| 后台任务 | 各 loop / create_task | 部分规范（`events/bus.py:36` 是好范式），部分裸 create_task 不持引用 |

**规则**：中途的 `except Exception` 只允许出现在「可重试封装」或「best-effort 且注释说明」处；
**兜底降级**只在边界，且必须 `logger.error(exc_info=True)`（不是 `print(str(e)[:120])`）。

## 4. 两个标杆模板（照抄）

**A. 可重试外部调用**（源：`agent/core.py:23-49` 模型调用，全仓最佳）：
```
transient = (Timeout, ConnectionError, RateLimit, InternalServerError, ...)  # 白名单，窄
for attempt in range(MAX):           # 有界
    try: return await call()
    except transient as e:
        if already_committed: raise   # 已产生副作用（吐了 token / 发了半条）就别重试
        await sleep(backoff[attempt]) # 退避 [1,2,4]
raise                                 # 用尽 → 上抛给上层降级，别吞
```
要点：**白名单窄**（别把 `except Exception` 当可重试）、**副作用守卫**（emitted 标记）、**用尽 raise**。
反例：`core.py:31` 把 `IndexError/KeyError` 也列入瞬时——是 MiniMax SDK 畸形流的特例，**须窄化到该调用点**，不可扩散成「KeyError 一律重试」。

**B. 边界脱敏**（源：`agent/tools/base.py:301-315`）：
```
try: result = await handler(...)
except Exception as e:
    traceback.print_exc()                    # 原始进服务端日志
    safe = sanitize_error(f"{type(e).__name__}: {e}")  # 脱敏
    record_metric(...); return {"error": safe}         # 给外部只给脱敏版 + 记指标
```

## 5. 脱敏红线（扩面）

`sanitize_error`（`agent/tools/base.py:23-40`，抹连接串/密钥/路径/UUID/traceback）当前**只覆盖工具返回值**。
规则：**任何跨出后端边界的错误文案**（给模型/用户/前端/Debug 面板）都必须先过 `sanitize_error`。落点：
- 适配器 print 日志、`core.py:380` 的降级日志、拼了上游响应体的 `RuntimeError(...)` 消息、API 层 `HTTPException(detail=...)`。
- **绝不**把上游原始响应体（可能回显凭据）拼进异常消息（现有反例：`feishu.py:742`、`qq.py:291/582`、`wechat.py:537`）。

## 6. 反模式清单（收债时按此改）

- **过宽 except 吞编程错误** → 窄化或让其到边界记 ERROR：`core.py:376,594,634`、`genstream.py:36/45/70/78/87/141`、`feishu.py:421/430/655`、`wechat.py:283`（`(TimeoutError, Exception)` 冗余）。
- **外部 I/O 无重试**（瞬时抖动直接失败）→ 套模板 A：`storage/__init__.py:131-145`（OSS put/get/delete）、`voice.py:99-114`（ASR）、`web.py:66-95`（http_get）、feishu 出站多数不重试。
- **盲重试不分瞬时/永久**（4xx 白重试）→ 加白名单判别：`qq.py:629/642`、`wechat.py:430/588/630`（参照 `wechat.py:559` 判 4xx 不重试、`qq.py:697` 判 401 的既有做法提炼）。
- **str(e) 未脱敏**（105 处，高风险）→ 走 §5：`core.py:380`、三适配器全部 `print(f"…{e}")`、拼响应体的 RuntimeError。
- **裸 create_task 不持引用**（GC 静默回收）→ 入 set + done_callback：`config.py:467,553`。

## 7. 收债顺序（分链路，先易后险）

1. **建 `app/core/errors.py` 三基类**（零风险，纯新增，后续改造的地基）。
2. **`sanitize_error` 下沉为公共出口**：从 `agent/tools/base.py` 提到 `app/core/`（或 `agent/logsafe.py` 旁），适配器/core 复用。对称测试保证脱敏规则不回归。
3. **外部 I/O 封装重试**：storage/voice/web 三处套模板 A（瞬时白名单 + 退避 + 用尽 raise）。**独立、可单测**（mock 抛瞬时错验重试、抛 4xx 验不重试）。
4. **IM 适配器先 qq/wechat 后 feishu**：把盲重试改成白名单判别，出站失败经 §5 脱敏；入站 worker 循环立统一边界。
5. **core.py 主循环边界收窄**：`:376` 区分——`RetryableError` 用尽→降级文案、`ExpectedError`→透传业务文案、其余→ERROR+traceback+通用文案，不再 `print(str(e)[:120])`。

**纪律**：每条链路独立提交；先补该链路的对称测试再改；`except Exception` 不是被禁止，而是**只准出现在可重试封装或边界兜底**两个位置，中途别用它吞。

## 8. 明确不做

- 不给 287 个 except 逐个加日志（噪声）。
- 不动工具 dispatch 那个「网」（`base.py:301-315` 已是标杆，工具错误不冲垮对话是**有意韧性**）。
- 不追求「零 except Exception」——best-effort 的 SSE 发布、指标上报等静默吞是合理的，只要求**加一行注释说明为何可吞**。
