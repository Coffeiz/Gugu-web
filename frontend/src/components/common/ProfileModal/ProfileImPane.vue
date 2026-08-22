<template>
  <div class="pm-section">
    <div class="pm-section-label">接入咕咕</div>
    <template v-for="platform in platforms" :key="platform.key">
      <div class="pm-field-row"><div class="pm-field-desc"><span class="pm-field-name">{{ platform.label }}</span><span class="pm-field-hint">{{ platform.hint }}</span></div><button v-if="!botsOf(platform.key).length" class="pm-bind-btn" :disabled="connecting === platform.key" @click="startConnect(platform.key)">{{ connecting === platform.key ? '生成中…' : '扫码连接' }}</button><span v-else class="pm-field-hint pm-bound-tag">已连接 · 删除后可重连</span></div>
      <div v-for="bot in botsOf(platform.key)" :key="bot.id" class="pm-bot-item">
        <div class="pm-bot-item-top"><div class="pm-bot-info"><span class="pm-bot-name">{{ bot.name }}<span v-if="bot.sandbox" class="pm-bot-tag">沙箱</span></span><span class="pm-bot-appid">{{ bot.app_id }}</span></div><span class="pm-switch-wrap"><label class="switch sm"><input type="checkbox" :checked="bot.enabled" @change="toggleBot(bot)" /><span class="slider"></span></label><span class="pm-switch-label" :class="{ on: bot.enabled }">{{ bot.enabled ? '已启用' : '已停用' }}</span></span><button class="pm-bot-del" @click="removeBot(bot)">删除</button></div>
        <div v-if="platform.key === 'qq'" class="pm-bot-group-row"><div class="pm-field-desc"><span class="pm-field-name">QQ 身份绑定</span><span class="pm-field-hint">未绑定时生成验证码，在 QQ 私聊机器人发送“绑定 6 位验证码”</span></div><div class="pm-binding-code"><button v-if="!bot.owner_bound" type="button" class="pm-style-chip" :disabled="bindingBotId === bot.id" @click="createBindingCode(bot)">{{ bindingBotId === bot.id ? '生成中…' : '生成验证码' }}</button><div v-if="bindingCodes[bot.id]" class="pm-binding-code-result"><span class="pm-binding-code-command" title="发送给 QQ 机器人"><span class="pm-binding-code-prefix">绑定</span><code class="pm-binding-code-value">{{ bindingCodes[bot.id].code }}</code></span><span class="pm-binding-code-expiry">{{ bindingCodes[bot.id].expiresIn }} 秒内有效</span><button type="button" class="pm-binding-copy-btn" :class="{ copied: copiedBindingBotId === bot.id }" :title="copiedBindingBotId === bot.id ? '已复制绑定指令' : '复制绑定指令'" @click="copyBindingCode(bot.id)"><PhCheck v-if="copiedBindingBotId === bot.id" :size="12" weight="bold" /><PhCopy v-else :size="12" weight="bold" /><span>{{ copiedBindingBotId === bot.id ? '已复制' : '复制' }}</span></button></div><span v-else-if="bot.owner_bound" class="pm-field-hint">已绑定</span></div></div>
        <div v-if="platform.key === 'qq'" class="pm-bot-group-row"><div class="pm-field-desc"><span class="pm-field-name">群聊回应</span><span class="pm-field-hint">开启后，咕咕会参与群聊，默认无需 @ 机器人</span></div><span class="pm-switch-wrap"><label class="switch sm"><input type="checkbox" :checked="bot.group_chat_enabled" @change="toggleGroupChat(bot)" /><span class="slider"></span></label><span class="pm-switch-label" :class="{ on: bot.group_chat_enabled }">{{ bot.group_chat_enabled ? '已开启' : '已关闭' }}</span></span></div>
        <div v-if="platform.key === 'qq' && bot.group_chat_enabled" class="pm-bot-group-row pm-bot-tools-row"><div class="pm-field-desc pm-help-anchor"><span class="pm-field-name">回应方式</span><span class="pm-help-row"><span class="pm-field-hint">选择群消息的处理方式</span><button type="button" class="pm-help-toggle" @click.stop="toggleHelpPop(bot.id)">设置方法</button></span><div v-if="helpPopBotId === bot.id" class="pm-help-pop" @click.stop><div class="pm-help-pop-title">开启全量消息接收</div><div class="pm-help-pop-step">1. 手机端 QQ 打开机器人所在的群</div><div class="pm-help-pop-step">2. 点机器人的头像进入资料页</div><div class="pm-help-pop-step">3. 点右上角「设置」</div><div class="pm-help-pop-step">4. 打开「全量消息接收」</div><div class="pm-help-pop-note">不开启时机器人只能收到 @ 消息，非 @ 消息不会进入会话记录</div></div></div><div class="pm-style-group pm-tool-options"><button v-for="option in groupResponseOptions" :key="option.key" type="button" class="pm-style-chip" :class="{ active: groupResponseMode(bot) === option.key }" @click="setGroupResponseMode(bot, option.key)">{{ option.label }}</button></div></div>
        <template v-if="platform.key === 'qq'">
          <MessageFormatSettings :bot="bot" @change="(scope, mode) => setMessageFormat(bot, scope, mode)" />
          <div class="pm-bot-group-row pm-bot-tools-row"><div class="pm-field-desc"><span class="pm-field-name">私聊流式回复</span><span class="pm-field-hint">使用 QQ 官方接口逐步更新同一条私聊消息；部分客户端可能不显示过程</span></div><span class="pm-switch-wrap"><label class="switch sm"><input type="checkbox" :checked="bot.private_streaming_enabled === true" @change="togglePrivateStreaming(bot)" /><span class="slider"></span></label><span class="pm-switch-label" :class="{ on: bot.private_streaming_enabled === true }">{{ bot.private_streaming_enabled === true ? '已开启' : '已关闭' }}</span></span></div>
        </template>
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
import { PhCheck, PhCopy } from '@phosphor-icons/vue'
import { fireHint } from '@/composables/useOnboarding'
import { feishuConnectApi, qqConnectApi, userBotsApi, wechatConnectApi } from '@/services/api'
import { optimisticMutation } from '@/utils/optimisticMutation'
import { beginOptimisticIntent, isOptimisticIntentCurrent, withOptimisticIntent } from '@/utils/optimisticIntent'
import MessageFormatSettings from './MessageFormatSettings.vue'

