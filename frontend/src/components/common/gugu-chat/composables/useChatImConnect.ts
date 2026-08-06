import { ref, reactive, computed, nextTick, onUnmounted, type Ref, type ComponentPublicInstance } from 'vue'
import QRCode from 'qrcode'
import { userBotsApi, qqConnectApi, feishuConnectApi, wechatConnectApi } from '@/services/api'
import type { ImPlatformKey } from '../chatTypes'
import type GuguChatSidebar from '../GuguChatSidebar.vue'
import type GuguChatBindDialog from '../GuguChatBindDialog.vue'

interface Bot {
  id?: number
  platform: string
  enabled: boolean
}

interface ImConnectState { platform: string; id: string | number }

// ImPlatformKey 从 chatTypes.ts 引入（GuguChatSidebar.vue 的函数类型 props 也要用同一个
// 类型别名，strictFunctionTypes 下两边收窄成不同类型会报参数逆变错误）。
interface ImPlatformApi { start: () => Promise<any>; poll: (id: any) => Promise<any> }
interface ImPlatform { key: ImPlatformKey; label: string; api: ImPlatformApi }

/**
 * IM（飞书/QQ/微信）接入的唯一状态所有权：Bot 列表、侧栏「扫码连接」抽屉、聊天内
 * 「扫码绑定」弹窗——两处扫码流程复用同一套 IM_PLATFORMS 元数据和轮询模式，但各自
 * 独立的连接状态（互不干扰，同时开两个不会串）。
 *
 * sidebarRef/bindDialogRef/expanded/enterExpanded 由 GuguChat.vue 传入：前两个是拿去操作
 * 子组件暴露的 DOM（滚动定位 IM 抽屉 / 往对话框的 canvas 画二维码），后两个是因为
 * 「点击离线状态」这个入口需要联动窗口展开，窗口状态本身不属于这个 composable。
 */
