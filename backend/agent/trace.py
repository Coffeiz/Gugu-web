"""兼容入口：请从 :mod:`agent.runtime.trace` 导入。"""

import sys as _sys

from agent.runtime import trace as _implementation

_sys.modules[__name__] = _implementation
