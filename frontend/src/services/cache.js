import { ref } from 'vue'
export const filesCache   = { data: null }   // Dashboard 文件面板缓存
export const uploadSignal = ref(0)           // 每次上传完成后 +1，各页面可 watch 触发刷新
