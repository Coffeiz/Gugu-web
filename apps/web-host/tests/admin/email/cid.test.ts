import assert from 'node:assert/strict'
import test from 'node:test'
import {createHash} from 'node:crypto'
import {execFileSync} from 'node:child_process'
import {resolve} from 'node:path'
import {renderEmailPreview} from '@gugu/core/email-preview'

test('预览兼容Python对整份HTML中CID字面量的替换，纯文本保留原值',()=>{
 const python=process.env.GUGU_WEBUI_TEST_PYTHON
 assert.ok(python,'需要显式隔离测试Python')
 const draft={subject:'CID兼容',title:'cid:gugu-logo-mark',preheader:'cid:gugu-logo-wordmark',body:'第一行 cid:gugu-logo-mark\n第二行 cid:gugu-logo-wordmark',sections:[{heading:'cid:gugu-logo-mark',text:'cid:gugu-logo-wordmark'}],actions:[{label:'cid:gugu-logo-mark',url:'https://example.invalid/cid:gugu-logo-wordmark'}]}
 const expected=JSON.parse(execFileSync(python,['-c',"import hashlib,json,sys;from app.services.email.templates import render_email;content=render_email(**json.load(sys.stdin));print(json.dumps({'sha':hashlib.sha256(content.preview_html().encode()).hexdigest(),'plain':content.plain}))"],{encoding:'utf8',input:JSON.stringify(draft),cwd:resolve('../../backend'),env:{...process.env,PYTHONPATH:'.',GUGU_ENV_FILE:'/dev/null',GUGU_CONFIG_OVERRIDE_FILE:'/tmp/nonexistent-email-cid-test'}}))
 const actual=renderEmailPreview(draft)
 assert.equal(createHash('sha256').update(actual.html).digest('hex'),expected.sha)
 assert.equal(actual.plain,expected.plain)
 assert.doesNotMatch(actual.html,/cid:gugu-logo/)
})
