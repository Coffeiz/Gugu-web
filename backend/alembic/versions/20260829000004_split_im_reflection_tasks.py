"""分离群级反思与群友批量反思的任务和游标。"""

from alembic import op
import sqlalchemy as sa


revision = "20260829000004"
down_revision = "20260829000003"
branch_labels = None
depends_on = None


def upgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    if not inspector.has_table("memory_reflection_jobs"):
        return

    job_columns = {item["name"] for item in inspector.get_columns("memory_reflection_jobs")}
    if "task_type" not in job_columns:
        op.add_column(
            "memory_reflection_jobs",
            sa.Column("task_type", sa.String(length=32), nullable=False, server_default="group"),
        )
    constraints = {item["name"] for item in sa.inspect(bind).get_unique_constraints("memory_reflection_jobs")}
    if "uq_memory_reflection_range" in constraints:
        op.drop_constraint("uq_memory_reflection_range", "memory_reflection_jobs", type_="unique")
    op.create_unique_constraint(
        "uq_memory_reflection_range",
        "memory_reflection_jobs",
        [
            "owner_user_id", "platform", "bot_id", "scope_type", "scope_id",
            "from_message_id", "to_message_id", "extractor_version", "task_type",
        ],
    )

    cursor_columns = {item["name"] for item in sa.inspect(bind).get_columns("memory_reflection_cursors")}
    if "last_member_reflected_message_id" not in cursor_columns:
        op.add_column(
            "memory_reflection_cursors",
            sa.Column("last_member_reflected_message_id", sa.Integer(), nullable=True),
        )


def downgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    if not inspector.has_table("memory_reflection_jobs"):
        return
    constraints = {item["name"] for item in inspector.get_unique_constraints("memory_reflection_jobs")}
    if "uq_memory_reflection_range" in constraints:
        op.drop_constraint("uq_memory_reflection_range", "memory_reflection_jobs", type_="unique")
    op.create_unique_constraint(
        "uq_memory_reflection_range",
        "memory_reflection_jobs",
        [
            "owner_user_id", "platform", "bot_id", "scope_type", "scope_id",
            "from_message_id", "to_message_id", "extractor_version",
        ],
    )
    if "task_type" in {item["name"] for item in sa.inspect(bind).get_columns("memory_reflection_jobs")}:
        op.drop_column("memory_reflection_jobs", "task_type")
    if "last_member_reflected_message_id" in {
        item["name"] for item in sa.inspect(bind).get_columns("memory_reflection_cursors")
    }:
        op.drop_column("memory_reflection_cursors", "last_member_reflected_message_id")