interface Bot { id: number; platform: string; name?: string; sandbox?: boolean; app_id?: string; enabled?: boolean; group_chat_enabled?: boolean; group_requires_at?: boolean; group_read_enabled?: boolean; group_response_mode?: string; group_allowed_tools?: string[]; group_message_format?: string; private_message_format?: string; private_streaming_enabled?: boolean; owner_bound?: boolean }
type BotSettingPatch = Partial<Pick<Bot,
  'enabled' | 'group_chat_enabled' | 'group_response_mode' | 'group_allowed_tools' |
  'group_message_format' | 'private_message_format' | 'private_streaming_enabled'
>>

const groupResponseOptions = [
  { key: 'reply_all', label: '自动回复' },
  { key: 'reply_mentions', label: '只响应 @' },
  { key: 'record_only', label: '静默记录' },
] as const
const groupToolOptions = [
  { key: 'web_search', label: '联网搜索 + 网页阅读 + 搜图/读图/发图', tools: ['web_search', 'http_get', 'image_search', 'inspect_images', 'send_file'] },
  { key: 'group_context_search', label: '群上下文搜索', tools: ['group_context_search'] },
] as const
const platforms = [
  { key: 'feishu', label: '飞书（自带机器人）', api: feishuConnectApi, hint: '手机飞书扫码 → 授权创建机器人，咕咕自动连接，私聊它直接管项目/文件/日程' },
  { key: 'qq', label: 'QQ（自带机器人）', api: qqConnectApi, hint: '手机 QQ 扫码 → 选一个机器人授权，咕咕自动连接，私聊或在群里 @它管理项目/文件/日程' },
  { key: 'wechat', label: '微信（个人微信）', api: wechatConnectApi, hint: '手机微信扫码 → 授权个人微信机器人（官方 iLink、无需企业资质），私聊它直接管项目/文件/日程' },
]
const bots = ref<Bot[]>([]); const botsOf = (platform: string) => bots.value.filter(bot => bot.platform === platform)
const helpPopBotId = ref<number | null>(null)
function toggleHelpPop(botId: number) { helpPopBotId.value = helpPopBotId.value === botId ? null : botId }
function onDocClickCloseHelp() { helpPopBotId.value = null }
const connecting = ref(''); const connect = ref<{ platform: string; id: string } | null>(null); const connectHint = ref(''); const connectErr = ref(''); const connectCanvas = ref<HTMLCanvasElement | null>(null); const bindingBotId = ref<number | null>(null); const bindingCodes = ref<Record<number, { code: string; expiresIn: number }>>({}); const copiedBindingBotId = ref<number | null>(null); let poll: ReturnType<typeof setInterval> | null = null; let copyFeedbackTimer: ReturnType<typeof setTimeout> | null = null

