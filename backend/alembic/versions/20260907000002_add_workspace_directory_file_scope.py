"""让文件和文件夹记录可归属到顶层 Workspace。

这一步必须能在生产大表上安全运行：新增的值全部为 NULL，不需要为了验证历史
数据而长时间持有表锁；索引使用 CONCURRENTLY，外键先以 NOT VALID 约束未来写入。
"""

from alembic import op


revision = "20260907000002"
down_revision = "20260907000001"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # 不允许迁移无限等待业务连接释放表锁；失败时让部署器得到明确错误并可重试。
    op.execute("SET lock_timeout = '30s'")
    op.execute("SET statement_timeout = '30min'")

    # IF NOT EXISTS 让迁移在被中断后可以安全重跑。可空列的 ADD COLUMN 在 PostgreSQL
    # 上不重写历史行，只需很短的元数据锁。
    op.execute("ALTER TABLE files ADD COLUMN IF NOT EXISTS workspace_directory_id INTEGER")
    op.execute("ALTER TABLE folders ADD COLUMN IF NOT EXISTS workspace_directory_id INTEGER")

    # 历史列刚创建且全部为 NULL，验证旧行没有收益，却可能扫描整张大表并阻塞迁移。
    # NOT VALID 仍会校验所有后续 INSERT/UPDATE；后续可在低峰期单独 VALIDATE。
    op.execute("""
        DO $$
        BEGIN
            IF NOT EXISTS (
                SELECT 1 FROM pg_constraint WHERE conname = 'fk_files_workspace_directory_id'
            ) THEN
                ALTER TABLE files
                ADD CONSTRAINT fk_files_workspace_directory_id
                FOREIGN KEY (workspace_directory_id) REFERENCES workspace_directories(id)
                ON DELETE SET NULL NOT VALID;
            END IF;
            IF NOT EXISTS (
                SELECT 1 FROM pg_constraint WHERE conname = 'fk_folders_workspace_directory_id'
            ) THEN
                ALTER TABLE folders
                ADD CONSTRAINT fk_folders_workspace_directory_id
                FOREIGN KEY (workspace_directory_id) REFERENCES workspace_directories(id)
                ON DELETE SET NULL NOT VALID;
            END IF;
        END $$;
    """)

    # CREATE INDEX CONCURRENTLY 不阻塞 files/folders 的正常读写；autocommit_block
    # 会先提交上面的元数据变更，避免 PostgreSQL 禁止在事务中执行 CONCURRENTLY。
    with op.get_context().autocommit_block():
        # 被 kill 的 CREATE INDEX CONCURRENTLY 会留下 indisvalid=false 的索引；
        # 先删除同名残留，避免 IF NOT EXISTS 错误地跳过重建。
        op.execute("DROP INDEX CONCURRENTLY IF EXISTS ix_files_workspace_directory_id")
        op.execute("DROP INDEX CONCURRENTLY IF EXISTS ix_folders_workspace_directory_id")
        op.execute("CREATE INDEX CONCURRENTLY IF NOT EXISTS ix_files_workspace_directory_id ON files (workspace_directory_id)")
        op.execute("CREATE INDEX CONCURRENTLY IF NOT EXISTS ix_folders_workspace_directory_id ON folders (workspace_directory_id)")


def downgrade() -> None:
    with op.get_context().autocommit_block():
        op.execute("DROP INDEX CONCURRENTLY IF EXISTS ix_folders_workspace_directory_id")
        op.execute("DROP INDEX CONCURRENTLY IF EXISTS ix_files_workspace_directory_id")
    op.execute("ALTER TABLE folders DROP CONSTRAINT IF EXISTS fk_folders_workspace_directory_id")
    op.execute("ALTER TABLE files DROP CONSTRAINT IF EXISTS fk_files_workspace_directory_id")
    op.execute("ALTER TABLE folders DROP COLUMN IF EXISTS workspace_directory_id")
    op.execute("ALTER TABLE files DROP COLUMN IF EXISTS workspace_directory_id")
