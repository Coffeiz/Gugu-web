import { createHash } from 'node:crypto'
import { strip } from '@gugu/core/shared/values'
import type {VendorMediaSource} from '@gugu/core/providers'
import type { Pool } from 'pg'
import { openLocalFile } from '@gugu/fs/node'
import { imageSize } from 'image-size'
import { assertDurableCanonical, formatGroupMessage, formatQuotedContext, resolveCurrentTurnTextAttachments, stableJson,
  type Block, type CanonicalMessage, type ContextReferenceCodec, type CurrentTurnSources, type CurrentUser, type Json, type MessageEntry, type RunIdentity } from '@gugu/core/agent'
import { createCurrentMessageAttachmentReader } from '../../../agent/context/attachments.js'
import type { OwnedCurrentMessage } from '../../../agent/context/source.js'
import { isOwnedFileStorageKey, normalizeFileOwnerId } from '../../../files/store.js'
import { imAttachmentScopeKey, type ImAttachmentScope } from './attachments.js'
import type {ImNativeVoiceTranscript} from '../media/voice.js'

export class ImMessageMaterializationError extends Error {
  constructor() { super('IM 消息上下文无法恢复'); this.name = 'ImMessageMaterializationError' }
}
/** 独立ASR确实未配置；由正式Runner准备入口投影为voice_unsupported early exit。 */
export class ImVoiceUnavailableError extends Error {
  constructor() { super('当前未配置可用的语音识别模型'); this.name = 'ImVoiceUnavailableError' }
}
export interface ImAudioInput { bytes: Uint8Array; mime: string; ext: string; duration: number | null; attachId: string }
export interface ImVideoInput extends VendorMediaSource {
  attachId:string
  assertCurrent(signal?:AbortSignal):Promise<void>
  digest(signal?:AbortSignal):Promise<string>
}
interface MessageRow {
  id: string; content: string; content_json: unknown; files: unknown; quoted_text: string | null
  platform_user_id: string; platform_user_name: string | null; message_ms: string
}
interface MediaRow extends Record<string, unknown> {
  attach_id: string; name: string; ext: string; mime: string | null; kind: string; size: string | number
  storage_key: string; extra: Record<string, unknown> | null; message_id: number; duration: number | null
}
const sameIdentity = (left: RunIdentity, right: RunIdentity) => left.ownerId === right.ownerId && left.sessionId === right.sessionId && left.runId === right.runId
const positive = (value: string) => /^[1-9]\d*$/.test(value) && Number.isSafeInteger(Number(value)) && Number(value) <= 2_147_483_647
const imageMimes: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' }

