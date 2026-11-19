-- 升级入口：仅用于已安装旧 delivery-schema.sql（已有run_delivery/receipts）的数据库。
-- 新建数据库使用当前 delivery-schema.sql；不要重复执行全部旧表DDL或同时执行两个入口。
-- 部署前显式审查/备份；服务启动不得自动执行。
BEGIN;
CREATE TABLE gugu_im_platform_projection (
  user_id uuid NOT NULL,
  session_id integer NOT NULL,
  run_id varchar(128) NOT NULL,
  platform varchar(16) NOT NULL CHECK (platform='feishu'),
  version bigint NOT NULL CHECK (version>0),
  nonce bytea NOT NULL CHECK (octet_length(nonce)=12),
  payload bytea NOT NULL CHECK (octet_length(payload)<=1048592),
  PRIMARY KEY(user_id,session_id,run_id,platform),
  FOREIGN KEY(user_id,session_id,run_id) REFERENCES gugu_im_run_delivery(user_id,session_id,run_id) ON DELETE CASCADE
);
COMMIT;
