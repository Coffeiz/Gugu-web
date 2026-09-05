import asyncio
from types import SimpleNamespace


def test_independent_reflection_task_binds_user_model(monkeypatch):
    from agent.llm import modelctx
    from agent.llm import llm_select
    from agent.memory import reflection
    import app.db.session as db_session

    platform = object()
    user_model = object()
    calls = []

    class SessionContext:
        async def __aenter__(self):
            return object()

        async def __aexit__(self, exc_type, exc, tb):
            return False

    async def resolve(settings, db, user_id, ctx):
        calls.append((settings, user_id))
        return SimpleNamespace(model=user_model)

    monkeypatch.setattr(db_session, "ensure_engine", lambda: None)
    monkeypatch.setattr(db_session, "_SessionLocal", lambda: SessionContext())
    monkeypatch.setattr(llm_select, "resolve_run_config_for_user", resolve)

    token_model = modelctx._model_cfg.set(platform)
    token_scope = modelctx._user_scope.set(False)
    async def exercise():
        bound = await reflection._bind_user_model("user-1", SimpleNamespace())
        assert bound is user_model
        assert modelctx.get_model_cfg() is user_model
        assert calls and calls[0][1] == "user-1"

    try:
        asyncio.run(exercise())
    finally:
        modelctx._model_cfg.reset(token_model)
        modelctx._user_scope.reset(token_scope)
