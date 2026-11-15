"""模型分流：隔离正式元数据与真实模型选择/状态消费者，不发送模型请求。"""
import asyncio
import json
import logging
import os
import sys
from datetime import timedelta
from uuid import UUID, uuid4
logging.getLogger("gugu.diag").addHandler(logging.NullHandler())
from sqlalchemy.ext.asyncio import create_async_engine, async_sessionmaker
from app.db.base import Base
from app.models import User, ConversationSession, ProviderReasoningState
from app.core.tz import now_utc
from app.core.config import get_settings
from agent.context.reasoning_state import ReasoningPersistencePolicy
from app.services.provider_reasoning_state import load_state


async def main():
    engine = create_async_engine(os.environ["GUGU_WEBUI_TEST_DATABASE_URL"].replace("postgresql://", "postgresql+asyncpg://"),
        connect_args={"server_settings": {"search_path": os.environ["TEST_SCHEMA"]}})
    factory = async_sessionmaker(engine, expire_on_commit=False)
    owner = UUID(os.environ["TEST_OWNER"])
    try:
        if sys.argv[1] == "setup":
            async with engine.begin() as connection:
                await connection.run_sync(Base.metadata.create_all)
            async with factory() as db:
                other = UUID(os.environ["TEST_OTHER"]) if os.environ.get("TEST_OTHER") else uuid4()
                db.add_all([User(id=owner, username="小北", email="synthetic-strategy@example.invalid", hashed_password="synthetic"),
                    User(id=other, username="小月", email="synthetic-other-strategy@example.invalid", hashed_password="synthetic")])
                await db.flush()
                for number in (1, 2, 3):
                    db.add(ConversationSession(id=number, user_id=other if number == 2 else owner, source="web"))
                await db.flush()
                for number in (1, 2, 3):
                    db.add(ProviderReasoningState(id=number, user_id=other if number == 2 else owner, session_id=number, version=7,
                        status="expired" if number == 3 else "active", provider="openai", api_format="responses", model_id="active-model",
                        reasoning_persistence="continuation", config_digest="synthetic-config", reasoning_config_digest="synthetic-reasoning",
                        source_run_id="synthetic-run", state_kind="response_id", encrypted_payload="synthetic-ciphertext", payload_nonce="synthetic-nonce",
                        encrypted_data_key="synthetic-key", payload_digest="synthetic-digest", payload_size=20, state_summary={"kind": "response_id"},
                        expires_at=now_utc() + timedelta(hours=-1 if number == 2 else 1)))
                await db.commit()
            print("{}")
            return
        from agent.llm.llm_select import pick_model
        settings = get_settings()
        if sys.argv[1] == "capabilities":
            from agent.providers import capability_snapshot
            print(json.dumps(capability_snapshot(settings.ai)))
            return
        selected = [pick_model(settings) for _ in range(4)]
        async with factory() as db:
            state = await load_state(db, user_id=owner, session_id=1, policy=ReasoningPersistencePolicy(mode="continuation"),
                provider="openai", api_format="responses", model_id="active-model", config_digest="synthetic-config", reasoning_config_digest="synthetic-reasoning")
        print(json.dumps({"model": selected[0].model, "selections": [item.model for item in selected], "unavailable_reason": state.unavailable_reason, "expected_version": state.expected_version}))
    finally:
        await engine.dispose()


asyncio.run(main())
