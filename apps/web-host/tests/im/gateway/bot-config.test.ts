import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import type { Pool } from 'pg';
import { createGatewayBotConfig, createGatewayConfigChangePublisher } from '../../../src/modules/im/gateway/bot-config.js';
import { encryptEncryptedString } from '../../../src/adapters/security/encrypted-string.js';

const owner = '00000000-0000-0000-0000-00000000000a';
const secretKey = 'synthetic-gateway-key';

const pgUrl = process.env.GUGU_IM_GATEWAY_TEST_DATABASE_URL;
test('隔离PG：账户状态控制可信快照，实际提交变更通知后权威重读并释放LISTEN', {
  skip: !pgUrl && '需显式隔离PG；通知替身不验证LISTEN和账户JOIN', timeout: 10000,
}, async () => {
  const { Pool } = await import('pg');
  const schema = `im_config_${randomUUID().replaceAll('-', '')}`, admin = new Pool({ connectionString: pgUrl });
  let pool: Pool | undefined, subscription: Awaited<ReturnType<ReturnType<typeof createGatewayBotConfig>['subscribe']>> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await admin.query(`CREATE SCHEMA "${schema}"`);
    pool = new Pool({ connectionString: pgUrl, options: `-c search_path=${schema}` });
    await pool.query(`CREATE TABLE users(id uuid PRIMARY KEY,is_active boolean,account_status text);
      CREATE TABLE user_bots(id integer PRIMARY KEY,user_id uuid,platform text,app_id text,app_secret text,sandbox boolean,enabled boolean)`);
    await pool.query("INSERT INTO users VALUES($1,true,'active')", [owner]);
    await pool.query("INSERT INTO user_bots VALUES(1,$1,'telegram','',$2,false,true)", [owner, encryptEncryptedString(secretKey, 'synthetic-token')]);
    const config = createGatewayBotConfig({ pool, secretKey, supportedPlatforms: () => ['telegram'], normalizeOwner: value => value });
    assert.equal((await config.read())[0]!.credentials.appSecret, 'synthetic-token');
    let received!: () => void;
    const notified = new Promise<void>(resolve => { received = resolve; });
    subscription = await config.subscribe(received, new AbortController().signal);
    let webNotices = 0;
    const publish = createGatewayConfigChangePublisher(pool, async value => { assert.equal(value, owner); webNotices++; });
    await pool.query("UPDATE users SET account_status='suspended' WHERE id=$1", [owner]);
    await publish(owner);
    await Promise.race([notified, new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error('隔离PG通知超时')), 5000); })]);
    assert.equal(webNotices, 1); assert.deepEqual(await config.read(), []);
    await pool.query("UPDATE users SET account_status='active',is_active=false WHERE id=$1", [owner]);
    assert.deepEqual(await config.read(), []);
    await subscription.close(); await subscription.disconnected;
  } finally {
    if (timer) clearTimeout(timer);
    await subscription?.close(); await pool?.end();
    await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); await admin.end();
  }
});
function fixture() {
  let rows: Record<string, unknown>[] = [{ id: 1, platform: 'telegram', user_id: owner.toUpperCase(), app_id: '', app_secret: encryptEncryptedString(secretKey, 'synthetic-token'), sandbox: false, enabled: true, owner_is_active: true, owner_account_status: 'active' }];
  let fail = false;
  let allowed = ['telegram', 'qq', 'feishu', 'wechat'];
  let released = 0;
  const events: string[] = [];
  const client = Object.assign(new EventEmitter(), {
    async query(sql: string) { events.push(sql); if (fail) throw new Error('synthetic-token'); return { rows }; },
    release(destroy: boolean) { assert.equal(destroy, true); released++; },
  });
  const pool = {
    query: client.query,
    async connect() { events.push('connect'); return client; },
  } as unknown as Pick<Pool, 'query' | 'connect'>;
  const config = createGatewayBotConfig({ pool, secretKey, supportedPlatforms: () => allowed, normalizeOwner(value) {
    assert.equal(value.toLowerCase(), owner); return value.toLowerCase();
  } });
  return { config, client, events, setRows(value: typeof rows) { rows = value; }, row: () => ({ ...rows[0]! }),
    setAllowed(value: string[]) { allowed = value; }, fail() { fail = true; }, released: () => released };
}

