"""合并重复活动文件夹并约束同一作用域内的目录名唯一。"""

from alembic import op
import sqlalchemy as sa


revision = "20261001000002"
down_revision = "20261001000001"
branch_labels = None
depends_on = None


def _merge_active_duplicate_folders(connection) -> int:
    """合并历史重复目录树，保留最早的 Folder ID 和所有关联。"""
    merged_count = 0
    while True:
        groups = connection.execute(sa.text("""
            SELECT user_id, project_id, workspace_directory_id, parent_id, name
            FROM folders
            WHERE deleted_at IS NULL
            GROUP BY user_id, project_id, workspace_directory_id, parent_id, name
            HAVING COUNT(*) > 1
            ORDER BY MIN(id)
        """)).all()
        if not groups:
            return merged_count

        for group in groups:
            values = dict(group._mapping)
            predicates = ["user_id = :user_id", "name = :name"]
            params = {"user_id": values["user_id"], "name": values["name"]}
            for column in ("project_id", "workspace_directory_id", "parent_id"):
                value = values[column]
                if value is None:
                    predicates.append(f"{column} IS NULL")
                else:
                    predicates.append(f"{column} = :{column}")
                    params[column] = value
            where = " AND ".join(predicates)
            folder_ids = connection.execute(
                sa.text(f"SELECT id FROM folders WHERE deleted_at IS NULL AND {where} ORDER BY id"),
                params,
            ).scalars().all()
            if len(folder_ids) < 2:
                continue

            canonical_id = folder_ids[0]
            for duplicate_id in folder_ids[1:]:
                connection.execute(sa.text(
                    "UPDATE files SET folder_id = :canonical_id WHERE folder_id = :duplicate_id"
                ), {"canonical_id": canonical_id, "duplicate_id": duplicate_id})
                connection.execute(sa.text(
                    "UPDATE workspaces SET folder_id = :canonical_id WHERE folder_id = :duplicate_id"
                ), {"canonical_id": canonical_id, "duplicate_id": duplicate_id})
                # 子目录先重挂到保留节点；下一轮会继续合并因此产生的同名子目录。
                connection.execute(sa.text(
                    "UPDATE folders SET parent_id = :canonical_id WHERE parent_id = :duplicate_id"
                ), {"canonical_id": canonical_id, "duplicate_id": duplicate_id})
                connection.execute(sa.text("""
                    UPDATE folders
                    SET deleted_at = CURRENT_TIMESTAMP,
                        updated_at = CURRENT_TIMESTAMP,
                        version = version + 1
                    WHERE id = :duplicate_id AND deleted_at IS NULL
                """), {"duplicate_id": duplicate_id})
                merged_count += 1


def upgrade() -> None:
    # 目录表规模有限；迁移时短暂阻止并发目录写入，确保清理与唯一索引原子完成。
    connection = op.get_bind()
    if connection.dialect.name == "postgresql":
        op.execute("SET lock_timeout = '30s'")
        op.execute("SET statement_timeout = '30min'")
        # 禁止目录/文件/Workspace 引用在重复扫描与索引建立之间继续变化。
        # SHARE 保留普通读取，同时阻止这些表上的并发写入。
        op.execute("LOCK TABLE folders, files, workspaces IN SHARE MODE")
    _merge_active_duplicate_folders(connection)
    op.execute("""
        CREATE UNIQUE INDEX uq_folders_active_scope_name
        ON folders (
            user_id,
            (COALESCE(project_id, 0)),
            (COALESCE(workspace_directory_id, 0)),
            (COALESCE(parent_id, 0)),
            name
        )
        WHERE deleted_at IS NULL
    """)


def downgrade() -> None:
    op.execute("DROP INDEX IF EXISTS uq_folders_active_scope_name")
