import assert from 'node:assert/strict'
import { test } from 'vitest'
import { classifyImGroupInbound, defaultImTools, imActorInputFromPayload, imCanUseGroupOwnerMemory, imCanUseTool, imContextPolicy, imDisplayPolicy, imVisibleToolNames, resolveImAccess, resolveImActor } from '../../src/im/access.js'
import type { ImActorInput, ImBotAccess, ImPlatform } from '../../src/im/access.js'

const bot: ImBotAccess = { id: '7', ownerId: 'owner-a', platform: 'qq', ownerPlatformUserId: 'sender-owner', groupAllowedTools: ['web_search'], groupOwnerMemoryEnabled: true }
const input: ImActorInput = { ownerId: 'owner-a', botId: '7', platform: 'qq', chatType: 'group', chatId: 'group-a', platformUserId: 'sender-owner', botMentioned: true, mentionsOtherBot: false }
const resolve = (scope: Parameters<typeof resolveImAccess>[0]) => resolveImAccess(scope, bot)

test('IM展示偏好沿Python默认值，群强制隐藏、飞书私聊强制完整，不改变身份权限',()=>{
  assert.deepEqual(imDisplayPolicy('telegram','c2c',{}),{toolDisplay:'all',showIntermediateReplies:false})
  for(const mode of ['off','slow_only','all'])assert.deepEqual(imDisplayPolicy('telegram','c2c',{im_tool_display_mode:mode,show_intermediate_replies:true}),{toolDisplay:mode,showIntermediateReplies:true})
  assert.deepEqual(imDisplayPolicy('feishu','group',{im_tool_display_mode:'all',show_intermediate_replies:true}),{toolDisplay:'off',showIntermediateReplies:false})
  assert.deepEqual(imDisplayPolicy('feishu','c2c',{im_tool_display_mode:'off'}),{toolDisplay:'all',showIntermediateReplies:true})
  assert.equal(imDisplayPolicy('telegram','c2c',{show_intermediate_replies:[]}).showIntermediateReplies,false)
})

test('批次身份从逐条平台事实解析，不能用汇总owner角色覆盖混合发言权限', () => {
  const binding = { ownerId: input.ownerId, botId: input.botId, platform: input.platform }
  const message = { owner_user_id: input.ownerId, bot_id: input.botId, platform: input.platform,
    platform_user_id: input.platformUserId, chat_type: 'group', chat_id: input.chatId, bot_mentioned: true }
  const member = { ...message, platform_user_id: 'sender-member' }
  const payload = { ...message, _turn_speakers: [{ platform_user_id: input.platformUserId, role: 'owner' }], _batch_messages: [member, message] }
  const actor = resolveImActor(imActorInputFromPayload(binding, payload), resolve)
  assert.equal(actor.role, 'member')
  assert.equal(actor.verifiedOwner, false)
  assert.equal(imContextPolicy(actor, bot, true).loadOwnerContext, false)
  for (const patch of [{ owner_user_id: 'owner-b' }, { bot_id: '8' }, { channel_id: '8' },
    { platform: 'telegram' }, { chat_id: 'group-b' }, { platform_user_id: '' }]) {
    assert.throws(() => imActorInputFromPayload(binding, { ...payload, _batch_messages: [{ ...member, ...patch }, message] }))
  }
  assert.throws(() => imActorInputFromPayload(binding, { ...payload, _batch_messages: [message, member] }))
  assert.throws(() => imActorInputFromPayload(binding, { ...payload, _batch_messages: [] }))
  const privateMessage = { ...message, chat_type: 'c2c', chat_id: null }
  assert.throws(() => imActorInputFromPayload(binding, { ...privateMessage,
    _batch_messages: [{ ...privateMessage, platform_user_id: 'sender-member' }, privateMessage] }))
})

test('群入站分类保留只读/需at/其他Bot语义，不把私聊或微信强行纳入群规则', () => {
  for (const platform of ['feishu', 'qq', 'telegram'] as const) {
    const message = { platform, chatType: 'group' as const, chatId: 'group-a', groupMentioned: false, mentionsOtherBot: false }
    assert.equal(classifyImGroupInbound(message, { readOnly: false, requiresAt: false }), 'reply')
    assert.equal(classifyImGroupInbound(message, { readOnly: true, requiresAt: false }), 'passive')
    assert.equal(classifyImGroupInbound(message, { readOnly: false, requiresAt: true }), 'passive')
    assert.equal(classifyImGroupInbound({ ...message, mentionsOtherBot: true }, { readOnly: false, requiresAt: false }), 'passive')
    assert.equal(classifyImGroupInbound({ ...message, mentionsOtherBot: true, groupMentioned: true }, { readOnly: false, requiresAt: true }), 'reply')
    assert.equal(classifyImGroupInbound({ ...message, chatType: 'c2c', chatId: null }, { readOnly: true, requiresAt: true }), null)
    assert.equal(classifyImGroupInbound({ ...message, platform: 'wechat' }, { readOnly: true, requiresAt: true }), null)
  }
})

