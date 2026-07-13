"""错误分类的类型载体（P2-b §2）。

三分类口径见 docs/refactor/P2b-错误处理规则.md §1：
- **可预期 Expected**：业务上合法的失败，非故障（文件不存在/输入非法/权限不足/内容被平台拒）。
  不重试，就地返回结构化错误，public_message 是静态业务文案。
- **可重试 Retryable**：外部依赖的瞬时故障（超时/连接重置/5xx/429），有界退避重试，
  用尽才上抛或降级。**只对幂等操作或带幂等键的操作重试**——非幂等写（OSS put/delete、
  发消息、扣费）不得盲重试。
- **未知 Unknown**：编程错误/未预期状态（KeyError/AttributeError/TypeError/断言失败）。
  不新建类型——就是「其余一切」，让它冒泡到链路边界统一处理（原始进受限诊断出口，
  脱敏摘要进可见日志，见 app/core/redaction.py）。

`public_message` 只放**来源明确、可直接公开**的内容：`ExpectedError` 用静态业务文案；
动态上游异常绝不直接进 `public_message`，必须先过 `redact()` 或只给通用码对应的固定文案。
原始异常放 `cause`，只流向受限诊断出口，不进任何 Debug 可见日志。

不用一个泛化 `message` + 「是否已脱敏」标志：那会把"静态业务文案"和"动态上游异常串"
混成来源不明的字符串，容易把没脱敏的上游内容误当已脱敏外发。
"""
from __future__ import annotations


class AppError(Exception):
    """错误分类的根。code 是机器可读分类码（如 'file.not_found' / 'oss.timeout'），
    public_message 是面向用户/模型的文案（来源已知、可直接外发），cause 是原始异常
    （只进受限诊断出口，绝不外发/绝不进可见日志）。"""

    def __init__(self, code: str, public_message: str, *, cause: BaseException | None = None):
        super().__init__(public_message)
        self.code = code
        self.public_message = public_message
        self.cause = cause

    def __str__(self) -> str:
        return f"[{self.code}] {self.public_message}"


class ExpectedError(AppError):
    """可预期：业务上合法的失败，不是故障。不重试；public_message 是静态业务文案，
    可以直接展示给用户/模型，不需要再脱敏（前提：调用方没有把动态上游内容塞进来）。"""


class RetryableError(AppError):
    """可重试：外部依赖的瞬时故障，重试用尽后抛出。携带 attempt 记录已尝试次数，
    供上层降级文案或日志参考（不是重试逻辑本身——重试发生在抛出这个异常之前）。"""

    def __init__(self, code: str, public_message: str, *, cause: BaseException | None = None,
                 attempt: int | None = None):
        super().__init__(code, public_message, cause=cause)
        self.attempt = attempt


# 未知错误不在此定义子类——按规则它就是「其余一切」，由链路边界的 `except Exception` 兜底：
# 原始异常 → 受限诊断出口（app.core.redaction.diag_log）；
# code + public_message + type(e).__name__ → 可见日志（ERROR 级）；
# 脱敏摘要 → 外发给用户/模型（app.core.redaction.redact）。
