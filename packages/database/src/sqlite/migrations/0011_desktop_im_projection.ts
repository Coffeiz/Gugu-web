import type SQLite from 'better-sqlite3'

export function initializeDesktopImProjection(db: SQLite.Database): void {
  db.transaction(() => db.exec(`
    CREATE TABLE IF NOT EXISTS desktop_qq_sequences (
      sequence_key TEXT PRIMARY KEY,
      value INTEGER NOT NULL CHECK(value > 0),
      expires_ms INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS ix_desktop_qq_sequences_expiry ON desktop_qq_sequences(expires_ms);
    CREATE TABLE IF NOT EXISTS desktop_im_projections (
      owner_id TEXT NOT NULL,
      platform TEXT NOT NULL,
      connection_id TEXT NOT NULL,
      event_key TEXT NOT NULL,
      version INTEGER NOT NULL CHECK(version > 0),
      sealed_state BLOB NOT NULL,
      PRIMARY KEY(owner_id,platform,connection_id,event_key),
      FOREIGN KEY(owner_id,platform,connection_id,event_key)
        REFERENCES desktop_im_inbox(owner_id,platform,connection_id,event_key) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS desktop_im_projection_receipts (
      owner_id TEXT NOT NULL,
      platform TEXT NOT NULL,
      connection_id TEXT NOT NULL,
      event_key TEXT NOT NULL,
      operation_key TEXT NOT NULL,
      fingerprint TEXT NOT NULL CHECK(length(fingerprint) = 64),
      state TEXT NOT NULL CHECK(state IN ('sending','accepted','rejected','unknown')),
      PRIMARY KEY(owner_id,platform,connection_id,event_key,operation_key),
      FOREIGN KEY(owner_id,platform,connection_id,event_key)
        REFERENCES desktop_im_projections(owner_id,platform,connection_id,event_key) ON DELETE CASCADE
    );
  `)).immediate()
}
