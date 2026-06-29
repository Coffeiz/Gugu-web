import { defineStore } from 'pinia'
import { ref, watch } from 'vue'

const AUDIO_FILE_KEY = 'gugu_audio_file'

const bc = new BroadcastChannel('gugu_audio')

export const useAudioStore = defineStore('audio', () => {
  const file    = ref(null)   // { id, displayName, ext }
  const blobUrl = ref(null)
  const loading = ref(false)
  const error   = ref(null)

  // 持久化当前文件信息（blob URL 不可持久化，只存元数据）
  watch(file, (f) => {
    if (f) localStorage.setItem(AUDIO_FILE_KEY, JSON.stringify(f))
    else   localStorage.removeItem(AUDIO_FILE_KEY)
  })

  function revoke() {
    if (blobUrl.value) { URL.revokeObjectURL(blobUrl.value); blobUrl.value = null }
  }

  // 其他 tab 开始播放时，停掉本 tab
  bc.onmessage = () => stop()

  async function play(f) {
    if (file.value?.id === f.id) return  // 同一首不重新加载
    bc.postMessage('playing')
    revoke()
    file.value    = f
    loading.value = true
    error.value   = null
    try {
      const BASE_URL = import.meta.env.VITE_API_URL ?? '/api/v1'
      const token    = localStorage.getItem('user_token') ?? ''
      const res = await fetch(`${BASE_URL}/files/${f.id}/download`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      blobUrl.value = URL.createObjectURL(await res.blob())
    } catch (e) {
      error.value = e.message
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
