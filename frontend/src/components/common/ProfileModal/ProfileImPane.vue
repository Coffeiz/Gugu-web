<template>
  <div class="pm-section">
    <div class="pm-section-label">接入咕咕</div>
    <template v-for="platform in platforms" :key="platform.key">
      <div class="pm-field-row"><div class="pm-field-desc"><span class="pm-field-name">{{ platform.label }}</span><span class="pm-field-hint">{{ platform.hint }}</span></div><button v-if="!botsOf(platform.key).length" class="pm-bind-btn" :disabled="connecting === platform.key" @click="startConnect(platform.key)">{{ connecting === platform.key ? '生成中…' : '扫码连接' }}</button><span v-else class="pm-field-hint pm-bound-tag">已连接 · 删除后可重连</span></div>
      <div v-for="bot in botsOf(platform.key)" :key="bot.id" class="pm-bot-item">
        <div class="pm-bot-item-top"><div class="pm-bot-info"><span class="pm-bot-name">{{ bot.name }}<span v-if="bot.sandbox" class="pm-bot-tag">沙箱</span></span><span class="pm-bot-appid">{{ bot.app_id }}</span></div><span class="pm-switch-wrap"><label class="switch sm"><input type="checkbox" :checked="bot.enabled" @change="toggleBot(bot)" /><span class="slider"></span></label><span class="pm-switch-label" :class="{ on: bot.enabled }">{{ bot.enabled ? '已启用' : '已停用' }}</span></span><button class="pm-bot-del" @click="removeBot(bot)">删除</button></div>
        <div v-if="platform.key === 'qq'" class="pm-bot-group-row"><div class="pm-field-desc"><span class="pm-field-name">QQ 身份绑定</span><span class="pm-field-hint">未绑定时生成验证码，在 QQ 私聊机器人发送“绑定 6 位验证码”</span></div><div class="pm-binding-code"><button v-if="!bot.owner_bound" type="button" class="pm-style-chip" :disabled="bindingBotId === bot.id" @click="createBindingCode(bot)">{{ bindingBotId === bot.id ? '生成中…' : '生成验证码' }}</button><span v-if="bindingCodes[bot.id]" class="pm-binding-code-value">绑定 {{ bindingCodes[bot.id].code }}（{{ bindingCodes[bot.id].expiresIn }} 秒内）</span><span v-else-if="bot.owner_bound" class="pm-field-hint">已绑定</span></div></div>
        <div v-if="platform.key === 'qq'" class="pm-bot-group-row"><div class="pm-field-desc"><span class="pm-field-name">群聊回应</span><span class="pm-field-hint">开启后，咕咕会参与群聊，默认无需 @ 机器人</span></div><span class="pm-switch-wrap"><label class="switch sm"><input type="checkbox" :checked="bot.group_chat_enabled" @change="toggleGroupChat(bot)" /><span class="slider"></span></label><span class="pm-switch-label" :class="{ on: bot.group_chat_enabled }">{{ bot.group_chat_enabled ? '已开启' : '已关闭' }}</span></span></div>
        <div v-if="platform.key === 'qq' && bot.group_chat_enabled" class="pm-bot-group-row pm-bot-tools-row"><div class="pm-field-desc"><span class="pm-field-name">回应方式</span><span class="pm-field-hint">选择群消息的处理方式</span></div><div class="pm-style-group pm-tool-options"><button v-for="option in groupResponseOptions" :key="option.key" type="button" class="pm-style-chip" :class="{ active: groupResponseMode(bot) === option.key }" @click="setGroupResponseMode(bot, option.key)">{{ option.label }}</button></div></div>
        <MessageFormatSettings v-if="platform.key === 'qq'" :bot="bot" @updated="loadBots" />
        <div v-if="platform.key === 'qq' && bot.group_chat_enabled" class="pm-bot-group-row pm-bot-tools-row"><div class="pm-field-desc"><span class="pm-field-name">群成员可用工具</span><span class="pm-field-hint">可多选；未选中的工具不会提供给群成员</span></div><div class="pm-style-group pm-tool-options"><button v-for="option in groupToolOptions" :key="option.key" type="button" class="pm-style-chip" :class="{ active: hasGroupTool(bot, option) }" @click="toggleGroupTool(bot, option)">{{ option.label }}</button></div></div>
      </div>
    </template>
    <div v-if="connect" class="pm-qr-box"><canvas ref="connectCanvas" class="pm-qr-canvas"></canvas><div class="pm-qr-hint">{{ connectHint }}</div><button class="pm-qr-cancel" @click="cancelConnect">取消</button></div>
    <div v-if="connectErr" class="pm-qr-err">{{ connectErr }}</div>
  </div>
</template>

<script setup lang="ts">
import { nextTick, onActivated, onDeactivated, onMounted, ref } from 'vue'
import QRCode from 'qrcode'
import { fireHint } from '@/composables/useOnboarding'
import { feishuConnectApi, qqConnectApi, userBotsApi, wechatConnectApi } from '@/services/api'
import MessageFormatSettings from './MessageFormatSettings.vue'

