import type { FastifyInstance,preHandlerHookHandler } from 'fastify'

import type { EmailPreviewDraft } from '@gugu/core/email-preview'

import { deliverAdminEmailBulk,type AdminEmailDeliveryMetric,type AdminEmailPublishSettings,type AdminEmailPublishSummary } from '@gugu/core/email/publish'

import type { SmtpTestDelivery } from '@gugu/core/email/smtp-test'

import type { AdminEmailPublishDraft } from '@gugu/core/email/publish'

import { normalizeEmailTestRecipient,testAdminEmail,type AdminEmailTestDraft } from '@gugu/core/email/test-delivery'

import { readSmtpFileSettings } from './smtp.js'

import { createSmtpTestDelivery } from '../../adapters/smtp-test-delivery.js'

import type { EmailTranslationDraft } from '@gugu/core/email/translate'

import { translateEmailDraft } from '@gugu/core/email/translate'

import { completeStandaloneText } from '@gugu/core/providers'

import type { ProviderConfig,ProviderDriverDependencies,ProviderTransport } from '@gugu/core/providers'

import { createNodeProviderTransport } from '@gugu/core/providers/node'

import { createHash } from 'node:crypto'

import { readConfigOverride } from '../../adapters/config-override-file.js'

import { strip } from '@gugu/core/shared/values'

import { validEmail,type EmailRecipientGroups } from '@gugu/core/email/recipients'

export interface AdminEmailPreviewOptions {
 requireAdmin:preHandlerHookHandler
 render(draft:EmailPreviewDraft):{html:string;plain:string}
}
export function object(value:unknown):value is Record<string,unknown>{return value!==null&&typeof value==='object'&&!Array.isArray(value)}
function string(value:unknown,min:number,max:number):value is string{return typeof value==='string'&&Array.from(value).length>=min&&Array.from(value).length<=max}
function localized(value:unknown):value is EmailPreviewDraft{
 if(!object(value)||!string(value.subject,1,200)||!string(value.title,1,200)||!string(value.body,1,20000))return false
 if(value.preheader!==undefined&&!string(value.preheader,0,180))return false
 if(value.sections!==undefined&&(!Array.isArray(value.sections)||value.sections.length>8||!value.sections.every(item=>object(item)&&string(item.text,1,5000)&&(item.heading===undefined||string(item.heading,0,120)))))return false
 if(value.actions!==undefined&&(!Array.isArray(value.actions)||value.actions.length>3||!value.actions.every(item=>object(item)&&string(item.label,1,80)&&string(item.url,1,2048))))return false
 return true
}
export function validDraft(value:unknown):value is EmailPreviewDraft{
 if(!localized(value))return false
 const body=value as unknown as Record<string,unknown>
 for(const [field,allowed] of [['template',['notification','reminder','report','security','test']],['theme',['light','dark']],['palette',['cafe','neutral','red','blue','green']]] as const){
  if(body[field]!==undefined&&!(allowed as readonly unknown[]).includes(body[field]))return false
 }
 if(body.translations!==undefined&&(!object(body.translations)||Object.keys(body.translations).length>3||!Object.entries(body.translations).every(([locale,content])=>['zh-CN','ja-JP','en-US'].includes(locale)&&localized(content))))return false
 return true
}
/** 只渲染管理员草稿；身份与 DTO 属于 Host，模板和安全链接规则属于 Core。 */
export function registerAdminEmailPreviewRoute(app:FastifyInstance,options:AdminEmailPreviewOptions):void{
 app.post('/api/v1/admin/email/preview',{preHandler:options.requireAdmin},(request,reply)=>{
  if(!validDraft(request.body))return reply.code(422).send({detail:'邮件草稿参数无效'})
  try{return options.render(request.body)}catch(error){
   if(error instanceof Error&&error.name==='EmailPreviewError')return reply.code(400).send({detail:error.message})
   throw error
  }
 })
}

export interface AdminEmailPublishOperations {
  recipients(): Promise<EmailRecipientGroups>
  enqueue(recipients: EmailRecipientGroups, draft: AdminEmailPublishDraft): void
  close(): Promise<void>
}

export function createEmailPublishTaskLifecycle(reportFailure: () => void = () => {}) {
  const running = new Set<Promise<void>>()
  let closing = false
  return {
    enqueue(task: () => Promise<void>): void {
      if (closing) throw new Error('邮件发布任务已停止接收')
      let pending!: Promise<void>
      pending = Promise.resolve().then(task).catch(() => { reportFailure() }).finally(() => { running.delete(pending) })
      running.add(pending)
    },
    async close(): Promise<void> {
      closing = true
      while (running.size) await Promise.all([...running])
    },
  }
}

