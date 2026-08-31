<template>
  <div class="pty-terminal-shell" :class="{ 'is-disconnected': !connected }">
    <div ref="terminalRef" class="pty-terminal" :aria-label="t('terminalUi.interactiveLabel')"></div>
    <div v-if="statusText" class="pty-terminal-status" role="status">{{ statusText }}</div>
  </div>
</template>

<script setup lang="ts">
import { onActivated, onMounted, onUnmounted, onDeactivated, ref, watch } from 'vue'
import { FitAddon } from '@xterm/addon-fit'
import { Terminal } from 'xterm'
import 'xterm/css/xterm.css'
import { getToken } from '@/services/api'
import { useI18n } from 'vue-i18n'

const props = defineProps<{ terminalId: string; restartToken?: number }>()
const { t } = useI18n()
const emit = defineEmits<{ status: [value: { terminalId: string; cols?: number; rows?: number }]; exit: [terminalId: string]; error: [message: string] }>()
const terminalRef = ref<HTMLElement | null>(null)
const connected = ref(false)
const statusText = ref('')
let terminal: Terminal | null = null
let fitAddon: FitAddon | null = null
let socket: WebSocket | null = null
let socketGeneration = 0
let intentionalClose = false
let reconnectTimer: number | null = null
let reconnectAttempt = 0
let outputDecoder: TextDecoder | null = null
let suppressPasteSubmitUntil = 0
let promptRecoveryTimer: number | null = null
let hasEstablishedConnection = false

function socketUrl(id: string): string {
  const configured = import.meta.env.VITE_API_URL ?? '/api/v1'
  const base = configured.startsWith('/')
    ? `${window.location.protocol === 'https:' ? 'wss:' : 'ws:'}//${window.location.host}${configured}`
    : configured.replace(/^http:/, 'ws:').replace(/^https:/, 'wss:')
  return `${base}/terminals/${encodeURIComponent(id)}/ws`
}
function send(value: Record<string, unknown>) { if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(value)) }
function resize() {
  if (!terminal || !fitAddon) return
  fitAddon.fit()
  send({ type: 'resize', cols: terminal.cols, rows: terminal.rows })
}
function scheduleReconnect() {
  if (intentionalClose || reconnectTimer !== null) return
  const delay = Math.min(5000, 300 * 2 ** reconnectAttempt++)
  statusText.value = t('terminalUi.disconnected', { seconds: Math.ceil(delay / 1000) })
  reconnectTimer = window.setTimeout(() => { reconnectTimer = null; connect() }, delay)
}
function connect(forcePromptRecovery = false) {
  if (intentionalClose) return
  statusText.value = t('terminalUi.connecting')
  if (promptRecoveryTimer !== null) { window.clearTimeout(promptRecoveryTimer); promptRecoveryTimer = null }
  const generation = ++socketGeneration
  const previous = socket
  if (previous && previous.readyState !== WebSocket.CLOSED) previous.close()
  const token = getToken()
  const current = new WebSocket(socketUrl(props.terminalId), token ? [`gugu-auth.${token}`] : [])
  socket = current
  const isCurrent = () => socket === current && socketGeneration === generation
  current.onopen = () => {
    if (!isCurrent()) return
    connected.value = true; reconnectAttempt = 0; statusText.value = ''; resize()
    // 首次连接和显式重启允许用 Ctrl-L 兜底重绘提示符。普通断线重连时
    // PTY 仍在运行，后端会从新订阅推送输出，重复重绘会把两个提示符写到一行。
    if (forcePromptRecovery || !hasEstablishedConnection) {
      promptRecoveryTimer = window.setTimeout(() => {
        promptRecoveryTimer = null
        const shouldRecover = isCurrent() && !hasWorkspacePrompt()
        if (shouldRecover) send({ type: 'input', data: '\u000c' })
      }, 700)
    }
    hasEstablishedConnection = true
  }
  current.onmessage = (event) => {
    if (!isCurrent()) return
    try {
      const message = JSON.parse(event.data) as { type?: string; data?: string; cols?: number; rows?: number; message?: string }
      if (message.type === 'output' && message.data) {
        const bytes = Uint8Array.from(atob(message.data), char => char.charCodeAt(0))
        terminal?.write((outputDecoder ??= new TextDecoder()).decode(bytes, { stream: true }))
      } else if (message.type === 'ready' || message.type === 'status') emit('status', { terminalId: props.terminalId, cols: message.cols, rows: message.rows })
      else if (message.type === 'exit') {
        if (outputDecoder) terminal?.write(outputDecoder.decode())
        outputDecoder = null
        statusText.value = t('terminalUi.exited'); connected.value = false; intentionalClose = true; emit('exit', props.terminalId)
      }
      else if (message.type === 'error') emit('error', message.message ?? t('terminalUi.connectionFailed'))
    } catch { emit('error', t('terminalUi.invalidOutput')) }
  }
  current.onerror = () => { if (isCurrent()) connected.value = false }
  current.onclose = (event) => {
    if (!isCurrent()) return
    if (promptRecoveryTimer !== null) { window.clearTimeout(promptRecoveryTimer); promptRecoveryTimer = null }
    socket = null
    connected.value = false
    if (event.code === 4401 || event.code === 4403) {
      intentionalClose = true
      statusText.value = t('terminals.unavailable')
      return
    }
    if (!intentionalClose) scheduleReconnect()
  }
}
function hasWorkspacePrompt(): boolean {
  if (!terminal) return false
  const buffer = terminal.buffer.active
  for (let index = 0; index < buffer.length; index += 1) {
    if (buffer.getLine(index)?.translateToString(true).includes('gugu-sandbox:/workspace$')) return true
  }
  return false
}
function handleResize() { resize() }
function handlePaste(event: ClipboardEvent) {
  const text = event.clipboardData?.getData('text/plain')
  if (!text) return
  // 浏览器粘贴默认可能把换行直接送给 Bash，导致整段日志被逐行执行。
  // 显式使用 bracketed paste，让 readline 把多行内容当作一次编辑输入。
  event.preventDefault()
  event.stopImmediatePropagation()
  const data = `\u001b[200~${text.replace(/\r?\n/g, '\r\n')}\u001b[201~`
  // xterm 在原生 paste 事件之后可能额外派发一个换行；该换行会立即提交整段粘贴内容。
  suppressPasteSubmitUntil = performance.now() + 250
  send({ type: 'input', data })
}
function terminalTheme() {
  // 终端本体保持传统暗色 CLI；亮暗主题只影响外围页面，不改变命令行可读性。
  const styles = getComputedStyle(document.documentElement)
  const accent = styles.getPropertyValue('--theme-action-primary').trim() || '#c6c9ff'
  const selection = styles.getPropertyValue('--theme-selection').trim() || '#45476b'
  return { background: '#101319', foreground: '#e7edf7', cursor: accent, selectionBackground: selection }
}
function applyTheme() { terminal?.options && (terminal.options.theme = terminalTheme()) }
function activateTerminal() {
  // KeepAlive 切换终端后容器尺寸可能已经变化，重新 fit 只调整 PTY 窗口，
  // 不重建 xterm，因此当前路径、输入行和屏幕缓冲都能保留。
  void requestAnimationFrame(() => { resize(); terminal?.focus() })
}
let themeObserver: MutationObserver | null = null

