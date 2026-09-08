"""检查上下文自动压缩策略是否保持单一路径。

这是一个轻量静态门禁，防止结束后后台调度被重新接回，或 provider round 的
90% 检查被改回只覆盖工具续轮。真正的行为由 pytest 回归测试覆盖。
"""
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
CORE = ROOT / "agent" / "core.py"
FINALIZE = ROOT / "agent" / "context" / "run_finalize.py"
RUNNER = ROOT / "agent" / "runner.py"
WEB = ROOT / "agent" / "gateway" / "web.py"
COMPRESS = ROOT / "agent" / "context" / "compress_conv.py"


def main() -> int:
    core = CORE.read_text(encoding="utf-8")
    finalize = FINALIZE.read_text(encoding="utf-8")
    production = "\n".join(
        path.read_text(encoding="utf-8")
        for path in (FINALIZE, RUNNER, WEB, COMPRESS)
    )

    forbidden = (
        "schedule_baseline_update",
        "wait_for_baseline_update",
    )
    stale = [name for name in forbidden if name in production]
    if stale:
        raise SystemExit(f"发现已废弃的自动压缩入口：{', '.join(stale)}")

    if "run_context_usage >= int(context_tokens * AUTO_COMPACTION_RATIO)" not in core:
        raise SystemExit("缺少 provider 实际 usage >= 90% 的唯一阈值判断")
    if core.count("if usage_compaction_due():") != 1:
        raise SystemExit("90% 阈值必须在每个 provider round 返回后的统一位置检查")
    if "if compaction_applied:" not in finalize or "compress_conv.compress_if_needed(" not in finalize:
        raise SystemExit("压缩后的 baseline 必须在同一 run 收口时同步持久化")

    print("上下文压缩策略检查通过：provider round >=90% 触发，已移除结束后后台调度。")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
