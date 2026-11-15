import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSafeEgressSettingsReader } from '../../src/modules/admin/safe-egress-settings.js'

test('安全出站配置按默认、环境嵌套与override优先级读取且不改写文件', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gugu-safe-egress-read-'))
  const path = join(root, 'config.json')
  try {
    const env = { SAFE_EGRESS: JSON.stringify({enabled:true,proxy_url:'http://proxy.example.test:8080',proxy_auth_secret:'synthetic-env-secret'}), SAFE_EGRESS__ENABLED: 'false' }
    await writeFile(path, JSON.stringify({ safe_egress:{enabled:true}, database:{keep:'synthetic'} }))
    const before = await readFile(path, 'utf8')
    const read = createSafeEgressSettingsReader(env, path)
    assert.deepEqual(read(), { enabled:true,proxy_url:'http://proxy.example.test:8080',proxy_auth_secret:'synthetic-env-secret' })
    assert.equal(await readFile(path, 'utf8'), before)
    await writeFile(path, JSON.stringify({safe_egress:{proxy_auth_secret:''}}))
    assert.equal(read().proxy_auth_secret, '')
    await writeFile(path, '{broken')
    assert.throws(read, /配置/)
    assert.deepEqual(createSafeEgressSettingsReader({}, join(root,'missing.json'))(), { enabled:false,proxy_url:'',proxy_auth_secret:'' })
  } finally { await rm(root, {recursive:true,force:true}) }
})

test('读取保持历史配置中的无凭据路径和查询，不执行出站连接', async () => {
  const { publicSafeEgressSettings } = await import('../../../../packages/core/src/preferences/safe-egress.js')
  const proxy_url = 'http://proxy.example.test:8080/status?mode=legacy#health'
  assert.deepEqual(publicSafeEgressSettings({ enabled: false, proxy_url, proxy_auth_secret: '' }), { enabled: false, proxy_url, has_auth: false })
})
