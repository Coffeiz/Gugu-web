"""Add persisted user data portability jobs and source identity mappings.

Revision ID: 20261002000001
Revises: 20261001000002
"""
from alembic import op
import sqlalchemy as sa


revision = "20261002000001"
down_revision = "20261001000002"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "data_portability_origins",
        sa.Column("user_id", sa.Uuid(), nullable=False),
        sa.Column("origin_id", sa.Uuid(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("user_id"),
        sa.UniqueConstraint("origin_id"),
        if_not_exists=True,
    )
    op.create_table(
        "data_export_jobs",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("user_id", sa.Uuid(), nullable=False),
        sa.Column("status", sa.String(length=24), nullable=False),
        sa.Column("options", sa.JSON(), nullable=False),
        sa.Column("idempotency_key", sa.String(length=128), nullable=True),
        sa.Column("stage", sa.String(length=40), nullable=True),
        sa.Column("progress_current", sa.Integer(), nullable=False),
        sa.Column("progress_total", sa.Integer(), nullable=True),
        sa.Column("artifact_key", sa.String(length=500), nullable=True),
        sa.Column("artifact_size", sa.BigInteger(), nullable=True),
        sa.Column("artifact_sha256", sa.String(length=64), nullable=True),
        sa.Column("error_code", sa.String(length=80), nullable=True),
        sa.Column("lease_owner", sa.String(length=128), nullable=True),
        sa.Column("lease_until", sa.DateTime(timezone=True), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("started_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("finished_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("user_id", "idempotency_key", name="uq_data_export_idempotency"),
        if_not_exists=True,
    )
    op.create_index("ix_data_export_jobs_user_id", "data_export_jobs", ["user_id"], if_not_exists=True)
    op.create_index("ix_data_export_jobs_status", "data_export_jobs", ["status"], if_not_exists=True)
    op.create_index("ix_data_export_jobs_created_at", "data_export_jobs", ["created_at"], if_not_exists=True)
    op.create_index("ix_data_export_jobs_expires_at", "data_export_jobs", ["expires_at"], if_not_exists=True)
    op.create_index("ix_data_export_jobs_claim", "data_export_jobs", ["status", "lease_until", "created_at"], if_not_exists=True)

    op.create_table(
        "data_import_jobs",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("user_id", sa.Uuid(), nullable=False),
        sa.Column("mode", sa.String(length=20), nullable=False),
        sa.Column("source_job_id", sa.Uuid(), nullable=True),
        sa.Column("status", sa.String(length=24), nullable=False),
        sa.Column("staging_key", sa.String(length=500), nullable=True),
        sa.Column("import_token_hash", sa.String(length=64), nullable=True),
        sa.Column("archive_origin_id", sa.Uuid(), nullable=True),
        sa.Column("archive_export_id", sa.Uuid(), nullable=True),
        sa.Column("archive_sha256", sa.String(length=64), nullable=True),
        sa.Column("preview", sa.JSON(), nullable=True),
        sa.Column("idempotency_key", sa.String(length=128), nullable=True),
        sa.Column("stage", sa.String(length=40), nullable=True),
        sa.Column("progress_current", sa.Integer(), nullable=False),
        sa.Column("progress_total", sa.Integer(), nullable=True),
        sa.Column("rollback_key", sa.String(length=500), nullable=True),
        sa.Column("rollback_expires_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("error_code", sa.String(length=80), nullable=True),
        sa.Column("lease_owner", sa.String(length=128), nullable=True),
        sa.Column("lease_until", sa.DateTime(timezone=True), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("started_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("finished_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("user_id", "idempotency_key", name="uq_data_import_idempotency"),
        if_not_exists=True,
    )
    import_columns = {column["name"] for column in sa.inspect(op.get_bind()).get_columns("data_import_jobs")}
    if "source_job_id" not in import_columns:
        op.add_column("data_import_jobs", sa.Column("source_job_id", sa.Uuid(), nullable=True))
    op.create_index("ix_data_import_jobs_user_id", "data_import_jobs", ["user_id"], if_not_exists=True)
    op.create_index("ix_data_import_jobs_source_job_id", "data_import_jobs", ["source_job_id"], if_not_exists=True)
    op.create_index("ix_data_import_jobs_status", "data_import_jobs", ["status"], if_not_exists=True)
    op.create_index("ix_data_import_jobs_import_token_hash", "data_import_jobs", ["import_token_hash"], if_not_exists=True)
    op.create_index("ix_data_import_jobs_created_at", "data_import_jobs", ["created_at"], if_not_exists=True)
    op.create_index("ix_data_import_jobs_expires_at", "data_import_jobs", ["expires_at"], if_not_exists=True)
    op.create_index("ix_data_import_jobs_claim", "data_import_jobs", ["status", "lease_until", "created_at"], if_not_exists=True)

    op.create_table(
        "data_portable_identities",
        sa.Column("id", sa.Integer(), autoincrement=True, nullable=False),
        sa.Column("user_id", sa.Uuid(), nullable=False),
        sa.Column("origin_id", sa.Uuid(), nullable=False),
        sa.Column("source_type", sa.String(length=80), nullable=False),
        sa.Column("portable_id", sa.String(length=200), nullable=False),
        sa.Column("target_type", sa.String(length=80), nullable=False),
        sa.Column("target_id", sa.String(length=200), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint(
            "user_id", "origin_id", "source_type", "portable_id",
            name="uq_data_portable_source_identity",
        ),
        if_not_exists=True,
    )
    op.create_index("ix_data_portable_identities_user_id", "data_portable_identities", ["user_id"], if_not_exists=True)
    op.create_index("ix_data_portable_identities_origin_id", "data_portable_identities", ["origin_id"], if_not_exists=True)
    op.create_index(
        "ix_data_portable_identity_target", "data_portable_identities",
        ["user_id", "target_type", "target_id"],
        if_not_exists=True,
    )


def downgrade() -> None:
    # 表可能在 Alembic 之前由 Base.metadata.create_all 创建并已承载数据，不能安全删除。
    pass
