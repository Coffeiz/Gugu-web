import { ref, computed, watch, onUnmounted } from 'vue'
import { useAudioStore } from '@/stores/audio'
import { API_BASE } from '../chatConstants'
import type { ChatFile } from '../chatTypes'
import { i18n } from '@/i18n'
import { isUnauthorizedResponse } from '@/services/authSession'

/**
 * 迷你播放器（文件库音频）+ 消息语音条播放的唯一状态所有权：<audio> 元素、
 * 播放/进度/音量、跨曲目续播进度（localStorage）、语音 Object URL 缓存。
 *
 * 悬浮球的转圈/涟漪视觉反应（fabSvgRef 转场动画）仍留在 GuguChat.vue——那是
 * FAB 自己的展示逻辑，只是恰好由 audioPlaying 触发，不属于"播放器状态"本身。
 * audioStop() 因此拆成两半：这里做纯音频机制（暂停/清进度/通知 store），FAB
 * 转场动画通过 onBeforeStop 钩子在 audioStore.file 还没被清空前插入一次。
 */
export function useChatAudio(options: {
  onTip: (text: string) => void
  onBeforeStop?: () => void
}) {
  const audioStore = useAudioStore()

  const audioEl       = ref<HTMLAudioElement | null>(null)
  const audioPlaying  = ref(false)
  const audioCurrent  = ref(0)
  const audioDuration = ref(0)
  const audioIdleBars = [12, 12, 12, 12]
  const idleVoiceBars = Array(13).fill(12)
  const audioBars = ref([...audioIdleBars])
  const voiceBars = ref([...idleVoiceBars])
  type WaveTarget = { analyser: AnalyserNode; bars: typeof audioBars }
  let audioContext: AudioContext | null = null
  let samplingFrame = 0
  const analyzers = new WeakMap<HTMLAudioElement, AnalyserNode>()
  const waveTargets = new Map<HTMLAudioElement, WaveTarget>()

  function ensureAudioContext(): AudioContext | null {
    if (audioContext) return audioContext
    if (typeof window === 'undefined' || !window.AudioContext) return null
    try { audioContext = new window.AudioContext(); return audioContext }
    catch { return null }
  }

  function ensureAnalyser(element: HTMLAudioElement): AnalyserNode | null {
    const existing = analyzers.get(element)
    if (existing) return existing
    const context = ensureAudioContext()
    if (!context || context.state !== 'running') return null
    try {
      const source = context.createMediaElementSource(element)
      const analyser = context.createAnalyser()
      analyser.fftSize = 256
      analyser.smoothingTimeConstant = 0.72
      source.connect(analyser)
      analyser.connect(context.destination)
      analyzers.set(element, analyser)
      return analyser
    } catch {
      // 分析器不可用时仍保留 HTMLAudioElement 原有播放能力。
      return null
    }
  }

  function sampleWave(analyser: AnalyserNode, count: number): number[] {
    const spectrum = new Uint8Array(analyser.frequencyBinCount)
    analyser.getByteFrequencyData(spectrum)
    return Array.from({ length: count }, (_, index) => {
      const start = Math.max(1, Math.floor(index * spectrum.length / count))
      const end = Math.max(start + 1, Math.floor((index + 1) * spectrum.length / count))
      let total = 0
      for (let bin = start; bin < Math.min(end, spectrum.length); bin++) total += spectrum[bin]
      const average = total / Math.max(1, Math.min(end, spectrum.length) - start)
      return Math.max(12, Math.min(100, Math.round(Math.sqrt(average / 255) * 100)))
    })
  }

  function sampleWaves() {
    samplingFrame = 0
    let hasPlayingTarget = false
    for (const [element, target] of waveTargets) {
      if (element.paused || element.ended) { waveTargets.delete(element); continue }
      hasPlayingTarget = true
      target.bars.value = sampleWave(target.analyser, target.bars.value.length)
    }
    if (hasPlayingTarget) samplingFrame = requestAnimationFrame(sampleWaves)
  }

  function onMediaPlay(element: HTMLAudioElement, bars: typeof audioBars) {
    const context = ensureAudioContext()
    if (!context) return
    void context.resume().then(() => {
      if (element.paused) return
      const analyser = ensureAnalyser(element)
      if (!analyser) return
      waveTargets.set(element, { analyser, bars })
      if (!samplingFrame) samplingFrame = requestAnimationFrame(sampleWaves)
    }).catch(() => {})
  }

  function onMediaPause(element: HTMLAudioElement, bars: typeof audioBars, idle: number[]) {
    waveTargets.delete(element)
    bars.value = idle
    if (!waveTargets.size && samplingFrame) {
      cancelAnimationFrame(samplingFrame)
      samplingFrame = 0
    }
  }

  function onAudioDurationChange() {
    const duration = audioEl.value?.duration || 0
    audioDuration.value = duration
    const fileId = audioStore.file?.id
    if (fileId != null) audioStore.updateDuration(fileId, duration)
  }

  function progKey() { return audioStore.file ? `audio_prog_${audioStore.file.id}` : null }
  function saveProgress() {
    const key = progKey()
    if (!key || !audioEl.value?.duration) return
    const t = audioEl.value.currentTime, d = audioEl.value.duration
    if (t < d - 3) localStorage.setItem(key, String(t))
    else localStorage.removeItem(key)
  }
  function restoreProgress() {
    const key = progKey()
    if (!key || !audioEl.value) return
    const saved = localStorage.getItem(key)
    localStorage.removeItem(key)
    if (saved && +saved > 0) audioEl.value.currentTime = +saved
  }

  const needsRestore = ref(false)
  watch(() => audioStore.file?.id, () => {
    needsRestore.value = true
    audioCurrent.value = 0
    audioDuration.value = 0
  })

  const audioSeekPct = computed(() =>
    audioDuration.value ? (audioCurrent.value / audioDuration.value) * 100 : 0
  )

  // 浏览器可能在没有用户手势时拒绝自动播放；必须消费 play() 的 Promise，
  // 否则会把正常的自动播放限制冒泡成未捕获异常。用户随后点击播放时仍会重试。
  function playMainAudio() {
    const element = audioEl.value
    if (!element) return
    void element.play().catch(() => { audioPlaying.value = false })
  }

  function onAudioPlay() {
    audioPlaying.value = true
    if (audioEl.value) onMediaPlay(audioEl.value, audioBars)
  }

  function onCanPlay() {
    if (!audioEl.value) return
    audioEl.value.volume = audioVolume.value
    if (needsRestore.value) { needsRestore.value = false; restoreProgress() }
    playMainAudio()
  }
  function onAudioPause() {
    audioPlaying.value = false
    if (audioEl.value) onMediaPause(audioEl.value, audioBars, audioIdleBars)
  }
  function onAudioEnded() {
    if (audioEl.value) onMediaPause(audioEl.value, audioBars, audioIdleBars)
    audioPlaying.value = false
    const key = progKey(); if (key) localStorage.removeItem(key)
    const action = audioStore.handleTrackEnded()
    if (action === 'repeat' && audioEl.value) {
      audioEl.value.currentTime = 0
      playMainAudio()
    }
  }
  function audioToggle() {
    if (!audioEl.value) return
    if (audioPlaying.value) audioEl.value.pause()
    else playMainAudio()
  }
  function audioStop() {
    audioEl.value?.pause()
    options.onBeforeStop?.()   // FAB 转场动画：必须在 audioStore.file 清空前触发
    audioPlaying.value = false; audioCurrent.value = 0; audioDuration.value = 0
    audioStore.stop()
  }

  const VOL_KEY    = 'gugu_audio_volume'
  const audioVolume = ref(+(localStorage.getItem(VOL_KEY) ?? 0.5))
  const audioMuted  = ref(false)
  function audioSetVolume(e: Event) {
    audioVolume.value = +(e.target as HTMLInputElement).value
    localStorage.setItem(VOL_KEY, String(audioVolume.value))
    if (audioEl.value) { audioEl.value.volume = audioVolume.value; audioEl.value.muted = false }
    audioMuted.value = false
  }
  function audioToggleMute() {
    audioMuted.value = !audioMuted.value
    if (audioEl.value) audioEl.value.muted = audioMuted.value
  }
  function seekTo(clientX: number, rect: DOMRect) {
    if (!audioEl.value || !audioDuration.value) return
    audioEl.value.currentTime = ((clientX - rect.left) / rect.width) * audioDuration.value
  }
  function audioStartDrag(e: MouseEvent) {
    // 拖拽期间用 window 级 mousemove/mouseup 跟手（鼠标移出进度条也要继续跟）；
    // 这两个事件的 currentTarget 是 window 本身，取不到进度条的 rect，必须在
    // mousedown 这一下先把 rect 量出来存住，move 阶段复用同一个 rect。
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
    seekTo(e.clientX, rect)
    const move = (ev: MouseEvent) => seekTo(ev.clientX, rect)
    const up = () => { window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up) }
    window.addEventListener('mousemove', move); window.addEventListener('mouseup', up)
  }
  function fmtTime(s: number) {
    if (!s || isNaN(s)) return '0:00'
    return `${Math.floor(s / 60)}:${Math.floor(s % 60).toString().padStart(2, '0')}`
  }

  // ── 语音条播放：点击拉鉴权 blob（download 端点带 Bearer），单实例播放，再点暂停 ──
  const voicePlayingId = ref<string | null>(null)
  let _voiceAudio: HTMLAudioElement | null = null
  const _voiceUrls: Record<string, string> = {}            // attach_id → objectURL 缓存（同条重播不重拉）
  async function toggleVoice(f: ChatFile) {
    const id = f.attach_id
    if (!id) return
    if (voicePlayingId.value === id && _voiceAudio) { _voiceAudio.pause(); return }  // 再点＝暂停
    if (_voiceAudio) { _voiceAudio.pause(); _voiceAudio = null }                     // 切换：停掉上一条
    try {
      let url = _voiceUrls[id]
      if (!url) {
        const res = await fetch(`${API_BASE}/agent/attachment/${id}/download`,
          { credentials: 'include' })
        if (isUnauthorizedResponse(res)) return
        if (!res.ok) { options.onTip(res.status === 404 ? i18n.global.t('chatUi.voiceExpired') : i18n.global.t('chatUi.voiceLoadFailed')); return }
        url = URL.createObjectURL(await res.blob()); _voiceUrls[id] = url
      }
      const a = new Audio(url); _voiceAudio = a; voicePlayingId.value = id
      a.onplay = () => onMediaPlay(a, voiceBars)
      a.onended = a.onpause = () => {
        onMediaPause(a, voiceBars, idleVoiceBars)
        if (voicePlayingId.value === id) voicePlayingId.value = null
      }
      await a.play()
    } catch (e) { voicePlayingId.value = null; options.onTip(i18n.global.t('chatUi.voicePlayFailed')) }
  }

  onUnmounted(() => {
    for (const element of waveTargets.keys()) element.pause()
    waveTargets.clear()
    if (samplingFrame) cancelAnimationFrame(samplingFrame)
    samplingFrame = 0
    _voiceAudio?.pause()
    Object.values(_voiceUrls).forEach((url) => URL.revokeObjectURL(url))
    if (audioContext && audioContext.state !== 'closed') void audioContext.close()
  })

  return {
    audioEl, audioPlaying, audioCurrent, audioDuration, audioSeekPct, audioBars,
    onAudioDurationChange,
    saveProgress, onCanPlay, onAudioPlay, onAudioPause, onAudioEnded, audioToggle, audioStop,
    audioVolume, audioMuted, audioSetVolume, audioToggleMute, audioStartDrag, fmtTime,
    voicePlayingId, voiceBars, toggleVoice,
  }
}
