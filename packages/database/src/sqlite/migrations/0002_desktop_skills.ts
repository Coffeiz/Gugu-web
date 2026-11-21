import type SQLite from 'better-sqlite3'

/** 为已有桌面数据库补充技能表，保留现有基线版本与全部用户数据。 */
export function initializeDesktopSkills(db: SQLite.Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS user_skills (
    id INTEGER PRIMARY KEY, owner_id TEXT NOT NULL, skill_id TEXT NOT NULL,
    name TEXT NOT NULL, description_short TEXT NOT NULL, description_long TEXT,
    category TEXT NOT NULL, body TEXT NOT NULL, related_tools TEXT NOT NULL,
    source TEXT NOT NULL, managed_by TEXT NOT NULL, enabled INTEGER NOT NULL CHECK(enabled IN (0,1)),
    content_digest TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
    UNIQUE(owner_id,skill_id)
  )`)
}
