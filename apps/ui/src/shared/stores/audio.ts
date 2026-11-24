import { defineStore } from 'pinia'
import { ref, watch } from 'vue'
import { getAccountBoundaryEpoch } from '@/utils/accountBoundary'
import { filesApi } from '@/services/api'
import type { PathFileRef } from '@/services/api'
import { usePathFileAccess } from '@/services/pathFileAccess'

const AUDIO_FILE_KEY = 'gugu_audio_file'
const AUDIO_PLAYBACK_MODE_KEY = 'gugu_audio_playback_mode'
const PLAYBACK_MODES = ['none', 'single', 'list', 'shuffle'] as const

export type AudioPlaybackMode = typeof PLAYBACK_MODES[number]

const bc = new BroadcastChannel('gugu_audio')

export interface AudioTrack {
  filePath?: string
  displayName?: string
  ext?: string
  workspaceFile?: PathFileRef
  projectId?: number | null
  space?: string
  workspaceDirectoryId?: number | null
  duration?: number
}

function isAudioTrack(file: AudioTrack): boolean {
  return ['MP3', 'WAV', 'OGG', 'FLAC', 'M4A', 'AAC', 'OPUS'].includes((file.ext ?? '').toUpperCase())
}

export function audioTrackKey(track: AudioTrack | null | undefined): string | null {
  if (track?.workspaceFile) return JSON.stringify([track.workspaceFile.directoryId, track.workspaceFile.relativePath])
  return track?.filePath ? `path:${track.filePath}` : null
}

