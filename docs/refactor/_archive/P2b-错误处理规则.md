# P2-b 错误处理规则（立规则版 · 2026-07-11）

> 目的：给后端「外部 I/O / 适配器 / 后台任务」的异常处理立一套**分类 + 处理约定**，
> 供后续按链路逐个收债时对照。**先立规则、再改代码**——本文档不含代码改动。
> 原则底线（沿用计划）：**不搞「所有 except 必须写日志」**（噪声）；按类别决定日志/重试/可见性。
> 关联：[[gugu-tool-error-redaction]]、[[gugu-p2-refactor-plan]] 步骤 5；脱敏机制见 docs/security/安全-工具错误信息脱敏.md。
>
> **落地状态（2026-07-11）**：§7 收债顺序 6 步全部完成——`app/core/errors.py`/`app/core/redaction.py`
> 地基已建；dispatch（`agent/tools/base.py`）与 `agent/core.py` 主循环边界已改双出口；
> storage/voice/web 三处外部 I/O 已套模板 A；qq/wechat/feishu 三个 IM 适配器已按 §5/§6 修完
> 响应体脱敏、过宽 except 收窄、盲重试分类。不是「287 处 except 全部逐个处理完」（§8 明确不做），
> 是按本文档定的规则和收债顺序，把最高风险的链路（工具边界、LLM 主循环、外部 I/O、三个 IM
> 适配器）过了一遍；其余零散 except 仍按本规则的三分类口径，后续增量收敛。

## 0. 现状一句话

全后端 287 个 `except Exception`、42 个具体 except、105 处 `str(e)`、**只有 1 个自定义异常** `ToolContractError`。
两条根因：
1. **错误分类的类型载体缺失**：外部 I/O 与适配器全部裸抛 `RuntimeError` 或盲 `except Exception`，三类错误（可预期/可重试/未知）无类型可依。
2. **日志出口未分级**：`gugu.log` 被 Debug 面板直接 tail 且不脱敏，但代码普遍把原始异常/traceback `print` 进去，误当「安全的服务端日志」（见 §3）。

有两处**局部**值得抽模板：`core.py:23-49`（窄重试）与 dispatch 的**外发脱敏**（`base.py` 的 `{"error"}` 返回，注意其日志出口是反例，见 §4-B）。

> 本版已按代码复审修正：日志可见性边界（§3）、dispatch 定性为半标杆（§4-B/§8）、脱敏出口定死 `app/core/redaction.py`（§5）、异常用 `code`+`public_message` 而非泛化 message（§2）、重试限幂等（§1/§4-A）。

## 1. 错误三分类（唯一权威口径）

| 类别 | 定义 | 例子 | 日志级别 | 重试 | 用户可见 | 传播 |
|---|---|---|---|---|---|---|
| **可预期 Expected** | 业务上合法的失败，非故障 | 文件不存在、输入非法、权限不足、余额不足、内容被平台拒 | 不记 / INFO | **否** | 友好业务文案 | 就地返回结构化错误，不上抛 |
| **可重试 Retryable** | 外部依赖的**瞬时**故障，重试可能成功 | 网络超时、连接重置、HTTP 5xx、限流 429、SDK 瞬时解析错 | 重试用尽才 WARNING | **是**（有界退避） | 重试用尽后降级文案 | 用尽后上抛或降级 |
| **未知 Unknown** | 编程错误 / 未预期状态 | KeyError、AttributeError、TypeError、断言失败、字段拼错 | **必 ERROR + traceback** | 通用「内部错误」文案 | **绝不静默吞** | 让其崩到边界统一兜底（见 §3） |

**判定要点**：
- 分类看**错误性质**，不看「在哪抛的」。同一个 `except Exception` 里可能三类都有 → 不能一刀切处理。
- 外部依赖返回的 **4xx**（认证失败/参数错/被拒）= **可预期或永久**，**不是可重试**。只有超时/5xx/连接错/429 才重试。
- **重试限幂等**：可重试 ≠ 无脑重试——只重试幂等操作或带幂等键的操作；非幂等写（OSS put/delete、发消息、扣费）不盲重试，否则重复执行（详见 §4-A）。
- 拿不准是不是编程错误时，**按未知处理**（记 ERROR + 原始进受限出口），宁可吵不可瞎。

