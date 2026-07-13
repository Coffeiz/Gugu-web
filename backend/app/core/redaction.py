"""脱敏公共出口 + 受限诊断出口（P2-b §3/§5）。

**位置定死在这里、不放 agent/**：API 层、存储层、Agent、适配器都要脱敏跨边界的错误文案，
若放 `agent/logsafe.py` 会逼 `app.*`（API/存储/core）反向依赖 `agent.*`——依赖方向红线，
`app.*` 不得反向依赖 `agent.*`。原逻辑叫 `sanitize_error`、在 `agent/tools/base.py`，
现迁到这里，`agent/tools/base.py` 改 import 复用（见该文件顶部注释）。

规则（§5）：任何跨出后端边界、或进入 Debug/后台可见出口的错误文案（给模型/用户/前端/
gugu.log/SystemLog）都必须先过 `redact()`。绝不把上游原始响应体（可能回显凭据）拼进
异常消息。原始未脱敏内容只允许进 `diag_log()` 这一个受限诊断出口。

两类日志出口的地基（§3）：`logs/gugu.log`（= console stdout/stderr）**不是**安全的
「服务端日志」——它被后台 Debug 实时日志面板直接 tail 展示，且不脱敏；WARNING+ 还会进
`SystemLog` DB → 系统日志页，同样可见。「反正只进服务端日志」的假设不成立。
"""
from __future__ import annotations

import logging
import re
import traceback as _tb

# ── 脱敏（原 agent/tools/base.py 的 sanitize_error，逻辑原样搬来，顺序不变）──────────
# 连接串、密钥含路径/uuid 片段，先抹；再抹路径、UUID；最后去 traceback 帧。
_CONN_RE = re.compile(r"\b(?:postgres(?:ql)?|redis|rediss|mysql|mongodb)://[^\s'\"]+", re.I)
_KEY_RE  = re.compile(r"\b(?:sk-[A-Za-z0-9]{16,}|(?:api[_-]?key|token|secret|bearer)[\"'=:\s]+[A-Za-z0-9._\-]{12,})", re.I)
_PATH_RE = re.compile(r"(?:\.{0,2}/)?(?:uploads|\.agent|\.thumbs|\.chat_staging)/[^\s'\"]*|/(?:home|opt|Users|var|etc|root|tmp|private)/[^\s'\"]*")
_UUID_RE = re.compile(r"\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\b")
_TB_RE   = re.compile(r"\n?\s*File \"[^\"]+\", line \d+[^\n]*(?:\n\s+[^\n]+)?")


def redact(s: str) -> str:
    """抹掉错误串里的敏感内部信息（连接串/密钥/路径/UUID/traceback）。
    只用于 error/异常文案，绝不动正常业务内容（如 read_file 正文可能含任意文本）。"""
    if not s or not isinstance(s, str):
        return s
    s = _CONN_RE.sub("‹连接串已隐藏›", s)
    s = _KEY_RE.sub("‹密钥已隐藏›", s)
    s = _PATH_RE.sub("‹路径已隐藏›", s)
    s = _UUID_RE.sub("‹id已隐藏›", s)
    s = _TB_RE.sub("", s)
    return s.strip()


# ── 受限诊断出口：不进 gugu.log / SystemLog / Debug 面板 ─────────────────────────────
# 独立 logger + 独立文件 handler，propagate=False——不挂在 root logger 下，
# 不会被 app.core.logging.setup_logging() 的 DbLogHandler/控制台 handler 接住，
# 因此既不进 SystemLog（Debug 面板「系统日志」页），也不进 stdout/stderr（不进 gugu.log，
# 而 admin_debug.py 的 LOG_FILES 白名单本来也没有这个文件名，Debug 面板「实时日志」页
# tail 不到它）。落点：logs/gugu-diag.log，只给运维直接登服务器看，不进任何后台可见出口。
_diag_logger = logging.getLogger("gugu.diag")
_diag_logger.propagate = False
_diag_logger.setLevel(logging.ERROR)

if not _diag_logger.handlers:
    from pathlib import Path
    _diag_dir = Path(__file__).resolve().parents[2] / "logs"
    try:
        _diag_dir.mkdir(parents=True, exist_ok=True)
        _handler: logging.Handler = logging.FileHandler(_diag_dir / "gugu-diag.log", encoding="utf-8")
    except OSError:
        # 只读文件系统等极端环境下的兜底：仍不挂 root，宁可丢诊断细节也不能让它意外冒进可见日志
        _handler = logging.NullHandler()
    _handler.setFormatter(logging.Formatter(
        "%(asctime)s [%(name)s] %(message)s", datefmt="%Y-%m-%d %H:%M:%S"))
    _diag_logger.addHandler(_handler)


def diag_log(where: str, exc: BaseException) -> None:
    """把原始异常全文（含 traceback）落进受限诊断出口。`where` 是定位用的链路标识
    （如 'agent.tools.dispatch' / 'agent.core.main_loop'），不是给用户看的。"""
    tb = "".join(_tb.format_exception(type(exc), exc, exc.__traceback__))
    _diag_logger.error("%s | %s: %s\n%s", where, type(exc).__name__, exc, tb)


def diag_log_raw(where: str, text: str) -> None:
    """跟 diag_log 同一个受限出口，但用于「已经是字符串、不是异常对象」的原始错误文案
    （比如某个工具自己把 str(e) 拼进了返回值的 error 字段，这里只是转发而非捕获）。"""
    _diag_logger.error("%s | %s", where, text)
