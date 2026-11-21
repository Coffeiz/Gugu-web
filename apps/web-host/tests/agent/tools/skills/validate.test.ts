import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { normalizeUserSkill } from '../../../../../../packages/core/src/agent/skills/user-validation.js'

const digest = (body:string) => createHash('sha256').update(body).digest('hex').slice(0,16)
test('用户技能规范化正文、分类和关联工具，并拒绝未知工具', () => {
 const result = normalizeUserSkill({name:'  合成技能 ',description_short:' 摘要 ',description_long:'  ',category:' PERSONAL ',body:' 正文 ',related_tools:[' web_search ','web_search','mcp_remote']},new Set(['web_search']),digest)
 assert.equal(result.name,'合成技能'); assert.equal(result.body,'正文'); assert.equal(result.description_long,null)
 assert.equal(result.category,'personal'); assert.deepEqual(result.related_tools,['web_search','mcp_remote']); assert.equal(result.content_digest,digest('正文'))
 assert.throws(()=>normalizeUserSkill({name:'a',description_short:'b',description_long:null,category:'personal',body:'x',related_tools:['unknown']},new Set(),digest))
 assert.throws(()=>normalizeUserSkill({name:'a',description_short:'b',description_long:null,category:'invalid',body:'x',related_tools:[]},new Set(),digest))
})

test('用户技能规范化与实际 Python 规则一致',{skip:!process.env.GUGU_CORE_GOLDEN_PYTHON&&'需要隔离 Python'},async()=>{
 const python=process.env.GUGU_CORE_GOLDEN_PYTHON
 assert.ok(python,'需要显式隔离 Python')
 const {execFile}=await import('node:child_process');const {promisify}=await import('node:util')
 const source=`import json\nfrom agent.capabilities.skill_registry import validate_user_skill\nr=validate_user_skill(name='  合成  ',description_short=' 摘要 ',description_long='  ',category=' PERSONAL ',body=' 正文 ',related_tools=[' web_search ','web_search','mcp_demo'],owner_id='synthetic')\nprint(json.dumps(r,ensure_ascii=False))`
 const cwd = process.env.GUGU_CORE_GOLDEN_BACKEND ?? fileURLToPath(new URL('../../../../../../backend/', import.meta.url))
 const root = await mkdtemp(join(tmpdir(), 'gugu-skill-golden-'))
 try {
  const { stdout } = await promisify(execFile)(python, ['-c', source], {
   cwd,
   env: {
    ...process.env,
    PYTHONPATH: [cwd, resolve(cwd, '../compat/core-python/src')].join(delimiter),
    GUGU_ENV_FILE: join(root, 'absent.env'),
    GUGU_CONFIG_OVERRIDE_FILE: join(root, 'absent.json'),
    STORAGE__LOCAL_PATH: join(root, 'storage'),
   },
  })
  const expected=JSON.parse(stdout),actual=normalizeUserSkill({name:'  合成  ',description_short:' 摘要 ',description_long:'  ',category:' PERSONAL ',body:' 正文 ',related_tools:[' web_search ','web_search','mcp_demo']},new Set(['web_search']),digest)
  assert.deepEqual(actual,expected)
 } finally {
  await rm(root, { recursive: true, force: true })
 }
})
