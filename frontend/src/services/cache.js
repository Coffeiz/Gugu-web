import { ref, shallowRef } from 'vue'

const SS_KEY  = 'gugu_files_cache'
const VER_KEY = 'gugu_files_version'

function readSS() {
  try { return JSON.parse(sessionStorage.getItem(SS_KEY) ?? 'null') } catch { return null }
}
function writeSS(data) {
  try { sessionStorage.setItem(SS_KEY, JSON.stringify(data)) } catch {}
}

const _fileList = shallowRef(readSS())

export const filesCache = {
  get data() { return _fileList.value },
  ref: _fileList,
  set(data) { _fileList.value = data; writeSS(data) },
  clear()   { _fileList.value = null; try { sessionStorage.removeItem(SS_KEY) } catch {} },
}

// 上次已知的文件版本摘要（count:max_updated:max_deleted），模块级持久到 sessionStorage
export const filesCacheVersion = {
  get()    { try { return sessionStorage.getItem(VER_KEY) ?? null } catch { return null } },
  set(ver) { try { sessionStorage.setItem(VER_KEY, ver) } catch {} },
  clear()  { try { sessionStorage.removeItem(VER_KEY) } catch {} },
}

export const uploadSignal = ref(0)
// 日历事件变更信号（咕咕对话里增删改活动后 bump，日历页监听并清缓存重取）
export const calendarSignal = ref(0)
