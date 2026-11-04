"""通知网关管理器处理已提交的 Bot 配置变化。

Revision ID: 20261101000001
Revises: 20261029000007
Create Date: 2026-11-01
"""
from alembic import op


revision = "20261101000001"
down_revision = "20261029000007"
branch_labels = None
depends_on = None
bootstrap_on_empty_database = True
bootstrap_on_legacy_database = True


def upgrade() -> None:
    op.execute("""
        CREATE OR REPLACE FUNCTION notify_im_gateway_bot_config()
        RETURNS trigger
        LANGUAGE plpgsql
        AS $$
        BEGIN
            IF TG_OP = 'UPDATE' THEN
                IF OLD.user_id IS NOT DISTINCT FROM NEW.user_id
                   AND OLD.platform IS NOT DISTINCT FROM NEW.platform
                   AND OLD.app_id IS NOT DISTINCT FROM NEW.app_id
                   AND OLD.app_secret IS NOT DISTINCT FROM NEW.app_secret
                   AND OLD.sandbox IS NOT DISTINCT FROM NEW.sandbox
                   AND OLD.enabled IS NOT DISTINCT FROM NEW.enabled THEN
                    RETURN NEW;
                END IF;
                PERFORM pg_notify('im_gateway_reload', '1');
                RETURN NEW;
            END IF;

            PERFORM pg_notify('im_gateway_reload', '1');
            IF TG_OP = 'DELETE' THEN
                RETURN OLD;
            END IF;
            RETURN NEW;
        END;
        $$
    """)
    op.execute("DROP TRIGGER IF EXISTS trg_user_bots_gateway_config ON user_bots")
    op.execute("""
        CREATE TRIGGER trg_user_bots_gateway_config
        AFTER INSERT OR UPDATE OR DELETE ON user_bots
        FOR EACH ROW EXECUTE FUNCTION notify_im_gateway_bot_config()
    """)


def downgrade() -> None:
    op.execute("DROP TRIGGER IF EXISTS trg_user_bots_gateway_config ON user_bots")
    op.execute("DROP FUNCTION IF EXISTS notify_im_gateway_bot_config()")
