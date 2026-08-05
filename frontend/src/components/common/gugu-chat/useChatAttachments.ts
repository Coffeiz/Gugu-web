import { ref, computed } from 'vue'
import { agentApi } from '@/services/api'
import type { ChatFile } from './chatTypes'
import { IMG_EXTS } from './messageDisplay'

/**
 * 附件（选择/拖拽/粘贴/暂存上传）+ 语音录制的唯一状态所有权。
 *
 * 由 GuguChat.vue 单次实例化并把结果透传给 GuguChatComposer.vue——不是让
 * Composer 自己调用这个 composable，因为 send() 仍在主组件（Phase 4 前），
 * 需要直接读 pendingAtt 来拼发送 payload；同一个 composable 调两次会拿到
 * 两份互不相干的状态，不是共享同一份。
 */
export function useChatAttachments(options: {
  onError: (text: string) => void
  onVoiceSent: () => void   // 录完即发：语音上传成功后通知调用方触发 send()
}) {
  const pendingAtt   = ref<ChatFile[]>([])     // 待发送的聊天附件（已上传暂存）
  const attUploading = ref(false)
  const fileInput    = ref<HTMLInputElement | null>(null)

  function pickFile() { fileInput.value && fileInput.value.click() }

  async function uploadAttachFiles(files: File[], opts: { voice?: boolean } = {}) {
    if (!files.length) return
    attUploading.value = true
    try {
      for (const file of files) {
        try {
          const meta: ChatFile = await agentApi.uploadAttachment(file, opts.voice)
          // 图片附件：本地 objectURL 立即出预览（暂存附件无 file_id，取不到服务端缩略图）
          if (IMG_EXTS.has((meta.ext || '').toLowerCase())) meta._thumbUrl = URL.createObjectURL(file)
          pendingAtt.value.push(meta)
        } catch (err: any) {
          options.onError('附件上传失败 😵 ' + (err && err.message || ''))
        }
      }
    } finally { attUploading.value = false }
  }

  async function onFilePicked(e: Event) {
    const target = e.target as HTMLInputElement
    const files = [...(target.files || [])]
    target.value = ''
    await uploadAttachFiles(files)
  }

  // ── 拖入文件添加附件（大小窗都支持）──
  const chatDrag = ref(0)
  const isChatDragging = computed(() => chatDrag.value > 0)
  function _dragHasFiles(e: DragEvent) { return [...(e.dataTransfer?.types || [])].includes('Files') }
  function onChatDragEnter(e: DragEvent) { if (_dragHasFiles(e)) { e.preventDefault(); chatDrag.value++ } }
  function onChatDragOver(e: DragEvent)  { if (_dragHasFiles(e)) e.preventDefault() }
  function onChatDragLeave()  { if (chatDrag.value > 0) chatDrag.value-- }
  function onChatDrop(e: DragEvent) {
    if (!_dragHasFiles(e)) return
    e.preventDefault()
    chatDrag.value = 0
    uploadAttachFiles([...(e.dataTransfer?.files || [])])
  }
  // ── 粘贴文件/图片添加附件（截图直接 Ctrl+V，纯文本粘贴不受影响）──
  function onPaste(e: ClipboardEvent) {
    const files = [...(e.clipboardData?.items || [])]
      .filter(it => it.kind === 'file')
      .map(it => it.getAsFile())
      .filter((f): f is File => !!f)
    if (!files.length) return
    e.preventDefault()
    uploadAttachFiles(files)
  }
  function removeAtt(a: ChatFile) {
    if (a._thumbUrl) URL.revokeObjectURL(a._thumbUrl)   // 未发送即移除，回收 objectURL
    pendingAtt.value = pendingAtt.value.filter(x => x.attach_id !== a.attach_id)
  }

  // ── 语音输入：录音 → 上传成附件 → 录完即发（咕咕用 mimo 听懂内容）──
  // 浏览器多录成 webm/opus（mimo 不收）→ 后端 /agent/upload 转 mp3；Safari m4a/Firefox ogg 原生免转。
  const recording  = ref(false)
  const recordSecs = ref(0)
  let _recorder: MediaRecorder | null = null
  let _recChunks: Blob[] = []
  let _recStream: MediaStream | null = null
  let _recTimer: ReturnType<typeof setInterval> | null = null
  let _recMime = ''
  let _recCancelled = false
  function _pickRecMime() {
    const cands = ['audio/mp4', 'audio/ogg;codecs=opus', 'audio/ogg', 'audio/webm']  // 优先 mimo 原生(m4a/ogg)
    if (window.MediaRecorder)
      for (const m of cands) { try { if (MediaRecorder.isTypeSupported(m)) return m } catch {} }
    return ''
  }
  function _recExt(m: string) {
    if (m.includes('mp4')) return 'm4a'
    if (m.includes('ogg')) return 'ogg'
    if (m.includes('wav')) return 'wav'
    return 'webm'
  }
  async function startRecord() {
    if (recording.value) return
    // getUserMedia 只在安全环境（HTTPS / localhost）可用——http 访问时 navigator.mediaDevices 直接是 undefined、连权限都不弹
    if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
      options.onError('录音需要 HTTPS 或 localhost 安全环境 🎤 当前是 http 访问（如局域网 IP），浏览器不给开麦克风。线上 https 域名可以用～'); return
    }
    if (!window.MediaRecorder) { options.onError('这个浏览器不支持录音 🎤'); return }
    try {
      _recStream = await navigator.mediaDevices.getUserMedia({ audio: true })
      const mime = _pickRecMime()
      _recorder = mime ? new MediaRecorder(_recStream, { mimeType: mime }) : new MediaRecorder(_recStream)
      _recMime = _recorder.mimeType || mime || 'audio/webm'
      _recChunks = []; _recCancelled = false
      _recorder.ondataavailable = (e) => { if (e.data && e.data.size) _recChunks.push(e.data) }
      _recorder.onstop = _onRecStop
      _recorder.start()
      recording.value = true; recordSecs.value = 0
      _recTimer = setInterval(() => { recordSecs.value++; if (recordSecs.value >= 60) stopRecord() }, 1000)
    } catch (e: any) {
      _recStream?.getTracks().forEach(t => t.stop()); _recStream = null
      options.onError('没法录音 🎤 ' + (e?.name === 'NotAllowedError' ? '麦克风权限被拒了，去浏览器设置允许一下' : (e?.message || '')))
    }
  }
  function stopRecord()   { if (recording.value && _recorder) { _recCancelled = false; _recorder.stop() } }   // 结束并发送
  function cancelRecord() { if (recording.value && _recorder) { _recCancelled = true;  _recorder.stop() } }   // 丢弃
  async function _onRecStop() {
    recording.value = false
    if (_recTimer) { clearInterval(_recTimer); _recTimer = null }
    _recStream?.getTracks().forEach(t => t.stop()); _recStream = null
    const chunks = _recChunks, mime = _recMime, cancelled = _recCancelled
    _recChunks = []; _recorder = null
    if (cancelled || !chunks.length) return
    const blob = new Blob(chunks, { type: mime })
    if (!blob.size) return
    const file = new File([blob], `语音_${Date.now()}.${_recExt(mime)}`, { type: mime })
    await uploadAttachFiles([file], { voice: true })   // 标记为语音 → 语音条 + 30 天存储 + 「让我听听」
    if (pendingAtt.value.length) options.onVoiceSent()   // 录完即发（含可能已输入的文字）
  }

  return {
    pendingAtt, attUploading, fileInput, pickFile, uploadAttachFiles, onFilePicked,
    chatDrag, isChatDragging, onChatDragEnter, onChatDragOver, onChatDragLeave, onChatDrop, onPaste,
    removeAtt,
    recording, recordSecs, startRecord, stopRecord, cancelRecord,
  }
}
