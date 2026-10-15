"""项目卡片文件数投影的 PostgreSQL 数据库对象。"""

PROJECT_FILE_COUNT_PROJECTION_SQL = (
    """CREATE TABLE IF NOT EXISTS project_file_counts (
        project_id INTEGER PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
        file_count BIGINT NOT NULL CONSTRAINT ck_project_file_counts_positive CHECK (file_count > 0)
    )""",
    """CREATE TABLE IF NOT EXISTS project_file_count_projection_state (
        id SMALLINT PRIMARY KEY CHECK (id = 1),
        initialized_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )""",
    """CREATE OR REPLACE FUNCTION gugu_project_file_count_after_insert()
    RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
        INSERT INTO project_file_counts (project_id, file_count)
        SELECT project_id, count(*)::bigint
        FROM new_project_files
        WHERE space = 'project' AND project_id IS NOT NULL AND folder_id IS NULL AND deleted_at IS NULL
        GROUP BY project_id
        ON CONFLICT (project_id) DO UPDATE
        SET file_count = project_file_counts.file_count + EXCLUDED.file_count;
        RETURN NULL;
    END;
    $$""",
    """CREATE OR REPLACE FUNCTION gugu_project_file_count_after_delete()
    RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
        WITH deltas AS (
            SELECT project_id, -count(*)::bigint AS delta
            FROM old_project_files
            WHERE space = 'project' AND project_id IS NOT NULL AND folder_id IS NULL AND deleted_at IS NULL
            GROUP BY project_id
        )
        DELETE FROM project_file_counts AS counts
        USING deltas
        WHERE counts.project_id = deltas.project_id
          AND counts.file_count + deltas.delta <= 0;

        WITH deltas AS (
            SELECT project_id, -count(*)::bigint AS delta
            FROM old_project_files
            WHERE space = 'project' AND project_id IS NOT NULL AND folder_id IS NULL AND deleted_at IS NULL
            GROUP BY project_id
        )
        UPDATE project_file_counts AS counts
        SET file_count = counts.file_count + deltas.delta
        FROM deltas
        WHERE counts.project_id = deltas.project_id
          AND counts.file_count + deltas.delta > 0;
        RETURN NULL;
    END;
    $$""",
    """CREATE OR REPLACE FUNCTION gugu_project_file_count_after_update()
    RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
        WITH deltas AS (
            SELECT project_id, sum(delta)::bigint AS delta
            FROM (
                SELECT project_id, -count(*)::bigint AS delta
                FROM old_project_files
                WHERE space = 'project' AND project_id IS NOT NULL AND folder_id IS NULL AND deleted_at IS NULL
                GROUP BY project_id
                UNION ALL
                SELECT project_id, count(*)::bigint AS delta
                FROM new_project_files
                WHERE space = 'project' AND project_id IS NOT NULL AND folder_id IS NULL AND deleted_at IS NULL
                GROUP BY project_id
            ) AS changes
            GROUP BY project_id
            HAVING sum(delta) <> 0
        )
        INSERT INTO project_file_counts (project_id, file_count)
        SELECT project_id, delta
        FROM deltas
        WHERE delta > 0
        ON CONFLICT (project_id) DO UPDATE
        SET file_count = project_file_counts.file_count + EXCLUDED.file_count;

        WITH deltas AS (
            SELECT project_id, sum(delta)::bigint AS delta
            FROM (
                SELECT project_id, -count(*)::bigint AS delta
                FROM old_project_files
                WHERE space = 'project' AND project_id IS NOT NULL AND folder_id IS NULL AND deleted_at IS NULL
                GROUP BY project_id
                UNION ALL
                SELECT project_id, count(*)::bigint AS delta
                FROM new_project_files
                WHERE space = 'project' AND project_id IS NOT NULL AND folder_id IS NULL AND deleted_at IS NULL
                GROUP BY project_id
            ) AS changes
            GROUP BY project_id
            HAVING sum(delta) < 0
        )
        DELETE FROM project_file_counts AS counts
        USING deltas
        WHERE counts.project_id = deltas.project_id
          AND counts.file_count + deltas.delta <= 0;

        WITH deltas AS (
            SELECT project_id, sum(delta)::bigint AS delta
            FROM (
                SELECT project_id, -count(*)::bigint AS delta
                FROM old_project_files
                WHERE space = 'project' AND project_id IS NOT NULL AND folder_id IS NULL AND deleted_at IS NULL
                GROUP BY project_id
                UNION ALL
                SELECT project_id, count(*)::bigint AS delta
                FROM new_project_files
                WHERE space = 'project' AND project_id IS NOT NULL AND folder_id IS NULL AND deleted_at IS NULL
                GROUP BY project_id
            ) AS changes
            GROUP BY project_id
            HAVING sum(delta) < 0
        )
        UPDATE project_file_counts AS counts
        SET file_count = counts.file_count + deltas.delta
        FROM deltas
        WHERE counts.project_id = deltas.project_id
          AND counts.file_count + deltas.delta > 0;
        RETURN NULL;
    END;
    $$""",
    # 锁住文件写入期间安装触发器并初始化，避免切换期间并发写入导致投影漏计或重复计数。
    "LOCK TABLE files IN SHARE ROW EXCLUSIVE MODE",
    """DO $$ BEGIN
        IF NOT EXISTS (
            SELECT 1 FROM pg_trigger
            WHERE tgrelid = 'files'::regclass AND tgname = 'trg_project_file_count_insert'
              AND NOT tgisinternal
        ) THEN
            CREATE TRIGGER trg_project_file_count_insert
            AFTER INSERT ON files
            REFERENCING NEW TABLE AS new_project_files
            FOR EACH STATEMENT EXECUTE FUNCTION gugu_project_file_count_after_insert();
        END IF;
        IF NOT EXISTS (
            SELECT 1 FROM pg_trigger
            WHERE tgrelid = 'files'::regclass AND tgname = 'trg_project_file_count_delete'
              AND NOT tgisinternal
        ) THEN
            CREATE TRIGGER trg_project_file_count_delete
            AFTER DELETE ON files
            REFERENCING OLD TABLE AS old_project_files
            FOR EACH STATEMENT EXECUTE FUNCTION gugu_project_file_count_after_delete();
        END IF;
        IF NOT EXISTS (
            SELECT 1 FROM pg_trigger
            WHERE tgrelid = 'files'::regclass AND tgname = 'trg_project_file_count_update'
              AND NOT tgisinternal
        ) THEN
            CREATE TRIGGER trg_project_file_count_update
            AFTER UPDATE ON files
            REFERENCING OLD TABLE AS old_project_files NEW TABLE AS new_project_files
            FOR EACH STATEMENT EXECUTE FUNCTION gugu_project_file_count_after_update();
        END IF;
    END $$""",
    """DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM project_file_count_projection_state WHERE id = 1) THEN
            INSERT INTO project_file_counts (project_id, file_count)
            SELECT project_id, count(*)::bigint
            FROM files
            WHERE space = 'project' AND project_id IS NOT NULL AND folder_id IS NULL AND deleted_at IS NULL
            GROUP BY project_id
            ON CONFLICT (project_id) DO NOTHING;

            INSERT INTO project_file_count_projection_state (id) VALUES (1)
            ON CONFLICT (id) DO NOTHING;
        END IF;
    END $$""",
)