## 2. 类型载体：三个异常基类（建议新增）

当前只有 `ToolContractError`。建议在 `app/core/errors.py`（新）建最小层次，外部边界统一抛这三类，替代裸 `RuntimeError` + 盲 catch：

```
class AppError(Exception):                      # 根
    code: str                                   # 机器可读分类码（如 'file.not_found' / 'oss.timeout'）
    public_message: str                         # 面向用户/模型的文案，来源已知、可直接外发
    def __init__(self, code, public_message, *, cause=None): ...  # cause=原始异常，只进受限诊断出口
class ExpectedError(AppError): ...              # 可预期：业务失败，public_message = 静态业务文案
class RetryableError(AppError): ...             # 可重试：瞬时外部故障，携带 attempt 上下文
# 未知不新建类——就是「其余一切」，由边界的 except Exception 兜底（见 §3）
```

- **不要**用一个泛化 `message` + 「是否已脱敏」标志：那会把「静态业务文案」和「动态上游异常串」混成来源不明的字符串，容易把没脱敏的上游内容误当已脱敏外发。
- `public_message` **只放来源明确、可直接公开**的内容：`ExpectedError` 用静态业务文案（"文件不存在"）；动态上游异常**绝不**直接进 `public_message`，必须先过 `redact`（§5）或只给通用码对应的固定文案。
- 原始异常放 `cause`，**只**流向受限诊断出口（§3），不进任何 Debug 可见日志。
- 适配器/外部 I/O 封装层**主动判别**后抛 `ExpectedError` / `RetryableError`；判别不了的**原样上抛**，交边界当未知处理。

## 3. 两类日志出口（本规则的地基，先定死）

**关键事实**：`logs/gugu.log`（= console stdout/stderr）**不是**安全的「服务端日志」——它被后台 Debug 实时日志面板直接 tail 展示，且只去 ANSI、**不脱敏**（`app/api/v1/admin_debug.py:55/86` 的 `_strip` 仅 `_ANSI_RE.sub`；`app/core/logging.py:74` 明确 console→gugu.log→Debug 面板）。WARNING+ 还会进 `SystemLog` DB → 系统日志页，同样可见。所以「把原始 traceback/异常串 print 出去、反正只进服务端日志」的假设**不成立**。

定死两类出口：

| 出口 | 是否 Debug/后台可见 | 允许放什么 |
|---|---|---|
| **可见日志**（gugu.log / console / SystemLog DB / Debug 面板） | 是 | **只脱敏后的**：`code` + `public_message` + `type(e).__name__`。**禁**原始 `str(e)`、原始 traceback、聊天正文 |
| **受限诊断出口**（原始 traceback / cause） | 否（仅运维） | 原始异常全文。落点建议：不在 `LOG_FILES` 里的独立文件，或外部 APM/Sentry，或标记 `_traj_log.debug` 之类明确不进面板的通道。**本项目当前缺这条通道 → P2-b 需补** |
| 聊天正文 | —— | **任何出口都只记 `fingerprint()`**（`agent/logsafe.py`），永不原文 |

未知错误不在中途 catch，让它冒泡到**链路边界**统一：**原始 → 受限诊断出口；`code`+`public_message`+异常类型名 → 可见日志（ERROR 级）；记指标；脱敏文案给外部**。每条链路有且只有一个这样的边界：