/** 读取真实已claim锚点；currentUsers只代表当前输入，正式source loader继续读取完整历史。 */
export function createImMessageMaterializer(options: {
  pool: Pick<Pool, 'query'>
  storageRoot: string
  identity: RunIdentity
  scope: ImAttachmentScope
  /** 按本段业务顺序传入；不可按数据库ID/历史seq重新排序。最后一项为dispatch.userMessageId。 */
  messageIds: readonly string[]
  timezone: string
  formatMessageTime(timestamp: number, timezone: string): string
  /** 每次materialize/hydrate/dehydrate前用当前Bot、actor、账户状态复核。 */
  authorize(signal?: AbortSignal): Promise<boolean>
  extractDocumentText?(bytes: Uint8Array, extension: string): Promise<string>
  /** 只处理发送模型的图片副本，稳定引用仍绑定原附件元数据。 */
  fitImage?(input:{bytes:Uint8Array;ext:string;mime?:string},signal:AbortSignal):Promise<{bytes:Uint8Array;mime:string;width:number;height:number}|null>
  prepareVideo?(input:ImVideoInput,signal?:AbortSignal):Promise<{block:Block|null;note:string}>
  /** 接真实Provider ASR链路；缺失时明确拒绝音频，不生成空转录或假媒体。 */
  transcribe?(input: ImAudioInput, signal?: AbortSignal): Promise<string | null>
  /** 仅当前真实模型/协议支持时返回音频块；null走独立ASR，不以模型名称猜测能力。 */
  nativeAudio?(input: ImAudioInput, signal?: AbortSignal): Promise<Block | null>
  /** 主模型仍接原生音频；此识别只用于附加展示，null表示未配置。 */
  transcribeNative?(input:ImAudioInput,signal?:AbortSignal):Promise<ImNativeVoiceTranscript|null>
  /** 引用语音必须经当前Run与原消息双证明；不能只凭quoted卡片/附件ID授权。 */
  assertQuotedAudio?(input: { messageId: string; attachId: string }, signal?: AbortSignal): Promise<void>
  persistTranscript?(messageId: string, transcript: string|null, status: 'completed' | 'empty' | 'failed', signal?: AbortSignal): Promise<void>
}) {
  const identity = Object.freeze({ ...options.identity }), scope = Object.freeze({ ...options.scope })
  const ids = [...options.messageIds], scopeKey = imAttachmentScopeKey(scope)
  if (normalizeFileOwnerId(identity.ownerId) !== scope.ownerId || !positive(identity.sessionId) || !identity.runId
    || !ids.length || ids.length > 128 || ids.some(id => !positive(id)) || new Set(ids).size !== ids.length || !options.timezone)
    throw new ImMessageMaterializationError()
  const texts = createCurrentMessageAttachmentReader({ pool: options.pool, storageRoot: options.storageRoot, extractDocumentText: options.extractDocumentText })
  const inlineReferences = new Map<string, Map<string,{messageId:string;reference:Block}>>()
  const fingerprint = (value: unknown) => createHash('sha256').update(stableJson(value)).digest('hex')
  function remember(block:Block,row:MediaRow){
    const key=fingerprint(block),references=inlineReferences.get(key)??new Map<string,{messageId:string;reference:Block}>()
    references.set(row.attach_id,{messageId:String(row.message_id),reference:ref(row)})
    inlineReferences.set(key,references)
  }
  async function authorize(signal?: AbortSignal) { signal?.throwIfAborted(); if (!await options.authorize(signal)) throw new ImMessageMaterializationError(); signal?.throwIfAborted() }
  async function media(attachId: string, signal?: AbortSignal): Promise<MediaRow> {
    const result = await options.pool.query<MediaRow>(`SELECT a.attach_id,a.name,a.ext,a.mime,a.kind,a.size,a.storage_key,a.extra,a.message_id,a.duration
      FROM chat_attachments a JOIN conversation_messages m ON m.id=a.message_id JOIN conversation_sessions s ON s.id=m.session_id
      WHERE a.user_id=$1 AND s.user_id=$1 AND s.id=$2 AND a.attach_id=$3 AND a.state='attached'
        AND a.platform=$4 AND a.extra->>'im_ingress_scope'=$5`, [identity.ownerId, identity.sessionId, attachId, scope.platform, scopeKey])
    signal?.throwIfAborted()
    if (result.rows.length !== 1) throw new ImMessageMaterializationError()
    const row = result.rows[0]!
    if (row.attach_id !== attachId || !isOwnedFileStorageKey(identity.ownerId, row.storage_key) || row.extra?.im_ingress_scope !== scopeKey)
      throw new ImMessageMaterializationError()
    return row
  }
  async function readBytes(row: MediaRow, maximum: number, signal?: AbortSignal): Promise<Uint8Array> {
    const size = Number(row.size)
    if (!Number.isSafeInteger(size) || size < 1 || size > maximum || !isOwnedFileStorageKey(identity.ownerId, row.storage_key)) throw new ImMessageMaterializationError()
    const file = await openLocalFile(options.storageRoot, row.storage_key)
    if (!file) throw new ImMessageMaterializationError()
    try {
      signal?.throwIfAborted()
      if (file.size !== size) throw new ImMessageMaterializationError()
      const bytes = await file.handle.readFile(); signal?.throwIfAborted()
      if (bytes.length !== size) throw new ImMessageMaterializationError()
      return bytes
    } finally { await file.handle.close() }
  }
  function ref(row: MediaRow): Block {
    return { type: 'attachment_ref', attach_id: row.attach_id, name: row.name, ext: row.ext, mime: row.mime, kind: row.kind, size_bytes: Number(row.size) }
  }
  async function image(row: MediaRow, signal?: AbortSignal): Promise<Block> {
    if(options.fitImage){
      await authorize(signal)
      const original=await readBytes(row,64*1024*1024,signal)
      let ext = row.ext
      // 旧 QQ 附件可能保留了转换前的文件后缀，核对实际格式和已记录的 MIME。
      if (scope.platform === 'qq' && imageMimes[ext.toLowerCase()] !== row.mime) {
        const detected = imageSize(original).type
        if (detected && imageMimes[detected] && imageMimes[detected] === row.mime) ext = detected
      }
      const fitted=await options.fitImage({bytes:original,ext,...(row.mime?{mime:row.mime}:{})},signal??new AbortController().signal)
      await authorize(signal)
      if(!fitted||!['image/jpeg','image/png','image/gif','image/webp','image/bmp','image/tiff'].includes(fitted.mime)
        ||!fitted.bytes.length||fitted.bytes.length>64*1024*1024||!Number.isSafeInteger(fitted.width)||!Number.isSafeInteger(fitted.height)
        ||fitted.width<1||fitted.height<1)throw new ImMessageMaterializationError()
      const block:Block={type:'image',source:{type:'base64',media_type:fitted.mime,data:Buffer.from(fitted.bytes).toString('base64')}}
      remember(block,row)
      return block
    }
    const mime = imageMimes[row.ext.toLowerCase()]
    if (!mime || row.mime !== mime) throw new ImMessageMaterializationError()
    const bytes = await readBytes(row, 8 * 1024 * 1024, signal)
    const size = imageSize(bytes)
    if (!size.width || !size.height || imageMimes[size.type ?? ''] !== mime) throw new ImMessageMaterializationError()
    const block: Block = { type: 'image', source: { type: 'base64', media_type: mime, data: Buffer.from(bytes).toString('base64') } }
    remember(block,row)
    return block
  }
  async function nativeAudio(row: MediaRow, signal?: AbortSignal): Promise<{block:Block;input:ImAudioInput}|null> {
    if (!options.nativeAudio || !row.mime) return null
    const bytes = await readBytes(row, 36 * 1024 * 1024, signal)
    const input={ bytes, mime: row.mime, ext: row.ext, duration: row.duration, attachId: row.attach_id }
    const block = await options.nativeAudio(input, signal)
    await authorize(signal)
    if (block) remember(block,row)
    return block?{block,input}:null
  }
  async function video(row:MediaRow,signal?:AbortSignal):Promise<{block:Block|null;note:string}>{
    await authorize(signal)
    if(!options.prepareVideo)return{block:null,note:'（当前入口未启用视频理解，视频未发送给模型。）'}
    const size=Number(row.size),signature=fingerprint(row)
    const mime=({mp4:'video/mp4',mov:'video/quicktime',avi:'video/x-msvideo',wmv:'video/x-ms-wmv',mkv:'video/x-matroska'} as Record<string,string>)[row.ext.toLowerCase()]??row.mime
    if(!Number.isSafeInteger(size)||size<1||size>512*1024*1024||!mime||!/^video\/[\w.+-]+$/u.test(mime))throw new ImMessageMaterializationError()
    const statKey=(s:{dev:bigint;ino:bigint;size:bigint;mtimeNs:bigint;ctimeNs:bigint})=>[s.dev,s.ino,s.size,s.mtimeNs,s.ctimeNs].join(':')
    const first=await openLocalFile(options.storageRoot,row.storage_key);if(!first)throw new ImMessageMaterializationError()
    let original:string
    try{if(first.size!==size)throw new ImMessageMaterializationError();original=statKey(await first.handle.stat({bigint:true}))}finally{await first.handle.close()}
    let digest:string|null=null,changed=false
    async function assertCurrent(currentSignal?:AbortSignal){
      await authorize(currentSignal)
      if(changed||fingerprint(await media(row.attach_id,currentSignal))!==signature)throw new ImMessageMaterializationError()
      const file=await openLocalFile(options.storageRoot,row.storage_key);if(!file)throw new ImMessageMaterializationError()
      try{if(statKey(await file.handle.stat({bigint:true}))!==original)throw new ImMessageMaterializationError()}finally{await file.handle.close()}
    }
    async function* stream(){
      await assertCurrent(signal)
      const file=await openLocalFile(options.storageRoot,row.storage_key);if(!file)throw new ImMessageMaterializationError()
      try{
        const hash=createHash('sha256');let position=0
        while(position<size){await authorize(signal);const buffer=Buffer.allocUnsafe(Math.min(512*1024,size-position));const read=await file.handle.read(buffer,0,buffer.length,position)
          if(read.bytesRead!==buffer.length)throw new ImMessageMaterializationError();position+=read.bytesRead;hash.update(buffer);yield buffer}
        if(statKey(await file.handle.stat({bigint:true}))!==original)throw new ImMessageMaterializationError()
        const actual=hash.digest('hex');if(digest!==null&&digest!==actual){changed=true;throw new ImMessageMaterializationError()}digest=actual
      }finally{await file.handle.close()}
      await assertCurrent(signal)
    }
    const result=await options.prepareVideo({name:row.name,mime,size,attachId:row.attach_id,stream,assertCurrent,
      async digest(currentSignal){await assertCurrent(currentSignal);if(digest===null)for await(const _chunk of stream()){/* 有界摘要，不聚合原视频。 */}await assertCurrent(currentSignal);return digest!}},signal)
    await assertCurrent(signal)
    if(!result||typeof result.note!=='string'||!result.note||result.note.length>2000||result.block!==null&&!['video','video_url'].includes(String(result.block.type)))throw new ImMessageMaterializationError()
    if(result.block)remember(result.block,row)
    return result
  }
  async function materialize(target: RunIdentity, message: OwnedCurrentMessage, signal?: AbortSignal): Promise<CurrentTurnSources> {
    try {
      if (!sameIdentity(target, identity) || message.id !== ids.at(-1)) throw new ImMessageMaterializationError()
      await authorize(signal)
      const selected = await options.pool.query<MessageRow>(`SELECT m.id::text,m.content,m.content_json,m.files,m.quoted_text,m.platform_user_id,m.platform_user_name,
        COALESCE(m.im_platform_sent_ms,m.im_event_received_ms,(extract(epoch FROM m.created_at)*1000)::bigint)::text AS message_ms
        FROM conversation_messages m JOIN conversation_sessions s ON s.id=m.session_id
        JOIN gugu_im_inbound_receipts r ON r.message_id=m.id AND r.user_id=s.user_id AND r.session_id=s.id
        WHERE s.user_id=$1 AND s.id=$2 AND m.id=ANY($3::integer[]) AND m.role='user' AND m.run_id=$4
          AND r.run_id=$4 AND r.state='dispatched' AND r.platform=$5 AND r.bot_id=$6 AND r.chat_type=$7
          AND m.chat_type=$7 AND ($7='group' AND s.chat_id=$8 AND s.source=$5 AND s.bot_id=$6 AND s.chat_type='group'
            OR $7='c2c' AND m.platform_user_id=$9)`,
      [identity.ownerId, identity.sessionId, ids, identity.runId, scope.platform, scope.botId, scope.chatType, scope.chatId, scope.platformUserId])
      signal?.throwIfAborted()
      const byId = new Map(selected.rows.map(row => [row.id, row]))
      if (selected.rows.length !== ids.length || byId.size !== ids.length || ids.some(id => !byId.has(id))) throw new ImMessageMaterializationError()
      const users: CurrentUser[] = []
      for (const id of ids) {
        const row = byId.get(id)!
        if (typeof row.content !== 'string' || row.content_json != null || !row.platform_user_id
          || row.quoted_text !== null && typeof row.quoted_text !== 'string' || row.files != null && !Array.isArray(row.files)) throw new ImMessageMaterializationError()
        const cards = (row.files ?? []) as unknown[]
        if (cards.length > 100 || cards.some(card => !card || typeof card !== 'object' || typeof (card as Record<string, unknown>).attach_id !== 'string')) throw new ImMessageMaterializationError()
        const resolved = await texts(identity.ownerId, id, cards)
        if (resolved.attachments.length !== cards.length) throw new ImMessageMaterializationError()
        const checked: MediaRow[] = []
        for (const attachment of resolved.attachments) {
          const owned = await media(attachment.attach_id, signal)
          if (Number(owned.message_id) !== Number(id)) throw new ImMessageMaterializationError()
          checked.push(owned)
        }
        const extracted = new Map<string, string>()
        for (const attachment of resolved.attachments.filter(item => item.kind === 'text' && Number(item.size) <= 32 * 1024 * 1024)) {
          signal?.throwIfAborted()
          // 先在Host完成真实读取；不能让Core兼容性的空文本回落掩盖权限/存储/提取器缺失。
          extracted.set(attachment.attach_id, await resolved.readText(attachment))
        }
        let text = (await resolveCurrentTurnTextAttachments(row.content, resolved.attachments,
          async attachment => extracted.get(attachment.attach_id)!)).rawText
        const blocks: Block[] = []
        const transcripts: ImNativeVoiceTranscript[] = []
        const quotedTranscripts: string[] = []
        const nativeCaptionEnabled=checked.some(item=>item.kind==='voice'&&item.extra?.quoted!==true)
        for (const attachment of checked) {
          if (attachment.kind === 'image') blocks.push(await image(attachment, signal))
          else if (attachment.kind === 'audio' || attachment.kind === 'voice') {
            const quoted = attachment.extra?.quoted === true
            if (quoted) {
              if (!options.assertQuotedAudio) throw new ImMessageMaterializationError()
              await options.assertQuotedAudio({ messageId: id, attachId: attachment.attach_id }, signal)
              await authorize(signal)
            }
            const native = await nativeAudio(attachment, signal)
            if (native) {
              if(options.transcribeNative&&(nativeCaptionEnabled||quoted&&attachment.kind==='voice')){
                const caption=await options.transcribeNative(native.input,signal)
                await authorize(signal)
                if(caption){
                  if(!['completed','empty','failed'].includes(caption.status)||caption.text!==null&&(typeof caption.text!=='string'||caption.text.length>200_000))throw new ImMessageMaterializationError()
                  if(quoted){if(caption.status==='completed'&&caption.text&&strip(caption.text))quotedTranscripts.push(`（引用消息的语音内容：）${strip(caption.text)}`)}
                  else transcripts.push(caption)
                }
              }
              if (quoted) await options.assertQuotedAudio!({ messageId: id, attachId: attachment.attach_id }, signal)
              blocks.push(native.block); continue
            }
            if (!options.transcribe || !attachment.mime) throw new ImMessageMaterializationError()
            const bytes = await readBytes(attachment, 50 * 1024 * 1024, signal)
            const transcript = await options.transcribe({ bytes, mime: attachment.mime, ext: attachment.ext, duration: attachment.duration, attachId: attachment.attach_id }, signal)
            await authorize(signal)
            if (transcript === null) throw new ImVoiceUnavailableError()
            if (typeof transcript !== 'string' || transcript.length > 200_000) throw new ImMessageMaterializationError()
            if (quoted) {
              await options.assertQuotedAudio!({ messageId: id, attachId: attachment.attach_id }, signal)
              quotedTranscripts.push(`（引用消息的语音内容：）${strip(transcript) || '（引用消息包含一段语音，但这次没听清内容）'}`)
            } else {
              transcripts.push({text:strip(transcript),status:strip(transcript)?'completed':'empty'})
              text += `\n（用户发来语音，内容是：）${strip(transcript) || '（用户发来一段语音，但这次没听清内容）'}`
            }
          } else if (attachment.kind === 'video') {
            const result=await video(attachment,signal)
            if(attachment.extra?.quoted===true)quotedTranscripts.push('（引用消息的视频）'+result.note)
            else text+='\n'+result.note
            if(result.block){blocks.push(result.block);continue}
          }
          if (attachment.kind !== 'image') blocks.push(ref(attachment))
        }
        if (transcripts.length && options.persistTranscript) {
          await authorize(signal)
          const failed=transcripts.some(item=>item.status==='failed')
          const transcript=failed?null:transcripts.map(item=>item.status==='completed'&&item.text?strip(item.text):'').filter(Boolean).join('\n')
          await options.persistTranscript(id, transcript, failed?'failed':transcript?'completed':'empty', signal)
          await authorize(signal)
        }
        const quotedText = [row.quoted_text, ...quotedTranscripts].filter(Boolean).join('\n') || null
        const content = scope.chatType === 'group'
          ? formatGroupMessage({ body: text, senderId: row.platform_user_id, senderName: row.platform_user_name, quote: quotedText,
            attachmentIds: checked.map(item => item.attach_id) }) : formatQuotedContext(text, quotedText)
        const timestamp = Number(row.message_ms)
        if (!Number.isSafeInteger(timestamp) || timestamp <= 0) throw new ImMessageMaterializationError()
        const time = options.formatMessageTime(timestamp, options.timezone)
        if (typeof time !== 'string' || !time) throw new ImMessageMaterializationError()
        users.push({ persistedMessageId: id, rawText: row.content, messageTime: time,
          message: { role: 'user', content: [{ type: 'text', text: content }, ...blocks], _history_id: id,
            _history_envelope: { quote: quotedText ? { type: 'quote', text: quotedText } : null,
              sender: { id: row.platform_user_id, name: row.platform_user_name }, source: scope.platform,
              attachments: checked.map(ref) } } })
      }
      await authorize(signal)
      return ids.length === 1 ? { currentUser: users[0], currentUsersInHistory: false }
        : { currentUsers: users, currentUsersInHistory: false, query: users.map(user => user.rawText).join('\n') }
    } catch (error) { if (error instanceof ImVoiceUnavailableError) throw error; throw new ImMessageMaterializationError() }
  }
  function references(base: ContextReferenceCodec): ContextReferenceCodec {
    async function convert(entry: MessageEntry, target: { ownerId: string; sessionId: string }, hydrate: boolean, signal?: AbortSignal, batch = false): Promise<CanonicalMessage> {
      try {
        if (target.ownerId !== identity.ownerId || target.sessionId !== identity.sessionId) throw new ImMessageMaterializationError()
        if (!batch) await authorize(signal)
        signal?.throwIfAborted()
        const message = structuredClone(hydrate ? await base.hydrate(entry, target, signal) : entry.message)
        // 相同媒体字节不能代表附件身份。按可信消息锚点和原附件顺序匹配每次出现，
        // 不依赖异步读取完成顺序，也不向Provider媒体块添加私有标记。
        const occurrences=new Map<string,number>()
        const envelope=message._history_envelope
        const attachmentOrder=envelope&&typeof envelope==='object'&&!Array.isArray(envelope)?envelope.attachments:null
        const orderedIds=Array.isArray(attachmentOrder)?attachmentOrder.map(value=>value&&typeof value==='object'&&!Array.isArray(value)?value.attach_id:null):[]
        async function visit(value: Json): Promise<Json> {
          if (Array.isArray(value)) return Promise.all(value.map(visit))
          if (!value || typeof value !== 'object') return value
          if (!hydrate && ['image', 'input_audio','video','video_url'].includes(String(value.type))) {
            const key=fingerprint(value),registered=inlineReferences.get(key)
            const candidates=registered?[...registered.values()].filter(item=>message._history_id==null||item.messageId===String(message._history_id)):[]
            let stable:Block|undefined
            if(candidates.length===1)stable=candidates[0]!.reference
            else if(candidates.length>1){
              if(message._history_id==null||new Set(orderedIds).size!==orderedIds.length)throw new ImMessageMaterializationError()
              const ordered=candidates.map(item=>({item,index:orderedIds.indexOf(item.reference.attach_id)}))
              if(ordered.some(item=>item.index<0))throw new ImMessageMaterializationError()
              ordered.sort((left,right)=>left.index-right.index)
              const index=occurrences.get(key)??0;occurrences.set(key,index+1)
              stable=ordered[index]?.item.reference
              if(!stable)throw new ImMessageMaterializationError()
            }
            if (stable) { if (!batch) await media(String(stable.attach_id), signal); return stable }
          }
          if (hydrate && value.type === 'attachment_ref' && value.kind === 'image') {
            const owned = await media(String(value.attach_id), signal)
            return image(owned, signal)
          }
          if(hydrate&&value.type==='attachment_ref'&&value.kind==='video'){
            const owned=await media(String(value.attach_id),signal)
            return (await video(owned,signal)).block??value
          }
          if (hydrate && value.type === 'attachment_ref' && ['voice', 'audio'].includes(String(value.kind)) && options.nativeAudio) {
            const owned = await media(String(value.attach_id), signal)
            const quotedAudio = owned.extra?.quoted === true
            if (quotedAudio) {
              if (!options.assertQuotedAudio) throw new ImMessageMaterializationError()
              await options.assertQuotedAudio({ messageId: String(owned.message_id), attachId: owned.attach_id }, signal)
            }
            const block = await nativeAudio(owned, signal)
            if (quotedAudio) await options.assertQuotedAudio!({ messageId: String(owned.message_id), attachId: owned.attach_id }, signal)
            return block?.block ?? value
          }
          return Object.fromEntries(await Promise.all(Object.entries(value).map(async ([key, item]) => [key, await visit(item)])))
        }
        // 元数据内的稳定附件refs保持原样，只有真正Canonical正文参与媒体投影。
        message.content = await visit(message.content)
        if (batch) return message
        const projected = hydrate ? message : await base.dehydrate({ ...entry, message }, target, signal)
        if (!hydrate) assertDurableCanonical(projected)
        await authorize(signal)
        return projected
      } catch { throw new ImMessageMaterializationError() }
    }
    return {
      ...(base.dehydrateBatch && { async dehydrateBatch(entries, target, signal, timing) {
        const started = performance.now()
        const projected: MessageEntry[] = []
        for (const entry of entries)
          projected.push({ ...entry, message: await convert(entry, target, false, signal, true) })
        timing?.('project_im_media', performance.now() - started)
        return base.dehydrateBatch!(projected, target, signal, timing)
      } }),
      hydrate: (entry, target, signal) => convert(entry, target, true, signal), dehydrate: (entry, target, signal) => convert(entry, target, false, signal) }
  }
  return { materialize, references }
}