// 「接入咕咕」设置全部走同一套 latest-intent 乐观事务：apply 永远同步发生，
// 同 bot 同字段的 persistence 由 optimisticIntent 串行，旧失败不会回滚更新点击。
// 不在每次成功后整表 loadBots，避免慢 GET 把更晚的本地意图覆盖回旧值。
const pendingSettingWrites = new Set<Promise<void>>()
let settingsRevision = 0
let botsLoadSeq = 0

function botById(botId: number): Bot | undefined { return bots.value.find(bot => bot.id === botId) }
function patchLocalBot(botId: number, patch: BotSettingPatch) {
  const index = bots.value.findIndex(bot => bot.id === botId)
  if (index === -1) return
  bots.value[index] = { ...bots.value[index], ...patch }
}
function trackSettingWrite(task: Promise<void>) {
  pendingSettingWrites.add(task)
  void task.finally(() => pendingSettingWrites.delete(task))
}
async function waitForSettingWrites() {
  while (pendingSettingWrites.size) await Promise.allSettled([...pendingSettingWrites])
}
async function loadBots() {
  const seq = ++botsLoadSeq
  await waitForSettingWrites()
  if (seq !== botsLoadSeq) return
  const startRevision = settingsRevision
  try {
    const result = await userBotsApi.list()
    if (seq !== botsLoadSeq) return
    // GET 发出后若又发生了乐观写，即使该写很快结算，当前响应也可能读到提交前快照。
    // 丢掉这份响应并重取，不能让旧 list 覆盖已经立即呈现给用户的新状态。
    if (startRevision !== settingsRevision || pendingSettingWrites.size) {
      void loadBots()
      return
    }
    bots.value = result.items || []
  } catch {}
}
function updateBotSetting(botId: number, patch: BotSettingPatch, fallbackError: string): Promise<void> {
  const current = botById(botId)
  if (!current) return Promise.resolve()
  const fields = Object.keys(patch) as Array<keyof BotSettingPatch>
  const backup = Object.fromEntries(fields.map(field => [field, current[field]])) as BotSettingPatch
  const intent = beginOptimisticIntent(fields.map(field => `profile-im:${botId}:${String(field)}`))
  connectErr.value = ''
  const task = withOptimisticIntent(intent, () => optimisticMutation({
    apply: () => {
      settingsRevision++
      patchLocalBot(botId, patch)
    },
    work: () => userBotsApi.update(botId, patch),
    rollback: () => {
      settingsRevision++
      patchLocalBot(botId, backup)
    },
    afterMutate: () => {},
    onError: error => {
      // 被更新点击 supersede 的旧失败不再弹错误；只有当前最终意图失败才提示。
      if (!isOptimisticIntentCurrent(intent)) return
      connectErr.value = (error instanceof Error ? error.message : '') || fallbackError
    },
  }))
  trackSettingWrite(task)
  return task
}

