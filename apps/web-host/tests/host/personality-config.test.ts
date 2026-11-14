import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { loadConfig } from '../../src/config.js'

const required = {
  GUGU_WEBUI_DATABASE_URL: 'postgres://db.invalid/gugu',
  SECRET_KEY: 'synthetic-secret',
}

test('personality preference availability follows the Python-compatible default and environment switch', () => {
  assert.equal(loadConfig(required).personalityPreferenceEnabled, true)
  assert.equal(loadConfig({ ...required, AGENT__PERSONALITY_PREFERENCE_ENABLED: 'false' }).personalityPreferenceEnabled, false)
  assert.throws(
    () => loadConfig({ ...required, AGENT__PERSONALITY_PREFERENCE_ENABLED: 'sometimes' }),
    /AGENT__PERSONALITY_PREFERENCE_ENABLED 配置无效/,
  )
})

test('agent config override takes precedence over the environment feature switch', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'gugu-personality-config-'))
  const overridePath = path.join(directory, 'config.override.json')
  try {
    await writeFile(overridePath, JSON.stringify({ agent: { personality_preference_enabled: false } }), { mode: 0o600 })
    const config = loadConfig({ ...required, AGENT__PERSONALITY_PREFERENCE_ENABLED: 'true' }, overridePath)
    assert.equal(config.personalityPreferenceEnabled, false)
  } finally { await rm(directory, { recursive: true, force: true }) }
})