export function useChatImConnect(options: {
  sidebarRef: Ref<InstanceType<typeof GuguChatSidebar> | null>
  bindDialogRef: Ref<InstanceType<typeof GuguChatBindDialog> | null>
  expanded: Ref<boolean>
  enterExpanded: () => Promise<void> | void
  fetchSessions: () => Promise<void>
}) {
  const IM_PLATFORMS: ImPlatform[] = [
    { key: 'feishu',  label: '飞书', api: feishuConnectApi },
    { key: 'qq',   label: 'QQ',   api: qqConnectApi },
    { key: 'wechat',  label: '微信', api: wechatConnectApi },
  ]
  const bots   = ref<Bot[]>([])
  const imOpen = reactive<Record<ImPlatformKey, boolean>>({ feishu: false, qq: false, wechat: false })
  // Sidebar 只需要 key/label 展示，api 对象（feishuConnectApi 等）留在这里，
  // startImConnect/openChatImBind 仍按 IM_PLATFORMS.find(...) 查找。
  const imPlatformOptions = computed(() => IM_PLATFORMS.map(p => ({ key: p.key, label: p.label })))
  const imOnline = computed(() => bots.value.some(b => b.enabled))   // 有「启用中」的 IM bot 才算在线（停用/残留不算）
  const imHighlight = ref(false)
  const botsOf = (platform: ImPlatformKey) => bots.value.filter(b => b.platform === platform)

  async function loadBots() {
    try { const r = await userBotsApi.list(); bots.value = r.items || [] } catch {}
  }
  function toggleImPlatform(key: ImPlatformKey) { imOpen[key] = !imOpen[key] }

  // 离线状态被点击：展开大窗 → 摊开各 IM 抽屉露出「扫码连接」→ 高亮 IM 区一下（暗示式引导，不强推）
  async function promptConnectIM() {
    if (!options.expanded.value) await options.enterExpanded()
    else loadBots()
    IM_PLATFORMS.forEach(p => { imOpen[p.key] = true })
    await nextTick()
    options.sidebarRef.value?.imGroupEl?.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
    imHighlight.value = false   // 重置以便点第二次也能重放动画
    await nextTick()
    imHighlight.value = true
    setTimeout(() => { imHighlight.value = false }, 2600)
  }

  // 通用扫码连接（建任务 → 渲染二维码 → 轮询 → 自动写 user_bot，与 ProfileModal 同一套 API）
  const connecting    = ref('')        // 正在生成二维码的平台 key
  const connect       = ref<ImConnectState | null>(null)      // { platform, id } 连接进行中
  const connectHint   = ref('')
  const connectErr    = ref('')
  const connectCanvas = ref<HTMLCanvasElement | null>(null)
  let   connectPoll: ReturnType<typeof setInterval> | null = null
  function setConnectCanvas(el: Element | ComponentPublicInstance | null) { if (el) connectCanvas.value = el as HTMLCanvasElement }   // v-for 内函数 ref，避免数组 ref

  async function startImConnect(platform: ImPlatformKey) {
    const p = IM_PLATFORMS.find(x => x.key === platform)
    if (!p) return
    connecting.value = platform; connectErr.value = ''
    try {
      const r = await p.api.start()
      connect.value = { platform, id: r.poll_id || r.task_id }   // 飞书 poll_id / QQ & 微信 task_id
      connectHint.value = platform === 'feishu'
        ? '手机飞书扫码 → 授权创建机器人，授权后自动连接'
        : platform === 'wechat'
          ? '手机微信扫码 → 授权后自动连接'
          : '手机 QQ 扫码 → 选一个机器人授权，授权后自动连接'
      await nextTick()
      await QRCode.toCanvas(connectCanvas.value, r.scan_url, { width: 160, margin: 1 })
      _startImPoll(p)
    } catch (e: any) {
      connectErr.value = e?.message || '生成二维码失败'
      connect.value = null
    } finally { connecting.value = '' }
  }
  function _startImPoll(p: ImPlatform) {
    _stopImPoll()
    let tries = 0
    connectPoll = setInterval(async () => {
      tries++
      try {
        const r = await p.api.poll(connect.value?.id)
        if (r.status === 'success') { cancelImConnect(); await loadBots(); await options.fetchSessions() }
        else if (r.status === 'expired') { connectErr.value = '二维码已过期，请重新扫码'; cancelImConnect() }
        else if (r.status === 'fail') { connectErr.value = '连接失败：' + (r.reason || '未知'); cancelImConnect() }
      } catch {}
      if (tries > 100) cancelImConnect()   // ~5 分钟超时
    }, 3000)
  }
  function _stopImPoll() { if (connectPoll) { clearInterval(connectPoll); connectPoll = null } }
  function cancelImConnect() { _stopImPoll(); connect.value = null }

  // ── 聊天内「扫码绑定 IM」：咕咕回复里输出 [文案](gugu://bind-im/<platform>) 当按钮，
  //    点击 → 这里弹小窗扫码（复用 IM_PLATFORMS 的 start/poll，与侧栏同一套后端，互不干扰）──
  const chatBind = reactive<{ open: boolean; platform: string; label: string; hint: string; err: string; id: string | number | null }>(
    { open: false, platform: '', label: '', hint: '', err: '', id: null }
  )
  let chatBindPoll: ReturnType<typeof setInterval> | null = null

  async function openChatImBind(platform: string) {
    const p = IM_PLATFORMS.find(x => x.key === platform)
    if (!p) return
    _stopChatBindPoll()
    chatBind.platform = platform; chatBind.label = p.label
    chatBind.err = ''; chatBind.hint = ''; chatBind.id = null; chatBind.open = true
    await nextTick()
    try {
      const r = await p.api.start()
      chatBind.id = r.poll_id || r.task_id
      chatBind.hint = platform === 'feishu'
        ? '手机飞书扫码 → 授权创建机器人，授权后自动连接'
        : platform === 'wechat'
          ? '手机微信扫码 → 授权后自动连接'
          : '手机 QQ 扫码 → 选一个机器人授权，授权后自动连接'
      await nextTick()
      await QRCode.toCanvas(options.bindDialogRef.value?.canvasEl, r.scan_url, { width: 168, margin: 1 })
      _startChatBindPoll(p)
    } catch (e: any) {
      chatBind.err = e?.message || '生成二维码失败'
    }
  }
  function _startChatBindPoll(p: ImPlatform) {
    _stopChatBindPoll()
    let tries = 0
    chatBindPoll = setInterval(async () => {
      tries++
      try {
        const r = await p.api.poll(chatBind.id)
        if (r.status === 'success') { closeChatBind(); await loadBots(); await options.fetchSessions() }
        else if (r.status === 'expired') { chatBind.err = '二维码已过期，关掉再点一次按钮'; _stopChatBindPoll() }
        else if (r.status === 'fail') { chatBind.err = '连接失败：' + (r.reason || '未知'); _stopChatBindPoll() }
      } catch {}
      if (tries > 100) closeChatBind()
    }, 3000)
  }
  function _stopChatBindPoll() { if (chatBindPoll) { clearInterval(chatBindPoll); chatBindPoll = null } }
  function closeChatBind() { _stopChatBindPoll(); chatBind.open = false }

  onUnmounted(() => { _stopImPoll(); _stopChatBindPoll() })

  return {
    bots, imOpen, imPlatformOptions, imOnline, botsOf, imHighlight,
    loadBots, toggleImPlatform, promptConnectIM,
    connecting, connect, connectHint, connectErr, setConnectCanvas,
    startImConnect, cancelImConnect,
    chatBind, openChatImBind, closeChatBind,
  }
}
