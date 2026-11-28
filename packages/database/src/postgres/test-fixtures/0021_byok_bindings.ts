import { definePostgresMigration } from '../runner.js'

export const byokBindings = definePostgresMigration({
  revision: '0021_byok_bindings',
  prerequisites: ['user_provider_credentials'],
  tables: ['user_provider_bindings'],
  sql: `
CREATE TABLE user_provider_bindings (
  user_id UUID NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  capability VARCHAR(32) NOT NULL,
  credential_id INTEGER NOT NULL REFERENCES user_provider_credentials (id) ON DELETE CASCADE,
  PRIMARY KEY (user_id, capability)
);

-- 历史查询按编号选择首个启用项，迁移沿用该选择。
INSERT INTO user_provider_bindings (user_id, capability, credential_id)
SELECT DISTINCT ON (user_id, capability) user_id, capability, id
FROM user_provider_credentials
WHERE enabled
ORDER BY user_id, capability, id;

UPDATE user_provider_credentials AS item SET enabled = false
WHERE item.enabled AND NOT EXISTS (
  SELECT 1 FROM user_provider_bindings AS binding WHERE binding.credential_id = item.id
);
`,
})
