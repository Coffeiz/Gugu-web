import { defineStore } from 'pinia'
import { ref, watch } from 'vue'
import { getAccountBoundaryEpoch } from '@/utils/accountBoundary'
import { filesApi } from '@/services/api'

const AUDIO_FILE_KEY = 'gugu_audio_file'

const bc = new BroadcastChannel('gugu_audio')

interface AudioFile { id?: number; displayName?: string; ext?: string }

export const useAudioStore = defineStore('audio', () => {
  const file    = ref<AudioFile | null>(null)   // { id, displayName, ext }
  const blobUrl = ref<string | null>(null)
  const loading = ref(false)
  const error   = ref<string | null>(null)

  // 持久化当前文件信息（blob URL 不可持久化，只存元数据）
  watch(file, (f) => {
    if (f) localStorage.setItem(AUDIO_FILE_KEY, JSON.stringify(f))
    else   localStorage.removeItem(AUDIO_FILE_KEY)
  })

  function revoke() {
    if (blobUrl.value?.startsWith('blob:')) URL.revokeObjectURL(blobUrl.value)
    blobUrl.value = null
  }

  // 其他 tab 开始播放时，停掉本 tab
  bc.onmessage = () => stop()

  async function play(f: AudioFile) {
    if (f.id == null) return              // 没有文件 id 无法取流
    if (file.value?.id === f.id) return  // 同一首不重新加载
    bc.postMessage('playing')
    revoke()
    file.value    = f
    loading.value = true
    error.value   = null
    const requestEpoch = getAccountBoundaryEpoch()
    try {
      // 交给原生 audio 直接请求流地址，让浏览器自行使用 Range，避免把大文件
      // 一次性聚合成 Blob 后才开始播放。
      const { url } = await filesApi.getStreamUrl(f.id)
      if (requestEpoch !== getAccountBoundaryEpoch() || file.value?.id !== f.id) return
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
      if (saved?.id) await play(saved)
    } catch { /* 存储数据损坏则忽略 */ }
  }

  function stop() {
    revoke()
    file.value    = null   // watch 会自动清除 localStorage
    error.value   = null
    loading.value = false
  }

  return { file, blobUrl, loading, error, play, stop, restore }
})
