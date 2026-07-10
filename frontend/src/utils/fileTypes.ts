/**
 * 文件类型助手 · 单一来源
 *
 * 原先文件库（Files/index）、项目卡（ProjectModal）、总览文件面板（FilePanel）各自抄了一份
 * isImageExt / fileExtCategory / fileIconColor / fileListIcon，集合还彼此不一致。这里统一收口，
 * 各处 import 即可。集合一律取并集（哪边都不丢分类）。
 */
import {
  PhImage, PhFilmStrip, PhMusicNote, PhTable,
  PhPresentationChart, PhArchive, PhCode, PhFileText,
} from '@phosphor-icons/vue'

// 能出缩略图的图片类型（决定文件卡是否渲染 thumb 区）；与后端 thumb 生成支持的格式对齐
const IMAGE_EXTS = new Set(['jpg','jpeg','png','gif','webp','avif','bmp','svg','heic','heif'])

export function isImageExt(ext: string | null | undefined): boolean {
  return IMAGE_EXTS.has((ext || '').toLowerCase())
}

/** ext → 大类，用于选图标 / 模板分支。未知归 'doc'。 */
export function fileExtCategory(ext: string | null | undefined): string {
  const e = (ext || '').toLowerCase()
  if (['jpg','jpeg','png','gif','webp','svg','ico','bmp','avif','heic','heif','tif','tiff'].includes(e)) return 'image'
  if (['mp4','mov','avi','mkv','webm','wmv','flv','m4v'].includes(e))   return 'video'
  if (['mp3','wav','flac','aac','ogg','m4a','wma','opus'].includes(e))  return 'audio'
  if (['xls','xlsx','csv','ods','numbers'].includes(e))                 return 'sheet'
  if (['ppt','pptx','key','odp'].includes(e))                           return 'slide'
  if (['zip','rar','7z','tar','gz','bz2','xz'].includes(e))             return 'archive'
  if (['js','ts','jsx','tsx','vue','py','go','rs','java','cpp','c','cs','rb','swift','php','kt','dart','sh',
       'html','css','scss','less','xml','json','yaml','yml','toml','md','mdx','graphql'].includes(e)) return 'code'
  return 'doc'
}

/** ext → 图标主题色（文件卡 --fc-color / 列表图标）。pdf、doc 等单列以便区分。 */
export function fileIconColor(ext: string | null | undefined): string {
  const e = (ext || '').toLowerCase()
  if (['jpg','jpeg','png','gif','webp','svg','ico','bmp','avif','heic','heif'].includes(e)) return '#b07858'
  if (['mp4','mov','avi','mkv','webm','wmv'].includes(e)) return '#8868a0'
  if (['mp3','wav','flac','aac','ogg','m4a'].includes(e)) return '#a07088'
  if (['pdf'].includes(e))                               return '#a85858'
  if (['doc','docx','rtf','odt'].includes(e))            return '#5078a8'
  if (['xls','xlsx','csv','ods'].includes(e))            return '#508870'
  if (['ppt','pptx','key','odp'].includes(e))            return '#a07840'
  if (['zip','rar','7z','tar','gz'].includes(e))         return '#808888'
  if (['js','ts','jsx','tsx','vue','py','go','rs','java','cpp','c'].includes(e)) return '#688858'
  if (['html','css','scss','json','yaml','xml','md'].includes(e)) return '#508898'
  return '#8888a8'
}

/** ext → 列表/大图标组件（Phosphor）。 */
export function fileListIcon(ext: string | null | undefined) {
  const cat = fileExtCategory(ext)
  if (cat === 'image')   return PhImage
  if (cat === 'video')   return PhFilmStrip
  if (cat === 'audio')   return PhMusicNote
  if (cat === 'sheet')   return PhTable
  if (cat === 'slide')   return PhPresentationChart
  if (cat === 'archive') return PhArchive
  if (cat === 'code')    return PhCode
  return PhFileText
}
