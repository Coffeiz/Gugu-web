import type {FastifyInstance,preHandlerHookHandler} from 'fastify'
import {testAdminEmail,normalizeEmailTestRecipient,type AdminEmailTestDraft} from '@gugu/core/email/test-delivery'
import {draft as validDraft} from './email-preview.js'
import {readSmtpFileSettings} from './smtp-probe.js'
import {createSmtpTestDelivery} from '../../adapters/smtp-test-delivery.js'
export function createAdminEmailFileTest(env:NodeJS.ProcessEnv,path:string) {
 return (draft:AdminEmailTestDraft)=>testAdminEmail(draft,readSmtpFileSettings(env,path),createSmtpTestDelivery(env))
}
export function registerAdminEmailTestRoute(app:FastifyInstance,options:{requireAdmin:preHandlerHookHandler;send:ReturnType<typeof createAdminEmailFileTest>}):void {
 app.post('/api/v1/admin/email/test',{preHandler:options.requireAdmin},async(request,reply)=>{
  const value=request.body
  if(!validDraft(value))return reply.code(422).send({detail:'邮件测试参数无效'})
  const body=value as unknown as AdminEmailTestDraft
  if(typeof body.recipient!=='string'||Array.from(body.recipient).length<3||Array.from(body.recipient).length>300||!normalizeEmailTestRecipient(body.recipient)||body.test_locale!==undefined&&!['zh-CN','ja-JP','en-US'].includes(body.test_locale))return reply.code(422).send({detail:'邮件测试参数无效'})
  try{return await options.send({...body,recipient:normalizeEmailTestRecipient(body.recipient)!})}catch{return reply.code(503).send({detail:'SMTP 配置不可读取'})}
 })
}
