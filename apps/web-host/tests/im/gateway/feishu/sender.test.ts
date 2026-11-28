import assert from 'node:assert/strict'
import test from 'node:test'
import type { ProviderHttpRequest } from '@gugu/core/providers'
import { createFeishuClient, FeishuApiError } from '@gugu/gateway/feishu'
import { buildFeishuCardElements, createFeishuSender, feishuFileType } from '@gugu/gateway/feishu'

function fixture() {
  const calls: { path: string; body?: Record<string, unknown>; files?: Record<string, unknown> }[] = []
  let handler = async (_path: string): Promise<Record<string, unknown>> => ({ code: 0, data: { message_id: 'om_synthetic', image_key: 'img_synthetic', file_key: 'file_synthetic', reaction_id: 'reaction_synthetic' } })
  const sender = createFeishuSender({ client: { call: async (_method, path, args) => { calls.push({ path, body: args?.body, files: args?.files }); return handler(path) } } })
  return { sender, calls, setHandler(value: typeof handler) { handler = value } }
}

test('飞书普通文本保留heading与原生table，首个markdown element_id唯一', async () => {
  const text = '# 标题\n\n| 名称 | 数字 |\n| :--- | ---: |\n| **值** | 2 |\n\n结尾'
  const elements = buildFeishuCardElements(text)
  assert.deepEqual(elements, [
    { tag: 'markdown', content: '**标题**', element_id: 'markdown_1' },
    { tag: 'table', page_size: 10, columns: [{ name: 'col0', display_name: '名称', width: 'auto', horizontal_align: 'left' }, { name: 'col1', display_name: '数字', width: 'auto', horizontal_align: 'right' }], rows: [{ col0: '值', col1: '2' }] },
    { tag: 'markdown', content: '结尾' },
  ])
  const f = fixture()
  assert.deepEqual(await f.sender.text('ou_synthetic', text), { outcome: 'accepted', platformMessageIds: ['om_synthetic'] })
  assert.equal(f.calls[0]!.path, '/open-apis/im/v1/messages?receive_id_type=open_id')
  assert.deepEqual(f.calls[0]!.body, { receive_id: 'ou_synthetic', msg_type: 'interactive', content: JSON.stringify({ elements }) })
  assert.deepEqual(buildFeishuCardElements(''), [{ tag: 'markdown', content: '', element_id: 'markdown_1' }])
  assert.deepEqual(buildFeishuCardElements('| 非表格 |'), [{ tag: 'markdown', content: '| 非表格 |', element_id: 'markdown_1' }])
})

test('飞书interactive确定拒绝才降级text，超时或缺message_id保持未知不重发', async () => {
  for (const kind of ['rejected', 'unknown', 'missing'] as const) {
    const f = fixture()
    f.setHandler(async () => {
      if (f.calls.length > 1) return { code: 0, data: { message_id: 'om_text' } }
      if (kind === 'missing') return { code: 0, data: {} }
      throw kind === 'rejected' ? new FeishuApiError('message', 400, 123) : new Error('synthetic-secret-token')
    })
    const result = await f.sender.text('oc_synthetic', '合成文字')
    assert.equal(result.outcome, kind === 'rejected' ? 'accepted' : 'unknown')
    assert.equal(f.calls.length, kind === 'rejected' ? 2 : 1)
    if (kind === 'rejected') assert.deepEqual(f.calls[1]!.body, { receive_id: 'oc_synthetic', msg_type: 'text', content: '{"text":"合成文字"}' })
    assert.equal(JSON.stringify(result).includes('synthetic-secret-token'), false)
  }
})

test('飞书interaction仅携带prompt和一次性action token，不把业务上下文放进按钮', async () => {
  const f = fixture()
  await f.sender.interaction('oc_synthetic', { prompt_id: 7, title: '选择方式', body: '请选择', options: [{ id: 'a', label: '方案 A', token: 'synthetic-action-token' }] })
  const card = JSON.parse(String(f.calls[0]!.body!.content))
  assert.deepEqual(card.config, { wide_screen_mode: true })
  assert.deepEqual(card.elements[1].actions[0].value, { prompt_id: 7, token: 'synthetic-action-token', option_id: 'a', label: '方案 A' })
  assert.equal(JSON.stringify(card).includes('session_id'), false)
  assert.equal((await f.sender.interaction('oc_synthetic', { prompt_id: 0 })).outcome, 'rejected')
  await f.sender.linkCard('oc_synthetic', ' 正文 ', [{ label: '打开', url: 'https://example.test/synthetic' }])
  const link = JSON.parse(String(f.calls.at(-1)!.body!.content))
  assert.deepEqual(link.elements[1].actions[0].behaviors, [{ type: 'open_url', default_url: 'https://example.test/synthetic' }])
  const count = f.calls.length
  assert.equal((await f.sender.linkCard('oc_synthetic', '', [{ label: '无效', url: 'javascript:alert(1)' }])).outcome, 'rejected')
  assert.equal(f.calls.length, count)
})

