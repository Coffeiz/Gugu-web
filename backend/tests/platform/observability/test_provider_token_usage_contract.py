"""执行链路和 LoopScope 只接收 Provider token 用量。"""

import ast
from pathlib import Path
import re


def test_backend_has_no_local_llm_tokenizer_or_estimator():
    root = Path(__file__).resolve().parents[3]
    packages = {"tokenizers", "tiktoken", "transformers", "sentencepiece"}
    forbidden_name = re.compile(r"estimate.*token|token.*estimat|chars_per_(?:estimated_)?token", re.I)
    violations = []
    for directory in ("agent", "app", "scripts"):
        for path in (root / directory).rglob("*.py"):
            for node in ast.walk(ast.parse(path.read_text(encoding="utf-8"))):
                names = []
                if isinstance(node, ast.ImportFrom):
                    names = [(node.module or "").split(".")[0], *(alias.name for alias in node.names)]
                elif isinstance(node, ast.Import):
                    names = [alias.name.split(".")[0] for alias in node.names]
                elif isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
                    names = [node.name]
                elif isinstance(node, (ast.Name, ast.Attribute)):
                    names = [node.id if isinstance(node, ast.Name) else node.attr]
                if any(name in packages or forbidden_name.search(name) for name in names):
                    violations.append(f"{path.relative_to(root)}:{node.lineno}")
    assert not violations, violations
