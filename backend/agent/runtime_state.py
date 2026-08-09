"""兼容入口：请从 :mod:`agent.runtime.runtime_state` 导入。

使用模块别名而不是 ``import *``，以保留旧测试和插件对私有辅助函数、monkeypatch
路径的兼容性；新代码仍以 ``agent.runtime.runtime_state`` 为 canonical path。
"""

import sys as _sys

from agent.runtime import runtime_state as _implementation

_sys.modules[__name__] = _implementation