test('飞书图片与文件按Python上传后发送，已知Office/音频映射及未知扩展不伪造类型', async () => {
  const f = fixture(), data = Buffer.from('合成附件')
  await f.sender.file('oc_synthetic', data, '图片', 'PNG')
  assert.equal(f.calls[0]!.path, '/open-apis/im/v1/images')
  assert.deepEqual(f.calls[0]!.body, { image_type: 'message' })
  assert.deepEqual(f.calls[1]!.body, { receive_id: 'oc_synthetic', msg_type: 'image', content: '{"image_key":"img_synthetic"}' })
  for (const [extension, mapped] of [['docx', 'doc'], ['xlsx', 'xls'], ['pptx', 'ppt'], ['pdf', 'pdf'], ['ogg', 'opus'], ['opus', 'opus'], ['mp4', 'mp4'], ['unknown', 'stream']] as const) {
    assert.equal(feishuFileType(extension), mapped)
    await f.sender.file('oc_synthetic', data, '合成附件', extension)
    assert.deepEqual(f.calls.at(-2)!.body, { file_type: mapped, file_name: `合成附件.${extension}` })
    assert.deepEqual(f.calls.at(-1)!.body, { receive_id: 'oc_synthetic', msg_type: 'file', content: '{"file_key":"file_synthetic"}' })
  }
  f.setHandler(async () => ({ code: 0, data: {} }))
  const before = f.calls.length
  assert.equal((await f.sender.file('oc_synthetic', data, '附件', 'txt')).outcome, 'unknown')
  assert.equal(f.calls.length, before + 1)
})

test('飞书reaction协议和缺ID未知语义，危险路径/文件名/空媒体在上传前拒绝', async () => {
  const f = fixture()
  assert.deepEqual(await f.sender.react('om_synthetic', 'THUMBSUP'), { outcome: 'accepted', reactionId: 'reaction_synthetic' })
  assert.deepEqual(f.calls[0]!.body, { reaction_type: { emoji_type: 'THUMBSUP' } })
  f.setHandler(async () => ({ code: 0, data: {} }))
  assert.deepEqual(await f.sender.react('om_synthetic', 'THUMBSUP'), { outcome: 'unknown', reactionId: null })
  const count = f.calls.length
  assert.equal((await f.sender.file('oc_synthetic', Buffer.alloc(0), '附件', 'png')).outcome, 'rejected')
  assert.equal((await f.sender.file('oc_synthetic', Buffer.from('x'), '../附件', 'txt')).outcome, 'rejected')
  assert.equal((await f.sender.file('ou_synthetic', Buffer.from('x'), '附件', 'txt')).outcome, 'rejected')
  assert.equal((await f.sender.react('../om_synthetic', 'THUMBSUP')).outcome, 'rejected')
  assert.equal(f.calls.length, count)
})

test('飞书真实client认证、multipart媒体上传及sendMessage JSON经过合成transport', async () => {
  const requests: ProviderHttpRequest[] = []
  const client = createFeishuClient({ appId: 'synthetic-app', appSecret: 'synthetic-secret', transport: { request: async request => {
    requests.push(request)
    assert.equal(new URL(request.url).hostname, 'open.feishu.cn')
    const path = new URL(request.url).pathname
    const body = path.includes('/auth/') ? { code: 0, tenant_access_token: 'synthetic-tenant-token', expire: 7200 }
      : path.endsWith('/files') ? { code: 0, data: { file_key: 'file_uploaded' } } : { code: 0, data: { message_id: 'om_sent' } }
    return { status: 200, headers: {}, body: (async function* () { yield Buffer.from(JSON.stringify(body)) })(), cancel: async () => {} }
  } } })
  try {
    const sender = createFeishuSender({ client })
    assert.deepEqual(await sender.file('oc_synthetic', Buffer.from('合成文件正文'), '合成文档', 'docx'), { outcome: 'accepted', platformMessageIds: ['om_sent'] })
    assert.equal(requests.length, 3)
    assert.deepEqual(JSON.parse(Buffer.from(requests[0]!.body as Uint8Array).toString()), { app_id: 'synthetic-app', app_secret: 'synthetic-secret' })
    const upload = requests[1]!, multipart = Buffer.from(upload.body as Uint8Array).toString()
    assert.match(upload.headers['content-type']!, /^multipart\/form-data; boundary=/)
    assert.ok(multipart.includes('name="file_type"\r\n\r\ndoc'))
    assert.ok(multipart.includes('name="file_name"\r\n\r\n合成文档.docx'))
    assert.ok(multipart.includes('filename="合成文档.docx"'))
    assert.ok(multipart.includes('合成文件正文'))
    assert.deepEqual(JSON.parse(Buffer.from(requests[2]!.body as Uint8Array).toString()), { receive_id: 'oc_synthetic', msg_type: 'file', content: '{"file_key":"file_uploaded"}' })
  } finally { await client.close() }
})