export function createAdminEmailPublishOperations(options: {
  query: EmailRecipientQuery
  readSettings(): AdminEmailPublishSettings
  send(delivery: SmtpTestDelivery): Promise<void>
  reportResult(result: AdminEmailPublishSummary): void
  recordMetric?(metric: AdminEmailDeliveryMetric): void
  reportFailure(): void
}): AdminEmailPublishOperations {
  const lifecycle = createEmailPublishTaskLifecycle(options.reportFailure)
  return {
    recipients: createEmailRecipientLister(options.query),
    enqueue(recipients, draft) {
      lifecycle.enqueue(async () => {
        const result = await deliverAdminEmailBulk(recipients, draft, options.readSettings(), options.send, 8, options.recordMetric)
        options.reportResult(result)
      })
    },
    close: () => lifecycle.close(),
  }
}

export function registerAdminEmailPublishRoute(app: FastifyInstance, options: {
  requireAdmin: preHandlerHookHandler
  operations: AdminEmailPublishOperations
}): void {
  app.post('/api/v1/admin/email/publish', { preHandler: options.requireAdmin }, async (request, reply) => {
    const value = request.body
    if (!validDraft(value) || !value || typeof value !== 'object' || Array.isArray(value)
      || typeof (value as unknown as Record<string, unknown>).confirm !== 'boolean')
      return reply.code(422).send({ detail: '邮件发布参数无效' })
    const body = value as unknown as AdminEmailPublishDraft & { confirm: boolean }
    if (!body.confirm) return reply.code(400).send({ detail: '正式发布必须显式确认' })
    let recipients: EmailRecipientGroups
    try { recipients = await options.operations.recipients() }
    catch { return reply.code(503).send({ detail: '暂时无法读取邮件收件人' }) }
    const locale_counts = {
      'zh-CN': recipients['zh-CN'].length, 'ja-JP': recipients['ja-JP'].length, 'en-US': recipients['en-US'].length,
    }
    const recipient_count = Object.values(locale_counts).reduce((sum, count) => sum + count, 0)
    if (!recipient_count) return reply.code(400).send({ detail: '没有可发送的有效注册邮箱' })
    const { confirm: _confirm, ...draft } = body
    options.operations.enqueue(recipients, draft)
    return { ok: true, status: 'queued', recipient_count, locale_counts }
  })
  app.addHook('onClose', async () => options.operations.close())
}

export function registerEmailRecipientCountRoute(app: FastifyInstance, options: {
  requireAdmin: preHandlerHookHandler
  read(): Promise<{count:number;locale_counts:Record<string,number>}>
}): void {
  app.get('/api/v1/admin/email/recipient-count', {preHandler:options.requireAdmin}, ()=>options.read())
}

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

export interface AdminEmailTranslateOptions {
  readonly requireAdmin: preHandlerHookHandler
  translate(draft: EmailTranslationDraft): Promise<Awaited<ReturnType<typeof translateEmailDraft>>>
}

/** 只读旧版 ai 配置与 AI__ 环境覆盖，凭据不进入请求体、日志或返回值。 */
export function createAdminEmailTranslator(environment: NodeJS.ProcessEnv, configPath: string, createTransport?: () => ProviderTransport) {
  return async (draft: EmailTranslationDraft) => {
    const rawSettings = readConfigOverride(configPath).ai
    const values = object(rawSettings) ? rawSettings : {}
    const setting = (key: string, envKey: string, fallback: string) => environment[envKey] ?? String(values[key] ?? fallback)
    const config: ProviderConfig = {
      provider: setting('provider', 'AI__PROVIDER', 'qwen'),
      model: setting('model', 'AI__MODEL', 'qwen-max'),
      api_key: setting('api_key', 'AI__API_KEY', ''),
      base_url: setting('base_url', 'AI__BASE_URL', 'https://dashscope.aliyuncs.com/compatible-mode/v1'),
      api_format: setting('api_format', 'AI__API_FORMAT', ''),
      thinking: setting('thinking', 'AI__THINKING', ''),
      reasoning_effort: setting('reasoning_effort', 'AI__REASONING_EFFORT', ''),
      ollama_api_mode: setting('ollama_api_mode', 'AI__OLLAMA_API_MODE', 'native'),
      ollama_mode: setting('ollama_mode', 'AI__OLLAMA_MODE', 'local'),
      timeout_ms: 300_000,
      capability_overrides: object(values.capability_overrides) ? values.capability_overrides as Record<string, boolean> : {},
    }
    const providerTransport = createTransport?.() ?? createNodeProviderTransport({ allowLocal: true, connectTimeoutMs: 5_000, writeTimeoutMs: 10_000, environment: () => environment })
    const dependencies: ProviderDriverDependencies = {
      transport: providerTransport,
      digest: value => createHash('sha256').update(JSON.stringify(value)).digest('hex'),
    }
    try {
      return await translateEmailDraft(draft, (prompt, maxTokens) => completeStandaloneText({
        config, prompt, maxTokens, signal: new AbortController().signal,
        identity: { ownerId: 'admin-email', sessionId: 'translation', runId: 'email-translation' },
      }, dependencies))
    } finally { await providerTransport.close?.() }
  }
}

