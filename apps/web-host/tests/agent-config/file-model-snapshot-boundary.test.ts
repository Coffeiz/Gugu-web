import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import test from 'node:test'
import { Pool } from 'pg'
import type { ProviderConfig } from '@gugu/core/providers'
import { createFileModelSnapshotBoundary } from '../../src/domains/agent-config/file-model-snapshot-boundary.js'
import { createAtomicAgentModelSnapshot } from '../../src/domains/agent-config/atomic-model-snapshot.js'
const url = process.env.GUGU_WEBUI_TEST_DATABASE_URL
const skip = !(url && ['darwin', 'linux'].includes(process.platform) && Number(process.versions.node.split('.')[0]) >= 26)

test('锁内读取完整配置与 PG owner 快照，内容和实际密钥变化更新不透明版本', { skip: skip && '需要 Node 26、POSIX 和隔离 PostgreSQL' }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'gugu-model-file-')), path = join(directory, 'config.json'), schema = `gugu_model_file_${randomUUID().replaceAll('-', '')}`
  const admin = new Pool({ connectionString: url, max: 1 })
  await admin.query(`CREATE SCHEMA "${schema}"`)
  const pool = new Pool({ connectionString: url, options: `-c search_path=${schema}`, max: 3 })
  try {
    await pool.query(`CREATE TABLE user_provider_credentials (id integer PRIMARY KEY, user_id text, capability text, enabled boolean, provider text, api_format text, base_url text, model text, encrypted_value text, nonce text, encrypted_data_key text, key_version integer, max_tokens integer, context_tokens integer, thinking text, reasoning_effort text, reasoning_persistence text, image boolean, video boolean, audio boolean, image_detail text, web_search_enabled boolean)`)
    await pool.query("INSERT INTO user_provider_credentials VALUES (1,'owner-a','llm',true,'openai','','https://example.test','user-model','synthetic-cipher','nonce','wrapped',1,NULL,NULL,NULL,NULL,'off',false,false,false,'auto',false)")
    const base = { ai: { provider: 'openai', model: 'model-a', api_key: 'synthetic-platform-key' } }
    await writeFile(path, JSON.stringify(base))
    let masterKey = 'synthetic-master-1', envKey = 'synthetic-env-1', permission = 'permission-1', incomplete = false
    const boundary = createFileModelSnapshotBoundary({ path, versionSecret: 'synthetic-hmac-key',
      resolveEffective(document) { return { ai: document.ai as ProviderConfig, byokEnabled: true, systemPrompt: '合成系统', versionMaterial: { credentialsMasterKeys: incomplete ? {} as Record<string, string> : { '1': masterKey }, permissionIdentity: permission, environment: { apiKey: envKey } } } },
      async accessScope() { return { contextScopeKey: 'b'.repeat(64), accessScopeHash: 'c'.repeat(64) } },
    })
    const select = createAtomicAgentModelSnapshot(pool, 'synthetic-credential-hmac', boundary, null), identity = { ownerId: 'owner-a', sessionId: '1', runId: 'run-a' }, signal = new AbortController().signal
    const first = await select(identity, signal); first.release()
    const same = await select(identity, signal); same.release()
    assert.equal(first.configVersion, same.configVersion); assert.equal(first.credentialVersion, same.credentialVersion)
    assert.equal(first.credential?.model, 'user-model')
    assert.doesNotMatch(JSON.stringify([first.configVersion, first.credentialVersion, first.accessScopeHash]), /synthetic-platform-key|synthetic-master|synthetic-env|synthetic-cipher/)
    masterKey = 'synthetic-master-2'; const changedKey = await select(identity, signal); changedKey.release(); assert.notEqual(first.configVersion, changedKey.configVersion)
    masterKey = 'synthetic-master-1'; envKey = 'synthetic-env-2'; const changedEnv = await select(identity, signal); changedEnv.release(); assert.notEqual(first.configVersion, changedEnv.configVersion)
    envKey = 'synthetic-env-1'; permission = 'permission-2'; const changedPermission = await select(identity, signal); changedPermission.release(); assert.notEqual(first.configVersion, changedPermission.configVersion)
    permission = 'permission-1'
    const script = "import fcntl,os,sys,json; f=os.open(sys.argv[1],os.O_CREAT|os.O_RDWR,0o600); fcntl.flock(f,fcntl.LOCK_EX); print('ready',flush=True); sys.stdin.readline(); d=json.load(open(sys.argv[2])); d['ai']['model']='model-b'; t=sys.argv[2]+'.temp'; open(t,'w').write(json.dumps(d)); os.replace(t,sys.argv[2]); fcntl.flock(f,fcntl.LOCK_UN)"
    const writer = spawn('python3', ['-u', '-c', script, join(directory, '.config.json.lock'), path], { stdio: ['pipe', 'pipe', 'pipe'] })
    try {
      await once(writer.stdout!, 'data')
      let settled = false
      const pending = select(identity, signal).finally(() => { settled = true })
      await new Promise(resolve => setTimeout(resolve, 80)); assert.equal(settled, false)
      writer.stdin!.write('\n'); await once(writer, 'exit')
      const changed = await pending; changed.release(); assert.notEqual(first.configVersion, changed.configVersion); assert.equal(changed.config.model, 'model-b')
    } finally { if (writer.exitCode === null && writer.signalCode === null) { writer.kill('SIGKILL'); await once(writer, 'exit') } }
    await writeFile(path, JSON.stringify(base)); const reverted = await select(identity, signal); reverted.release(); assert.equal(first.configVersion, reverted.configVersion)
    await pool.query("UPDATE user_provider_credentials SET encrypted_value='synthetic-cipher-new' WHERE id=1")
    const updated = await select(identity, signal); updated.release(); assert.notEqual(first.credentialVersion, updated.credentialVersion)
    incomplete = true; await assert.rejects(select(identity, signal), /有效模型配置不完整/); incomplete = false
    await writeFile(path, '{ invalid'); await assert.rejects(select(identity, signal), /无法解析有效模型配置/)
    await rm(path); await assert.rejects(select(identity, signal), /无法解析有效模型配置/)
  } finally { await pool.end(); await admin.query(`DROP SCHEMA "${schema}" CASCADE`); await admin.end(); await rm(directory, { recursive: true, force: true }) }
})
