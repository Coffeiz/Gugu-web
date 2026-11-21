import { definePostgresMigration } from '../runner.js'

export const webPush = definePostgresMigration({
  revision: '0024_web_push',
  prerequisites: ['users', 'site_notifications'],
  tables: ['web_push_subscriptions', 'web_push_outbox'],
  sql: `
CREATE TABLE web_push_subscriptions (
  id uuid PRIMARY KEY,
  owner_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  endpoint text NOT NULL UNIQUE,
  p256dh text NOT NULL,
  auth text NOT NULL,
  vapid_key text NOT NULL
);
CREATE INDEX web_push_subscriptions_owner ON web_push_subscriptions(owner_id);
CREATE TABLE web_push_outbox (
  subscription_id uuid NOT NULL REFERENCES web_push_subscriptions(id) ON DELETE CASCADE,
  notification_id integer NOT NULL REFERENCES site_notifications(id) ON DELETE CASCADE,
  ready_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL DEFAULT now() + interval '1 hour',
  attempts integer NOT NULL DEFAULT 0,
  PRIMARY KEY(subscription_id, notification_id)
);
CREATE INDEX web_push_outbox_ready ON web_push_outbox(ready_at);
`,
})