test('平台身份与Bot所有者、平台和内部ID共同验证，显示身份不能跨Bot提权', () => {
  assert.equal(resolve(input).role, 'owner')
  for (const scope of [{ ...input, ownerId: 'owner-b' }, { ...input, botId: '8' }, { ...input, platform: 'telegram' as const }]) {
    const access = resolve(scope)
    assert.equal(access.role, 'unknown')
    assert.notEqual(access.allowedToolNames, null)
  }
  assert.deepEqual(resolve({ ...input, platformUserId: 'sender-member' }), { role: 'member', allowedToolNames: ['web_search', 'http_get'] })
  assert.equal(resolveImAccess(input, { ...bot, ownerPlatformUserId: null }).role, 'unknown')
})

test('旧群权限保留搜图和发送文件，过滤已退役的文件读取权限', () => {
  const scope = { ...input, platformUserId: 'sender-member' }
  assert.deepEqual(resolveImAccess(scope, {
    ...bot, groupAllowedTools: ['similar_image_search', 'read_file', 'send_file'],
  }).allowedToolNames, ['similar_image_search', 'send_file'])
  assert.deepEqual(resolveImAccess(scope, {
    ...bot, groupAllowedTools: ['similar_image_search'],
  }).allowedToolNames, ['similar_image_search'])
})

test('QQ和Telegram私聊必须核对绑定，飞书和微信保留旧版可信私聊owner语义', () => {
  for (const platform of ['qq', 'telegram', 'feishu', 'wechat'] as const) {
    const ownBot = { ...bot, platform }
    const scope = { ...input, platform, chatType: 'c2c' as const, platformUserId: 'stranger' }
    assert.equal(resolveImAccess(scope, ownBot).role, platform === 'qq' ? 'member' : platform === 'telegram' ? 'unknown' : 'owner')
    assert.equal(resolveImAccess({ ...scope, ownerId: 'owner-b' }, ownBot).role, 'unknown')
    assert.equal(resolveImAccess(scope, null).role, 'unknown')
  }
})

test('owner单条提及与完整单发言人批次可保留权限，普通群消息降级但保留已验证身份', () => {
  const owner = resolveImActor(input, resolve)
  assert.equal(owner.role, 'owner')
  assert.equal(owner.ownerMentionAuthorized, true)
  const ordinary = resolveImActor({ ...input, botMentioned: false }, resolve)
  assert.equal(ordinary.role, 'member')
  assert.equal(ordinary.verifiedOwner, true)
  assert.equal(imContextPolicy(ordinary, bot, true).loadOwnerContext, false)
  assert.equal(imContextPolicy(ordinary, bot, true).groupOwnerMemoryEnabled, true)
  assert.equal(resolveImActor({ ...input, botMentioned: false, speakers: [{ platformUserId: input.platformUserId }] }, resolve).role, 'owner')
  assert.equal(resolveImActor({ ...input, mentionsOtherBot: true }, resolve).role, 'member')
  assert.equal(resolveImActor({ ...input, batchMessages: [] }, resolve).role, 'member')
})

test('混合批次按最弱权限执行且与发言顺序无关，不借owner加载私人上下文', () => {
  const speakers = [{ platformUserId: 'sender-owner' }, { platformUserId: 'sender-member' }]
  const a = resolveImActor({ ...input, speakers }, resolve)
  const b = resolveImActor({ ...input, speakers: [...speakers].reverse() }, resolve)
  assert.deepEqual(a, b)
  assert.equal(a.role, 'member')
  assert.equal(a.verifiedOwner, false)
  assert.deepEqual(a.allowedToolNames, ['web_search', 'http_get'])
  assert.equal(imContextPolicy(a, bot, true).groupOwnerMemoryEnabled, false)
  assert.equal(imContextPolicy(a, bot, true).loadOwnerContext, false)
  assert.equal(imContextPolicy(a, bot, true).allowContinuityBridge, false)
  assert.equal(imCanUseTool(a, 'list_skills'), false)
  assert.equal(imCanUseTool(a, 'get_current_time'), true)
  assert.equal(imCanUseTool(a, 'ask_user'), true)
})