test('可信配置读取解密并调用owner规范化；平台关闭与停用不启动', async () => {
  const f = fixture();
  const [spec] = await f.config.read();
  assert.equal(spec!.owner, owner);
  assert.equal(spec!.credentials.appSecret, 'synthetic-token');
  assert.equal(spec!.key, 'telegram:1');
  assert.match(spec!.revision, /^[a-f0-9]{64}$/);
  f.setAllowed(['qq']); assert.deepEqual(await f.config.read(), []);
  f.setAllowed(['telegram']); f.setRows([{ ...f.row(), enabled: false }]); assert.deepEqual(await f.config.read(), []);
  f.setRows([{ ...f.row(), enabled: true, owner_is_active: false }]); assert.deepEqual(await f.config.read(), []);
  f.setRows([{ ...f.row(), owner_is_active: true, owner_account_status: 'suspended' }]); assert.deepEqual(await f.config.read(), []);
});

test('丢失通知仍定期请求权威对账，关闭后不遗留定时任务', async context => {
  context.mock.timers.enable({ apis: ['setInterval'] });
  const f = fixture(); let reads = 0;
  const subscription = await f.config.subscribe(() => { reads++; }, new AbortController().signal);
  context.mock.timers.tick(30_000); assert.equal(reads, 1);
  await subscription.close();
  context.mock.timers.tick(60_000); assert.equal(reads, 1);
});

test('配置更新同时通知Gateway和Web，任一通知失败仍尝试另一条且不泄露上游异常', async () => {
  for (const fail of ['none', 'gateway', 'web']) {
    const calls: string[] = [];
    const publish = createGatewayConfigChangePublisher({ async query() { calls.push('gateway'); if (fail === 'gateway') throw new Error('synthetic-secret'); } } as never,
      async received => { assert.equal(received, owner); calls.push('web'); if (fail === 'web') throw new Error('synthetic-secret'); });
    if (fail === 'none') await publish(owner);
    else await assert.rejects(publish(owner), error => error instanceof Error && error.message === 'IM 配置变更通知待重试' && error.cause === undefined);
    assert.deepEqual(calls, ['gateway', 'web']);
  }
});

test('配置revision稳定且包含连接凭据与sandbox变化；重新加密不触发变更', async () => {
  const f = fixture(); const [first] = await f.config.read(); const row = f.row();
  f.setRows([{ ...row, app_secret: encryptEncryptedString(secretKey, 'synthetic-token') }]);
  assert.equal((await f.config.read())[0]!.revision, first!.revision);
  f.setRows([{ ...row, sandbox: true }]); assert.notEqual((await f.config.read())[0]!.revision, first!.revision);
  f.setRows([{ ...row, app_secret: 'synthetic-new-token' }]); assert.notEqual((await f.config.read())[0]!.revision, first!.revision);
});

test('损坏密文与数据库错误拒绝配置快照，固定错误不泄露凭据', async () => {
  const f = fixture(); f.setRows([{ ...f.row(), app_secret: 'gcm1:synthetic-token' }]);
  await assert.rejects(f.config.read(), { message: '读取网关配置失败' });
  f.setRows([{ ...f.row(), user_id: 'invalid-owner' }]);
  await assert.rejects(f.config.read(), { message: '读取网关配置失败' });
  f.fail(); await assert.rejects(f.config.read(), { message: '读取网关配置失败' });
});

test('LISTEN成功后返回订阅，通知payload只触发权威重读，close释放所有监听', async () => {
  const f = fixture(); const controller = new AbortController(); let notified = 0;
  const subscription = await f.config.subscribe(() => { notified++; }, controller.signal);
  assert.deepEqual(f.events, ['connect', 'LISTEN im_gateway_reload']);
  f.client.emit('notification', { channel: 'wrong', payload: 'synthetic-token' });
  f.client.emit('notification', { channel: 'im_gateway_reload', payload: '{"owner":"forged"}' });
  assert.equal(notified, 1);
  await subscription.close(); await subscription.disconnected;
  assert.equal(f.released(), 1);
  for (const event of ['notification', 'error', 'end']) assert.equal(f.client.listenerCount(event), 0);
  await subscription.close(); assert.equal(f.released(), 1);
});

test('监听断线与取消可观察且释放连接，LISTEN失败也不泄露上游异常', async () => {
  for (const event of ['error', 'end']) {
    const f = fixture(); const subscription = await f.config.subscribe(() => {}, new AbortController().signal);
    f.client.emit(event, new Error('synthetic-token')); await subscription.disconnected;
    await subscription.close(); assert.equal(f.released(), 1);
  }
  const f = fixture(); const controller = new AbortController();
  const subscription = await f.config.subscribe(() => {}, controller.signal);
  controller.abort(); await subscription.disconnected; assert.equal(f.released(), 1);
  const broken = fixture(); broken.fail();
  await assert.rejects(broken.config.subscribe(() => {}, new AbortController().signal), { message: '订阅网关配置失败' });
  assert.equal(broken.released(), 1);
});
