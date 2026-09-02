"""新增待验证邮箱变更申请表。"""

from alembic import op
import sqlalchemy as sa


revision = "20260902000005"
down_revision = "20260902000004"
branch_labels = None
depends_on = None


def upgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    if not inspector.has_table("email_change_requests"):
        op.create_table(
            "email_change_requests",
            sa.Column("id", sa.Integer(), autoincrement=True, nullable=False),
            sa.Column("user_id", sa.Uuid(), nullable=False),
            sa.Column("new_email", sa.String(length=300), nullable=False),
            sa.Column("token_hash", sa.String(length=64), nullable=False),
            sa.Column("purpose", sa.String(length=32), nullable=False, server_default="email_change"),
            sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
            sa.Column("used_at", sa.DateTime(timezone=True), nullable=True),
            sa.Column("revoked_at", sa.DateTime(timezone=True), nullable=True),
            sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
            sa.Column("request_ip_hash", sa.String(length=64), nullable=True),
            sa.Column("user_agent_hash", sa.String(length=64), nullable=True),
            sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
            sa.PrimaryKeyConstraint("id"),
            sa.UniqueConstraint("token_hash", name="uq_email_change_request_token_hash"),
        )
    inspector = sa.inspect(bind)
    existing = {item["name"] for item in inspector.get_indexes("email_change_requests")}
    for name, columns in {
        "ix_email_change_requests_user_id": ["user_id"],
        "ix_email_change_requests_new_email": ["new_email"],
        "ix_email_change_requests_token_hash": ["token_hash"],
        "ix_email_change_requests_expires_at": ["expires_at"],
        "ix_email_change_requests_user_created": ["user_id", "created_at"],
        "ix_email_change_requests_user_active": ["user_id", "used_at", "revoked_at"],
    }.items():
        if name not in existing:
            op.create_index(name, "email_change_requests", columns, unique=False)


def downgrade() -> None:
    bind = op.get_bind()
    if sa.inspect(bind).has_table("email_change_requests"):
        op.drop_table("email_change_requests")
