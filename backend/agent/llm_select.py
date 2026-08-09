"""兼容入口：请从 :mod:`agent.llm.llm_select` 导入。"""

from agent.llm.llm_select import (
    _is_deepseek,
    _is_mimo,
    anthropic_default_headers,
    is_minimax,
    openai_default_headers,
    pick_model,
    release,
    set_router,
    supports_anthropic_active_cache,
    supports_thinking_toggle,
    use_anthropic_for,
)