PROJECT_FILE_COUNT_DROP_SQL = (
    "DROP TRIGGER IF EXISTS trg_project_file_count_update ON files",
    "DROP TRIGGER IF EXISTS trg_project_file_count_delete ON files",
    "DROP TRIGGER IF EXISTS trg_project_file_count_insert ON files",
    "DROP FUNCTION IF EXISTS gugu_project_file_count_after_update()",
    "DROP FUNCTION IF EXISTS gugu_project_file_count_after_delete()",
    "DROP FUNCTION IF EXISTS gugu_project_file_count_after_insert()",
    "DROP TABLE IF EXISTS project_file_count_projection_state",
    "DROP TABLE IF EXISTS project_file_counts",
)


async def rebuild_project_file_count_projection(db) -> int:
    """在阻止文件写入的事务中重建投影，返回有文件的项目数。"""
    from sqlalchemy import delete, func, select, text

    from app.models import ProjectFileCount

    if db.bind.dialect.name != "postgresql":
        raise RuntimeError("项目文件数投影只能在 PostgreSQL 上重建")

    await db.execute(text("LOCK TABLE files IN SHARE MODE"))
    await db.execute(delete(ProjectFileCount))
    await db.execute(text("""
        INSERT INTO project_file_counts (project_id, file_count)
        SELECT project_id, count(*)::bigint
        FROM files
        WHERE space = 'project' AND project_id IS NOT NULL AND folder_id IS NULL AND deleted_at IS NULL
        GROUP BY project_id
    """))
    await db.execute(text("""
        INSERT INTO project_file_count_projection_state (id) VALUES (1)
        ON CONFLICT (id) DO NOTHING
    """))
    project_count = await db.scalar(select(func.count()).select_from(ProjectFileCount))
    await db.commit()
    return int(project_count or 0)


async def get_project_file_counts(db, user_id, project_ids: list[int] | None = None) -> dict[int, int]:
    """只读取当前用户项目的投影；不扫描 files 表。"""
    from sqlalchemy import func, select

    from app.models import Project, ProjectFileCount

    statement = (
        select(Project.id, func.coalesce(ProjectFileCount.file_count, 0))
        .outerjoin(ProjectFileCount, ProjectFileCount.project_id == Project.id)
        .where(Project.user_id == user_id)
    )
    if project_ids is not None:
        if not project_ids:
            return {}
        statement = statement.where(Project.id.in_(project_ids))
    rows = (await db.execute(statement)).all()
    return {int(project_id): int(file_count) for project_id, file_count in rows}
