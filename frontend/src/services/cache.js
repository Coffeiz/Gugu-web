import { ref } from 'vue'

const SS_KEY = 'gugu_files_cache'

function readSS() {
  try { return JSON.parse(sessionStorage.getItem(SS_KEY) ?? 'null') } catch { return null }
}
function writeSS(data) {
  try { sessionStorage.setItem(SS_KEY, JSON.stringify(data)) } catch {}
}

export const filesCache = {
  data: readSS(),
  set(data) { this.data = data; writeSS(data) },
  clear()   { this.data = null; try { sessionStorage.removeItem(SS_KEY) } catch {} },
}

export const uploadSignal = ref(0)
