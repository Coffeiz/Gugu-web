import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { readConfigOverride } from '../../src/adapters/config/config-override-file.js'
import { createAgentStateLabelOverrides } from '../../src/modules/agent/sessions/labels.js'

test('合成配置支持旧扁平、嵌套、动态读取和 Python 值形式', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'gugu-label-config-')), path = join(dir, 'test-config.json')
  try {
    const read = createAgentStateLabelOverrides(() => readConfigOverride(path))
    await writeFile(path, JSON.stringify({ state_labels: { _thinking: '旧标签', _count: 12, _none: null, _flag: true, _list: ['一', false, null, '甲\u00a0乙'], _dict: { label: '值' } } }))
    assert.deepEqual(read(), { _thinking: '旧标签', _count: '12', _none: 'None', _flag: 'True', _list: "['一', False, None, '甲\\xa0乙']", _dict: "{'label': '值'}" })
    await writeFile(path, JSON.stringify({ state_labels: { _thinking: '不可用旧值', overrides: { _thinking: '新标签' } } }))
    assert.deepEqual(read(), { _thinking: '新标签' })
    await writeFile(path, JSON.stringify({ state_labels: { _thinking: '不可用旧值', overrides: null } }))
    assert.deepEqual(read(), {})
    await writeFile(path, '{invalid')
    assert.throws(read, /配置文件损坏或格式无效/)
  } finally { await rm(dir, { recursive: true, force: true }) }
})