interface Bot { id: number; platform: string; name?: string; sandbox?: boolean; app_id?: string; enabled?: boolean; group_chat_enabled?: boolean; group_requires_at?: boolean; group_read_enabled?: boolean; group_response_mode?: string; group_allowed_tools?: string[]; group_message_format?: string; private_message_format?: string; owner_bound?: boolean }
const groupResponseOptions = [
  { key: 'reply_all', label: '自动回复' },
  { key: 'reply_mentions', label: '只响应 @' },
  { key: 'record_only', label: '静默记录' },
] as const
const groupToolOptions = [
  { key: 'web_search', label: '联网搜索 + 网页阅读 + 搜图发图', tools: ['web_search', 'http_get', 'image_search', 'send_file'] },
  { key: 'group_context_search', label: '群上下文搜索', tools: ['group_context_search'] },
] as const
const platforms = [
  { key: 'feishu', label: '飞书（自带机器人）', api: feishuConnectApi, hint: '手机飞书扫码 → 授权创建机器人，咕咕自动连接，私聊它直接管项目/文件/日程' },
  { key: 'qq', label: 'QQ（自带机器人）', api: qqConnectApi, hint: '手机 QQ 扫码 → 选一个机器人授权，咕咕自动连接，私聊或在群里 @它管理项目/文件/日程' },
  { key: 'wechat', label: '微信（个人微信）', api: wechatConnectApi, hint: '手机微信扫码 → 授权个人微信机器人（官方 iLink、无需企业资质），私聊它直接管项目/文件/日程' },
]
const bots = ref<Bot[]>([]); const botsOf = (platform: string) => bots.value.filter(bot => bot.platform === platform)
const connecting = ref(''); const connect = ref<{ platform: string; id: string } | null>(null); const connectHint = ref(''); const connectErr = ref(''); const connectCanvas = ref<HTMLCanvasElement | null>(null); const bindingBotId = ref<number | null>(null); const bindingCodes = ref<Record<number, { code: string; expiresIn: number }>>({}); let poll: ReturnType<typeof setInterval> | null = null
async function loadBots() { try { const result = await userBotsApi.list(); bots.value = result.items || [] } catch {} }
async function startConnect(platform: string) { const item = platforms.find(value => value.key === platform); if (!item) return; connecting.value = platform; connectErr.value = ''; try { const result = await item.api.start(); const id = result.poll_id || result.task_id; connect.value = { platform, id }; connectHint.value = platform === 'feishu' ? '手机飞书扫码 → 授权创建机器人，授权后自动连接' : platform === 'wechat' ? '手机微信扫码 → 授权个人微信机器人，授权后自动连接' : '手机 QQ 扫码 → 选一个机器人授权，授权后自动连接'; await nextTick(); await QRCode.toCanvas(connectCanvas.value, result.scan_url, { width: 180, margin: 1 }); startPoll(item) } catch (error) { connectErr.value = (error instanceof Error ? error.message : '') || '生成二维码失败'; connect.value = null } finally { connecting.value = '' } }
function startPoll(platform: (typeof platforms)[number]) { stopPoll(); let tries = 0; poll = setInterval(async () => { tries++; try { if (!connect.value) return; const result = await platform.api.poll(connect.value.id); if (result.status === 'success') { cancelConnect(); await loadBots(); fireHint('im_bind') } else if (result.status === 'expired') { connectErr.value = '二维码已过期，请重新扫码连接'; cancelConnect() } else if (result.status === 'fail') { connectErr.value = '连接失败：' + (result.reason || '未知'); cancelConnect() } } catch {} if (tries > 100) cancelConnect() }, 3000) }
function stopPoll() { if (poll) { clearInterval(poll); poll = null } }
function resumePoll() {
  if (!connect.value) return
  const platform = platforms.find(value => value.key === connect.value?.platform)
  if (platform) startPoll(platform)
}
function cancelConnect() { stopPoll(); connect.value = null }
async function toggleBot(bot: Bot) { try { await userBotsApi.update(bot.id, { enabled: !bot.enabled }); await loadBots() } catch (error) { connectErr.value = error instanceof Error ? error.message : '连接失败' } }
async function createBindingCode(bot: Bot) { bindingBotId.value = bot.id; connectErr.value = ''; try { const result = await userBotsApi.createQqBindingCode(bot.id); bindingCodes.value = { ...bindingCodes.value, [bot.id]: { code: result.code, expiresIn: result.expires_in } } } catch (error) { connectErr.value = error instanceof Error ? error.message : '生成验证码失败' } finally { bindingBotId.value = null } }
async function toggleGroupChat(bot: Bot) { try { await userBotsApi.update(bot.id, { group_chat_enabled: !bot.group_chat_enabled }); await loadBots() } catch (error) { connectErr.value = error instanceof Error ? error.message : '群聊设置失败' } }
function groupResponseMode(bot: Bot): string { return bot.group_response_mode ?? (bot.group_read_enabled ? 'record_only' : bot.group_requires_at ? 'reply_mentions' : 'reply_all') }
async function setGroupResponseMode(bot: Bot, mode: string) { try { await userBotsApi.update(bot.id, { group_response_mode: mode }); await loadBots() } catch (error) { connectErr.value = error instanceof Error ? error.message : '群聊回应方式设置失败' } }
function groupTools(bot: Bot): string[] { return bot.group_allowed_tools ?? ['web_search', 'http_get', 'image_search', 'send_file'] }
function hasGroupTool(bot: Bot, option: (typeof groupToolOptions)[number]): boolean { return option.tools.every(t => groupTools(bot).includes(t)) }
async function toggleGroupTool(bot: Bot, option: (typeof groupToolOptions)[number]) {
  try {
    const tools = new Set(groupTools(bot))
    if (hasGroupTool(bot, option)) option.tools.forEach(t => tools.delete(t))
    else option.tools.forEach(t => tools.add(t))
    await userBotsApi.update(bot.id, { group_allowed_tools: [...tools] })
    await loadBots()
  } catch (error) {
    connectErr.value = error instanceof Error ? error.message : '群聊工具设置失败'
  }
}
async function removeBot(bot: Bot) { if (!confirm(`删除「${bot.name}」？删除后这个机器人不再连咕咕。`)) return; try { await userBotsApi.remove(bot.id); await loadBots() } catch (error) { connectErr.value = error instanceof Error ? error.message : '连接失败' } }
onMounted(loadBots)
onDeactivated(stopPoll)
onActivated(resumePoll)
</script>
