-- 仅用于已应用旧delivery-schema.sql的数据库；须由部署者显式执行。
-- 保留飞书既有密文、密钥派生和AAD；新QQ/Telegram状态使用独立platform绑定。
BEGIN;
ALTER TABLE gugu_im_platform_projection DROP CONSTRAINT gugu_im_platform_projection_platform_check;
ALTER TABLE gugu_im_platform_projection ADD CONSTRAINT gugu_im_platform_projection_platform_check
  CHECK (platform IN ('feishu','qq','telegram'));
COMMIT;