/** Host 处理管理员认证与旧 DTO 边界；邮件结构规则和模型输出校验位于 Core。 */
export function registerAdminEmailTranslateRoute(app: FastifyInstance, options: AdminEmailTranslateOptions): void {
  app.post('/api/v1/admin/email/translate', { preHandler: options.requireAdmin }, async (request, reply) => {
    if (!validDraft(request.body)) return reply.code(422).send({ detail: '邮件草稿参数无效' })
    const value = request.body as unknown as Record<string, unknown>
    const draft = {
      ...value,
      preheader: value.preheader ?? '',
      sections: value.sections ?? [],
      actions: value.actions ?? [],
      template: value.template ?? 'notification',
      theme: value.theme ?? 'light',
      palette: value.palette ?? 'neutral',
    } as EmailTranslationDraft
    try { return { translations: await options.translate(draft) } }
    catch { return reply.code(502).send({ detail: '多语言邮件生成失败，请检查当前模型配置' }) }
  })
}

export { validDraft as draft }

export type { EmailRecipientGroups } from '@gugu/core/email/recipients'

type RecipientRow = { email: string | null; data_json: string | null }
export type EmailRecipientQuery = (text: string, params: unknown[]) => Promise<{ rows: RecipientRow[] }>

/** 只返回聚合数量，不暴露收件人地址，不触发邮件投递。 */
export function createEmailRecipientCounter(query: EmailRecipientQuery) {
  return async () => {
    const rows = await query(`SELECT u.email,p.data_json FROM users u LEFT JOIN user_preferences p ON p.user_id=u.id
      WHERE u.is_active IS TRUE AND u.account_status='active' AND u.email_subscribed IS TRUE`, [])
    const locale_counts = { 'zh-CN':0, 'ja-JP':0, 'en-US':0 }
    for (const row of rows.rows) {
      if (!validEmail.test(strip(row.email ?? ''))) continue
      let locale: unknown
      try {
        const data: unknown = JSON.parse(row.data_json || '{}')
        locale = data && typeof data === 'object' && !Array.isArray(data) ? (data as Record<string,unknown>).locale : undefined
      } catch { /* 对齐 Python：损坏的偏好不影响收件人数，使用默认语言。 */ }
      const key = locale === 'en-US' || locale === 'ja-JP' ? locale : 'zh-CN'
      locale_counts[key]++
    }
    return { count:Object.values(locale_counts).reduce((sum,value)=>sum+value,0), locale_counts }
  }
}


/** 管理员批量邮件的发送快照；只从活跃且订阅的账户读取有效地址。 */
export function createEmailRecipientLister(query: EmailRecipientQuery) {
  return async (): Promise<EmailRecipientGroups> => {
    const rows = await query(`SELECT u.email,p.data_json FROM users u LEFT JOIN user_preferences p ON p.user_id=u.id
      WHERE u.is_active IS TRUE AND u.account_status='active' AND u.email_subscribed IS TRUE`, [])
    const result: EmailRecipientGroups = { 'zh-CN': [], 'ja-JP': [], 'en-US': [] }
    for (const row of rows.rows) {
      const email = strip(row.email ?? '')
      if (!validEmail.test(email)) continue
      let locale: unknown
      try {
        const value: unknown = JSON.parse(row.data_json || '{}')
        locale = value && typeof value === 'object' && !Array.isArray(value)
          ? (value as Record<string, unknown>).locale : undefined
      } catch { /* 损坏的偏好按 Python 行为使用中文。 */ }
      result[locale === 'ja-JP' || locale === 'en-US' ? locale : 'zh-CN'].push(email)
    }
    return result
  }
}
