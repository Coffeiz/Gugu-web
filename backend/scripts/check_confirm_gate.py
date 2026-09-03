#!/usr/bin/env python3
"""删除确认门静态守卫：destructive=True 的工具，其 handler 必须接确认门。

背景（商用就绪评审 P0-3）：Tool.destructive 此前只是文档性标记，dispatch 不读它做任何
强制——确认门（confirm.needs_confirmation）完全靠每个 handler 作者记得手动调用。现有
5 个 destructive 工具都接对了，但新工具漏接不会有任何机制拦住。本脚本在提交前抓这个：

  AST 扫 agent/tools/*.py，找出所有 `Tool(..., destructive=True, handler=X)` 注册，
  校验同模块的函数 X 及其同模块委托链源码里引用了 `needs_confirmation`。没引用 = 违规退出 1。

运行时另有 dispatch 层绊线兜底（无 confirm 的调用返回了"成功执行" → CRITICAL 日志），
两层配合：静态防提交、动态抓漏网。用法：python scripts/check_confirm_gate.py
"""
from __future__ import annotations

import ast
import sys
from pathlib import Path

TOOLS_DIR = Path(__file__).parent.parent / "agent" / "tools"


def _kw(call: ast.Call, name: str):
    for k in call.keywords:
        if k.arg == name:
            return k.value
    return None


def _has_gate(fn_src: dict[str, str], name: str, seen: set[str] | None = None) -> bool:
    """判断 handler 及其同模块委托链里是否引用了 confirm.needs_confirmation。

    允许 handler 是审计/加锁等包装层，把执行委托给同模块其他函数——
    确认门在委托链任意一层出现即视为已接。seen 防循环委托。
    """
    seen = seen if seen is not None else set()
    if name in seen:
        return False
    seen.add(name)
    src = fn_src.get(name)
    if src is None:
        return False
    if "needs_confirmation" in src:
        return True
    tree = ast.parse(src)
    for node in ast.walk(tree):
        if isinstance(node, ast.Call) and isinstance(node.func, ast.Name):
            if _has_gate(fn_src, node.func.id, seen):
                return True
    return False


def check() -> list[str]:
    violations: list[str] = []
    for py in sorted(TOOLS_DIR.glob("*.py")):
        if py.name.startswith("._"):
            continue
        src = py.read_text(encoding="utf-8")
        tree = ast.parse(src)
        # 模块内函数名 → 源码段
        fn_src = {n.name: ast.get_source_segment(src, n) or ""
                  for n in ast.walk(tree) if isinstance(n, (ast.AsyncFunctionDef, ast.FunctionDef))}
        for node in ast.walk(tree):
            if not (isinstance(node, ast.Call) and isinstance(node.func, ast.Name) and node.func.id == "Tool"):
                continue
            dv = _kw(node, "destructive")
            if not (isinstance(dv, ast.Constant) and dv.value is True):
                continue
            tool_name = ""
            nv = _kw(node, "name")
            if isinstance(nv, ast.Constant):
                tool_name = str(nv.value)
            hv = _kw(node, "handler")
            handler_name = hv.id if isinstance(hv, ast.Name) else None
            if handler_name is None or handler_name not in fn_src:
                violations.append(f"{py.name}: 工具 {tool_name or '?'} 的 handler 不是本模块函数，无法静态校验确认门——请改为本模块函数或人工确认")
                continue
            if not _has_gate(fn_src, handler_name):
                violations.append(f"{py.name}: 工具 {tool_name or '?'}（destructive=True）的 handler {handler_name} 没有调用 confirm.needs_confirmation——不可逆操作缺确认门")
    return violations


def main() -> int:
    violations = check()
    if violations:
        print("❌ 确认门守卫失败：")
        for v in violations:
            print("  " + v)
        return 1
    print("✅ 确认门守卫通过：所有 destructive 工具的 handler 都接了 needs_confirmation")
    return 0


if __name__ == "__main__":
    sys.exit(main())
