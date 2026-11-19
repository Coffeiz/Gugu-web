-- 显式迁移：审查、备份并确认Node独占对应Bot后执行；Gateway不自动建表。
-- 与owner绑定在同一事务记录挑战消费，防止Redis清理失败后解绑重用旧码。
CREATE TABLE gugu_im_binding_consumptions (
  platform varchar(20) NOT NULL CHECK (platform IN ('qq','telegram')),
  bot_id integer NOT NULL REFERENCES user_bots(id) ON DELETE CASCADE,
  owner_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  challenge_digest char(64) NOT NULL CHECK (challenge_digest ~ '^[0-9a-f]{64}$'),
  sender_digest char(64) NOT NULL CHECK (sender_digest ~ '^[0-9a-f]{64}$'),
  consumed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(platform,bot_id,challenge_digest)
);