onMounted(() => {
  terminal = new Terminal({
    cursorBlink: true, convertEol: true,
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
    fontSize: 13, scrollback: 5000,
    theme: terminalTheme(),
  })
  fitAddon = new FitAddon()
  terminal.loadAddon(fitAddon)
  terminal.open(terminalRef.value as HTMLElement)
  terminal.focus()
  terminalRef.value?.addEventListener('click', () => terminal?.focus())
  terminalRef.value?.addEventListener('paste', handlePaste, true)
  terminal.onData(data => {
    if (performance.now() < suppressPasteSubmitUntil && (data === '\r' || data === '\n')) {
      suppressPasteSubmitUntil = 0
      return
    }
    send({ type: 'input', data })
  })
  window.addEventListener('resize', handleResize)
  themeObserver = new MutationObserver(applyTheme)
  themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'data-palette', 'data-family'] })
  connect(true)
})
onActivated(activateTerminal)
onDeactivated(() => { /* 保留 WebSocket 与 xterm 状态，切回时继续使用同一 PTY */ })
watch(() => [props.terminalId, props.restartToken], ([terminalId, restartToken], previous) => {
  if (terminalId === previous?.[0] && restartToken === previous?.[1]) return
  intentionalClose = true
  if (reconnectTimer !== null) { window.clearTimeout(reconnectTimer); reconnectTimer = null }
  if (promptRecoveryTimer !== null) { window.clearTimeout(promptRecoveryTimer); promptRecoveryTimer = null }
  socketGeneration++
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'detach' }))
  socket?.close()
  socket = null
  outputDecoder = null
  terminal?.reset()
  intentionalClose = false
  reconnectAttempt = 0
  connect()
})
onUnmounted(() => {
  intentionalClose = true
  socketGeneration++
  if (reconnectTimer !== null) window.clearTimeout(reconnectTimer)
  if (promptRecoveryTimer !== null) window.clearTimeout(promptRecoveryTimer)
  const current = socket
  socket = null
  if (current?.readyState === WebSocket.OPEN) current.send(JSON.stringify({ type: 'detach' }))
  current?.close()
  window.removeEventListener('resize', handleResize)
  themeObserver?.disconnect()
  themeObserver = null
  terminalRef.value?.removeEventListener('paste', handlePaste, true)
  terminal?.dispose()
})
</script>

<style scoped>
.pty-terminal-shell { position:relative; min-height:0; flex:1; overflow:hidden; background:var(--terminal-bg,#101319); }
.pty-terminal { height:100%; padding:14px 16px; box-sizing:border-box; }
.pty-terminal :deep(.xterm) { height:100%; }
.pty-terminal :deep(.xterm-viewport) { background:var(--terminal-bg,#101319) !important; }
.pty-terminal :deep(.xterm-screen) { padding:0; }
.pty-terminal-shell { --terminal-bg:#101319; }
.pty-terminal-status { position:absolute; z-index:2; inset:0; display:grid; place-items:center; color:#778196; font:12px/1.5 var(--font-sans); pointer-events:none; }
.pty-terminal-shell:not(.is-disconnected) .pty-terminal-status { display:none; }
</style>
