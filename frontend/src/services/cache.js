import { ref, shallowRef } from 'vue'

const SS_KEY = 'gugu_files_cache'

function readSS() {
  try { return JSON.parse(sessionStorage.getItem(SS_KEY) ?? 'null') } catch { return null }
}
function writeSS(data) {
  try { sessionStorage.setItem(SS_KEY, JSON.stringify(data)) } catch {}
}

const _fileList = shallowRef(readSS())

export const filesCache = {
  get data() { return _fileList.value },
  ref: _fileList,                          // 响应式 ref，供 watch / computed 使用
  set(data) { _fileList.value = data; writeSS(data) },
  clear()   { _fileList.value = null; try { sessionStorage.removeItem(SS_KEY) } catch {} },
}

export const uploadSignal = ref(0)