| 链路 | 边界位置 | 现状 |
|---|---|---|
| Agent 工具 | `agent/tools/base.py:301-315` dispatch | ⚠️ **半标杆**：外发的 `{"error"}` 已脱敏（✓，可抄），但 `print(...{e})` + `traceback.print_exc()`（`:304-306`）把**原始**异常/traceback 直排 stdout→gugu.log→**Debug 面板可见**（✗，待整改到受限出口） |
| Agent 对话主循环 | `agent/core.py:376` | ⚠️ 过宽：吞编程错误成「开小差」，只留 `print(str(e)[:120])`、无分类、原始串又进可见日志 |
| IM 适配器（每平台入站 worker） | 各 adapter 的 worker 循环 | ⚠️ 散落 `print(f"…{e}")` 吞掉，原始入可见日志，无统一边界 |
| 后台任务 | 各 loop / create_task | 部分规范（`events/bus.py:36` `logger.warning(exc_info=True)`——但注意 exc_info 也进可见日志，整改后应走受限出口），部分裸 create_task 不持引用 |

**规则**：中途 `except Exception` 只允许在「可重试封装」或「best-effort 且注释说明」处；兜底降级只在边界；**可见日志一行只准出现 `code`+`public_message`+异常类型名，原始细节走受限诊断出口**——不是 `print(str(e))`、也不是 `logger.error(exc_info=True)` 直接进 gugu.log。

## 4. 两个标杆模板（照抄）

**A. 可重试外部调用**（源：`agent/core.py:23-49` 模型调用，全仓最佳）：
```
transient = (Timeout, ConnectionError, RateLimit, InternalServerError, ...)  # 白名单，窄
for attempt in range(MAX):           # 有界
    try: return await call()
    except transient as e:
        if already_committed: raise   # 已产生副作用（吐了 token / 发了半条）就别重试
        await sleep(backoff[attempt]) # 退避 [1,2,4]
raise RetryableError(code, public_message, cause=e)   # 用尽 → 上抛给边界降级，别吞
```
要点：**白名单窄**（别把 `except Exception` 当可重试）、**副作用守卫**、**用尽 raise**。
**幂等前提（硬约束）**：只对**幂等操作**、或**带幂等键/去重键**的操作重试。读操作（GET/list/ASR/http_get）天然幂等可重试；**非幂等写**（OSS put/delete、发消息、扣费）**不得盲重试**——要么带幂等键（如上传用内容 hash 做 key、发送带 client dedup id），要么只重试「明确未产生副作用」的失败（如连接建立前的超时）。宁可不重试，不可重复执行。
反例：`core.py:31` 把 `IndexError/KeyError` 列入瞬时——MiniMax SDK 畸形流特例，**须窄化到该调用点**，不可扩散成「KeyError 一律重试」。

**B. 边界脱敏 + 双出口**（源：`agent/tools/base.py:301-315`，**外发脱敏部分可抄，日志出口部分是待整改反例**）：
```
try: result = await handler(...)
except Exception as e:
    diag_log(e, exc_info=True)                 # 原始 traceback → 受限诊断出口（不进 gugu.log/Debug）
    safe = redact(f"{type(e).__name__}: {e}")  # 脱敏（app/core/redaction）
    logger.error("tool %s failed: %s", name, safe)   # 可见日志只给脱敏摘要 + 异常类型名
    record_metric(...); return {"error": safe}       # 外发只给脱敏版
```
> 现状 dispatch 用 `print` + `traceback.print_exc()` 把原始直排 stdout→gugu.log→Debug 面板，
> 是本规则要修的**日志出口漏点**；`return {"error": sanitize_error(...)}` 的外发脱敏才是可抄的部分。

## 5. 脱敏红线（扩面）+ 公共出口位置定死

脱敏逻辑现在叫 `sanitize_error`、放在 `agent/tools/base.py:23-40`（抹连接串/密钥/路径/UUID/traceback），**只覆盖工具返回值**。
API 层、存储层、Agent、适配器都要用它 → **位置固定为 `app/core/redaction.py`**（导出 `redact()`），不放 `agent/`：
- **依赖方向红线**：`app.*`（API/存储/core）**不得反向依赖 `agent.*`**。放 `agent/logsafe.py` 会逼 app 反依赖 agent。
- 迁移：把 `sanitize_error` 提到 `app/core/redaction.py`，`agent/tools/base.py` 改 import 复用；补对称测试锁脱敏规则不回归。