test('群主个人记忆要求主人角色、可信身份验证和启用开关', () => {
  const verifiedOwner = { ...resolveImActor(input, resolve), verifiedOwner: true }
  assert.equal(imCanUseGroupOwnerMemory(verifiedOwner, true), true)
  assert.equal(imCanUseGroupOwnerMemory(verifiedOwner, false), false)
  assert.equal(imCanUseGroupOwnerMemory({ ...verifiedOwner, role: 'member' }, true), false)
  assert.equal(imCanUseGroupOwnerMemory({ ...verifiedOwner, verifiedOwner: false }, true), false)
  assert.equal(imCanUseGroupOwnerMemory({ ...verifiedOwner, chatType: 'c2c', chatId: null }, true), false)
})

test('缺失发言身份使整批降到unknown，权限解析异常不转换成owner', () => {
  const actor = resolveImActor({ ...input, speakers: [{ platformUserId: 'sender-owner' }, { platformUserId: '' }] }, resolve)
  assert.equal(actor.role, 'unknown')
  assert.equal(actor.verifiedOwner, false)
  assert.deepEqual(actor.allowedToolNames, ['web_search', 'http_get'])
  assert.throws(() => resolveImActor(input, () => { throw new Error('身份查询失败') }))
  assert.throws(() => resolveImActor({ ...input, platformUserId: '' }, resolve))
  assert.throws(() => resolveImActor({ ...input, chatId: '' }, resolve))
})

test('未知身份无白名单时固定最小权限，不因null变成不限权限', () => {
  const actor = resolveImActor(input, () => ({ role: 'unknown', allowedToolNames: null }))
  assert.deepEqual(actor.allowedToolNames, defaultImTools)
  assert.equal(imCanUseTool(actor, 'delete_skill'), false)
  assert.equal(imContextPolicy(actor, bot, true).loadOwnerContext, false)
})

test('表情回应只向飞书暴露并执行，发现与派发均复用共享权限', () => {
  for (const platform of ['qq', 'telegram', 'wechat', 'feishu'] as ImPlatform[]) {
    const actor = resolveImActor({ ...input, platform }, scope => resolveImAccess(scope, { ...bot, platform }))
    assert.equal(imCanUseTool(actor, 'react'), platform === 'feishu')
    assert.deepEqual(imVisibleToolNames(actor, ['react', 'present_file', 'get_current_time']), platform === 'feishu' ? ['react', 'get_current_time'] : ['get_current_time'])
  }
})

test('群owner私人记忆只能来自匹配Bot服务端设置，禁止跨owner或平台授权', () => {
  const actor = resolveImActor(input, resolve)
  assert.deepEqual(imContextPolicy(actor, bot, false), { isIm: true, restricted: false, loadOwnerContext: true,
    memoryEnabled: false, allowContinuityBridge: true, allowMemoryReflection: true, groupOwnerMemoryEnabled: true })
  assert.equal(imContextPolicy(actor, bot, true).memoryEnabled, true)
  assert.throws(() => imContextPolicy(actor, bot, undefined as unknown as boolean))
  for (const stored of [null, { ...bot, ownerId: 'owner-b' }, { ...bot, platform: 'telegram' as const }, { ...bot, groupOwnerMemoryEnabled: false }])
    assert.equal(imContextPolicy(actor, stored, true).groupOwnerMemoryEnabled, false)
  assert.equal(imContextPolicy(actor, bot, true).groupOwnerMemoryEnabled, true)
  const privateActor = resolveImActor({ ...input, chatType: 'c2c', chatId: null }, resolve)
  assert.equal(imContextPolicy(privateActor, bot, true).groupOwnerMemoryEnabled, false)
})

test('快照冻结后后续白名单修改不改变本轮权限，下一次解析可见撤权', () => {
  const tools = ['web_search']
  const actor = resolveImActor(input, () => ({ role: 'member', allowedToolNames: tools }))
  tools.push('delete_skill')
  assert.deepEqual(actor.allowedToolNames, ['web_search'])
  assert.equal(Object.isFrozen(actor), true)
  const revoked = resolveImActor(input, () => ({ role: 'member', allowedToolNames: [] }))
  assert.equal(imCanUseTool(revoked, 'web_search'), false)
})
