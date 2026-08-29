"""增加统一交互 Prompt/Action 表。"""

from alembic import op


revision = "20260822000006"
down_revision = "20260822000005"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute(
        """CREATE TABLE IF NOT EXISTS interaction_prompts (
            id SERIAL PRIMARY KEY,
            user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            session_id INTEGER NOT NULL REFERENCES conversation_sessions(id) ON DELETE CASCADE,
            kind VARCHAR(20) NOT NULL DEFAULT 'confirm',
            title VARCHAR(300) NOT NULL DEFAULT '',
            body TEXT NOT NULL DEFAULT '',
            schema_json JSON NOT NULL DEFAULT '{}'::json,
            status VARCHAR(20) NOT NULL DEFAULT 'active',
            expires_at TIMESTAMPTZ NOT NULL,
            resolved_at TIMESTAMPTZ,
            created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
        )"""
    )
    op.execute("CREATE INDEX IF NOT EXISTS ix_interaction_prompts_user_id ON interaction_prompts (user_id)")
    op.execute("CREATE INDEX IF NOT EXISTS ix_interaction_prompts_session_id ON interaction_prompts (session_id)")
    op.execute("CREATE INDEX IF NOT EXISTS ix_interaction_prompts_status ON interaction_prompts (status)")
    op.execute(
        """CREATE TABLE IF NOT EXISTS interaction_actions (
            id SERIAL PRIMARY KEY,
            prompt_id INTEGER NOT NULL REFERENCES interaction_prompts(id) ON DELETE CASCADE,
            token_hash VARCHAR(64) NOT NULL,
            action_type VARCHAR(30) NOT NULL DEFAULT 'choice',
            option_id VARCHAR(100) NOT NULL DEFAULT '',
            context_json JSON NOT NULL DEFAULT '{}'::json,
            status VARCHAR(20) NOT NULL DEFAULT 'pending',
            expires_at TIMESTAMPTZ NOT NULL,
            consumed_at TIMESTAMPTZ,
            consumed_event_id VARCHAR(200),
            created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
        )"""
    )
    op.execute("CREATE INDEX IF NOT EXISTS ix_interaction_actions_prompt_id ON interaction_actions (prompt_id)")
    op.execute("CREATE INDEX IF NOT EXISTS ix_interaction_actions_token_hash ON interaction_actions (token_hash)")
    op.execute("CREATE INDEX IF NOT EXISTS ix_interaction_actions_status ON interaction_actions (status)")


def downgrade() -> None:
    op.execute("DROP TABLE IF EXISTS interaction_actions")
    op.execute("DROP TABLE IF EXISTS interaction_prompts")
