"""将系统与用户 Skill 的公开标识统一为 S# / U#。

Revision ID: 20261013000001
Revises: 20261012000004
Create Date: 2026-10-13
"""
from __future__ import annotations

from alembic import op
import sqlalchemy as sa


revision = "20261013000001"
down_revision = "20261012000004"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "users",
        sa.Column("next_skill_sequence", sa.Integer(), nullable=False, server_default="1"),
    )
    op.add_column("user_skills", sa.Column("skill_id", sa.String(length=16), nullable=True))

    connection = op.get_bind()
    rows = connection.execute(sa.text(
        "SELECT id, owner_id FROM user_skills ORDER BY owner_id, created_at, id"
    )).all()
    owner_id_type = (
        sa.Uuid(as_uuid=True)
        if connection.dialect.name == "postgresql"
        else sa.String()
    )
    next_by_owner: dict[object, int] = {}
    for row in rows:
        owner = row.owner_id
        sequence = next_by_owner.get(owner, 1)
        connection.execute(
            sa.text("UPDATE user_skills SET skill_id = :skill_id WHERE id = :id"),
            {"skill_id": f"U{sequence}", "id": row.id},
        )
        next_by_owner[owner] = sequence + 1
    for owner, sequence in next_by_owner.items():
        connection.execute(
            sa.text("UPDATE users SET next_skill_sequence = :next_value WHERE id = :owner_id")
            .bindparams(sa.bindparam("owner_id", type_=owner_id_type)),
            {"next_value": sequence, "owner_id": owner},
        )

    op.execute("DROP INDEX IF EXISTS ix_search_skills_slug_trgm")
    with op.batch_alter_table("user_skills") as batch:
        constraints = {
            item.get("name") for item in sa.inspect(connection).get_unique_constraints("user_skills")
        }
        if "uq_user_skill_owner_slug" in constraints:
            batch.drop_constraint("uq_user_skill_owner_slug", type_="unique")
        batch.alter_column("skill_id", existing_type=sa.String(length=16), nullable=False)
        batch.drop_column("slug")
        batch.create_unique_constraint("uq_user_skill_owner_skill_id", ["owner_id", "skill_id"])


def downgrade() -> None:
    connection = op.get_bind()
    with op.batch_alter_table("user_skills") as batch:
        batch.drop_constraint("uq_user_skill_owner_skill_id", type_="unique")
        batch.add_column(sa.Column("slug", sa.String(length=80), nullable=True))
    connection.execute(sa.text(
        "UPDATE user_skills SET slug = 'user-skill-' || lower(skill_id)"
    ))
    with op.batch_alter_table("user_skills") as batch:
        batch.alter_column("slug", existing_type=sa.String(length=80), nullable=False)
        batch.drop_column("skill_id")
        batch.create_unique_constraint("uq_user_skill_owner_slug", ["owner_id", "slug"])
    op.drop_column("users", "next_skill_sequence")
