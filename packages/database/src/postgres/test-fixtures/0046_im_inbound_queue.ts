import { definePostgresMigration } from '../runner.js'

export const imInboundQueue = definePostgresMigration({
  revision: '0046_im_inbound_queue',
  prerequisites: ['users', 'user_bots'],
  tables: ['gugu_im_inbound_queue', 'gugu_im_telegram_cursors'],
  indexes: ['gugu_im_inbound_queue_pending', 'gugu_im_inbound_queue_group', 'gugu_im_inbound_queue_cleanup'],
  createdObjects: ['gugu_im_inbound_queue', 'gugu_im_telegram_cursors'],
  sql: `
    CREATE TABLE gugu_im_inbound_queue (
      id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      bot_id integer NOT NULL REFERENCES user_bots(id) ON DELETE CASCADE,
      platform text NOT NULL,
      event_key text NOT NULL,
      group_id text,
      received_ms bigint NOT NULL DEFAULT floor(extract(epoch FROM clock_timestamp()) * 1000),
      payload jsonb,
      lease_token uuid,
      lease_until timestamptz,
      settled_at timestamptz,
      UNIQUE(user_id, bot_id, platform, event_key)
    );
    CREATE INDEX gugu_im_inbound_queue_pending ON gugu_im_inbound_queue (id) WHERE settled_at IS NULL;
    CREATE INDEX gugu_im_inbound_queue_group ON gugu_im_inbound_queue (user_id, bot_id, platform, group_id, received_ms)
      WHERE group_id IS NOT NULL AND payload IS NOT NULL;
    CREATE INDEX gugu_im_inbound_queue_cleanup ON gugu_im_inbound_queue (settled_at) WHERE payload IS NOT NULL;

    CREATE TABLE gugu_im_telegram_cursors (
      user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      bot_id integer NOT NULL REFERENCES user_bots(id) ON DELETE CASCADE,
      update_id bigint NOT NULL CHECK(update_id >= 0),
      PRIMARY KEY(user_id, bot_id)
    );
  `,
})
