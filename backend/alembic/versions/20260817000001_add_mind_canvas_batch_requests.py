"""增加 Mind Canvas Agent 批处理幂等请求记录。"""

from alembic import op
import sqlalchemy as sa

revision = "20260817000001"
down_revision = "20260812000001"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "mind_canvas_batch_requests",
        sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
        sa.Column("user_id", sa.Uuid(), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
        sa.Column("canvas_id", sa.Integer(), sa.ForeignKey("mind_maps.id", ondelete="CASCADE"), nullable=False),
        sa.Column("request_id", sa.String(length=120), nullable=False),
        sa.Column("payload_hash", sa.String(length=64), nullable=False),
        sa.Column("result_json", sa.Text(), nullable=False, server_default=""),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.UniqueConstraint(
            "user_id", "canvas_id", "request_id",
            name="uq_mind_canvas_batch_request",
        ),
    )
    op.create_index(
        "ix_mind_canvas_batch_requests_user_id",
        "mind_canvas_batch_requests",
        ["user_id"],
    )
    op.create_index(
        "ix_mind_canvas_batch_requests_canvas_id",
        "mind_canvas_batch_requests",
        ["canvas_id"],
    )


def downgrade() -> None:
    op.drop_index("ix_mind_canvas_batch_requests_canvas_id", table_name="mind_canvas_batch_requests")
    op.drop_index("ix_mind_canvas_batch_requests_user_id", table_name="mind_canvas_batch_requests")
    op.drop_table("mind_canvas_batch_requests")
