"""依赖方向是可执行的架构约束，防止 Core 再次绑定 Web 或宿主配置。"""
from pathlib import Path
import ast
import importlib.util

import gugu_core


def test_core_domain_and_application_do_not_import_framework_or_host():
    root = Path(gugu_core.__file__).parent
    for path in root.rglob("*.py"):
        forbidden = {"app", "agent", "fastapi", "redis"}
        if path.relative_to(root).parts[0] in {"domain", "application"}:
            forbidden |= {"sqlalchemy", "aiosqlite", "gugu_core.data"}
        if path.relative_to(root).parts[0] == "domain":
            forbidden.add("gugu_core.application")
        package = ".".join(("gugu_core", *path.relative_to(root).parts[:-1]))
        tree = ast.parse(path.read_text(encoding="utf-8"))
        imports = []
        for node in ast.walk(tree):
            if isinstance(node, ast.Import):
                imports.extend(alias.name for alias in node.names)
            elif isinstance(node, ast.ImportFrom):
                base = node.module or ""
                if node.level:
                    base = importlib.util.resolve_name("." * node.level + base, package)
                imports.append(base)
                imports.extend(base + "." + alias.name for alias in node.names)
        assert not [name for name in imports if any(name == item or name.startswith(item + ".") for item in forbidden)], path