async function startConnect(platform: string) { const item = platforms.find(value => value.key === platform); if (!item) return; connecting.value = platform; connectErr.value = ''; try { const result = await item.api.start(); const id = result.poll_id || result.task_id; connect.value = { platform, id }; connectHint.value = platform === 'feishu' ? '手机飞书扫码 → 授权创建机器人，授权后自动连接' : platform === 'wechat' ? '手机微信扫码 → 授权个人微信机器人，授权后自动连接' : '手机 QQ 扫码 → 选一个机器人授权，授权后自动连接'; await nextTick(); await QRCode.toCanvas(connectCanvas.value, result.scan_url, { width: 180, margin: 1 }); startPoll(item) } catch (error) { connectErr.value = (error instanceof Error ? error.message : '') || '生成二维码失败'; connect.value = null } finally { connecting.value = '' } }
function startPoll(platform: (typeof platforms)[number]) { stopPoll(); let tries = 0; poll = setInterval(async () => { tries++; try { if (!connect.value) return; const result = await platform.api.poll(connect.value.id); if (result.status === 'success') { cancelConnect(); await loadBots(); fireHint('im_bind') } else if (result.status === 'expired') { connectErr.value = '二维码已过期，请重新扫码连接'; cancelConnect() } else if (result.status === 'fail') { connectErr.value = '连接失败：' + (result.reason || '未知'); cancelConnect() } } catch {} if (tries > 100) cancelConnect() }, 3000) }
function stopPoll() { if (poll) { clearInterval(poll); poll = null } }
function resumePoll() {
  if (!connect.value) return
  const platform = platforms.find(value => value.key === connect.value?.platform)
  if (platform) startPoll(platform)
}
function cancelConnect() { stopPoll(); connect.value = null }
function toggleBot(bot: Bot) { const current = botById(bot.id); if (current) void updateBotSetting(bot.id, { enabled: !current.enabled }, '连接设置失败') }
async function createBindingCode(bot: Bot) { bindingBotId.value = bot.id; connectErr.value = ''; try { const result = await userBotsApi.createQqBindingCode(bot.id); bindingCodes.value = { ...bindingCodes.value, [bot.id]: { code: result.code, expiresIn: result.expires_in } } } catch (error) { connectErr.value = error instanceof Error ? error.message : '生成验证码失败' } finally { bindingBotId.value = null } }
async function copyText(text: string) {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    const el = document.createElement('textarea')
    el.value = text
    el.style.cssText = 'position:fixed;opacity:0'
    document.body.appendChild(el)
    el.focus()
    el.select()
    const copied = document.execCommand('copy')
    document.body.removeChild(el)
    return copied
  }
}
async function copyBindingCode(botId: number) {
  const binding = bindingCodes.value[botId]
  if (!binding) return
  const copied = await copyText(`绑定 ${binding.code}`)
  if (!copied) { connectErr.value = '复制失败，请手动复制绑定指令'; return }
  copiedBindingBotId.value = botId
  if (copyFeedbackTimer) clearTimeout(copyFeedbackTimer)
  copyFeedbackTimer = setTimeout(() => { copiedBindingBotId.value = null; copyFeedbackTimer = null }, 1600)
}
function clearCopyFeedback() { if (copyFeedbackTimer) clearTimeout(copyFeedbackTimer); copyFeedbackTimer = null; copiedBindingBotId.value = null }
function toggleGroupChat(bot: Bot) { const current = botById(bot.id); if (current) void updateBotSetting(bot.id, { group_chat_enabled: !current.group_chat_enabled }, '群聊设置失败') }
function groupResponseMode(bot: Bot): string { return bot.group_response_mode ?? (bot.group_read_enabled ? 'record_only' : bot.group_requires_at ? 'reply_mentions' : 'reply_all') }
function setGroupResponseMode(bot: Bot, mode: string) { void updateBotSetting(bot.id, { group_response_mode: mode }, '群聊回应方式设置失败') }
function groupTools(bot: Bot): string[] { return bot.group_allowed_tools ?? ['web_search', 'http_get', 'image_search', 'inspect_images', 'send_file'] }
function hasGroupTool(bot: Bot, option: (typeof groupToolOptions)[number]): boolean { return option.tools.every(t => groupTools(bot).includes(t)) }
function toggleGroupTool(bot: Bot, option: (typeof groupToolOptions)[number]) {
  const current = botById(bot.id)
  if (!current) return
  const tools = new Set(groupTools(current))
  if (hasGroupTool(current, option)) option.tools.forEach(t => tools.delete(t))
  else option.tools.forEach(t => tools.add(t))
  void updateBotSetting(bot.id, { group_allowed_tools: [...tools] }, '群聊工具设置失败')
}
function setMessageFormat(bot: Bot, scope: 'group' | 'private', mode: string) {
  const patch = scope === 'group' ? { group_message_format: mode } : { private_message_format: mode }
  void updateBotSetting(bot.id, patch, '消息格式设置失败')
}
function togglePrivateStreaming(bot: Bot) {
  const current = botById(bot.id)
  if (current) void updateBotSetting(bot.id, { private_streaming_enabled: current.private_streaming_enabled === false }, '私聊流式设置失败')
}
async function removeBot(bot: Bot) { if (!confirm(`删除「${bot.name}」？删除后这个机器人不再连咕咕。`)) return; try { await waitForSettingWrites(); await userBotsApi.remove(bot.id); await loadBots() } catch (error) { connectErr.value = error instanceof Error ? error.message : '连接失败' } }
onMounted(() => { loadBots(); document.addEventListener('click', onDocClickCloseHelp) })
onDeactivated(stopPoll)
onDeactivated(clearCopyFeedback)
onDeactivated(onDocClickCloseHelp)
onActivated(resumePoll)
</script>

<style scoped>
.pm-binding-code {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 8px;
  min-width: 0;
}

