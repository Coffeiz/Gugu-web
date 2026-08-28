<template>
  <div class="pty-terminal-shell" :class="{ 'is-disconnected': !connected }">
    <div ref="terminalRef" class="pty-terminal" aria-label="交互式终端"></div>
    <div v-if="statusText" class="pty-terminal-status" role="status">{{ statusText }}</div>
  </div>
</template>

<script setup lang="ts">
import { onMounted, onUnmounted, ref, watch } from 'vue'
import { FitAddon } from '@xterm/addon-fit'
import { Terminal } from 'xterm'
import 'xterm/css/xterm.css'
import { getToken } from '@/services/api'

const props = defineProps<{ terminalId: string }>()
const emit = defineEmits<{ status: [value: { cols?: number; rows?: number }]; exit: []; error: [message: string] }>()
const terminalRef = ref<HTMLElement | null>(null)
const connected = ref(false)
const statusText = ref('正在连接…')
let terminal: Terminal | null = null
let fitAddon: FitAddon | null = null
let socket: WebSocket | null = null
let intentionalClose = false
let reconnectTimer: number | null = null
let reconnectAttempt = 0
let outputDecoder: TextDecoder | null = null

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
  statusText.value = `连接已断开，${Math.ceil(delay / 1000)} 秒后重连…`
  reconnectTimer = window.setTimeout(() => { reconnectTimer = null; connect() }, delay)
}
function connect() {
  if (intentionalClose) return
  socket?.close()
  const token = getToken()
  socket = new WebSocket(socketUrl(props.terminalId), token ? [`gugu-auth.${token}`] : [])
  socket.onopen = () => { connected.value = true; reconnectAttempt = 0; statusText.value = ''; resize() }
  socket.onmessage = (event) => {
    try {
      const message = JSON.parse(event.data) as { type?: string; data?: string; cols?: number; rows?: number; message?: string }
      if (message.type === 'output' && message.data) {
        const bytes = Uint8Array.from(atob(message.data), char => char.charCodeAt(0))
        terminal?.write((outputDecoder ??= new TextDecoder()).decode(bytes, { stream: true }))
      } else if (message.type === 'ready' || message.type === 'status') emit('status', { cols: message.cols, rows: message.rows })
      else if (message.type === 'exit') {
        if (outputDecoder) terminal?.write(outputDecoder.decode())
        outputDecoder = null
        statusText.value = '终端已退出'; connected.value = false; emit('exit')
      }
      else if (message.type === 'error') emit('error', message.message ?? '终端连接失败')
    } catch { emit('error', '终端输出格式无效') }
  }
  socket.onerror = () => { connected.value = false }
  socket.onclose = () => { connected.value = false; if (!intentionalClose) scheduleReconnect() }
}
function handleResize() { resize() }

onMounted(() => {
  terminal = new Terminal({
    cursorBlink: true, convertEol: true,
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
    fontSize: 13, scrollback: 5000,
    theme: { background: '#101319', foreground: '#e7edf7', cursor: '#c6c9ff', selectionBackground: '#45476b' },
  })
  fitAddon = new FitAddon()
  terminal.loadAddon(fitAddon)
  terminal.open(terminalRef.value as HTMLElement)
  terminal.focus()
  terminalRef.value?.addEventListener('click', () => terminal?.focus())
  terminal.onData(data => send({ type: 'input', data }))
  window.addEventListener('resize', handleResize)
  connect()
})
watch(() => props.terminalId, () => { intentionalClose = true; socket?.close(); intentionalClose = false; reconnectAttempt = 0; connect() })
onUnmounted(() => {
  intentionalClose = true
  if (reconnectTimer !== null) window.clearTimeout(reconnectTimer)
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'detach' }))
  socket?.close()
  window.removeEventListener('resize', handleResize)
  terminal?.dispose()
})
</script>

<style scoped>
.pty-terminal-shell { position:relative; min-height:0; flex:1; overflow:hidden; background:#101319; }
.pty-terminal { height:100%; padding:14px 16px; box-sizing:border-box; }
.pty-terminal :deep(.xterm) { height:100%; }
.pty-terminal :deep(.xterm-viewport) { background:#101319 !important; }
.pty-terminal-status { position:absolute; inset:0; display:grid; place-items:center; color:#778196; font:12px/1.5 var(--font-sans); pointer-events:none; }
.pty-terminal-shell:not(.is-disconnected) .pty-terminal-status { display:none; }
</style>
