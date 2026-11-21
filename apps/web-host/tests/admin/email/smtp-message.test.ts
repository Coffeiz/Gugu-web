import assert from 'node:assert/strict'
import {execFileSync} from 'node:child_process'
import {createHash} from 'node:crypto'
import {resolve} from 'node:path'
import test from 'node:test'
import {smtpTestMessage} from '@gugu/core/email/smtp-test'

test('SMTP测试邮件与Python实际_build_msg的完整HTML、纯文本、CID图像一致',()=>{
 const python=process.env.GUGU_CORE_GOLDEN_PYTHON;assert.ok(python)
 const reference=JSON.parse(execFileSync(python,[resolve('tests/admin/fixtures/smtp_test_message_python.py')],{cwd:resolve('../../backend'),env:{...process.env,PYTHONPATH:resolve('../../backend')}}).toString())
 const message=smtpTestMessage()
 assert.deepEqual({...message,images:message.images.map(image=>({cid:image.cid,filename:image.filename,sha256:createHash('sha256').update(Buffer.from(image.base64,'base64')).digest('hex')}))},reference)
})
