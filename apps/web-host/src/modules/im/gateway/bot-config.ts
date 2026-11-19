import { createHmac } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { decryptEncryptedString } from '../../../adapters/security/encrypted-string.js';
import type { GatewayBotSpec, GatewaySubscription } from './supervisor.js';

export type GatewayPlatform = 'feishu' | 'qq' | 'wechat' | 'telegram';
export interface TrustedGatewayBot extends GatewayBotSpec {
  id: string;
  platform: GatewayPlatform;
  owner: string;
  credentials: { appId: string; appSecret: string };
  sandbox: boolean;
}
const platforms = new Set(['feishu', 'qq', 'wechat', 'telegram']);
const channel = 'im_gateway_reload';

/** 已提交Bot变更同时失效Gateway和Web视图；任一通知失败都不能阻止另一条。 */
export function createGatewayConfigChangePublisher(pool: Pick<Pool, 'query'>, publishChanged: (ownerId: string) => Promise<unknown>) {
  return async (ownerId: string): Promise<void> => {
    let failed = false;
    try { await pool.query("SELECT pg_notify('im_gateway_reload','')"); } catch { failed = true; }
    try { await publishChanged(ownerId); } catch { failed = true; }
    if (failed) throw new Error('IM 配置变更通知待重试');
  };
}

/** 只供可信 Host 装配使用，返回值含运行凭据，禁止用于 API DTO 或日志。 */
export function createGatewayBotConfig(options: {
  pool: Pick<Pool, 'query' | 'connect'>;
  secretKey: string;
  supportedPlatforms(): readonly string[] | Promise<readonly string[]>;
  normalizeOwner(owner: string): string;
  /** 低频权威对账恢复丢失的通知；不把通知作为配置真源。 */
  reconcileIntervalMs?: number;
}) {
  if (!options.secretKey) throw new Error('网关凭据密钥不可用');
  const reconcileInterval = options.reconcileIntervalMs ?? 30_000;
  if (!Number.isSafeInteger(reconcileInterval) || reconcileInterval < 1000 || reconcileInterval > 300_000) throw new Error('网关配置对账间隔无效');
  async function read(): Promise<TrustedGatewayBot[]> {
    try {
      const allowed = new Set(await options.supportedPlatforms());
      const { rows } = await options.pool.query<Record<string, unknown>>(
        `SELECT b.id,b.platform,b.user_id,b.app_id,b.app_secret,b.sandbox,b.enabled,
          u.is_active AS owner_is_active,u.account_status AS owner_account_status
         FROM user_bots b JOIN users u ON u.id=b.user_id
         WHERE b.enabled IS TRUE AND u.is_active IS TRUE AND COALESCE(u.account_status,'active')='active' ORDER BY b.id`,
      );
      const result: TrustedGatewayBot[] = [];
      for (const row of rows) {
        if (row.enabled !== true || row.owner_is_active !== true || (row.owner_account_status ?? 'active') !== 'active'
          || typeof row.platform !== 'string' || !platforms.has(row.platform) || !allowed.has(row.platform)) continue;
        const id = String(row.id);
        if (!/^[1-9][0-9]*$/.test(id) || typeof row.user_id !== 'string') throw new Error();
        const owner = options.normalizeOwner(row.user_id);
        if (typeof row.app_id !== 'string' || typeof row.app_secret !== 'string' || typeof row.sandbox !== 'boolean') throw new Error();
        const secret = decryptEncryptedString(options.secretKey, row.app_secret);
        // 兼容解密器会原样返回损坏密文；运行时必须拒绝，不能把密文作为平台凭据发送。
        if (!secret || secret.startsWith('gcm1:')) throw new Error();
        const value = {
          id, platform: row.platform as GatewayPlatform, owner,
          credentials: { appId: row.app_id, appSecret: secret }, sandbox: row.sandbox,
        };
        const revision = createHmac('sha256', options.secretKey)
          .update('gugu-im-gateway-config-v1\0').update(JSON.stringify(value)).digest('hex');
        result.push({ key: `${value.platform}:${id}`, revision, ...value });
      }
      return result;
    } catch { throw new Error('读取网关配置失败'); }
  }

  async function subscribe(notify: () => void, signal: AbortSignal): Promise<GatewaySubscription> {
    let client: PoolClient | undefined;
    let released = false;
    let disconnected = false;
    let timer: ReturnType<typeof setInterval> | undefined;
    let resolve!: () => void;
    const lost = new Promise<void>(done => { resolve = done; });
    const onLost = () => { disconnected = true; resolve(); };
    const onNotification = (event: { channel: string }) => {
      // payload 只是失效通知，不能成为 owner、配置或权限来源。
      if (!signal.aborted && !disconnected && event.channel === channel) notify();
    };
    const onAbort = () => { onLost(); void close(); };
    async function close() {
      if (released || !client) return;
      released = true;
      if (timer) clearInterval(timer);
      signal.removeEventListener('abort', onAbort);
      client.removeListener('notification', onNotification);
      client.removeListener('error', onLost);
      client.removeListener('end', onLost);
      // 专用LISTEN连接不回池复用，避免取消/断线时留下监听状态或未决查询。
      client.release(true);
      resolve();
    }
    try {
      if (signal.aborted) throw new Error();
      client = await options.pool.connect();
      client.on('notification', onNotification);
      client.on('error', onLost);
      client.on('end', onLost);
      signal.addEventListener('abort', onAbort, { once: true });
      if (signal.aborted) throw new Error();
      await client.query(`LISTEN ${channel}`);
      if (signal.aborted || disconnected) throw new Error();
      timer = setInterval(() => {
        if (!signal.aborted && !disconnected) {
          try { notify(); } catch { onLost(); void close(); }
        }
      }, reconcileInterval);
      timer.unref?.();
      return { disconnected: lost, close };
    } catch {
      await close();
      throw new Error('订阅网关配置失败');
    }
  }
  return { read, subscribe };
}