.pm-binding-code-result {
  min-height: 30px;
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 3px 4px 3px 10px;
  border: 1px solid var(--input-border);
  border-radius: var(--radius-sm);
  background: var(--surface-raised);
}

.pm-binding-code-command {
  display: inline-flex;
  align-items: baseline;
  gap: 6px;
  white-space: nowrap;
}

.pm-binding-code-prefix {
  font-size: 11px;
  font-weight: 600;
  color: var(--content-secondary);
}

.pm-binding-code-value {
  font-family: 'SF Mono', 'Consolas', monospace;
  font-size: 15px;
  font-weight: 750;
  line-height: 1;
  letter-spacing: .12em;
  font-variant-numeric: tabular-nums;
  color: var(--content-primary);
}

.pm-binding-code-expiry {
  font-size: 11px;
  color: var(--content-tertiary);
  white-space: nowrap;
}

.pm-binding-copy-btn {
  height: 24px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 4px;
  padding: 0 8px;
  border: 1px solid var(--control-border);
  border-radius: var(--radius-xs);
  background: var(--control-bg);
  color: var(--control-fg);
  font: 600 11px var(--font-sans);
  cursor: pointer;
  white-space: nowrap;
  transition:
    color var(--motion-hover-control) var(--motion-ease-standard),
    background-color var(--motion-hover-control) var(--motion-ease-standard),
    border-color var(--motion-hover-control) var(--motion-ease-standard);
}

.pm-binding-copy-btn:hover {
  color: var(--control-fg-strong);
  background: var(--control-bg-hover);
  border-color: var(--control-border-hover);
}

.pm-binding-copy-btn.copied {
  color: var(--status-success);
  background: var(--status-success-bg);
  border-color: color-mix(in srgb,var(--status-success) 32%,transparent);
}

/* 回应方式的「如何开启消息接收」浮层：表面颜色消费 --popup-* 契约
   （与右键菜单 popup-menu 同一套），组件里只定义几何。 */
.pm-help-anchor { position: relative; }
/* 「选择群消息的处理方式」文字 + 「设置方法」按钮同行水平排：
   pm-field-desc 是 flex-direction:column（默认所有 desc 都这么排），
   这里要把 hint + button 绑成一行，所以单独再套一个 inline 容器。 */
.pm-help-row { display: inline-flex; align-items: baseline; gap: 4px; }
.pm-help-toggle {
  /* 「设置方法」是行内小链接按钮：跟「选择群消息的处理方式」文字同行末尾
     居中显示，跟 hint 同字号 12px（不再小一号看着突兀），用 action-primary
     颜色 + 600 字重区别于普通灰色说明文字，让用户一眼识别为可点击；
     无下虚线、无下沉反馈——4 个字在按钮内水平居中。 */
  background: none;
  border: none;
  padding: 0 2px;
  margin: 0;
  cursor: pointer;
  font-size: 12px;
  font-weight: 600;
  color: var(--action-primary);
  text-align: center;
  text-decoration: none;
  font-family: var(--font-sans);
  line-height: inherit;
  vertical-align: baseline;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  transform: none;
  opacity: 1;
}
.pm-help-toggle:hover { color: var(--action-primary-hover, var(--action-primary)); text-decoration: none; }
.pm-help-toggle:focus { outline: none; }
.pm-help-toggle:focus-visible { outline: 2px solid var(--action-outline); outline-offset: 2px; border-radius: 2px; }
.pm-help-toggle:active { transform: none; opacity: 1; }
.pm-help-pop {
  position: absolute; top: calc(100% + 6px); left: 50%; transform: translateX(-50%);
  z-index: 30; width: max-content; max-width: 300px; padding: 10px 12px;
  border-radius: var(--popup-surface-radius); border: 1px solid var(--popup-surface-border);
  background: var(--popup-surface-bg); color: var(--popup-item-fg);
  box-shadow: var(--popup-surface-shadow), inset 0 1px 0 var(--popup-surface-highlight);
  backdrop-filter: var(--popup-surface-blur); -webkit-backdrop-filter: var(--popup-surface-blur);
}
.pm-help-pop-title { font-size: 12px; font-weight: 700; color: var(--content-primary); margin-bottom: 6px; }
.pm-help-pop-step { font-size: 12px; color: var(--content-secondary); line-height: 1.7; }
.pm-help-pop-note { margin-top: 6px; font-size: 11px; color: var(--popup-item-fg-muted); border-top: 1px solid var(--popup-divider); padding-top: 6px; line-height: 1.6; }
</style>