export const useAudioStore = defineStore('audio', () => {
  const pathFiles = usePathFileAccess()
  const file    = ref<AudioTrack | null>(null)
  const playlist = ref<AudioTrack[]>([])
  const blobUrl = ref<string | null>(null)
  const loading = ref(false)
  const error   = ref<string | null>(null)
  const savedMode = localStorage.getItem(AUDIO_PLAYBACK_MODE_KEY)
  const playbackMode = ref<AudioPlaybackMode>(
    PLAYBACK_MODES.includes(savedMode as AudioPlaybackMode)
      ? savedMode as AudioPlaybackMode
      : 'none',
  )
  const durationLoads = new Map<string, Promise<void>>()

  // 持久化当前文件信息（blob URL 不可持久化，只存元数据）
  watch(file, (f) => {
    if (f) localStorage.setItem(AUDIO_FILE_KEY, JSON.stringify(f))
    else   localStorage.removeItem(AUDIO_FILE_KEY)
  })
  watch(playbackMode, mode => localStorage.setItem(AUDIO_PLAYBACK_MODE_KEY, mode))

  function revoke() {
    if (blobUrl.value?.startsWith('blob:')) URL.revokeObjectURL(blobUrl.value)
    blobUrl.value = null
  }

  // 其他 tab 开始播放时，停掉本 tab
  bc.onmessage = () => stop()

  function updateDuration(key: string, duration: number) {
    if (!Number.isFinite(duration) || duration <= 0) return
    playlist.value = playlist.value.map(track => audioTrackKey(track) === key ? { ...track, duration } : track)
    if (audioTrackKey(file.value) === key && file.value) file.value = { ...file.value, duration }
  }

  function updatePlaylist(current: AudioTrack, siblings?: AudioTrack[]) {
    if (siblings) {
      const tracks = new Map<string, AudioTrack>()
      for (const sibling of siblings) {
        const key = audioTrackKey(sibling)
        if (key && isAudioTrack(sibling)) tracks.set(key, sibling)
      }
      const key = audioTrackKey(current)
      if (key && tracks.has(key)) {
        tracks.set(key, { ...tracks.get(key)!, ...current })
      } else if (key && isAudioTrack(current)) {
        tracks.set(key, current)
      }
      playlist.value = [...tracks.values()]
    } else if (!playlist.value.some(track => audioTrackKey(track) === audioTrackKey(current))) {
      playlist.value = audioTrackKey(current) && isAudioTrack(current) ? [current] : []
    }
  }

  async function play(f: AudioTrack, siblings?: AudioTrack[]) {
    updatePlaylist(f, siblings)
    const key = audioTrackKey(f)
    if (!key) return
    if (audioTrackKey(file.value) === key) return
    bc.postMessage('playing')
    revoke()
    file.value    = f
    loading.value = true
    error.value   = null
    const requestEpoch = getAccountBoundaryEpoch()
    try {
      // 交给原生 audio 直接请求流地址，让浏览器自行使用 Range，避免把大文件
      // 一次性聚合成 Blob 后才开始播放。
      const url = f.workspaceFile ? pathFiles.contentUrl(f.workspaceFile)
        : f.filePath ? (await filesApi.getStreamUrl(f.filePath)).url : (() => { throw new Error('文件路径不可用') })()
      if (requestEpoch !== getAccountBoundaryEpoch() || audioTrackKey(file.value) !== key) return
      blobUrl.value = url
    } catch (e) {
      error.value = e instanceof Error ? e.message : String(e)
    } finally {
      loading.value = false
    }
  }

  // 刷新后恢复：从 localStorage 读文件信息并重新拉取 blob
  async function restore() {
    if (file.value) return
    try {
      const saved = JSON.parse(localStorage.getItem(AUDIO_FILE_KEY) ?? 'null')
      if (!audioTrackKey(saved)) { localStorage.removeItem(AUDIO_FILE_KEY); return }
      const requestEpoch = getAccountBoundaryEpoch()
      try {
        const path = saved.workspaceFile ?? (saved.filePath ? (await filesApi.location(saved.filePath)).pathFile : null)
        if (!path) throw new Error('文件路径不可用')
        const parent = path.relativePath.split('/').slice(0, -1).join('/')
        const entries = await pathFiles.entries(path.directoryId, parent)
        if (requestEpoch !== getAccountBoundaryEpoch()) return
        const siblings: AudioTrack[] = entries.filter(entry => entry.kind === 'file').map(entry => {
          const dot = entry.name.lastIndexOf('.')
          return { displayName: dot > 0 ? entry.name.slice(0, dot) : entry.name,
            ext: dot > 0 ? entry.name.slice(dot + 1) : '', workspaceFile: { directoryId: path.directoryId, relativePath: entry.relativePath } }
        }).filter(isAudioTrack)
        const current = { ...saved, workspaceFile: path }
        if (isAudioTrack(current) && !siblings.some(candidate => audioTrackKey(candidate) === audioTrackKey(current))) siblings.unshift(current)
        await play(current, siblings)
      } catch {
        if (requestEpoch === getAccountBoundaryEpoch()) await play(saved)
      }
    } catch { /* 存储数据损坏则忽略 */ }
  }

  async function loadTrackDuration(track: AudioTrack): Promise<void> {
    const trackId = audioTrackKey(track)
    if (!trackId || track.duration) return
    if (playlist.value.find(candidate => audioTrackKey(candidate) === trackId)?.duration) return
    if (!playlist.value.some(candidate => audioTrackKey(candidate) === trackId)) return
    const requestEpoch = getAccountBoundaryEpoch()
    const requestKey = `${requestEpoch}:${trackId}`
    const existing = durationLoads.get(requestKey)
    if (existing) return existing

    const task = (async () => {
      let probe: HTMLAudioElement | null = null
      try {
        const url = track.workspaceFile ? pathFiles.contentUrl(track.workspaceFile)
          : track.filePath ? (await filesApi.getStreamUrl(track.filePath)).url : (() => { throw new Error('文件路径不可用') })()
        if (!url || requestEpoch !== getAccountBoundaryEpoch() || !playlist.value.some(candidate => audioTrackKey(candidate) === trackId)) return
        probe = new Audio()
        probe.preload = 'metadata'
        const duration = await new Promise<number>((resolve, reject) => {
          let timeout = 0
          const cleanup = () => {
            window.clearTimeout(timeout)
            probe?.removeEventListener('loadedmetadata', onLoaded)
            probe?.removeEventListener('error', onError)
          }
          const onLoaded = () => { cleanup(); resolve(probe?.duration ?? 0) }
          const onError = () => { cleanup(); reject(new Error('Audio metadata unavailable')) }
          timeout = window.setTimeout(() => { cleanup(); reject(new Error('Audio metadata timeout')) }, 15000)
          probe!.addEventListener('loadedmetadata', onLoaded, { once: true })
          probe!.addEventListener('error', onError, { once: true })
          probe!.src = url
          probe!.load()
        })
        if (requestEpoch === getAccountBoundaryEpoch() && playlist.value.some(candidate => audioTrackKey(candidate) === trackId)) {
          updateDuration(trackId, duration)
        }
      } catch {
        // Track duration is optional metadata; a failed lookup must not interrupt playback.
      } finally {
        if (probe) {
          probe.removeAttribute('src')
          probe.load()
        }
      }
    })()

    durationLoads.set(requestKey, task)
    try { await task } finally { durationLoads.delete(requestKey) }
  }

  async function loadPlaylistDurations() {
    const pending = playlist.value.filter(track => audioTrackKey(track) && !track.duration)
    // Limit concurrent metadata requests so opening a large directory does not fan out
    // an unbounded burst of signed-URL requests and media connections.
    let cursor = 0
    const workers = Array.from({ length: Math.min(3, pending.length) }, async () => {
      while (cursor < pending.length) {
        const track = pending[cursor++]
        await loadTrackDuration(track)
      }
    })
    await Promise.all(workers)
  }

  function stepTrack(offset: number) {
    if (playlist.value.length < 2 || !audioTrackKey(file.value)) return
    const index = playlist.value.findIndex(track => audioTrackKey(track) === audioTrackKey(file.value))
    if (index < 0) return
    const nextIndex = (index + offset + playlist.value.length) % playlist.value.length
    void play(playlist.value[nextIndex])
  }

  function playRandomTrack() {
    if (playlist.value.length < 2 || !audioTrackKey(file.value)) return
    const candidates = playlist.value.filter(track => audioTrackKey(track) !== audioTrackKey(file.value))
    const next = candidates[Math.floor(Math.random() * candidates.length)]
    if (next) void play(next)
  }

  function cyclePlaybackMode(): AudioPlaybackMode {
    const currentIndex = PLAYBACK_MODES.indexOf(playbackMode.value)
    playbackMode.value = PLAYBACK_MODES[(currentIndex + 1) % PLAYBACK_MODES.length]
    return playbackMode.value
  }

  function previousTrack() { stepTrack(-1) }
  function nextTrack() {
    if (playbackMode.value === 'shuffle') playRandomTrack()
    else stepTrack(1)
  }

  function handleTrackEnded(): 'stop' | 'repeat' | 'next' {
    if (playbackMode.value === 'none') return 'stop'
    if (playbackMode.value === 'single' || playlist.value.length < 2) return 'repeat'
    nextTrack()
    return 'next'
  }

  function stop() {
    revoke()
    file.value    = null   // watch 会自动清除 localStorage
    playlist.value = []
    error.value   = null
    loading.value = false
  }

  return {
    file, playlist, blobUrl, loading, error, playbackMode,
    play, stop, restore, updateDuration, loadPlaylistDurations,
    previousTrack, nextTrack, cyclePlaybackMode, handleTrackEnded,
  }
})