规则：**任何跨出后端边界、或进入 Debug/后台可见出口的错误文案**（给模型/用户/前端/gugu.log/SystemLog）都必须先过 `redact`。落点：
- 适配器 `print(f"…{e}")`、`core.py:380` 的降级日志、拼了上游响应体的 `RuntimeError(...)` 消息、API 层 `HTTPException(detail=...)`、以及 §3「可见日志」出口。
- **绝不**把上游原始响应体（可能回显凭据）拼进异常消息（现有反例：`feishu.py:742`、`qq.py:291/582`、`wechat.py:537`）。
- 原始未脱敏内容只允许进 §3 的**受限诊断出口**。

## 6. 反模式清单（收债时按此改）

- **过宽 except 吞编程错误** → 窄化或让其到边界记 ERROR：`core.py:376,594,634`、`genstream.py:36/45/70/78/87/141`、`feishu.py:421/430/655`、`wechat.py:283`（`(TimeoutError, Exception)` 冗余）。
- **外部 I/O 无重试**（瞬时抖动直接失败）→ 套模板 A：`storage/__init__.py:131-145`（OSS put/get/delete）、`voice.py:99-114`（ASR）、`web.py:66-95`（http_get）、feishu 出站多数不重试。
- **盲重试不分瞬时/永久**（4xx 白重试）→ 加白名单判别：`qq.py:629/642`、`wechat.py:430/588/630`（参照 `wechat.py:559` 判 4xx 不重试、`qq.py:697` 判 401 的既有做法提炼）。
- **str(e) 未脱敏**（105 处，高风险）→ 走 §5：`core.py:380`、三适配器全部 `print(f"…{e}")`、拼响应体的 RuntimeError。
- **裸 create_task 不持引用**（GC 静默回收）→ 入 set + done_callback：`config.py:467,553`。

## 7. 收债顺序（分链路，先易后险）

1. **建 `app/core/errors.py` 三基类**（`code`+`public_message`+`cause`，零风险纯新增，地基）。
2. **`redact` 归位 + 受限诊断出口**：把 `sanitize_error` 提到 `app/core/redaction.py`（`agent/tools/base.py` 改 import 复用，对称测试锁规则）；同时补一条**不进 gugu.log/Debug 面板的受限诊断出口**（独立文件或 APM），供原始 traceback 落地。这两件是后续所有链路的前置。
3. **修边界日志出口**：dispatch（`base.py:304-306`）、`core.py:376/380` 把 `print(...{e})`/`traceback.print_exc()` 改成「原始→受限出口，脱敏摘要→可见日志」。**外发脱敏不动**（已对）。
4. **外部 I/O 封装重试**：storage/voice/web 套模板 A（瞬时白名单 + 退避 + 用尽 raise）——**只对幂等操作**（读/带幂等键的写），OSS put/delete 等非幂等写不盲重试。**独立、可单测**（mock 瞬时错验重试、4xx 验不重试、非幂等验不重试）。
5. **IM 适配器先 qq/wechat 后 feishu**：盲重试改白名单判别（且守幂等）；出站失败与 print 日志经 §5 `redact`；入站 worker 立统一边界（§3）。
6. **core.py 主循环边界收窄**：`:376` 区分——`RetryableError` 用尽→降级文案、`ExpectedError`→透传 `public_message`、其余→可见日志记 `code`+类型名/原始进受限出口/通用文案，不再 `print(str(e)[:120])`。

**纪律**：每条链路独立提交；先补该链路的对称测试再改；`except Exception` 不是被禁止，而是**只准出现在可重试封装或边界兜底**两个位置，中途别用它吞。

## 8. 明确不做

- 不给 287 个 except 逐个加日志（噪声）。
- **保留** dispatch 的**韧性结构**（`base.py` catch 住工具异常、不冲垮对话、外发脱敏）——这是有意设计，不推翻；但它的**日志出口要整改**（原始 print/traceback 从 gugu.log 挪到受限出口，见 §7 步 3）。别把它整体当「最终标杆」。
- 不追求「零 except Exception」——best-effort 的 SSE 发布、指标上报等静默吞是合理的，只要求**加一行注释说明为何可吞**。
