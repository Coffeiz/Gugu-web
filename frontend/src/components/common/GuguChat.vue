<template>
  <!-- 迷你播放器 -->
  <Transition name="mini-player">
    <div v-if="audioStore.file && (miniPinned || open)" class="mini-player" :style="miniPlayerStyle" ref="playerRef">
      <div class="mp-info">
        <span class="mp-bars" :class="{ 'mp-bars--playing': barsPlaying }" ref="barsRef"><i v-for="n in 4" :key="n" /></span>
        <span class="mp-name">{{ audioStore.file.displayName }}.{{ audioStore.file.ext?.toLowerCase() }}</span>
        <div class="btn-group">
          <button class="mp-btn mp-btn--pin" :class="{ 'mp-btn--pinned': miniPinned }"
                  @click="miniPinned = !miniPinned" :title="miniPinned ? '取消固定' : '固定'">
            <PhPushPin v-if="miniPinned" :size="14" weight="fill" />
            <PhPushPinSlash v-else :size="14" weight="regular" />
          </button>
          <button class="mp-btn mp-btn--close popup-close-btn" @click="audioStop" title="关闭">
            <PhX weight="bold" :size="13" />
          </button>
        </div>
      </div>
      <div class="mp-seek-row">
        <span class="mp-time">{{ fmtTime(audioCurrent) }}</span>
        <div class="mp-track" @click="audioSeek" @mousedown="audioStartDrag">
          <div class="mp-fill" :style="{ width: audioSeekPct + '%' }" />
          <div class="mp-thumb" :style="{ left: audioSeekPct + '%' }" />
        </div>
        <span class="mp-time">{{ fmtTime(audioDuration) }}</span>
      </div>
      <div class="mp-controls">
        <div class="mp-vol-spacer" />
        <button class="mp-btn mp-btn--play" @click="audioToggle">
          <PhPlay  v-if="!audioPlaying" weight="fill" :size="16" />
          <PhPause v-else               weight="fill" :size="16" />
        </button>
        <div class="mp-vol-group">
          <button class="mp-vol-btn" @click="audioToggleMute">
            <PhSpeakerHigh  v-if="!audioMuted && audioVolume > 0.5" weight="fill" :size="14" />
            <PhSpeakerLow   v-else-if="!audioMuted && audioVolume > 0" weight="fill" :size="14" />
            <PhSpeakerSlash v-else weight="fill" :size="14" />
          </button>
          <input class="mp-vol-slider" type="range" min="0" max="1" step="0.02" :value="audioVolume" @input="audioSetVolume" />
        </div>
      </div>
    </div>
  </Transition>

  <audio
    ref="audioEl"
    :src="audioStore.blobUrl ?? undefined"
    @timeupdate="audioCurrent = audioEl?.currentTime ?? 0"
    @durationchange="audioDuration = audioEl?.duration || 0"
    @play="audioPlaying = true"
    @pause="onAudioPause"
    @ended="onAudioEnded"
    @canplay="onCanPlay"
  />

  <!-- 悬浮球 -->
  <button class="ai-fab" :class="{ 'ai-fab--playing': rippleActive }" :style="{ zIndex: fabZ }" ref="fabRef" @click="toggleOpen" title="咕咕">
    <svg ref="fabSvgRef"
         :class="{ 'ai-fab-spin': audioStore.file && !spinningBack, 'ai-fab--typing': fabJumping }"
         :style="audioStore.file && !spinningBack ? { animationPlayState: audioPlaying ? 'running' : 'paused' } : {}"
         width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">
      <path d="M16 7h.01"/>
      <path d="M3.4 18H12a8 8 0 0 0 8-8V7a4 4 0 0 0-7.28-2.3L2 20"/>
      <path d="M20 7l2 .5-2 .5"/>
      <path d="M10 18v3"/>
      <path d="M14 17.75V21"/>
    </svg>
  </button>

  <!-- 聊天窗口（单一元素，小/大状态通过位置过渡） -->
  <Transition name="chat-open" @after-leave="chatClosing = false">
    <!-- win-grow 排除 resizing：大/小窗位形切换的瞬间 .chat-window 的 top 还需要 0.42s 缓动做纵向过渡，
         一旦带上 win-grow 会把 top 的 transition 撤掉，窗口会瞬间从大窗高跳到小窗高（横轴仍走缓动，纵轴跳一下）。
         resizing 在 _markResizing() / 过渡结束 / 600ms 兜底 时机清掉，回归流式 top 即时跟随。 -->
    <div v-if="open" class="chat-window" :class="{ 'win-grow': streaming && !expanded && !resizing }" :style="windowStyle" ref="windowRef"
      @mousedown.capture="raiseChat"
      @dragenter="onChatDragEnter" @dragover="onChatDragOver" @dragleave="onChatDragLeave" @drop="onChatDrop">

      <!-- 拖入遮罩（覆盖整个窗口，大小窗通用）-->
      <Transition name="chat-drop-fade">
        <div v-if="isChatDragging" class="chat-drop-overlay">
          <svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
            <path d="M12 16V6M8 10l4-4 4 4"/><path d="M5 19h14"/>
          </svg>
          <span>松开以添加附件</span>
        </div>
      </Transition>

      <!-- 扫码绑定 IM 弹窗：咕咕回复里点 [扫码绑定…](gugu://bind-im/<platform>) 按钮触发，复用现有连接 API -->
      <Transition name="chat-drop-fade">
        <div v-if="chatBind.open" class="cb-overlay" @click.self="closeChatBind">
          <div class="cb-modal popup-menu">
            <div class="cb-title">扫码绑定{{ chatBind.label }}</div>
            <canvas ref="chatBindCanvas" class="cb-qr"></canvas>
            <div v-if="chatBind.err" class="cb-err">{{ chatBind.err }}</div>
            <div v-else class="cb-hint">{{ chatBind.hint || '生成二维码中…' }}</div>
            <button class="cb-cancel" @click="closeChatBind">取消</button>
          </div>
        </div>
      </Transition>


      <!-- 侧边栏（仅大窗） -->
      <div v-if="expanded" class="exp-sidebar panel-left">
        <div class="exp-sidebar-header">
          <span class="exp-sidebar-title">咕咕</span>
        </div>
        <div class="exp-sidebar-divider"></div>
        <div class="exp-session-list">
          <!-- IM 平台：飞书 / QQ / 微信，可展开抽屉。未接入 → 扫码连接；接入后 → 该平台会话 -->
          <div class="im-plat-group" ref="imGroupEl" :class="{ 'im-flash': imHighlight }">
          <div v-for="p in IM_PLATFORMS" :key="p.key" class="im-plat">
            <button class="im-plat-head" :class="{ open: imOpen[p.key] }" @click="toggleImPlatform(p.key)">
              <svg class="im-plat-chev" :class="{ open: imOpen[p.key] }" width="9" height="9" viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M2 3.5l3 3 3-3"/></svg>
              <span class="im-plat-name">{{ p.label }}</span>
              <span class="im-plat-badge" :class="{ on: botsOf(p.key).length }">{{ botsOf(p.key).length ? '已接入' : '未接入' }}</span>
            </button>
            <div v-show="imOpen[p.key]" class="im-plat-body">
              <!-- 已接入 → 该平台会话抽屉 -->
              <template v-if="botsOf(p.key).length">
                <div v-for="s in imSessionsOf(p.key)" :key="s.id"
                  class="exp-session-item" :class="{ active: s.id === sessionId }" @click="loadSession(s.id)">
                  <span v-if="s.chatType === 'group'" class="exp-session-tag" title="群聊">群</span>
                  <span class="exp-session-title">{{ s.title }}</span>
                  <button class="exp-session-del" @click.stop="deleteSession(s.id)" title="删除"><PhTrash :size="12" weight="bold" /></button>
                </div>
                <div v-if="!imSessionsOf(p.key).length" class="exp-session-empty">暂无对话</div>
              </template>
              <!-- 未接入 → 扫码连接 + 二维码抽屉 -->
              <template v-else>
                <div v-if="connect && connect.platform === p.key" class="im-qr-box">
                  <canvas :ref="setConnectCanvas" class="im-qr-canvas"></canvas>
                  <div class="im-qr-hint">{{ connectHint }}</div>
                  <button class="im-qr-cancel" @click="cancelImConnect">取消</button>
                </div>
                <template v-else>
                  <button class="im-connect-btn" :disabled="connecting === p.key" @click="startImConnect(p.key)">
                    {{ connecting === p.key ? '生成中…' : '扫码连接' }}
                  </button>
                  <div v-if="connectErr && connecting !== p.key" class="im-qr-err">{{ connectErr }}</div>
                </template>
              </template>
            </div>
          </div>
          </div><!-- /im-plat-group -->

          <!-- 网页对话 -->
          <div v-if="webSessions.length" class="exp-group-divider"></div>
          <div
            v-for="s in webSessions" :key="s.id"
            class="exp-session-item"
            :class="{ active: s.id === sessionId }"
            @click="loadSession(s.id)"
          >
            <span class="exp-session-title">{{ s.title }}</span>
            <button class="exp-session-del" @click.stop="deleteSession(s.id)" title="删除">
              <PhTrash :size="12" weight="bold" />
            </button>
          </div>
        </div>
        <div class="exp-sidebar-divider" style="margin: 0 12px"></div>
        <div class="exp-new-session-wrap">
          <button class="exp-new-session-btn" @click="newSession">
            <PhPencilSimple weight="bold" :size="13" />
            新对话
          </button>
        </div>
      </div>

      <!-- 主区域（始终存在，消息列表永不销毁） -->
      <div class="chat-main" :class="{ 'is-expanded': expanded, 'is-resizing': resizing }">
        <div class="chat-header">
          <span class="chat-title">{{ expanded ? currentSessionTitle : '咕咕' }}</span>
          <span class="popup-status" :class="'is-' + presenceKind"
                @click="presenceKind === 'offline' && promptConnectIM()"
                :title="presenceTitle">
            <em class="status-dot" />{{ presenceText }}
          </span>
          <div class="btn-group">
            <button v-if="!expanded" class="popup-icon-btn" @click="enterExpanded" title="展开">
              <PhArrowsOut weight="bold" :size="13" />
            </button>
            <button v-if="expanded" class="exp-icon-btn" @click="exitExpanded" title="收起">
              <PhArrowsIn weight="bold" :size="14" />
            </button>
            <button class="popup-close-btn" @click="closeChat">
              <PhX weight="bold" :size="13" />
            </button>
          </div>
        </div>

        <!-- 单一消息列表：真虚拟列表（@tanstack/vue-virtual），任何时刻只挂载视口 ± overscan
             内的消息 DOM，其余用下面这段按测量/估算高度撑出来的占位空间代替，滚动条始终代表
             整个会话的真实长度。messagesEl 是真实可滚动容器，虚拟列表只管它内部挂多少 DOM。 -->
        <div class="chat-messages" ref="messagesEl">
          <div class="msg-virtual-spacer" :style="{ height: virtualTotalSize + 'px' }">
            <!-- v-memo：同一帧内其它消息在变（比如正在流式输出的那条）时，跳过这一行没变的
                 子树重新生成——虚拟列表已经把同时挂载的行数摁在个位数附近，这里收益比之前小，
                 但仍能省掉一趟不必要的 vnode diff。 -->
            <div v-for="{ row, msg } in rowsWithMsg" :key="row.index" :data-index="row.index" :ref="measureRow"
                 class="msg-virtual-row" :style="{ transform: `translateY(${row.start + msgsPadTop}px)` }">
              <div :class="['msg', msg.role]" :data-db-id="msg.dbId || ''"
                   v-memo="[msg.role, msg.speakerLabel, msg.text, msg.html, msg.streaming, msg.files?.length, msg.files?.map(f => `${f.file_id ?? ''}:${f.attach_id ?? ''}:${f.ext ?? ''}`).join(','), msg.quotedText, copiedId === msg.id, voicePlayingId && msg.files?.some(f => f.attach_id === voicePlayingId)]">
                <!-- 群聊左侧消息标发言人：ai 标"咕咕"，群成员标 platformUserName。只在
                     群聊会话里显示，1:1 对话左侧默认就是咕咕，不额外占地方。 -->
                <div v-if="isGroupSession && msg.role !== 'user'" class="msg-speaker">{{ msg.role === 'ai' ? '咕咕' : msg.speakerLabel }}</div>
                <!-- IM 引用/回复：单独一条浅色预览条，跟真正打的话分开显示，别把引用原文
                     （可能带 markdown 表格等）直接摊平混进正文气泡（devlog 2026-07-10）。 -->
                <div v-if="msg.role !== 'ai' && (msg.quotedText || msg.files?.some(f => f.quoted))" class="msg-quoted" :title="msg.quotedText || '引用的 QQ 表情'">
                  <span v-if="msg.quotedText">{{ displayQQFaces(msg.quotedText) }}</span>
                  <template v-for="f in (msg.files || []).filter(f => f.quoted)" :key="`quoted:${f.file_id || f.attach_id}`">
                    <img v-if="f.qq_face || isAnimatedImageFile(f)" class="msg-quoted-thumb msg-face-gif" v-lazy-face="f.file_id || f.attach_id" draggable="false" alt="引用图片" @click.stop="openFileFromChat(f)" />
                    <img v-else-if="f._thumbUrl" class="msg-quoted-thumb" :src="f._thumbUrl" draggable="false" alt="引用图片" @click.stop="openFileFromChat(f)" />
                    <img v-else-if="isImageFile(f)" class="msg-quoted-thumb" v-lazy-thumb="f.file_id || f.attach_id" draggable="false" alt="引用图片" @click.stop="openFileFromChat(f)" />
                  </template>
                </div>
                <div v-if="msg.role === 'ai' && (msg.text?.trim() || msg.streaming)" class="msg-bubble md-body" @click="onChatActionClick"><MarkdownView :html="msg.streaming ? renderMdStream(msg.text) : (msg.html ?? renderMd(msg.text))" :text="msg.text" chat /></div>
                <div v-else-if="msg.text" class="msg-bubble">{{ displayQQFaces(msg.text) }}</div>
                <div v-if="msg.files && msg.files.length" class="msg-files">
                  <template v-for="f in msg.files.filter(f => !f.quoted)" :key="f.file_id || f.attach_id">
                  <!-- 语音条：点一下播放（带鉴权拉 blob），不是文件卡 -->
                  <div v-if="f.kind === 'voice'" class="msg-voice" :class="{ playing: voicePlayingId === f.attach_id }"
                       @click="toggleVoice(f)" title="点击播放语音">
                    <span class="mv-btn">
                      <PhPause v-if="voicePlayingId === f.attach_id" weight="fill" :size="13" />
                      <PhPlay  v-else weight="fill" :size="13" />
                    </span>
                    <span class="mv-wave"><i v-for="n in 13" :key="n" :style="{ height: voiceBar(n) }" /></span>
                    <span class="mv-dur">{{ fmtDur(f.duration) }}</span>
                  </div>
                  <div v-else-if="f.qq_face" class="msg-face-image-wrap" @click="openFileFromChat(f)" title="点击查看表情">
                    <img class="msg-face-image" v-lazy-face="f.file_id || f.attach_id" draggable="false" alt="QQ表情" />
                  </div>
                  <div v-else class="msg-file press-fx" @click="openFileFromChat(f)" :title="canPreview(f) ? '点击预览' : '点击下载'">
                    <span class="msg-file-ext">
                      <template v-if="!f.qq_face">{{ (f.ext || 'file').toUpperCase().slice(0, 4) }}</template>
                      <template v-if="isImageFile(f)">
                        <img v-if="f._thumbUrl" class="msg-file-thumb" :src="f._thumbUrl"
                          draggable="false" alt="" @error="($event.target as HTMLElement).remove()" />
                        <img v-else class="msg-file-thumb" v-lazy-thumb="f.file_id || f.attach_id"
                          decoding="async" draggable="false" alt="" @error="($event.target as HTMLElement).remove()" />
                      </template>
                    </span>
                    <span class="msg-file-info">
                      <span v-if="!f.qq_face" class="msg-file-name">{{ f.name }}.{{ f.ext }}</span>
                      <span class="msg-file-meta">{{ fmtSize(f.size_bytes) }} · {{ canPreview(f) ? '预览' : '下载' }}</span>
                    </span>
                    <svg class="msg-file-dl" width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M8 2v8M5 7l3 3 3-3M3 13h10"/></svg>
                  </div>
                  </template>
                </div>
                <div class="msg-footer">
                  <span class="msg-time">{{ msg.time }}</span>
                  <button class="msg-copy-btn" @click="copyMsg(msg)" title="复制">
                    <PhCheck v-if="copiedId === msg.id" :size="11" weight="bold" />
                    <PhCopy  v-else :size="11" />
                  </button>
                </div>
              </div>
            </div>
          </div>
          <!-- 整个生成期只维持一枚状态气泡：状态切换时替换内容，不让气泡闪退重建。 -->
          <div v-if="statusKind" class="msg ai">
            <div class="msg-bubble status-pop"
                 :class="statusKind === 'dots' ? 'thinking' : 'tool-bubble'">
              <template v-if="statusKind === 'dots'"><span /><span /><span /></template>
              <template v-else>
                <span class="tool-spinner" />
                <span class="tool-label">{{ statusTyped }}</span>
              </template>
            </div>
          </div>
        </div>

        <!-- 输入框 -->
        <div v-if="pendingAtt.length || attUploading" class="chat-att-row">
          <div v-for="a in pendingAtt" :key="a.attach_id" class="chat-att-chip">
            <span class="chat-att-name">{{ a.name }}.{{ a.ext }}</span>
            <button class="chat-att-x" @click="removeAtt(a)" title="移除">×</button>
          </div>
          <span v-if="attUploading" class="chat-att-chip att-up">上传中…</span>
        </div>
        <div class="chat-input-row">
          <button v-if="!recording" class="att-btn" @click="pickFile" title="添加附件">
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M13 7l-5.5 5.5a2.5 2.5 0 0 1-3.5-3.5L9 3.5a1.5 1.5 0 0 1 2 2L5.5 11"/></svg>
          </button>
          <button v-if="!recording" class="att-btn" @click="startRecord" title="语音输入">
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="6" y="1.5" width="4" height="8" rx="2"/><path d="M3.5 7a4.5 4.5 0 0 0 9 0M8 11.5V14M5.5 14h5"/></svg>
          </button>
          <input ref="fileInput" type="file" multiple style="display:none" @change="onFilePicked" />
          <textarea
            v-if="!recording"
            v-model="inputText"
            ref="expInputEl"
            placeholder="问问项目进度、截止日期…"
            rows="1"
            v-enter.exact.prevent="() => send()"
            @input="autoResize"
            @paste="onPaste"
          />
          <div v-else class="rec-bar">
            <span class="rec-dot"></span>
            <span class="rec-time">{{ recordSecs }}″</span>
            <span class="rec-hint">录音中… 点 ✓ 发送</span>
            <button class="rec-cancel" @click="cancelRecord">取消</button>
          </div>
          <button class="send-btn" :class="{ 'exp-send-btn': expanded }" @click="recording ? stopRecord() : (streaming ? stopStreaming() : send())">
            <PhCheck      v-if="recording"  weight="bold" :size="expanded ? 14 : 13" />
            <PhArrowRight v-else-if="!streaming" weight="bold" :size="expanded ? 14 : 13" />
            <PhStop       v-else            weight="fill"  :size="expanded ? 14 : 13" />
          </button>
        </div>
      </div>

    </div>
  </Transition>
</template>

<script setup lang="ts">
import { ref, reactive, computed, watch, nextTick, onMounted, onUnmounted, type ComponentPublicInstance } from 'vue'
import { useRouter } from 'vue-router'
import { useVirtualizer } from '@tanstack/vue-virtual'
import QRCode from 'qrcode'
import { marked, type Tokens } from 'marked'
import hljs from 'highlight.js'
import { useAudioStore } from '@/stores/audio'
import { nextZ } from '@/composables/windowz'
import { useProjectStore } from '@/stores/projects'
import { useLiveStore } from '@/stores/live'
import { useUiStore } from '@/stores/ui'
import { usePreviewStore, isPreviewable } from '@/stores/preview'
import { agentApi, filesApi, trackApi, userBotsApi, qqConnectApi, feishuConnectApi, wechatConnectApi, authApi, CLIENT_ID } from '@/services/api'
import { getGreeting, greeting, prefetchGreeting } from '@/composables/useGreeting'
import { uploadSignal, calendarSignal } from '@/services/cache'
import { playGuguSfx } from '@/services/sfx'
import { getThumb, getCachedThumb, getThumbUrl, getCachedThumbUrl } from '@/composables/useThumbCache'
import MarkdownView from '@/components/common/MarkdownView.vue'

const API_BASE = import.meta.env.VITE_API_URL ?? '/api/v1'
import {
  PhPushPin, PhPushPinSlash, PhX, PhPlay, PhPause,
  PhSpeakerHigh, PhSpeakerLow, PhSpeakerSlash,
  PhArrowRight, PhStop, PhArrowsOut, PhArrowsIn,
  PhPencilSimple, PhTrash, PhCopy, PhCheck,
} from '@phosphor-icons/vue'

// 聊天气泡的完整字段集合（TS 转换新增）：字段来自不同代码路径按需附加（默认问候/流式回复/
// 历史消息回填/用户发送各自只带自己用得上的那几个），松散 interface 如实反映这个既有形状，
// 不强行收紧成必填。
interface ChatMessage {
  id: number
  dbId?: number
  role: string
  text: string
  html?: string | null
  files?: ChatFile[]
  quotedText?: string
  time: string
  streaming?: boolean
  // 群聊消息的发言人标注：ai 不用管；owner 自己发的不用管（右侧气泡不署名）；
  // 群里其他成员填 platformUserName，气泡渲染在左侧并显示这个名字。
  speakerLabel?: string
  platformUserId?: string | null
  _greeting?: boolean
  _greetAnimated?: boolean
  _greetFull?: string
}

// 聊天附件（暂存上传 attach_id / 已落库 file_id 两种来源共用的松散形状，字段来自不同
// 代码路径按需附加，参见 ChatMessage 顶部注释同理）
interface ChatFile {
  file_id?: number
  attach_id?: string
  name?: string
  ext?: string
  size?: number
  size_bytes?: number
  kind?: string
  mime?: string
  qq_face?: boolean
  quoted?: boolean
  duration?: number
  upload?: boolean
  _thumbUrl?: string
  img_width?: number
  img_height?: number
}

interface ChatSession {
  id: number
  title: string
  source?: string
  chatType?: string
}

interface Bot {
  id?: number
  platform: string
  enabled: boolean
}

interface QuotaInfo {
  limit_6h?: number | null
  used_6h?: number
  limit_weekly?: number | null
  used_weekly?: number
}

interface ImConnectState {
  platform: string
  id: string | number
}

const SMALL_W   = 360
const SMALL_H   = 360
const SIDEBAR_W = 220

const audioStore    = useAudioStore()
const projectStore  = useProjectStore()
const liveStore     = useLiveStore()
const uiStore       = useUiStore()
const router        = useRouter()

// 顶栏全局搜索点「对话」结果 / 笔记里点「@对话」引用卡片：打开聊天面板并切到该会话。
// 不强制展开大窗——默认保持小窗，用户已经开着大窗才维持大窗；对话引用现在锚定的是
// 具体一条消息（见 useMindRefActions.ts），靠 _flashChatMessage 在消息列表里定位闪烁，
// 小窗一样看得见，不需要靠「大窗侧边栏 .active 高亮」这条路。
watch(() => uiStore.pendingChatSession, async (id) => {
  if (!id) return
  open.value = true
  await loadSession(id as number)
  const msgId = uiStore.pendingChatMessageId
  uiStore.pendingChatSession = null
  uiStore.pendingChatMessageId = null
  if (msgId) { await _revealMessage(msgId); _flashChatMessage(msgId) }
})

function _flashChatMessage(dbId: number) {
  setTimeout(() => {
    const el = messagesEl.value?.querySelector(`[data-db-id="${dbId}"]`)
    if (!el) return
    el.scrollIntoView({ behavior: 'smooth', block: 'center' })
    el.classList.add('msg-search-flash')
    setTimeout(() => el.classList.remove('msg-search-flash'), 1800)
  }, 200)
}

// 实时：IM（飞书/QQ）来了新消息 → 刷新会话列表，新会话/新标题即时出现
watch(() => liveStore.rev.sessions, () => fetchSessions())

// 消息级实时：若这条 IM 消息属于当前打开的会话，直接把「这一来一回」追加进气泡，
// 不必整列表/整会话 refetch（只传增量）。非当前会话则上面刷新列表即可。
// origin === 本标签页时是自己发起这轮对话的回声：token 流已经把气泡画出来了，这里跳过，
// 只让别的标签页/端补上（同一 client-id 每个标签页独立生成，见 services/api.ts）。
watch(() => liveStore.sessionEvent, async (e) => {
  if (!e || !e.appended?.length || e.session_id !== sessionId.value) return
  if (e.origin && e.origin === CLIENT_ID) return
  for (const m of e.appended) {
    const isAi = m.role === 'assistant'
    const speaker = resolveSpeaker(m.role || 'user', m.platform_user_id, m.platform_user_name)
    const latestNames: Record<string, string> = {}
    for (const existing of messages.value) {
      if (existing.platformUserId && existing.speakerLabel) {
        latestNames[existing.platformUserId] = existing.speakerLabel
      }
    }
    if (m.platform_user_id && m.platform_user_name) {
      latestNames[m.platform_user_id] = m.platform_user_name
    }
    if (m.platform_bot_user_id) {
      latestNames[m.platform_bot_user_id] = '咕咕'
    }
    messages.value.push({
      id: mkid(),
      role: speaker.role,
      speakerLabel: speaker.speakerLabel,
      platformUserId: m.platform_user_id || null,
      text: displayQQFaces(replaceMentionIdsForDisplay(m.text || '', latestNames)),
      html: isAi ? renderMd(displayQQFaces(replaceMentionIdsForDisplay(m.text || '', latestNames))) : null,
      files: (m.files && m.files.length) ? m.files as ChatFile[] : undefined,
      quotedText: m.quoted_text || undefined,
      time: now(),
    })
  }
  await nextTick(); await scrollBottom()
})

// 工具名 → 受影响数据域，咕咕操作后据此刷新前端，免手动刷新页面
// 与后端 RESOURCE_BY_TOOL（app/core/events.py）保持一致——漏了哪个工具，对应视图就不会实时刷新。
const _PROJECT_TOOLS = new Set(['create_project','update_project','delete_project','archive_project','update_stage','set_priority','set_color','add_stage','remove_stage','rename_stage','add_todo','remove_todo','set_stages','update_todo'])
const _CALENDAR_TOOLS = new Set(['create_event','update_event','delete_event'])
const _FILE_TOOLS = new Set(['edit_file','create_document','rename_file','move_items','copy_file','create_folder','delete_file','rename_folder','delete_folder','save_uploaded_file','restore_file','permanent_delete'])

async function refreshAfterTools(usedTools: Set<string>) {
  if (!usedTools.size) return
  const has = (set: Set<string>) => [...usedTools].some(t => set.has(t))
  try {
    if (has(_PROJECT_TOOLS)) await projectStore.fetchProjects()
    if (has(_CALENDAR_TOOLS)) { calendarSignal.value++; projectStore.fetchUpcomingCalEvents?.() }
    // 文件：刷文件管理器（uploadSignal）+ 确定性 bump rev.files 让打开的预览窗重载。
    // 实时 SSE（live.js）是 best-effort（dev 重启 / pub-sub 竞态会丢事件），靠这条回合末兜底保证稳定刷新。
    if (has(_FILE_TOOLS)) { uploadSignal.value++; liveStore.bump('files') }
  } catch (e) { /* 刷新失败不影响对话 */ }
}
const audioEl       = ref<HTMLAudioElement | null>(null)
const audioPlaying  = ref(false)
const audioCurrent  = ref(0)
const audioDuration = ref(0)

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
watch(() => audioStore.file?.id, () => { needsRestore.value = true })

const audioSeekPct = computed(() =>
  audioDuration.value ? (audioCurrent.value / audioDuration.value) * 100 : 0
)

const fabSvgRef    = ref<SVGSVGElement | null>(null)
const rippleActive = ref(false)
const barsRef      = ref<HTMLElement | null>(null)
const barsPlaying  = ref(false)

watch(audioPlaying, (playing) => {
  if (playing) {
    barsRef.value?.querySelectorAll('i').forEach((b) => { (b as HTMLElement).style.cssText = '' })
    barsPlaying.value = true
  } else {
    const bars = barsRef.value?.querySelectorAll('i') ?? []
    bars.forEach((b) => { (b as HTMLElement).style.height = getComputedStyle(b).height; (b as HTMLElement).style.transition = 'none' })
    barsPlaying.value = false
    requestAnimationFrame(() => requestAnimationFrame(() => {
      bars.forEach((b) => { (b as HTMLElement).style.transition = 'height 0.45s ease-out'; (b as HTMLElement).style.height = '4px' })
    }))
    setTimeout(() => bars.forEach((b) => { (b as HTMLElement).style.cssText = '' }), 500)
  }
})

const spinningBack = ref(false)
let rippleTimeout: ReturnType<typeof setTimeout> | null = null
watch(audioPlaying, (playing) => {
  if (playing) { if (rippleTimeout) clearTimeout(rippleTimeout); rippleActive.value = true }
  else { rippleTimeout = setTimeout(() => { rippleActive.value = false }, 3600) }
})

function onCanPlay() {
  if (!audioEl.value) return
  audioEl.value.volume = audioVolume.value
  if (needsRestore.value) { needsRestore.value = false; restoreProgress() }
  audioEl.value.play()
}
function onAudioPause() { audioPlaying.value = false }
function onAudioEnded() {
  audioPlaying.value = false
  const key = progKey(); if (key) localStorage.removeItem(key)
}
function audioToggle() {
  if (!audioEl.value) return
  audioPlaying.value ? audioEl.value.pause() : audioEl.value.play()
}
function audioStop() {
  audioEl.value?.pause()
  const svgEl = fabSvgRef.value
  if (svgEl && audioStore.file) {
    const matrix = new DOMMatrix(getComputedStyle(svgEl).transform)
    const angle = Math.atan2(matrix.b, matrix.a) * (180 / Math.PI)
    const normalized = Math.round(((angle % 360) + 360) % 360)
    spinningBack.value = true
    svgEl.style.transform = `rotate(${normalized}deg)`
    svgEl.style.transition = 'none'
    requestAnimationFrame(() => requestAnimationFrame(() => {
      svgEl.style.transition = 'transform 0.65s ease-out'
      svgEl.style.transform = 'rotate(360deg)'
    }))
    setTimeout(() => { svgEl.style.transform = ''; svgEl.style.transition = ''; spinningBack.value = false }, 750)
  }
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
function audioSeek(e: MouseEvent) {
  if (!audioEl.value || !audioDuration.value) return
  const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
  audioEl.value.currentTime = ((e.clientX - rect.left) / rect.width) * audioDuration.value
}
function audioStartDrag(e: MouseEvent) {
  audioSeek(e)
  const move = (ev: MouseEvent) => audioSeek(ev)
  const up = () => { window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up) }
  window.addEventListener('mousemove', move); window.addEventListener('mouseup', up)
}
function fmtTime(s: number) {
  if (!s || isNaN(s)) return '0:00'
  return `${Math.floor(s / 60)}:${Math.floor(s % 60).toString().padStart(2, '0')}`
}

marked.use({
  breaks: true, gfm: true,
  renderer: (() => {
    const r = new marked.Renderer()
    // 关掉删除线渲染：口语里 ~ 很常见（好的~、稍等~），~~ 叠出来会被 GFM 当删除线；
    // 伙伴语气几乎不需要真删除线，把 ~~x~~ 直接渲染成纯文本 x（保留表格等其它 GFM 能力）。
    r.del = (t: Tokens.Del) => (t && t.text) || ''
    r.code = ({ text, lang }: Tokens.Code) => {
      const language = lang && hljs.getLanguage(lang) ? lang : 'plaintext'
      const highlighted = hljs.highlight(text, { language }).value
      const label = lang || 'code'
      // 复制按钮不写内联 onclick——DOMPurify 会剥掉所有 on* 属性；改由 onChatActionClick 事件委托处理
      return `<div class="md-code-block"><div class="md-code-header"><span class="md-code-lang">${label}</span><button class="md-copy-btn" type="button">复制</button></div><pre><code class="hljs language-${language}">${highlighted}</code></pre></div>`
    }
    return r
  })(),
})
// 兜底：模型有时把加粗小标题写成 `** 标题**`（** 后带空格 = 无效 md，不渲染加粗）。
// 在代码块/行内代码之外，把成对 ** 内侧紧邻的空格去掉，让它正常加粗（不碰代码里的 `x ** 2`）。
function fixLooseBold(text: string) {
  return text.split(/(```[\s\S]*?```|`[^`\n]*`)/g).map((seg, i) =>
    i % 2 ? seg
      : seg.replace(/\*\*[ \t]+([^*\n]+?)\*\*/g, '**$1**')
           .replace(/\*\*([^*\n]+?)[ \t]+\*\*/g, '**$1**')
  ).join('')
}
function renderMd(text: string) { return text ? marked.parse(fixLooseBold(text)) as string : '' }

// 流式渲染专用：补全未闭合的代码围栏，避免 marked 把半段代码块解析成残缺 HTML
// 单条缓存：同一帧内 text 未变则直接返回上次结果，避免重复解析
let _mdStreamCache: { text: string; html: string } | null = null
function renderMdStream(text: string) {
  if (!text) return ''
  if (_mdStreamCache?.text === text) return _mdStreamCache.html
  const fences = (text.match(/^```/gm) || []).length
  const patched = fences % 2 === 1 ? text + '\n```' : text
  const html = marked.parse(patched) as string
  _mdStreamCache = { text, html }
  return html
}

const BASE_URL = import.meta.env.VITE_API_URL ?? '/api/v1'

// ── 窗口状态 ────────────────────────────────────────────
const open       = ref(false)
const expanded   = ref(false)
const resizing   = ref(false)   // 展开/缩小动画期间：关 backdrop-filter、停跟随，降卡顿
let _resizeTimer: ReturnType<typeof setTimeout> | null = null
let _onResizeTransitionEnd: ((e: TransitionEvent) => void) | null = null
function playIncomingMessageSfx() {
  // 聊天窗正在被用户看着时不打断；切到别的标签页或收起聊天窗才提示。
  if (!open.value || document.hidden) playGuguSfx('message')
}
function _markResizing() {
  resizing.value = true
  if (_resizeTimer) clearTimeout(_resizeTimer)
  if (windowRef.value && _onResizeTransitionEnd) {
    windowRef.value.removeEventListener('transitionend', _onResizeTransitionEnd)
  }
  // 用真实 transitionend 结束 resizing，而不是硬编码 420ms 定时器——.chat-window 的位移过渡
  // 也是 0.42s，正常情况下两者前后脚触发看不出差别；但性能不足时（掉帧/主线程繁忙）CSS 过渡
  // 的视觉完成时间会被拖慢，定时器却按固定墙钟时间准点触发，导致 backdrop-filter/跟随在过渡
  // 还没走完时就被重新打开，看起来「闪一下」。定时器保留作兜底（万一没有属性真正变化、不会
  // 触发 transitionend），加了缓冲、不再和过渡时长完全对齐。
  _onResizeTransitionEnd = (e: TransitionEvent) => {
    if (e.target !== windowRef.value) return   // 只认窗口自己的位移过渡，冒泡上来的子元素过渡不算
    if (!['top', 'left', 'right', 'bottom'].includes(e.propertyName)) return
    resizing.value = false
    fitTextarea()   // 过渡结束后做一次无视觉差的最终校准，处理浏览器的子像素取整
  }
  windowRef.value?.addEventListener('transitionend', _onResizeTransitionEnd)
  _resizeTimer = setTimeout(() => { resizing.value = false; fitTextarea() }, 600)
}
const miniPinned = ref(localStorage.getItem('gugu_mini_pinned') !== 'false')
watch(miniPinned, v => localStorage.setItem('gugu_mini_pinned', String(v)))

// 设置：重开浏览器时是否接续上次对话（默认关＝开新对话）。开关在个人设置→咕咕设置里，
// 写 localStorage『gugu_reopen_resume』；这里 onMounted 时读一次决定要不要接续。
const reopenResume = ref(localStorage.getItem('gugu_reopen_resume') === '1')

const fabRef      = ref<HTMLElement | null>(null)
const windowRef   = ref<HTMLElement | null>(null)
const playerRef   = ref<HTMLElement | null>(null)
const expInputEl  = ref<HTMLTextAreaElement | null>(null)
const messagesEl  = ref<HTMLElement | null>(null)

// 视口尺寸，用于计算小窗绝对坐标
const vw = ref(window.innerWidth)
const vh = ref(window.innerHeight)
function onResize() { vw.value = window.innerWidth; vh.value = window.innerHeight }

// 小窗高度跟随内容：直接用 messages 内容真实高度（scrollHeight，天然含所有气泡 + gap + padding）
//   算窗口该多高，到 maxH 封顶后内部滚动。比旧的「按滚动位移反推」稳——旧法窗口一增高、内容
//   不再溢出，位移 delta 就归零、停止增长（表现为生成到一半窗口不再长高）。
const contentH = ref(SMALL_H)   // 窗口高度（= SMALL_H + 相对基线的新增内容高度），驱动 smallH
let _baseScrollH = 0            // 打开/切会话时的内容高度基线：窗口只随「相对基线新增的内容」长高，
                               // 不一次跳到全部历史高度（否则历史多时一发消息就瞬间全高）

const smallH = computed(() => {
  const maxH = Math.min(vh.value * 0.75, vh.value - 88 - 16)
  return Math.min(maxH, Math.max(SMALL_H, contentH.value))
})

// 内容相对基线增高多少，窗口就增高多少（含用户气泡 + AI 气泡）；到 maxH 封顶后内部滚动
function syncSmallH() {
  const el = messagesEl.value
  if (!el || expanded.value || resizing.value) return
  contentH.value = SMALL_H + Math.max(0, el.scrollHeight - _baseScrollH)
}

// 单一窗口的位置样式：小状态与大状态都用 top/left/right/bottom 像素值，保证过渡正常
// transition 放在 CSS 而非 inline style，避免覆盖 Vue Transition 的 opacity/transform 动画
// 窗口层级：进统一窗口带（点谁谁上，见 composables/windowz.ts）；打开时置顶
const chatZ = ref(nextZ())
function raiseChat() { chatZ.value = nextZ() }
watch(open, v => { if (v) raiseChat() })

// 离场动画尚未结束时窗口仍缩回悬浮球，不能提前把球提到窗口前面。
// after-leave 后才恢复常驻最高层，避免关闭瞬间球盖住窗口。
const chatClosing = ref(false)
const fabZ = computed(() => (open.value || chatClosing.value) ? chatZ.value - 1 : 99999)

const windowStyle = computed(() => {
  if (expanded.value) {
    // 右锚 720px，遇到窄屏时不超过导航栏右边界
    const left = Math.max(SIDEBAR_W + 12, vw.value * 0.4 - 12)
    return { top: '12px', right: '12px', bottom: '12px', left: `${left}px`, zIndex: chatZ.value }
  }
  return {
    top:    `${vh.value - 88 - smallH.value}px`,
    left:   `${vw.value - parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--floating-edge')) - SMALL_W}px`,
    right:  'var(--floating-edge)',
    bottom: '88px',
    zIndex: chatZ.value,
  }
})

// 播放器联动：小窗打开时顶到窗口上方，其余情况悬在 fab 上方
const miniPlayerStyle = computed(() => {
  const bottom = (open.value && !expanded.value) ? 88 + smallH.value + 8 : 88
  // 小窗展开时播放器远离 FAB，从自身中心缩放；其他状态从 FAB 圆心缩放
  const origin = (open.value && !expanded.value)
    ? '50% 50%'
    : `calc(100% - 25px) calc(100% + ${bottom - 53}px)`
  // 跟随聊天窗相对层级：展开态在窗后（-1）、小窗态顶在窗前（+1）
  const zIndex = expanded.value ? chatZ.value - 1 : chatZ.value + 1
  return { bottom: `${bottom}px`, transformOrigin: origin, zIndex }
})

// 通知气泡锚点：让通知始终浮在「小窗 / 音乐播放器」上方，不与之重叠。
// 关闭态：浮在 fab（或其上的播放器）上方；小窗态：浮在小窗（及其上播放器）上方；
// 放大态：窗口几乎占满，播放器已缩回 fab，通知仍回到 fab 上方默认位。
const MP_EST_H = 112   // 播放器外高估值（含 padding，用于堆叠避让）
const notifyAnchor = computed(() => {
  const hasPlayer = !!audioStore.file && (miniPinned.value || open.value)
  if (open.value && !expanded.value) {
    const winTop = 88 + smallH.value                          // 小窗顶沿（距视口底）
    return (hasPlayer ? winTop + 8 + MP_EST_H : winTop) + 12
  }
  return hasPlayer ? 88 + MP_EST_H + 12 : 90
})
watch(notifyAnchor, v => { uiStore.chatNotifyAnchor = v }, { immediate: true })

// 通知气泡开合的缩放原点（与音乐播放器同逻辑）：
// 直接浮在咕咕球上方（聊天关闭且无播放器）→ 从球圆心缩放；被小窗/播放器顶高 → 从自身中心缩放。
const notifyOrigin = computed(() => {
  const hasPlayer = !!audioStore.file && (miniPinned.value || open.value)
  if (!open.value && !hasPlayer) {
    return `calc(100% - 25px) calc(100% + ${notifyAnchor.value - 53}px)`
  }
  return '50% 50%'
})
watch(notifyOrigin, v => { uiStore.chatNotifyOrigin = v }, { immediate: true })

async function toggleOpen() {
  if (open.value) {
    closeChat()
    return
  }
  open.value = true
  if (open.value) {
    if (!expanded.value) contentH.value = SMALL_H
    trackApi.track('chat_open').catch(() => {})
    await nextTick()
    stick.value = true
    _baseScrollH = messagesEl.value?.scrollHeight || 0   // 基线 = 打开时的历史内容高度
    scrollToBottom()
  }
}

function closeChat() {
  chatClosing.value = true
  open.value = false
  expanded.value = false
}

onMounted(() => {
  window.addEventListener('resize', onResize)
  window.addEventListener('beforeunload', saveProgress)
  // 拉一次状态显示名（目前只用到「思考中」候选文案；失败就保持默认三个点）
  agentApi.getUiLabels?.().then(r => {
    thinkingLabels.value = Array.isArray(r?.thinking) ? r.thinking : (r?.thinking ? [r.thinking] : [])
  }).catch(() => {})
  // 恢复上次会话：① 本标签刷新 → sessionStorage 仍在，直接接续；② 重开浏览器（sessionStorage 已清）
  //   → 仅当设置「重开接续上次」打开时，从 localStorage 的最近一段接续；否则开新对话。
  const saved = sessionStorage.getItem(SESSION_KEY)
              || (reopenResume.value ? localStorage.getItem(LAST_SESSION_KEY) : null)
  if (saved) {
    messages.value = []   // 续聊：立刻清掉默认问候占位，避免 loadSession 异步加载期间 animateGreeting 闪问候
    loadSession(Number(saved)).then(() => {
      if (sessionId.value !== Number(saved)) {   // 那段会话没了（删了/无权限）→ 清存档、恢复问候、当新对话
        sessionStorage.removeItem(SESSION_KEY)
        localStorage.removeItem(LAST_SESSION_KEY)
        messages.value = [{ id: mkid(), role: 'ai', text: '', html: '', time: now(), _greeting: true }]
        prefetchGreeting()
      }
    })
  } else {
    // 全新对话（无可恢复会话）才需要默认问候 → 此刻后台生成；刷新/接续停在老会话时不空跑。
    prefetchGreeting()
  }
})
onUnmounted(() => {
  window.removeEventListener('resize', onResize)
  window.removeEventListener('beforeunload', saveProgress)
})

// ── 对话状态 ────────────────────────────────────────────
const inputText      = ref('')
const thinkingLabels = ref<string[]>([])   // 「思考中」候选文案（后台「状态命名」_thinking，可多个 | 分隔；空=三个点）
const streaming      = ref(false)
// 状态气泡贯穿整个生成期：工具/复查/思考只替换同一个气泡的内容，直到真实输出或中断。
const statusKind     = ref('')   // '' | 'text'（工具/自定义思考）| 'dots'（默认思考三点）
const statusTyped    = ref('')   // 当前显示的文字（dots 时为空）
const isTypingText   = computed(() => streaming.value && !statusKind.value)
const fabJumping     = ref(false)
watch(isTypingText, v => {
  if (v) { fabJumping.value = true; setTimeout(() => { fabJumping.value = false }, 350) }
})

interface StatusItem { kind: 'text' | 'dots' | 'hide'; label?: string }

const STATUS_ENTER_MS = 300
let statusShownAt = 0
let statusSwitchTimer: ReturnType<typeof setTimeout> | null = null
let pendingStatus: StatusItem | null = null

function _thinkingItem(): StatusItem {
  // 「思考中」：设了自定义文案就随机取一条；否则三个点。
  const c = thinkingLabels.value
  return c.length ? { kind: 'text', label: c[Math.floor(Math.random() * c.length)] } : { kind: 'dots' }
}

function cancelPendingStatus() {
  if (statusSwitchTimer) clearTimeout(statusSwitchTimer)
  statusSwitchTimer = null
  pendingStatus = null
}

function applyStatus(item: StatusItem) {
  statusKind.value = item.kind
  statusTyped.value = item.kind === 'text' ? (item.label || '') : ''
  statusShownAt = performance.now()
  scrollBottom()
}

function clearStatus() {       // 仅在回复开始、生成结束或中断时收起
  cancelPendingStatus()
  statusShownAt = 0
  statusKind.value = ''; statusTyped.value = ''
}

function setStatus(item: StatusItem) {
  if (item.kind === 'hide') { clearStatus(); return }
  const label = item.kind === 'text' ? (item.label || '') : ''
  if (statusKind.value === item.kind && statusTyped.value === label) return

  const remaining = STATUS_ENTER_MS - (performance.now() - statusShownAt)
  if (!statusKind.value || remaining <= 0) {
    cancelPendingStatus()
    applyStatus(item)
    return
  }

  // 气泡入场未完成时只保留最新状态，避免工具链里的短状态一闪而过。
  pendingStatus = item
  if (!statusSwitchTimer) {
    statusSwitchTimer = setTimeout(() => {
      statusSwitchTimer = null
      const nextStatus = pendingStatus
      pendingStatus = null
      if (nextStatus) applyStatus(nextStatus)
    }, remaining)
  }
}

onUnmounted(cancelPendingStatus)
const sessionId      = ref<number | null>(null)
// 视图代次：切换/新建会话时立即递增，让尚未完成的旧 SSE 流失去写入当前消息列表的资格。
let _chatViewGeneration = 0
// 当前会话所属渠道里「owner」的平台身份（仅群聊/IM 用得上）：消息的
// platformUserId 等于它才归到右侧气泡，否则是群里其他成员，归左侧并标 username。
const ownerPlatformUserId = ref<string | null>(null)
// 当前会话是不是群聊——只有群聊才需要在左侧气泡上方标"咕咕"/群成员 username，
// 1:1 对话左侧默认就是咕咕，不用额外标注，保持原有视觉不变。
const isGroupSession = ref(false)
const abortCtrl      = ref<AbortController | null>(null)
const pendingQueue   = ref<string[]>([])   // 生成中发的消息，排队等流式结束后接着发
const pendingAtt   = ref<ChatFile[]>([])     // 待发送的聊天附件（已上传暂存）
const attUploading = ref(false)
const fileInput    = ref<HTMLInputElement | null>(null)
function pickFile() { fileInput.value && fileInput.value.click() }
async function uploadAttachFiles(files: File[], opts: { voice?: boolean } = {}) {
  if (!files.length) return
  attUploading.value = true
  try {
    for (const file of files) {
      try {
        const meta: ChatFile = await agentApi.uploadAttachment(file, opts.voice)
        // 图片附件：本地 objectURL 立即出预览（暂存附件无 file_id，取不到服务端缩略图）
        if (_IMG_EXTS.has((meta.ext || '').toLowerCase())) meta._thumbUrl = URL.createObjectURL(file)
        pendingAtt.value.push(meta)
      } catch (err: any) {
        messages.value.push({ id: mkid(), role: 'ai', text: '附件上传失败 😵 ' + (err && err.message || ''), time: now() })
      }
    }
  } finally { attUploading.value = false }
}
async function onFilePicked(e: Event) {
  const target = e.target as HTMLInputElement
  const files = [...(target.files || [])]
  target.value = ''
  await uploadAttachFiles(files)
}

// ── 拖入文件添加附件（大小窗都支持）──
const chatDrag = ref(0)
const isChatDragging = computed(() => chatDrag.value > 0)
function _dragHasFiles(e: DragEvent) { return [...(e.dataTransfer?.types || [])].includes('Files') }
function onChatDragEnter(e: DragEvent) { if (_dragHasFiles(e)) { e.preventDefault(); chatDrag.value++ } }
function onChatDragOver(e: DragEvent)  { if (_dragHasFiles(e)) e.preventDefault() }
function onChatDragLeave()  { if (chatDrag.value > 0) chatDrag.value-- }
function onChatDrop(e: DragEvent) {
  if (!_dragHasFiles(e)) return
  e.preventDefault()
  chatDrag.value = 0
  uploadAttachFiles([...(e.dataTransfer?.files || [])])
}
// ── 粘贴文件/图片添加附件（截图直接 Ctrl+V，纯文本粘贴不受影响）──
function onPaste(e: ClipboardEvent) {
  const files = [...(e.clipboardData?.items || [])]
    .filter(it => it.kind === 'file')
    .map(it => it.getAsFile())
    .filter((f): f is File => !!f)
  if (!files.length) return
  e.preventDefault()
  uploadAttachFiles(files)
}
function removeAtt(a: ChatFile) {
  if (a._thumbUrl) URL.revokeObjectURL(a._thumbUrl)   // 未发送即移除，回收 objectURL
  pendingAtt.value = pendingAtt.value.filter(x => x.attach_id !== a.attach_id)
}

// ── 语音输入：录音 → 上传成附件 → 录完即发（咕咕用 mimo 听懂内容）──
// 浏览器多录成 webm/opus（mimo 不收）→ 后端 /agent/upload 转 mp3；Safari m4a/Firefox ogg 原生免转。
const recording  = ref(false)
const recordSecs = ref(0)
let _recorder: MediaRecorder | null = null
let _recChunks: Blob[] = []
let _recStream: MediaStream | null = null
let _recTimer: ReturnType<typeof setInterval> | null = null
let _recMime = ''
let _recCancelled = false
function _pickRecMime() {
  const cands = ['audio/mp4', 'audio/ogg;codecs=opus', 'audio/ogg', 'audio/webm']  // 优先 mimo 原生(m4a/ogg)
  if (window.MediaRecorder)
    for (const m of cands) { try { if (MediaRecorder.isTypeSupported(m)) return m } catch {} }
  return ''
}
function _recExt(m: string) {
  if (m.includes('mp4')) return 'm4a'
  if (m.includes('ogg')) return 'ogg'
  if (m.includes('wav')) return 'wav'
  return 'webm'
}
function _chatTip(text: string) { messages.value.push({ id: mkid(), role: 'ai', text, time: now() }) }
async function startRecord() {
  if (recording.value) return
  // getUserMedia 只在安全环境（HTTPS / localhost）可用——http 访问时 navigator.mediaDevices 直接是 undefined、连权限都不弹
  if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
    _chatTip('录音需要 HTTPS 或 localhost 安全环境 🎤 当前是 http 访问（如局域网 IP），浏览器不给开麦克风。线上 https 域名可以用～'); return
  }
  if (!window.MediaRecorder) { _chatTip('这个浏览器不支持录音 🎤'); return }
  try {
    _recStream = await navigator.mediaDevices.getUserMedia({ audio: true })
    const mime = _pickRecMime()
    _recorder = mime ? new MediaRecorder(_recStream, { mimeType: mime }) : new MediaRecorder(_recStream)
    _recMime = _recorder.mimeType || mime || 'audio/webm'
    _recChunks = []; _recCancelled = false
    _recorder.ondataavailable = (e) => { if (e.data && e.data.size) _recChunks.push(e.data) }
    _recorder.onstop = _onRecStop
    _recorder.start()
    recording.value = true; recordSecs.value = 0
    _recTimer = setInterval(() => { recordSecs.value++; if (recordSecs.value >= 60) stopRecord() }, 1000)
  } catch (e: any) {
    _recStream?.getTracks().forEach(t => t.stop()); _recStream = null
    messages.value.push({ id: mkid(), role: 'ai',
      text: '没法录音 🎤 ' + (e?.name === 'NotAllowedError' ? '麦克风权限被拒了，去浏览器设置允许一下' : (e?.message || '')), time: now() })
  }
}
function stopRecord()   { if (recording.value && _recorder) { _recCancelled = false; _recorder.stop() } }   // 结束并发送
function cancelRecord() { if (recording.value && _recorder) { _recCancelled = true;  _recorder.stop() } }   // 丢弃
async function _onRecStop() {
  recording.value = false
  if (_recTimer) { clearInterval(_recTimer); _recTimer = null }
  _recStream?.getTracks().forEach(t => t.stop()); _recStream = null
  const chunks = _recChunks, mime = _recMime, cancelled = _recCancelled
  _recChunks = []; _recorder = null
  if (cancelled || !chunks.length) return
  const blob = new Blob(chunks, { type: mime })
  if (!blob.size) return
  const file = new File([blob], `语音_${Date.now()}.${_recExt(mime)}`, { type: mime })
  await uploadAttachFiles([file], { voice: true })   // 标记为语音 → 语音条 + 30 天存储 + 「让我听听」
  if (pendingAtt.value.length) send()   // 录完即发（含可能已输入的文字）
}
// ── 语音条播放：点击拉鉴权 blob（download 端点带 Bearer），单实例播放，再点暂停 ──
const voicePlayingId = ref<string | null>(null)
let _voiceAudio: HTMLAudioElement | null = null
const _voiceUrls: Record<string, string> = {}            // attach_id → objectURL 缓存（同条重播不重拉）
const _WAVE = [50, 80, 38, 95, 60, 72, 44, 88, 56, 68, 42, 84, 52]   // 装饰性波形高度
function voiceBar(n: number) { return _WAVE[(n - 1) % _WAVE.length] + '%' }
function fmtDur(sec?: number) {
  const s = Math.round(sec || 0)
  if (!s) return '语音'
  return s < 60 ? s + '″' : Math.floor(s / 60) + "'" + String(s % 60).padStart(2, '0')
}
async function toggleVoice(f: ChatFile) {
  const id = f.attach_id
  if (!id) return
  if (voicePlayingId.value === id && _voiceAudio) { _voiceAudio.pause(); return }  // 再点＝暂停
  if (_voiceAudio) { _voiceAudio.pause(); _voiceAudio = null }                     // 切换：停掉上一条
  try {
    let url = _voiceUrls[id]
    if (!url) {
      const BASE_URL = import.meta.env.VITE_API_URL ?? '/api/v1'
      const token = localStorage.getItem('user_token') ?? ''
      const res = await fetch(`${BASE_URL}/agent/attachment/${id}/download`,
        { headers: token ? { Authorization: `Bearer ${token}` } : {} })
      if (!res.ok) { _chatTip(res.status === 404 ? '这条语音过期啦（语音保留 30 天）🎤' : '语音加载失败了 😵'); return }
      url = URL.createObjectURL(await res.blob()); _voiceUrls[id] = url
    }
    const a = new Audio(url); _voiceAudio = a; voicePlayingId.value = id
    a.onended = a.onpause = () => { if (voicePlayingId.value === id) voicePlayingId.value = null }
    await a.play()
  } catch (e) { voicePlayingId.value = null; _chatTip('语音播放失败 🎤') }
}

let _sessionTurn = 0             // 当前 session 已发消息轮次（埋点用，切换 session 重置）

// 会话 id 存入 sessionStorage：刷新页面保留当前对话，关闭浏览器/标签页才清空。
// 同时把「最后一段对话」存进 localStorage（跨浏览器重开仍在）——重开浏览器是否接续上次，
// 由设置 reopenResume 控制（见侧栏开关）；默认关＝重开开新对话（与历史行为一致）。
const SESSION_KEY = 'gugu_session_id'            // sessionStorage：本标签刷新保留
const LAST_SESSION_KEY = 'gugu_last_session_id'  // localStorage：最近一段对话（跨浏览器重开可接续）
watch(sessionId, (v) => {
  if (v) { sessionStorage.setItem(SESSION_KEY, String(v)); localStorage.setItem(LAST_SESSION_KEY, String(v)) }
  else sessionStorage.removeItem(SESSION_KEY)   // 新对话只清当前标签；localStorage 留最后一段供重开接续
})

function stopStreaming() {
  pendingQueue.value = []   // 停止=放弃排队中的消息
  abortCtrl.value?.abort()
}

const copiedId = ref<number | null>(null)
function fmtSize(b?: number) {
  if (!b) return ''
  if (b < 1024) return b + ' B'
  if (b < 1048576) return (b / 1024).toFixed(1) + ' KB'
  return (b / 1048576).toFixed(1) + ' MB'
}

// ── 图片附件缩略图（与文件库共用 useThumbCache）──
const _IMG_EXTS = new Set(['jpg','jpeg','png','gif','webp','avif','bmp','svg','heic','heif'])
// 缩略图来源优先级：本地 _thumbUrl（刚发的，即时）> file_id（已落库，服务端图）
// > attach_id（刷新后历史里的暂存图，走 /agent/attachment 端点，6h 内有效）；都没有则 ext 角标
function isImageFile(f: ChatFile) {
  if (f._thumbUrl) return true
  const isImg = _IMG_EXTS.has((f.ext || '').toLowerCase())
  return isImg && (!!f.file_id || !!f.attach_id)
}

function isAnimatedImageFile(f: ChatFile) {
  const mime = (f.mime || '').toLowerCase()
  return (['gif', 'webp'].includes((f.ext || '').toLowerCase()) || mime === 'image/gif' || mime === 'image/webp')
    && (!!f.file_id || !!f.attach_id)
}
// IntersectionObserver 懒加载指令：进视口附近才取 card 尺寸缩略图。
// 值为数字 file_id → 文件库缩略图；为字符串 attach_id → 暂存附件缩略图端点。
interface ThumbEl extends HTMLImageElement {
  _thumbObs?: IntersectionObserver | null
  _thumbKey?: string
  _thumbGeneration?: number
}

function bindLazyThumb(el: ThumbEl, id: number | string | undefined | null, size = 'card') {
  el._thumbObs?.disconnect()
  el._thumbObs = null
  const generation = (el._thumbGeneration ?? 0) + 1
  el._thumbGeneration = generation
  el._thumbKey = id == null || id === '' ? undefined : String(id)
  // DOM 节点会被虚拟列表复用；切换附件时先清掉旧图，避免旧 blob 在新附件加载前残留。
  el.removeAttribute('src')
  if (!id) return

  const isAttach = typeof id === 'string'
  const key = isAttach ? `att:${id}_${size}` : `${id}_${size}`
  const cached = isAttach ? getCachedThumbUrl(key) : getCachedThumb(id, size)
  if (cached) { el.src = cached; return }
  const fetchThumb = () => isAttach
    ? getThumbUrl(key, `${API_BASE}/agent/attachment/${id}/thumb?size=${size}`)
    : getThumb(id, size)
  const obs = new IntersectionObserver(([entry]) => {
    if (!entry.isIntersecting) return
    obs.disconnect(); el._thumbObs = null
    fetchThumb().then((url: string | null) => {
      if (url && el._thumbGeneration === generation && el._thumbKey === String(id)) el.src = url
    })
  }, { rootMargin: '200px' })
  obs.observe(el)
  el._thumbObs = obs
}

function makeLazyThumbDirective(size: string) {
  return {
    mounted(el: ThumbEl, { value }: { value: number | string | undefined | null }) { bindLazyThumb(el, value, size) },
    updated(el: ThumbEl, { value, oldValue }: { value: number | string | undefined | null; oldValue: number | string | undefined | null }) {
      if (value !== oldValue) bindLazyThumb(el, value, size)
    },
    unmounted(el: ThumbEl) {
      el._thumbObs?.disconnect(); el._thumbObs = null
      el._thumbGeneration = (el._thumbGeneration ?? 0) + 1
      el._thumbKey = undefined
    },
  }
}

const vLazyThumb = makeLazyThumbDirective('card')
// QQ 表情需要保留 GIF/动画 WebP，不能走会转成 JPEG 的 card 缩略图端点。
const vLazyFace = makeLazyThumbDirective('full')

async function downloadFile(f: ChatFile) {
  if (f.attach_id) {
    // 聊天上传的暂存附件：走 /agent/attachment/{id}/download
    const token = localStorage.getItem('user_token') ?? ''
    const res = await fetch(`${API_BASE}/agent/attachment/${f.attach_id}/download`,
      { headers: token ? { Authorization: `Bearer ${token}` } : {} })
    if (!res.ok) { console.error('附件下载失败', res.status); return }
    const blob = await res.blob()
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url; a.download = `${f.qq_face ? 'QQ表情' : f.name}.${f.ext}`
    document.body.appendChild(a); a.click()
    setTimeout(() => { URL.revokeObjectURL(url); a.remove() }, 1000)
    return
  }
  if (f.file_id == null) return
  try { await filesApi.download(f.file_id, `${f.qq_face ? 'QQ表情' : f.name}.${f.ext}`) }
  catch (e) { console.error('下载失败', e) }
}

const previewStore = usePreviewStore()
function canPreview(f: ChatFile) {
  return (!!f.file_id || !!f.attach_id) && isPreviewable(f.ext)
}
function openFileFromChat(f: ChatFile) {
  if (canPreview(f)) {
    const displayName = f.qq_face ? 'QQ表情' : f.name
    previewStore.open({
      id: f.file_id ?? undefined,
      attach_id: f.attach_id ?? null,
      ext: (f.ext || '').toUpperCase(),
      displayName,
      size: fmtSize(f.size_bytes),
      // 真实像素尺寸（有的话）：预览窗口直接按此定尺，不用再靠缩略图猜大小
      imgWidth: f.img_width ?? null,
      imgHeight: f.img_height ?? null,
    })
    return
  }
  downloadFile(f)
}

function copyMsg(msg: ChatMessage) {
  // AI 消息取渲染后的纯文本，用户消息直接取原文
  let text = msg.text
  if (msg.role === 'ai' && msg.text) {
    const tmp = document.createElement('div')
    tmp.innerHTML = renderMd(msg.text)
    text = tmp.innerText || tmp.textContent || msg.text
  }
  const fallback = () => {
    const el = document.createElement('textarea')
    el.value = text
    el.style.cssText = 'position:fixed;top:-9999px;left:0;opacity:0'
    document.body.appendChild(el)
    el.focus(); el.select()
    try { document.execCommand('copy') } catch {}
    document.body.removeChild(el)
  }
  ;(navigator.clipboard ? navigator.clipboard.writeText(text).catch(fallback) : Promise.reject())
    .catch(fallback)
  copiedId.value = msg.id
  setTimeout(() => { if (copiedId.value === msg.id) copiedId.value = null }, 1500)
}

const now = () => {
  const d = new Date()
  return `${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`
}
let _mid = 0
const mkid = () => ++_mid

// 默认问候：占位空消息（打开对话框时再以打字机动画显示，文案在那一刻取最新生成版/兜底）
const messages = ref<ChatMessage[]>([
  { id: mkid(), role: 'ai', text: '', html: '', time: now(), _greeting: true },
])

// ── 长会话虚拟列表 ────────────────────────────────────────────────────────────
// 网络层不变，仍一次性把整条会话历史拉回来（messages 是完整数据，搜索跳转靠它按 dbId
// 定位）。DOM 层交给 @tanstack/vue-virtual：任何时刻只挂载视口 ± overscan 内的消息，
// 其余用一段按「已测量高度 / 估算高度」撑出来的占位空间代替，滚动条因此始终代表整个
// 会话的真实长度（顶部滚到底也准），而不是只随「挂了多少条」变化。
// 消息高度不定长（纯文本/代码块/文件卡片/语音条差异很大），measureElement 首次挂载
// 后用真实高度回填、并自带 ResizeObserver 持续纠偏（图片/缩略图迟一拍加载导致变高也能跟上）。
const virtualizer = useVirtualizer({
  get count() { return messages.value.length },
  getScrollElement: () => messagesEl.value,
  estimateSize: () => 96,
  overscan: 6,
})
const virtualRows = computed(() => virtualizer.value.getVirtualItems())
// 绝对定位的子元素不会跟着祖先的 padding 走（top:0/left:0 是相对祖先的边框盒，不是内容盒），
// 所以顶部留白只能自己在 translateY 里加、不能指望 .msg-virtual-spacer 的 padding-top 生效；
// 水平方向的留白则放在每一行自己的左右 padding 上（CSS，见下）。
const msgsPadTop = computed(() => expanded.value ? 20 : 12)
// 占位容器总高度 = 虚拟列表算出的内容高度 + 顶部留白（底部留白由最后一行自带的 padding-bottom 覆盖）
const virtualTotalSize = computed(() => virtualizer.value.getTotalSize() + msgsPadTop.value)
// v-for 需要同时拿到虚拟行的定位信息（row）和它对应的消息（msg），zip 成一个数组，
// 这样消息行内部的模板完全不用改，照样按 msg.xxx 取值。
const rowsWithMsg = computed(() => virtualRows.value.map(row => ({ row, msg: messages.value[row.index] })))
function measureRow(el: Element | ComponentPublicInstance | null) { if (el) virtualizer.value.measureElement(el as Element) }

// 只有真正挂进视口 ± overscan 的消息才需要解析 markdown——不在 loadSession 时就把
// 整个历史一次性跑一遍 marked.parse，等消息第一次进虚拟窗口再补，减轻长会话打开时的
// 一次性 CPU 尖峰；已经解析过的（html 非空）不重复解析。
watch(virtualRows, (rows) => {
  for (const row of rows) {
    const m = messages.value[row.index]
    if (m && m.role === 'ai' && !m.streaming && m.html == null) m.html = renderMd(m.text)
  }
})

// 会话内定位到某条历史消息（全局搜索跳转用）：先按 dbId 找到下标，用虚拟列表的
// scrollToIndex 滚过去（数据本来就在 messages 里，不用管它当前有没有挂 DOM），
// 等它挂载出来再交给 _flashChatMessage 做高亮。
async function _revealMessage(dbId: number) {
  const idx = messages.value.findIndex(m => m.dbId === dbId)
  if (idx === -1) return
  stick.value = false   // 跳去的多半是历史消息，不该被当成「回到底部」处理
  virtualizer.value.scrollToIndex(idx, { align: 'center', behavior: 'auto' })
  await nextTick()
}

// 打开对话框时让默认问候像回复一样「打字机」冒出来（生成版 / 兜底都走这套）。每条问候只播一次。
let _greetTimer: ReturnType<typeof setInterval> | null = null
function animateGreeting() {
  const m = messages.value
  if (!(m.length === 1 && m[0]._greeting)) return   // 已有真实对话 → 不动
  const msg = m[0]
  if (msg._greetAnimated) return
  msg._greetAnimated = true
  const full = getGreeting()                        // 此刻取最新（生成好就用生成版，否则兜底）
  msg._greetFull = full                             // 记下定稿文案：用户回复时随首条消息把它入库（见 send）
  msg.text = ''; msg.html = ''; msg.streaming = true
  let i = 0
  if (_greetTimer) clearInterval(_greetTimer)
  _greetTimer = setInterval(() => {
    msg.text = full.slice(0, ++i)
    if (i >= full.length) { if (_greetTimer) clearInterval(_greetTimer); _greetTimer = null; msg.streaming = false; msg.html = renderMd(full) }
  }, 22)
}
// 任何打开路径（FAB / 通知点开 / 展开）都触发一次
watch(open, (v) => { if (v) { animateGreeting(); loadBots(); loadQuota(); pickOfflineLabel() } })

// ── 展开/收起 ────────────────────────────────────────────
const sessions = ref<ChatSession[]>([])
const webSessions = computed(() => sessions.value.filter(s => !s.source || s.source === 'web'))
const imSessions  = computed(() => sessions.value.filter(s => s.source && s.source !== 'web'))
const currentSessionTitle = computed(() =>
  !sessionId.value ? '新对话' : (sessions.value.find(s => s.id === sessionId.value)?.title ?? '对话')
)

async function fetchSessions() {
  try { sessions.value = await agentApi.listSessions() } catch {}
}

// ── 侧栏 IM 接入（飞书 / QQ / 微信）：未接入显示扫码连接抽屉，接入后变成该平台会话抽屉 ──
type ImPlatformKey = 'feishu' | 'qq' | 'wechat'
interface ImPlatformApi { start: () => Promise<any>; poll: (id: any) => Promise<any> }
interface ImPlatform { key: ImPlatformKey; label: string; api: ImPlatformApi }
const IM_PLATFORMS: ImPlatform[] = [
  { key: 'feishu',  label: '飞书', api: feishuConnectApi },
  { key: 'qq',   label: 'QQ',   api: qqConnectApi },
  { key: 'wechat',  label: '微信', api: wechatConnectApi },
]
const bots   = ref<Bot[]>([])
const imOpen = reactive<Record<ImPlatformKey, boolean>>({ feishu: false, qq: false, wechat: false })
const imOnline    = computed(() => bots.value.some(b => b.enabled))   // 有「启用中」的 IM bot 才算在线（停用/残留不算）

// ── 顶部状态：休息中（精力耗尽）> 在线（任意 IM 启用）> 随机离线 ──
const quota = ref<QuotaInfo | null>(null)
async function loadQuota() { try { quota.value = await authApi.getQuota() } catch {} }
const energyExhausted = computed(() => {
  const q = quota.value
  if (!q) return false
  return (q.limit_6h != null && (q.used_6h ?? 0) >= q.limit_6h) ||
         (q.limit_weekly != null && (q.used_weekly ?? 0) >= q.limit_weekly)
})
// 离线时随机显示「QQ/微信/飞书 离线」之一（每次打开换一个，暗示这些渠道还没接上）
const _OFFLINE_LABELS = ['QQ 离线', '微信离线', '飞书离线']
const offlineLabel = ref('离线')
function pickOfflineLabel() { offlineLabel.value = _OFFLINE_LABELS[Math.floor(Math.random() * _OFFLINE_LABELS.length)] }
const presenceKind  = computed(() => energyExhausted.value ? 'resting' : (imOnline.value ? 'online' : 'offline'))
const presenceText  = computed(() => presenceKind.value === 'resting' ? '休息中'
                                   : presenceKind.value === 'online'  ? '在线' : offlineLabel.value)
const presenceTitle = computed(() => presenceKind.value === 'resting' ? '咕咕精力用完了，歇会儿就回来～'
                                   : presenceKind.value === 'online'  ? '咕咕在线'
                                   : '咕咕还没接到你的微信 / QQ / 飞书——点一下接上，随时随地找它')
const imHighlight = ref(false)
const imGroupEl   = ref<HTMLElement | null>(null)
const botsOf = (platform: ImPlatformKey) => bots.value.filter(b => b.platform === platform)
const imSessionsOf = (platform: ImPlatformKey) => imSessions.value.filter(s => s.source === platform)

async function loadBots() {
  try { const r = await userBotsApi.list(); bots.value = r.items || [] } catch {}
}
function toggleImPlatform(key: ImPlatformKey) { imOpen[key] = !imOpen[key] }

// 离线状态被点击：展开大窗 → 摊开各 IM 抽屉露出「扫码连接」→ 高亮 IM 区一下（暗示式引导，不强推）
async function promptConnectIM() {
  if (!expanded.value) await enterExpanded()
  else loadBots()
  IM_PLATFORMS.forEach(p => { imOpen[p.key] = true })
  await nextTick()
  imGroupEl.value?.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
  imHighlight.value = false   // 重置以便点第二次也能重放动画
  await nextTick()
  imHighlight.value = true
  setTimeout(() => { imHighlight.value = false }, 2600)
}

// 通用扫码连接（建任务 → 渲染二维码 → 轮询 → 自动写 user_bot，与 ProfileModal 同一套 API）
const connecting    = ref('')        // 正在生成二维码的平台 key
const connect       = ref<ImConnectState | null>(null)      // { platform, id } 连接进行中
const connectHint   = ref('')
const connectErr    = ref('')
const connectCanvas = ref<HTMLCanvasElement | null>(null)
let   connectPoll: ReturnType<typeof setInterval> | null = null
function setConnectCanvas(el: Element | ComponentPublicInstance | null) { if (el) connectCanvas.value = el as HTMLCanvasElement }   // v-for 内函数 ref，避免数组 ref

async function startImConnect(platform: ImPlatformKey) {
  const p = IM_PLATFORMS.find(x => x.key === platform)
  if (!p) return
  connecting.value = platform; connectErr.value = ''
  try {
    const r = await p.api.start()
    connect.value = { platform, id: r.poll_id || r.task_id }   // 飞书 poll_id / QQ & 微信 task_id
    connectHint.value = platform === 'feishu'
      ? '手机飞书扫码 → 授权创建机器人，授权后自动连接'
      : platform === 'wechat'
        ? '手机微信扫码 → 授权后自动连接'
        : '手机 QQ 扫码 → 选一个机器人授权，授权后自动连接'
    await nextTick()
    await QRCode.toCanvas(connectCanvas.value, r.scan_url, { width: 160, margin: 1 })
    _startImPoll(p)
  } catch (e: any) {
    connectErr.value = e?.message || '生成二维码失败'
    connect.value = null
  } finally { connecting.value = '' }
}
function _startImPoll(p: ImPlatform) {
  _stopImPoll()
  let tries = 0
  connectPoll = setInterval(async () => {
    tries++
    try {
      const r = await p.api.poll(connect.value?.id)
      if (r.status === 'success') { cancelImConnect(); await loadBots(); await fetchSessions() }
      else if (r.status === 'expired') { connectErr.value = '二维码已过期，请重新扫码'; cancelImConnect() }
      else if (r.status === 'fail') { connectErr.value = '连接失败：' + (r.reason || '未知'); cancelImConnect() }
    } catch {}
    if (tries > 100) cancelImConnect()   // ~5 分钟超时
  }, 3000)
}
function _stopImPoll() { if (connectPoll) { clearInterval(connectPoll); connectPoll = null } }
function cancelImConnect() { _stopImPoll(); connect.value = null }

// ── 聊天内「扫码绑定 IM」：咕咕回复里输出 [文案](gugu://bind-im/<platform>) 当按钮，
//    点击 → 这里弹小窗扫码（复用 IM_PLATFORMS 的 start/poll，与侧栏同一套后端，互不干扰）──
const chatBind = reactive<{ open: boolean; platform: string; label: string; hint: string; err: string; id: string | number | null }>(
  { open: false, platform: '', label: '', hint: '', err: '', id: null }
)
const chatBindCanvas = ref<HTMLCanvasElement | null>(null)
let chatBindPoll: ReturnType<typeof setInterval> | null = null

function onChatActionClick(e: MouseEvent) {
  // 代码块「复制」按钮：渲染时不写内联 onclick（DOMPurify 会剥掉 on*），这里事件委托兜住
  const target = e.target as HTMLElement
  const btn = target.closest?.('.md-copy-btn') as HTMLElement | null
  if (btn) {
    e.preventDefault()
    const text = (btn.closest('.md-code-block')?.querySelector('code') as HTMLElement | null)?.innerText ?? ''
    const done = () => { btn.textContent = '已复制 ✓'; setTimeout(() => { btn.textContent = '复制' }, 1200) }
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(text).then(done).catch(done)
    } else {
      const a = document.createElement('textarea')
      a.value = text; a.style.position = 'fixed'; a.style.opacity = '0'
      document.body.appendChild(a); a.select()
      try { document.execCommand('copy') } catch {}
      a.remove(); done()
    }
    return
  }
  const a = target.closest?.('a[href^="gugu://"]') as HTMLAnchorElement | null
  if (!a) return
  e.preventDefault()
  const href = a.getAttribute('href') || ''
  const mBind = href.match(/^gugu:\/\/bind-im\/([a-z]+)/i)
  if (mBind) { openChatImBind(mBind[1]); return }
  const mFile = href.match(/^gugu:\/\/open-file\/(\d+)/i)
  if (mFile) {
    uiStore.pendingFileTarget = { kind: 'file', id: parseInt(mFile[1]) }
    router.push('/files')
  }
}

async function openChatImBind(platform: string) {
  const p = IM_PLATFORMS.find(x => x.key === platform)
  if (!p) return
  _stopChatBindPoll()
  chatBind.platform = platform; chatBind.label = p.label
  chatBind.err = ''; chatBind.hint = ''; chatBind.id = null; chatBind.open = true
  await nextTick()
  try {
    const r = await p.api.start()
    chatBind.id = r.poll_id || r.task_id
    chatBind.hint = platform === 'feishu'
      ? '手机飞书扫码 → 授权创建机器人，授权后自动连接'
      : platform === 'wechat'
        ? '手机微信扫码 → 授权后自动连接'
        : '手机 QQ 扫码 → 选一个机器人授权，授权后自动连接'
    await nextTick()
    await QRCode.toCanvas(chatBindCanvas.value, r.scan_url, { width: 168, margin: 1 })
    _startChatBindPoll(p)
  } catch (e: any) {
    chatBind.err = e?.message || '生成二维码失败'
  }
}
function _startChatBindPoll(p: ImPlatform) {
  _stopChatBindPoll()
  let tries = 0
  chatBindPoll = setInterval(async () => {
    tries++
    try {
      const r = await p.api.poll(chatBind.id)
      if (r.status === 'success') { closeChatBind(); await loadBots(); await fetchSessions() }
      else if (r.status === 'expired') { chatBind.err = '二维码已过期，关掉再点一次按钮'; _stopChatBindPoll() }
      else if (r.status === 'fail') { chatBind.err = '连接失败：' + (r.reason || '未知'); _stopChatBindPoll() }
    } catch {}
    if (tries > 100) closeChatBind()
  }, 3000)
}
function _stopChatBindPoll() { if (chatBindPoll) { clearInterval(chatBindPoll); chatBindPoll = null } }
function closeChatBind() { _stopChatBindPoll(); chatBind.open = false }

async function enterExpanded() {
  expanded.value = true
  loadBots()
  _markResizing()
  // 真实输入框此时仍在从小窗宽度过渡到大窗宽度；用目标宽度离屏测量，避免把旧宽度的行数
  // 带到动画结束才纠正，也不需要为了兜底提前撑高窗口。
  await nextTick()
  fitTextarea(true)
  trackApi.track('chat_expanded').catch(() => {})
  await fetchSessions()
  await nextTick()
  expInputEl.value?.focus()
  stick.value = true
  const el = messagesEl.value
  if (!el) return
  el.scrollTop = 999999; _lastTop = el.scrollTop
  // 展开动画期间容器高度持续变化，用 ResizeObserver 跟底，420ms 动画结束后断开
  const ro = new ResizeObserver(() => { el.scrollTop = 999999; _lastTop = el.scrollTop })
  ro.observe(el)
  setTimeout(() => { ro.disconnect() }, 450)
}

async function exitExpanded() {
  contentH.value = SMALL_H  // 先重置，小窗 DOM 以 SMALL_H 直接创建，不产生二次缩小
  _baseScrollH = Infinity   // 缩小动画期间冻结增长（grown 恒 0、窗口稳在 SMALL_H）：大窗换行少、
                            // scrollHeight 偏小，拿它当基线会让小窗重新换行后的高度全被算成新增 → 顶满
  expanded.value = false
  _markResizing()
  await nextTick()
  fitTextarea(false)
  const el = messagesEl.value
  if (!el) return
  stick.value = true
  el.scrollTop = 999999; _lastTop = el.scrollTop
  // CSS transition 让窗口从大尺寸平滑缩小（0.38s），期间 clientHeight 持续变化
  // ResizeObserver 跟着一直滚底，过渡结束后断开；动画结束、小窗布局稳定后再测真实基线
  const ro = new ResizeObserver(() => { el.scrollTop = 999999; _lastTop = el.scrollTop })
  ro.observe(el)
  setTimeout(() => {
    ro.disconnect()
    _baseScrollH = messagesEl.value?.scrollHeight || 0
    syncSmallH()
  }, 450)
}

interface RawSessionMessage {
  id: number
  role: string
  content: string
  files?: ChatFile[]
  quotedText?: string
  platformUserId?: string | null
  platformUserName?: string | null
  createdAt: string
}

// role/platformUserId → 气泡归属 + 群成员发言人标注。三态：
// - 'ai'：assistant，左侧，不比对
// - 'user'：owner 自己发的，右侧，不署名
// - 'member'：群里其他成员（platformUserId 存在但跟 owner 对不上），左侧，署 speakerLabel。
// 单独开一个 role 值而不是复用 'user'，是因为全文件所有 role 判断都只认 'ai'/非 'ai'
// 两态（没有任何地方显式判断 === 'user'），加第三态不会破坏既有逻辑，但如果借用
// 'user' 表达"群成员"，气泡会被现有 CSS 判到右侧去，跟需求正好相反。
//
// 只有真正的群聊会话才去比对 platformUserId === ownerPlatformUserId——owner 绑定
// 目前只有 QQ 走了验证码流程，微信/飞书的 ownerPlatformUserId 恒为 null，但它们的
// IM 消息一样带 platformUserId（不分群聊私聊），如果不看 isGroupSession 直接比对，
// 微信/飞书自己的私聊消息会因为「真实 id !== null」被误判成群成员、错落左侧。
// 私聊/网页对话没有"群里其他人"这个概念，直接按 owner 处理。
function resolveSpeaker(
  role: string,
  platformUserId: string | null | undefined,
  platformUserName: string | null | undefined,
): { role: string; speakerLabel?: string } {
  if (role === 'assistant') return { role: 'ai' }
  if (!isGroupSession.value || !platformUserId || platformUserId === ownerPlatformUserId.value) return { role: 'user' }
  return { role: 'member', speakerLabel: platformUserName || platformUserId }
}

function replaceMentionIdsForDisplay(text: string, names: Record<string, string>): string {
  let result = text || ''
  for (const [platformUserId, name] of Object.entries(names)) {
    if (!platformUserId || !name) continue
    const escaped = platformUserId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    result = result.replace(new RegExp(`<@!?${escaped}>|@${escaped}`, 'g'), () => `@${name}`)
  }
  return result
}

// 兼容历史消息：旧记录可能还保存着 QQ 的内部表情协议串。
function displayQQFaces(text: string): string {
  if (!text || !text.includes('<faceType=')) return text || ''
  return text.replace(
    /<faceType=[^,>]+,faceId="[^"]*",ext="([^"]*)">/g,
    (_match, encoded: string) => {
      if (encoded) {
        try {
          const padded = encoded + '='.repeat((4 - encoded.length % 4) % 4)
          const bytes = Uint8Array.from(atob(padded), char => char.charCodeAt(0))
          const payload = JSON.parse(new TextDecoder().decode(bytes))
          if (typeof payload.text === 'string' && payload.text.trim()) return payload.text
        } catch { /* 历史协议串不完整时显示统一占位 */ }
      }
      return '[QQ表情]'
    },
  )
}

async function loadSession(id: number) {
  if (id === sessionId.value) return
  const viewGeneration = ++_chatViewGeneration
  abortCtrl.value?.abort()        // 停掉当前会话的流式消费（后端生成不受影响、继续跑）
  streaming.value = false
  try {
    const data = await agentApi.getMessages(String(id))
    if (viewGeneration !== _chatViewGeneration) return
    sessionId.value = id
    ownerPlatformUserId.value = data.session?.ownerPlatformUserId ?? null
    isGroupSession.value = data.session?.chatType === 'group'
    clearStatus()   // 切会话先清掉上个会话残留的状态指示（active 会话下面 resumeStream 会重置）
    // html 先留空、不在这一步就把整个历史都跑一遍 marked.parse——只有真正挂进虚拟列表
    // 视口的那些消息才会被 watch(virtualRows, ...) 补上，减轻长会话打开时的一次性 CPU 尖峰。
    messages.value = data.messages.map((m: RawSessionMessage) => {
      const speaker = resolveSpeaker(m.role, m.platformUserId, m.platformUserName)
      return {
        id: mkid(),
        dbId: m.id,
        role: speaker.role,
        speakerLabel: speaker.speakerLabel,
        platformUserId: m.platformUserId || null,
        text: displayQQFaces(m.content),
        html: null,
        files: m.files && m.files.length ? m.files : undefined,
        quotedText: m.quotedText || undefined,
        time: new Date(m.createdAt).toLocaleTimeString('zh', { hour: '2-digit', minute: '2-digit' }),
      }
    })
    contentH.value = SMALL_H; _sessionTurn = 0
    await nextTick()
    _baseScrollH = messagesEl.value?.scrollHeight || 0   // 基线 = 切入会话的历史高度
    scrollBottom(true)
    if (data.active) resumeStream(id)   // 该会话后端正在生成 → 重连续看
  } catch {}
}

async function newSession() {
  ++_chatViewGeneration
  abortCtrl.value?.abort()
  streaming.value = false
  sessionId.value = null
  messages.value = []        // 大窗「新对话」是干净起手——不放默认问候（问候只在打开小窗时出现）
  _sessionTurn = 0
  await nextTick()
  expInputEl.value?.focus()
}

async function deleteSession(id: number) {
  try {
    await agentApi.deleteSession(String(id))
    sessions.value = sessions.value.filter(s => s.id !== id)
    if (sessionId.value === id) await newSession()
  } catch {}
}

function textareaWidthForMode(isExpanded: boolean) {
  if (!isExpanded) {
    // 小窗：左右内边距 13px、两个 16px 附件按钮、28px 发送按钮和三段 8px 间距。
    return SMALL_W - 26 - 16 - 16 - 28 - 24
  }
  const left = Math.max(SIDEBAR_W + 12, vw.value * 0.4 - 12)
  const mainWidth = vw.value - left - 12 - 210
  // 大窗：左右内边距 20px、两个 16px 附件按钮、32px 发送按钮和三段 10px 间距。
  return Math.max(0, mainWidth - 40 - 16 - 16 - 32 - 30)
}

function fitTextarea(isExpanded = expanded.value) {
  // 切换时 chat-window 的四条边都在过渡，直接读真实 textarea 只能拿到“当前帧”的宽度。
  // 克隆到离屏节点按目标宽度量 scrollHeight，点击瞬间就能得到目标模式的正确行数。
  const el = expInputEl.value
  if (!el) return
  const width = textareaWidthForMode(isExpanded)
  if (!width) return
  const style = getComputedStyle(el)
  const sizer = document.createElement('textarea')
  sizer.value = el.value
  sizer.rows = 1
  sizer.setAttribute('aria-hidden', 'true')
  Object.assign(sizer.style, {
    position: 'fixed',
    visibility: 'hidden',
    pointerEvents: 'none',
    left: '-9999px',
    top: '0',
    width: `${width}px`,
    height: 'auto',
    minHeight: '0',
    maxHeight: 'none',
    overflow: 'hidden',
    boxSizing: style.boxSizing,
    padding: style.padding,
    border: style.border,
    font: style.font,
    letterSpacing: style.letterSpacing,
    lineHeight: style.lineHeight,
    whiteSpace: style.whiteSpace,
    wordBreak: style.wordBreak,
    overflowWrap: style.overflowWrap,
    tabSize: style.tabSize,
  })
  document.body.appendChild(sizer)
  const height = Math.min(sizer.scrollHeight, 120)
  sizer.remove()
  el.style.height = `${height}px`
}
function autoResize(e: Event) {
  const el = e.target as HTMLTextAreaElement; el.style.height = 'auto'
  el.style.height = Math.min(el.scrollHeight, 120) + 'px'
}

// streaming 跟随意图：只有用户主动上翻才取消，回到底部附近恢复。
const stick   = ref(true)
let _lastTop  = 0     // 上次（多为程序化）滚动后的 scrollTop，用于判别用户上翻

// streaming 用即时滚动跟随，避免 smooth 叠加追不上。用虚拟列表的 scrollToIndex 而不是
// 直接写 scrollTop——最后一条消息的高度可能还只是估算值（还没被 measureElement 量过），
// scrollToIndex 会按当前最新的测量/估算结果算，比直接读 scrollHeight 更准。
function scrollToBottom(smooth = false) {
  const idx = messages.value.length - 1
  if (idx < 0) return
  virtualizer.value.scrollToIndex(idx, { align: 'end', behavior: smooth ? 'smooth' : 'auto' })
  _lastTop = messagesEl.value?.scrollTop ?? 0   // 记录落点：程序化滚动产生的 scroll 事件不会误判为上翻
}

// 用户上翻 → 停住；滚回接近底部 → 恢复跟随。messagesEl 是真实可滚动容器，scrollHeight
// 由虚拟列表的占位高度撑出来，即使视口外的消息没挂 DOM，这个距离判断依然准确。
function onMsgScroll() {
  const el = messagesEl.value; if (!el) return
  const dist = el.scrollHeight - el.scrollTop - el.clientHeight
  stick.value = dist < 40
  _lastTop = el.scrollTop
}

// 用户发送时强制即时跳到底（大窗用 smooth 会被随后出现的 thinking 气泡/内容打断，看着没到底）；
// 再补一帧 rAF，兜住附件缩略图/气泡迟一拍布局导致的高度变化
async function scrollBottom(force = false) {
  await nextTick()
  const el = messagesEl.value; if (!el) return
  syncSmallH()   // 发送/加载后按内容真实高度更新窗口高（含刚加的用户气泡）
  if (force) {
    stick.value = true
    scrollToBottom()
    requestAnimationFrame(() => { if (stick.value) scrollToBottom() })
  }
  else if (stick.value) scrollToBottom()
}

watch(messagesEl, (el, oldEl) => {
  oldEl?.removeEventListener('scroll', onMsgScroll)
  if (!el) return
  el.addEventListener('scroll', onMsgScroll, { passive: true })
})

onUnmounted(() => {
  messagesEl.value?.removeEventListener('scroll', onMsgScroll)
  _stopImPoll()
})

// 消费一条 SSE 流，把事件渲染进消息列表。send（POST /chat）和续看（GET .../stream）共用。
// 返回 { aiIdx, usedTools }，供调用方做收尾（首条空回复兜底、刷新视图）。
async function consumeStream(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  ownerSid: number | null,
  viewGeneration = _chatViewGeneration,
) {
  const decoder = new TextDecoder()
  let buf = '', aiIdx = -1, aborted = false
  let sid = ownerSid           // 本流归属的会话（新对话在 session_id 事件前为 null）
  let detached = false         // 一旦用户切到别的会话，本流永久脱离、不再污染当前视图
  const usedTools = new Set<string>()
  // 当前看的还是本流的会话吗？切走后置 detached（之后切回靠 loadSession 干净重载，不半路重接）
  const live = () => {
    if (detached || viewGeneration !== _chatViewGeneration) {
      detached = true
      return false
    }
    if (sessionId.value !== (sid ?? ownerSid)) { detached = true; return false }
    return true
  }
  try {
    while (true) {
      let chunk
      try { chunk = await reader.read() }
      catch (e: any) { if (e?.name === 'AbortError') { aborted = true; break; } throw e }   // 切会话会 abort：优雅收尾，别当网络错
      const { done, value } = chunk
      if (done) break
      buf += decoder.decode(value, { stream: true })
      const lines = buf.split('\n'); buf = lines.pop() ?? ''
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue
        const raw = line.slice(6).trim(); if (!raw) continue
        let evt; try { evt = JSON.parse(raw) } catch { continue }
        if (evt.type === 'session_id') {
          const isNew = sessionId.value !== evt.session_id
          // 仅当用户仍停在本流视图（旧会话或新对话）才把视图切到新 id，否则别抢走用户当前会话
          if (viewGeneration === _chatViewGeneration && sessionId.value === (sid ?? ownerSid)) {
            sessionId.value = evt.session_id
          }
          sid = evt.session_id
          if (isNew) await fetchSessions()
        } else if (evt.type === 'session_title') {
          const s = sessions.value.find(s => s.id === sid)   // 按本流会话更新标题，与当前视图无关
          if (s) s.title = evt.title
        } else if (evt.type === '_new_round') {
          // 后端新一轮开始（sanitizer 已重置），前端无需变更视觉状态
        } else if (evt.type === 'tool_call') {
          if (evt.name && !evt.name.startsWith('_')) usedTools.add(evt.name)  // 跳过 _preparing 占位
          // label 已由后端解析（含「状态命名」覆盖 + 复查前缀）；气泡常驻，仅替换文字。
          if (live()) setStatus({ kind: 'text', label: evt.label || evt.name })
        } else if (evt.type === 'tool_done') {
          // 改动类工具一完成就即时 bump 对应资源（走已连好的对话流，不等回合末、不靠 best-effort
          // 的 events SSE）→ 文件预览 / 项目卡 / 日历当场刷新。视图是全局的，切走也该刷，故不受 live() 限制。
          if (evt.name) {
            if (_FILE_TOOLS.has(evt.name)) liveStore.bump('files')
            else if (_PROJECT_TOOLS.has(evt.name)) liveStore.bump('projects')
            else if (_CALENDAR_TOOLS.has(evt.name)) liveStore.bump('calendar')
          }
          // 任一工具结束都回到思考态；下一轮工具调用会继续替换文字，不能让气泡闪退。
          if (live()) setStatus(_thinkingItem())
        } else if (evt.type === 'token') {
          if (live()) {
            clearStatus()   // 真回复开始 → 打断状态队列、收起指示，让位给流式正文
            if (aiIdx === -1) playIncomingMessageSfx()
            if (aiIdx === -1) { messages.value.push({ id: mkid(), role: 'ai', text: '', time: now(), streaming: true }); aiIdx = messages.value.length - 1 }
            messages.value[aiIdx].text += evt.content
            await scrollBottom()
          }
        } else if (evt.type === 'file') {
          if (live()) {
            clearStatus()
            if (aiIdx === -1) playIncomingMessageSfx()
            if (aiIdx === -1) { messages.value.push({ id: mkid(), role: 'ai', text: '', time: now(), streaming: true }); aiIdx = messages.value.length - 1 }
            const m = messages.value[aiIdx]
            if (!m.files) m.files = []
            m.files.push(evt.file)
            await scrollBottom()
          }
        } else if (evt.type === 'done') {
          if (live()) clearStatus()
        } else if (evt.type === 'error') {
          if (live()) {
            clearStatus()
            playGuguSfx('error')
            messages.value.push({ id: mkid(), role: 'ai', text: evt.message || evt.detail || '咕咕开小差了 😵‍💫 麻烦再说一遍好吗？', time: now() })
            aiIdx = messages.value.length - 1
            await scrollBottom()
          }
        }
      }
    }
  } finally {
    if (!detached && viewGeneration === _chatViewGeneration && aiIdx !== -1 && messages.value[aiIdx]) {
      const m = messages.value[aiIdx]
      m.streaming = false
      m.html = renderMd(m.text)
      if (!m.text?.trim() && !m.files?.length) {
        messages.value.splice(aiIdx, 1)
      }
    }
  }
  return { aiIdx, usedTools, detached, sid, aborted }
}

// 续看：打开会话时若它正在生成（messages 接口返回 active），重连看后端跑完。
async function resumeStream(id: number) {
  if (streaming.value) return            // 本地正在发/看，不重复连
  const viewGeneration = _chatViewGeneration
  const token = localStorage.getItem('user_token') ?? ''
  abortCtrl.value = new AbortController()   // 让下次切会话能 abort 掉这条续看
  streaming.value = true; clearStatus(); setStatus(_thinkingItem())
  try {
    const res = await fetch(`${BASE_URL}/agent/sessions/${id}/stream`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      signal: abortCtrl.value.signal,
    })
    if (!res.ok) return
    if (viewGeneration !== _chatViewGeneration || sessionId.value !== id) return   // 期间又切走了，丢弃
    if (!res.body) return
    const r = await consumeStream(res.body.getReader(), id, viewGeneration)
    refreshAfterTools(r.usedTools)
  } catch { /* 续看失败/被切走中断都不打扰 */ }
  finally {
    // 仍停在本会话才收尾全局指示，避免切走后清掉新会话续看的状态
    if (viewGeneration === _chatViewGeneration && sessionId.value === id) {
      clearStatus(); streaming.value = false; abortCtrl.value = null
    }
  }
}

async function send(forcedText?: string) {
  // forcedText 来自"排队接力"（队首消息）：此时用户气泡已在入队时显示过，不重复推
  const fromInput = forcedText === undefined
  const text = (fromInput ? inputText.value : (forcedText ?? '')).trim()
  const atts = fromInput ? pendingAtt.value.slice() : []   // 本次随消息发的附件
  if (!text && !atts.length) return
  if (fromInput) {
    _sessionTurn++
    messages.value.push({ id: mkid(), role: 'user', text, time: now(),
      files: atts.length ? atts.map(a => ({ name: a.name, ext: a.ext, size_bytes: a.size, attach_id: a.attach_id, kind: a.kind, duration: a.duration, upload: true, _thumbUrl: a._thumbUrl, img_width: a.img_width, img_height: a.img_height })) : undefined })
    inputText.value = ''
    pendingAtt.value = []
    if (expInputEl.value) expInputEl.value.style.height = 'auto'
    trackApi.track('chat_message', { turn: _sessionTurn }).catch(() => {})
    await scrollBottom(true)
  }
  // 生成中：把这条排队，等当前流式结束后在 finally 里接着发（气泡已显示）
  if (streaming.value) { pendingQueue.value.push(text); return }

  streaming.value = true; clearStatus(); setStatus(_thinkingItem())
  abortCtrl.value = new AbortController()
  await scrollBottom()
  const token = localStorage.getItem('user_token') ?? ''
  const ownerSid = sessionId.value   // 本次发送归属的会话（新对话为 null，流里拿到 id 后回填）
  const viewGeneration = _chatViewGeneration
  let resolvedSid = ownerSid         // 流里 session_id 事件后回填成真实 id
  let aiIdx = -1
  const usedTools = new Set<string>()

  // 新会话且当前显示着默认问候 → 把问候随首条消息带给后端，落为本会话首条 assistant 消息，
  // 这样咕咕回复时能看到「自己已经打过招呼」，不会把用户对问候的回复当成对话刚开始。
  const _g0 = messages.value[0]
  const greetingForSession = (ownerSid == null && _g0?._greeting) ? (_g0._greetFull || _g0.text || '') : ''

  try {
    const res = await fetch(`${BASE_URL}/agent/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Client-Id': CLIENT_ID, ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify({ message: text, session_id: ownerSid, attachments: atts.map(a => a.attach_id),
                             ...(greetingForSession ? { greeting: greetingForSession } : {}) }),
      signal: abortCtrl.value.signal,
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    if (!res.body) throw new Error('empty response body')

    const r = await consumeStream(res.body.getReader(), ownerSid, viewGeneration)
    resolvedSid = r.sid
    aiIdx = r.aiIdx
    r.usedTools.forEach(t => usedTools.add(t))
    // 用户中途切走了 → 别把兜底气泡塞进当前别的会话视图（回复已在后端，切回会重载）
    if (aiIdx === -1 && !r.detached && !r.aborted) {
      messages.value.push({ id: mkid(), role: 'ai', text: '收到，但没有收到回复，请稍后再试。', time: now() })
      await scrollBottom()
    }
  } catch (e: any) {
    if (e?.name !== 'AbortError' && sessionId.value === resolvedSid) {
      // fetch 抛错=连不上咕咕后端，基本都是网络问题（仅在仍停在本会话时报）
      clearStatus()
      messages.value.push({ id: mkid(), role: 'ai', text: '咕咕网络不太好 📡 可以再发一遍吗？', time: now() })
      await scrollBottom()
    }
  } finally {
    // 仍停在本次发送的会话才收尾全局状态；切走后这些状态归新会话的续看流管，别清掉
    const ownsView = viewGeneration === _chatViewGeneration && sessionId.value === resolvedSid
    if (ownsView) {
      // 流式结束：把该条 AI 消息标记为非流式，触发 markdown 渲染（流式中按纯文本显示，避免半截表格/代码块闪烁）
      if (aiIdx !== -1 && messages.value[aiIdx]) messages.value[aiIdx].streaming = false
      clearStatus(); streaming.value = false; abortCtrl.value = null
      loadQuota()   // 回复消耗精力，刷新一次——耗尽时顶部状态即时变「休息中」
      // markdown 重渲染后内容变高，MutationObserver 此时已因 streaming=false 停止跟随，
      // 需在 nextTick 后再滚一次，否则底部时间戳会被截掉
      await scrollBottom()
    }
    // 咕咕若调用了改数据的工具，刷新对应前端视图（项目/日历/文件），免手动刷新页面
    refreshAfterTools(usedTools)
    // 生成期间排队的消息：取队首接着发（其自身 finally 会继续取下一条，逐条处理）
    if (ownsView && pendingQueue.value.length) send(pendingQueue.value.shift())
  }
}
</script>

<style scoped>
/* ── 悬浮球 ── */
.ai-fab {
  position: fixed; bottom: var(--floating-edge); right: var(--floating-edge);
  isolation: isolate; width: 50px; height: 50px; border-radius: 50%;
  background: linear-gradient(135deg, #7b7fb2, #9590c4); border: none;
  cursor: pointer;   /* z-index 由 :style 动态(fabZ)：默认在窗口带之上，大窗口展开时压到其下，见 script */
  display: flex; align-items: center; justify-content: center;
  box-shadow: 0 4px 18px rgba(123,127,178,0.32), inset 0 1px 0 rgba(255,255,255,0.45);
  transition: transform 0.2s, box-shadow 0.2s;
}
.ai-fab:hover { transform: scale(1.08); box-shadow: 0 7px 24px rgba(123,127,178,0.42), inset 0 1px 0 rgba(255,255,255,0.5); }
.ai-fab svg { position: relative; z-index: 1; }
.ai-fab-spin { animation: fab-spin 8s linear infinite; transform-origin: center; }
@keyframes fab-spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
.ai-fab--playing::before, .ai-fab--playing::after {
  content: ''; position: absolute; inset: 0; border-radius: 50%;
  border: 1.5px solid rgba(123,127,178,0.75); pointer-events: none;
  animation: fab-ripple 3.6s ease-out infinite;
}
.ai-fab--playing::after { animation-delay: 1.8s; }
@keyframes fab-ripple { 0% { transform: scale(0.4); opacity: 0.8; } 100% { transform: scale(1.55); opacity: 0; } }
@keyframes fab-typing {
  0%   { transform: translateY(0); }
  50%  { transform: translateY(-2px); }
  100% { transform: translateY(0); }
}
.ai-fab--typing { animation: fab-typing 0.2s linear 1; }

/* ── 单一聊天窗口 ── */
.chat-window {
  position: fixed;
  /* z-index 由 :style 动态(统一窗口带,点谁谁上) */
  border: 1px solid rgba(255,255,255,0.7);
  border-radius: 20px;
  overflow: hidden;
  box-shadow: 0 24px 64px rgba(20,25,50,0.18);
  will-change: top, left, right, bottom;
}
.chat-window::after {
  content: '';
  position: absolute; inset: 0;
  border-radius: 20px;
  box-shadow: inset 0 1px 0 rgba(255,255,255,0.95), inset 1px 0 0 rgba(255,255,255,0.55), inset 0 -1px 0 rgba(255,255,255,0.3);
  pointer-events: none;
  z-index: 100;
}

/* 主区域负责背景 blur */
.chat-main {
  background: var(--panel-bg);
  backdrop-filter: var(--glass-blur);
  -webkit-backdrop-filter: var(--glass-blur);
  transform: translateZ(0);
}

/* 位移过渡放在 CSS，不放 inline style（避免覆盖 Vue transition 的 opacity/transform） */
.chat-window {
  transition: top 0.42s cubic-bezier(0.16, 1, 0.3, 1),
              left 0.42s cubic-bezier(0.16, 1, 0.3, 1),
              right 0.42s cubic-bezier(0.16, 1, 0.3, 1),
              bottom 0.42s cubic-bezier(0.16, 1, 0.3, 1);
}
/* 小窗流式增高：top 即时跟随内容（去掉 0.42s 缓动，否则窗口高度滞后于出字、一跳一跳）。
   left/right/bottom 保留缓动用于开关/位移动画；流式中它们不变，无副作用。 */
.chat-window.win-grow {
  transition: left 0.42s cubic-bezier(0.16, 1, 0.3, 1),
              right 0.42s cubic-bezier(0.16, 1, 0.3, 1),
              bottom 0.42s cubic-bezier(0.16, 1, 0.3, 1);
}


/* 窗口开/关动画（从右下角 fab 原点缩放），!important 覆盖上方位移 transition */
/* 入场：极快启动、平滑减速（无过冲）；出场：平滑加速收缩 */
.chat-open-enter-active {
  transition: opacity 0.22s ease, transform 0.36s cubic-bezier(0.16, 1, 0.3, 1) !important;
  transform-origin: right bottom;
}
.chat-open-leave-active {
  transition: opacity 0.18s ease-in, transform 0.22s cubic-bezier(0.7, 0, 0.84, 0) !important;
  transform-origin: right bottom;
}
.chat-open-enter-from, .chat-open-leave-to { opacity: 0; transform: scale(0.78); }

/* ── 拖入附件遮罩 ── */
.chat-drop-overlay {
  position: absolute; inset: 0; z-index: 120;
  display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 10px;
  pointer-events: none;   /* 让拖拽事件穿透到 .chat-window，drop/dragleave 才能正常触发 */
  background: rgba(123,127,178,0.16);
  backdrop-filter: blur(3px); -webkit-backdrop-filter: blur(3px);
  border: 2px dashed rgba(123,127,178,0.6); border-radius: 20px;
  color: var(--color-primary); font-size: 14px; font-weight: 600;
}
.chat-drop-fade-enter-active, .chat-drop-fade-leave-active { transition: opacity 0.15s ease; }
.chat-drop-fade-enter-from, .chat-drop-fade-leave-to { opacity: 0; }

/* ── 单一布局 ── */
.chat-window { display: flex; }
.chat-main { flex: 1; min-width: 0; display: flex; flex-direction: column; }

.chat-header {
  display: flex; align-items: center; gap: 9px;
  padding: 13px 14px 10px;
  border-bottom: 1px solid rgba(255,255,255,0.5);
  flex-shrink: 0;
}
.chat-main.is-expanded .chat-header { padding: 16px 20px 12px; }
.chat-title { font-size: 13px; font-weight: 700; flex: 1; }
.chat-main.is-expanded .chat-title { font-size: 14px; font-weight: 600; }
.popup-status { font-size: 11px; color: var(--color-success); display: flex; align-items: center; gap: 4px; }
.status-dot { display: inline-block; width: 6px; height: 6px; border-radius: 50%; background: var(--color-success); transition: background .15s, box-shadow .15s; }
/* 离线：克制的暗示——灰点、弱化文字、可点；只在 hover 才微微亮起（点用暖色 + 细光环），平时不抢眼 */
.popup-status.is-offline { color: var(--text-secondary); cursor: pointer; opacity: .85; transition: color .15s, opacity .15s; }
.popup-status.is-offline .status-dot { background: var(--text-secondary); }
.popup-status.is-offline:hover { opacity: 1; color: var(--text-primary); }
.popup-status.is-offline:hover .status-dot { background: var(--color-warning); box-shadow: 0 0 0 3px rgba(176, 120, 88, 0.22); }
/* 休息中（精力耗尽）：暖色、点轻微呼吸，不可点 */
.popup-status.is-resting { color: var(--color-warning); cursor: default; }
.popup-status.is-resting .status-dot { background: var(--color-warning); animation: restPulse 1.8s ease-in-out infinite; }
@keyframes restPulse { 0%, 100% { opacity: 1; } 50% { opacity: .35; } }
/* 点击离线后，IM 区短暂高亮一下引导视线（不留痕） */
.im-plat-group { border-radius: 10px; }
.im-plat-group.im-flash { animation: imFlash 2.4s ease-out 1; }
@keyframes imFlash {
  0%, 100% { box-shadow: 0 0 0 0 rgba(123, 127, 178, 0); }
  14%      { box-shadow: 0 0 0 2px rgba(123, 127, 178, 0.55); }
  60%      { box-shadow: 0 0 0 2px rgba(123, 127, 178, 0.28); }
}
.btn-group { display: flex; align-items: center; gap: 2px; }

.popup-icon-btn {
  width: 26px; height: 26px; border-radius: 7px; border: none;
  background: none; color: var(--text-secondary);
  display: flex; align-items: center; justify-content: center;
  cursor: pointer; transition: background 0.12s, color 0.12s;
}
.popup-icon-btn:hover { background: rgba(123,127,178,0.12); color: var(--color-primary); }
.popup-icon-btn svg { display: block; }
.popup-close-btn {
  width: 26px; height: 26px; border-radius: 7px; border: none;
  background: none; color: var(--text-secondary);
  display: flex; align-items: center; justify-content: center;
  cursor: pointer; transition: background 0.12s, color 0.12s;
}
.popup-close-btn svg { display: block; }
.popup-close-btn:hover { background: rgba(200,80,80,0.1) !important; color: rgba(200,80,80,0.8) !important; }

.chat-messages {
  flex: 1; overflow-y: auto; overflow-x: hidden; position: relative;
}
.chat-main.is-expanded .chat-messages .msg-bubble { max-width: 72%; font-size: 14px; }
.chat-main.is-expanded .chat-messages .msg-quoted { max-width: 72%; font-size: 13.5px; }
/* 虚拟列表占位容器：高度由 JS 撑出来（虚拟内容高度 + 顶部留白），撑出的空间给绝对定位的消息行腾地方 */
.msg-virtual-spacer { position: relative; width: 100%; }
/* 绝对定位的行不认祖先的 padding（top:0/left:0 是相对边框盒，不是内容盒），
   横向留白（原来 .chat-messages 的左右 padding）和「gap」只能各自摆在每一行自己身上，
   用 box-sizing:border-box 保证不溢出 100% 宽度。 */
.msg-virtual-row { position: absolute; top: 0; left: 0; width: 100%; box-sizing: border-box; padding: 0 13px 8px; }
.chat-main.is-expanded .msg-virtual-row { padding: 0 24px 12px; }
/* 状态指示气泡不在虚拟列表里，是紧跟在占位容器后面的普通流内元素，补回同款左右留白 + gap */
.chat-messages > .msg { margin: 8px 13px 12px; }
.chat-main.is-expanded .chat-messages > .msg { margin: 12px 24px 20px; }

.chat-att-row { display: flex; flex-wrap: wrap; gap: 6px; padding: 0 4px 6px; }
.chat-att-chip { display: flex; align-items: center; gap: 5px; max-width: 180px;
  padding: 3px 8px; border-radius: 8px; font-size: 11px; color: var(--color-primary);
  background: rgba(123,127,178,0.1); border: 1px solid rgba(123,127,178,0.2); }
.chat-att-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.chat-att-x { background: none; border: none; cursor: pointer; color: var(--color-primary);
  font-size: 13px; line-height: 1; padding: 0; opacity: 0.6; }
.chat-att-x:hover { opacity: 1; }
.chat-att-chip.att-up { color: var(--text-secondary); background: rgba(0,0,0,0.04); border-color: rgba(0,0,0,0.08); }
.att-btn { flex-shrink: 0; background: none; border: none; cursor: pointer; color: var(--text-secondary);
  display: flex; align-items: center; justify-content: center; height: 28px; padding: 0;
  opacity: 0.7; transition: opacity 0.15s, color 0.15s; }   /* 与发送按钮(28)等高，底对齐时中心也对齐 */
.chat-main.is-expanded .att-btn { height: 32px; }   /* 放大态对齐放大发送按钮(32) */
.att-btn:hover { opacity: 1; color: var(--color-primary); }
.chat-input-row {
  display: flex; align-items: flex-end; gap: 8px;   /* 输入框多行增高时，附件/发送按钮贴底对齐 */
  padding: 10px 13px;
  border-top: 1px solid rgba(255,255,255,0.65);
  background: rgba(255,255,255,0.55);
  backdrop-filter: blur(12px);
  -webkit-backdrop-filter: blur(12px);
  box-shadow: inset 0 1px 0 rgba(255,255,255,0.9);
  flex-shrink: 0;
}
.chat-main.is-expanded .chat-input-row { padding: 14px 20px; gap: 10px; }
/* 录音条：录音时替换输入框 */
.rec-bar { flex: 1; display: flex; align-items: center; gap: 7px; font-size: 13px; color: var(--text-primary); height: 28px; min-width: 0; }   /* 与按钮(28)等高 → flex-end 底对齐时内容也居中对齐，不再偏低 */
.chat-main.is-expanded .rec-bar { height: 32px; }   /* 放大态对齐 32 */
.rec-dot { width: 8px; height: 8px; border-radius: 50%; background: #e15c5c; flex-shrink: 0; animation: rec-pulse 1s ease-in-out infinite; }
@keyframes rec-pulse { 0%,100% { opacity: 1; } 50% { opacity: 0.3; } }
.rec-time { font-variant-numeric: tabular-nums; font-weight: 600; color: #e15c5c; }
.rec-hint { color: var(--text-secondary); font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.rec-cancel { margin-left: auto; flex-shrink: 0; border: none; background: rgba(123,127,178,0.12); color: var(--text-secondary); font-size: 12px; padding: 3px 10px; border-radius: 999px; cursor: pointer; }
.rec-cancel:hover { background: rgba(123,127,178,0.2); }
.chat-input-row input {
  flex: 1; border: none; background: none;
  font-size: 13px; color: var(--text-primary);
  outline: none; font-family: var(--font-sans);
  line-height: 1.5; padding: 2px 0;
}
.chat-input-row textarea {
  flex: 1; border: none; background: none;
  font-size: 14px; color: var(--text-primary);
  outline: none; font-family: var(--font-sans);
  resize: none; line-height: 1.5; max-height: 120px; overflow-y: auto;
  display: block; padding: 4px 0; vertical-align: middle;
}
/* 大窗的附件/发送按钮为 32px；单行输入也占满同一高度，图标和文字的视觉中线才一致。 */
.chat-main.is-expanded .chat-input-row textarea { padding: 5.5px 0; }
/* 小窗输入字号略小，与小窗整体一致 */
.chat-main:not(.is-expanded) .chat-input-row textarea { font-size: 13px; }

.exp-sidebar {
  width: 210px; flex-shrink: 0;
  display: flex; flex-direction: column;
}
.exp-sidebar-header {
  display: flex; align-items: center;
  padding: 16px 14px 12px;
  flex-shrink: 0;
}
.exp-sidebar-divider {
  height: 1px; flex-shrink: 0; margin: 0 4px;
  background: linear-gradient(90deg, transparent 0%, rgba(0,0,0,0.07) 20%, rgba(0,0,0,0.07) 80%, transparent 100%);
}
.exp-group-divider {
  height: 1px; flex-shrink: 0; margin: 4px 2px;
  background: linear-gradient(90deg, transparent 0%, rgba(0,0,0,0.07) 20%, rgba(0,0,0,0.07) 80%, transparent 100%);
}
.exp-sidebar-title { flex: 1; font-size: 14px; font-weight: 700; color: var(--text-primary); text-align: center; }

.exp-new-session-wrap {
  padding: 10px 10px 12px;
  flex-shrink: 0;
}
.exp-new-session-btn {
  width: 100%; display: flex; align-items: center; justify-content: center; gap: 6px;
  padding: 9px 14px; border-radius: var(--radius-sm); cursor: pointer;
  font-size: 12.5px; font-weight: 700; font-family: var(--font-sans);
  color: var(--color-primary);
  background: rgba(255,255,255,0.82);
  border: 1px solid rgba(255,255,255,0.95);
  box-shadow: 0 2px 8px rgba(123,127,178,0.12), inset 0 1px 0 rgba(255,255,255,1);
  transition: background 0.15s, box-shadow 0.15s;
}
.exp-new-session-btn:hover {
  background: rgba(255,255,255,0.95);
  box-shadow: 0 5px 16px rgba(123,127,178,0.22), inset 0 1px 0 rgba(255,255,255,1);
}
.exp-new-session-btn:active {
  transform: translateY(1px);
  box-shadow: 0 1px 4px rgba(123,127,178,0.1), inset 0 1px 0 rgba(255,255,255,1);
  transition: transform 0.05s, box-shadow 0.05s;
}
.exp-new-session-btn svg { display: block; }
.exp-icon-btn {
  width: 28px; height: 28px; border-radius: 8px; border: none;
  background: none; color: var(--text-secondary);
  display: flex; align-items: center; justify-content: center;
  cursor: pointer; transition: background 0.12s, color 0.12s; flex-shrink: 0;
}
.exp-icon-btn:hover { background: rgba(123,127,178,0.12); color: var(--color-primary); }
.exp-icon-btn svg { display: block; }

.exp-session-list {
  flex: 1; overflow-y: auto;
  padding: 8px;
  display: flex; flex-direction: column; gap: 2px;
}
.exp-session-item {
  display: flex; align-items: center; gap: 6px;
  padding: 8px 10px; border-radius: 9px; cursor: pointer;
  transition: background 0.12s;
}
.exp-session-item:hover { background: rgba(255,255,255,0.55); }
.exp-session-item.active { background: rgba(123,127,178,0.12); }
.exp-session-item.active .exp-session-title { font-weight: 700; }
.exp-session-title {
  flex: 1; font-size: 12.5px; color: var(--text-primary);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.exp-session-del {
  width: 20px; height: 20px; border-radius: 5px; border: none;
  background: none; color: var(--text-secondary);
  display: flex; align-items: center; justify-content: center;
  cursor: pointer; opacity: 0; transition: opacity 0.12s, background 0.12s; flex-shrink: 0;
}
.exp-session-item:hover .exp-session-del { opacity: 1; }
.exp-session-del:hover { background: rgba(200,80,80,0.1); color: rgba(200,80,80,0.8); }
.exp-session-del svg { display: block; }
.exp-session-empty { font-size: 12px; color: var(--text-secondary); padding: 12px 10px; }
.exp-session-source {
  flex-shrink: 0; font-size: 11px; font-weight: 600; line-height: 1;
  font-family: var(--font-sans); letter-spacing: 0.01em;
  padding: 2px 5px; border-radius: 4px;
}
.exp-session-source.src-qq { background: rgba(18,183,245,0.15); color: #0c8fc0; }
.exp-session-source.src-feishu { background: rgba(66,133,244,0.15); color: #3b6fc4; }
.exp-session-tag {
  flex-shrink: 0; font-size: 10.5px; font-weight: 600; line-height: 1;
  font-family: var(--font-sans);
  padding: 2px 4px; border-radius: 4px;
  background: rgba(123,127,178,0.15); color: #6a6ea3;
}

/* IM 平台抽屉（飞书 / QQ） */
.im-plat { display: flex; flex-direction: column; }
.im-plat-head {
  display: flex; align-items: center; gap: 7px;
  padding: 8px 10px; border-radius: 9px; border: none; cursor: pointer;
  background: none; font-family: var(--font-sans);
  transition: background 0.12s;
}
.im-plat-head:hover { background: rgba(255,255,255,0.55); }
.im-plat-head.open { background: rgba(123,127,178,0.08); }
.im-plat-chev { color: var(--text-secondary); transition: transform 0.18s ease; flex-shrink: 0; }
.im-plat-chev.open { transform: rotate(-180deg); }
.im-plat-name { flex: 1; text-align: left; font-size: 12.5px; font-weight: 700; color: var(--text-primary); }
.im-plat-badge {
  flex-shrink: 0; font-size: 10.5px; font-weight: 600; line-height: 1;
  padding: 2px 6px; border-radius: 4px;
  background: rgba(123,127,178,0.12); color: var(--text-secondary);
}
.im-plat-badge.on { background: rgba(74,180,120,0.16); color: #2f9e63; }
.im-plat-body {
  display: flex; flex-direction: column; gap: 2px;
  padding: 2px 0 6px;
}
.im-connect-btn {
  width: 100%; display: flex; align-items: center; justify-content: center; gap: 6px;
  margin: 4px 0 2px;
  padding: 9px 14px; border-radius: var(--radius-sm); cursor: pointer;
  font-size: 12.5px; font-weight: 700; font-family: var(--font-sans);
  color: var(--color-primary);
  background: rgba(255,255,255,0.82);
  border: 1px solid rgba(255,255,255,0.95);
  box-shadow: 0 2px 8px rgba(123,127,178,0.12), inset 0 1px 0 rgba(255,255,255,1);
  transition: background 0.15s, box-shadow 0.15s;
}
.im-connect-btn:hover:not(:disabled) {
  background: rgba(255,255,255,0.95);
  box-shadow: 0 5px 16px rgba(123,127,178,0.22), inset 0 1px 0 rgba(255,255,255,1);
}
.im-connect-btn:active:not(:disabled) {
  transform: translateY(1px);
  box-shadow: 0 1px 4px rgba(123,127,178,0.1), inset 0 1px 0 rgba(255,255,255,1);
  transition: transform 0.05s, box-shadow 0.05s;
}
.im-connect-btn:disabled { opacity: 0.6; cursor: default; }
.im-qr-box {
  display: flex; flex-direction: column; align-items: center; gap: 8px;
  padding: 12px 8px 10px;
}
.im-qr-canvas {
  width: 160px; height: 160px; border-radius: 10px;
  background: #fff; padding: 6px; box-sizing: border-box;
  box-shadow: 0 2px 10px rgba(123,127,178,0.18);
}
.im-qr-hint { font-size: 11.5px; color: var(--text-secondary); text-align: center; line-height: 1.5; }
.im-qr-err { font-size: 11.5px; color: rgba(200,80,80,0.9); padding: 4px 0; }

/* 咕咕回复里的动作按钮：md 里的 gugu:// 链接渲染成按钮（onChatActionClick 拦截点击）——
   跟全局 .press-fx 一套手感（悬停不上浮，只在按下时下沉），这些 <a> 是 markdown 渲染出来的、
   没法在模板里挂 class，数值直接写这里（hover/active 与全局 .press-fx 保持一致） */
.msg-bubble.md-body :deep(a[href^="gugu://"]) {
  display: inline-flex; align-items: center; gap: 5px;
  margin: 3px 4px 3px 0; padding: 5px 12px;
  font-size: 12.5px; font-weight: 600; text-decoration: none;
  color: #fff; background: linear-gradient(135deg, #7b7fb2, #9590c4);
  border-radius: 999px; box-shadow: 0 2px 8px rgba(123,127,178,0.28);
  cursor: pointer; transition: box-shadow 0.12s, transform 0.15s ease, opacity 0.15s ease; user-select: none;
}
.msg-bubble.md-body :deep(a[href^="gugu://"]:hover) {
  box-shadow: 0 4px 14px rgba(80,90,110,0.3); opacity: 1;
}
.msg-bubble.md-body :deep(a[href^="gugu://"]:active) { transform: translateY(1px); opacity: 0.93; }

/* 扫码绑定弹窗（聊天上弹小窗）*/
.cb-overlay {
  position: absolute; inset: 0; z-index: 50;
  display: flex; align-items: center; justify-content: center;
  /* 极轻遮罩、不压暗（仅用于点外面关闭 + 一点聚焦）——避免把弹窗玻璃衬得发灰发透，
     让它和右键菜单一样浮在亮内容上、显得更实 */
  background: rgba(0,0,0,0.04);
}
.cb-modal {
  /* 玻璃外观复用全局 .popup-menu（与右键菜单完全一致）；这里只管布局 + 固定宽度（防止加载前后变宽）*/
  display: flex; flex-direction: column; align-items: center; gap: 9px;
  width: 230px; box-sizing: border-box;
  padding: 18px 20px 14px;
}
.cb-title { font-size: 13.5px; font-weight: 700; color: var(--text-primary); }
.cb-qr {
  width: 168px; height: 168px; border-radius: 10px;
  background: #fff; padding: 6px; box-sizing: border-box;
  box-shadow: 0 2px 10px rgba(123,127,178,0.18);
}
.cb-hint, .cb-err {
  font-size: 11.5px; text-align: center; line-height: 1.5; max-width: 190px;
  min-height: 33px;          /* 预留 ~2 行：二维码/提示加载前后弹窗高度不跳 */
  display: flex; align-items: center; justify-content: center;
}
.cb-hint { color: var(--text-secondary); }
.cb-err  { color: rgba(200,80,80,0.9); }
.cb-cancel {
  margin-top: 2px; padding: 5px 16px; font-size: 12px;
  color: var(--text-secondary); background: rgba(123,127,178,0.1);
  border: none; border-radius: 999px; cursor: pointer;
}
.cb-cancel:hover { background: rgba(123,127,178,0.18); }
.im-qr-cancel {
  font-size: 11.5px; color: var(--text-secondary); background: none; border: none;
  cursor: pointer; padding: 3px 10px; border-radius: 6px; transition: background 0.12s;
}
.im-qr-cancel:hover { background: rgba(123,127,178,0.12); color: var(--text-primary); }

.exp-send-btn { width: 32px; height: 32px; border-radius: 9px; }

/* ── 通用发送按钮 ── */
.send-btn {
  width: 28px; height: 28px; border-radius: 8px; border: none;
  background: linear-gradient(135deg, #7b7fb2, #9590c4); color: white;
  cursor: pointer; display: flex; align-items: center; justify-content: center;
  transition: transform 0.15s; flex-shrink: 0;
}
.send-btn svg { display: block; }
.send-btn:hover:not(:disabled) { transform: scale(1.1); }
.send-btn:disabled { opacity: 0.55; cursor: default; }

/* ── 消息气泡 ── */
.msg { display: flex; flex-direction: column; min-width: 0; }
.msg.user { align-items: flex-end; }
.msg-search-flash { animation: msg-search-flash 1.8s ease forwards; border-radius: 12px; }
@keyframes msg-search-flash {
  0%   { background: rgba(123,127,178,0.18); }
  35%  { background: rgba(123,127,178,0.18); }
  100% { background: transparent; }
}

.msg.ai { align-items: flex-start; }
/* 群成员消息（非 owner、非咕咕）：左侧，跟 ai 同一侧但气泡样式区分开，避免跟
   咕咕的回复混淆。 */
.msg.member { align-items: flex-start; }
.msg-bubble {
  padding: 9px 13px; border-radius: 13px;
  font-size: var(--gugu-body-size); line-height: var(--gugu-body-line); max-width: 88%;
  word-break: break-word; overflow-wrap: break-word;
}
.msg.ai .msg-bubble {
  background: rgba(255,255,255,0.5); border: 1px solid rgba(255,255,255,0.65);
  border-bottom-left-radius: 4px; box-shadow: inset 0 1px 0 rgba(255,255,255,0.8);
}
.msg.member .msg-bubble {
  background: rgba(123,127,178,0.08); border: 1px solid rgba(123,127,178,0.18);
  border-bottom-left-radius: 4px;
}
.msg.user .msg-bubble {
  background: linear-gradient(135deg, #7b7fb2, #9590c4); color: white;
  border-bottom-right-radius: 4px;
}
.msg-speaker {
  font-size: 11px; color: var(--text-secondary); margin: 0 2px 3px;
  font-weight: 600;
}
/* 引用/回复预览条：浅色小字，跟正文气泡区分开——只是提示"引用了什么"，不是正文。
   截到 8 行，超出部分靠 hover 的原生 title 提示看全文，避免长引用只剩一小段看不出内容。 */
.msg-quoted {
  max-width: 88%; margin-bottom: 4px; padding: 6px 10px;
  font-size: 12.5px; line-height: 1.5; color: var(--text-secondary);
  background: rgba(123,127,178,0.08); border-left: 2.5px solid rgba(123,127,178,0.45);
  border-radius: 4px; white-space: pre-wrap; word-break: break-word;
  display: -webkit-box; -webkit-line-clamp: 8; -webkit-box-orient: vertical; overflow: hidden;
}
.msg-quoted-thumb {
  display: block; width: 112px; height: 112px; margin-top: 5px; object-fit: cover;
  border-radius: 8px; cursor: pointer; border: 1px solid rgba(123,127,178,0.18);
}
.msg-face-image-wrap {
  max-width: 150px; margin-top: 5px; cursor: pointer; line-height: 0;
}
.msg-face-image {
  display: block; width: 128px; height: 128px; max-width: 100%; object-fit: contain;
  border-radius: 12px;
}
/* 咕咕发来的文件卡片 */
.msg-files { display: flex; flex-direction: column; gap: 6px; margin-top: 6px; max-width: 88%; min-width: 0; }
/* 按下反馈来自全局 .press-fx（模板里已加）——只要点击下沉，不要悬停抬起：
   这条挤在其它消息气泡中间，抬起会显得跟旁边气泡割裂 */
.msg-file {
  display: flex; align-items: center; gap: 10px; padding: 9px 12px; cursor: pointer;
  max-width: 100%; box-sizing: border-box;
  /* 和 AI 气泡同款：半透明白 + 左下角小尾巴 + 内高光，营造气泡感 */
  background: rgba(255,255,255,0.5); border: 1px solid rgba(255,255,255,0.65);
  border-radius: 14px; border-bottom-left-radius: 5px;
  box-shadow: inset 0 1px 0 rgba(255,255,255,0.8), 0 1px 3px rgba(80,80,120,0.06);
  /* transform/opacity 是按下反馈(.press-fx)要用的——跟这里自己的 transition 写一起，
     避免两条规则的 transition 互相整体覆盖、丢掉其中一份 */
  transition: background 0.2s ease, box-shadow 0.25s ease,
    transform 0.15s ease, opacity 0.15s ease;
}
.msg-file.press-fx:hover {
  background: rgba(255,255,255,0.7);
  /* 覆盖全局 .press-fx.press-fx:hover 的按钮阴影，避免文件气泡 hover 瞬间换影。 */
  box-shadow: inset 0 1px 0 rgba(255,255,255,0.9), 0 3px 10px rgba(100,110,200,0.14) !important;
}
.msg-file-ext {
  position: relative; overflow: hidden;
  flex-shrink: 0; width: 34px; height: 34px; border-radius: 8px;
  display: flex; align-items: center; justify-content: center;
  font-size: 11px; font-weight: 700; color: #fff; letter-spacing: 0.02em;
  background: linear-gradient(135deg, #7b7fb2, #9590c4);
}
/* 图片附件：缩略图覆盖 ext 角标；加载失败时 @error 移除自身，露出底下角标 */
.msg-file-thumb {
  position: absolute; inset: 0; width: 100%; height: 100%;
  object-fit: cover; display: block;
}
.msg-file-info { flex: 1; display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.msg-file-name { font-size: 15px; font-weight: 500; color: #2a2c3a; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.msg-file-meta { font-size: 12px; color: #9296ad; }
.msg-file-dl { flex-shrink: 0; color: #7b7fb2; }
/* 语音条：迷你播放条（播放钮 + 波形 + 时长），和文件卡同款气泡质感 */
.msg-voice {
  display: inline-flex; align-items: center; gap: 9px; padding: 8px 13px; cursor: pointer;
  max-width: 100%; box-sizing: border-box; user-select: none;
  background: rgba(255,255,255,0.5); border: 1px solid rgba(255,255,255,0.65);
  border-radius: 14px; border-bottom-left-radius: 5px;
  box-shadow: inset 0 1px 0 rgba(255,255,255,0.8), 0 1px 3px rgba(80,80,120,0.06);
  transition: background 0.15s, box-shadow 0.15s;
}
.msg-voice:hover { background: rgba(255,255,255,0.72); box-shadow: inset 0 1px 0 rgba(255,255,255,0.9), 0 3px 10px rgba(100,110,200,0.14); }
.msg-voice .mv-btn {
  flex-shrink: 0; width: 26px; height: 26px; border-radius: 50%;
  display: flex; align-items: center; justify-content: center; color: #fff;
  background: linear-gradient(135deg, #7b7fb2, #9590c4); box-shadow: 0 1px 3px rgba(110,110,170,0.3);
}
.msg-voice .mv-wave { display: flex; align-items: center; gap: 2px; height: 18px; }
.msg-voice .mv-wave i { width: 2.5px; border-radius: 2px; background: #b0b2cc; transition: background 0.2s; }
.msg-voice.playing .mv-wave i { background: #8186bd; animation: mv-pulse 0.9s ease-in-out infinite; }
.msg-voice .mv-wave i:nth-child(even) { animation-delay: 0.15s; }
.msg-voice .mv-wave i:nth-child(3n) { animation-delay: 0.3s; }
@keyframes mv-pulse { 0%,100% { transform: scaleY(0.6); } 50% { transform: scaleY(1); } }
.msg-voice .mv-dur { font-size: 12.5px; color: #7e82a6; font-variant-numeric: tabular-nums; flex-shrink: 0; }
/* 用户(右侧)发的附件卡：气泡尾巴翻到右下、左下回正常圆角、容器右对齐 */
.msg.user .msg-files { align-items: flex-end; }
.msg.user .msg-file { border-bottom-left-radius: 14px; border-bottom-right-radius: 5px; }
.msg.user .msg-voice { border-bottom-left-radius: 14px; border-bottom-right-radius: 5px; }
.msg-footer {
  display: flex; align-items: center; gap: 4px;
  margin-top: 3px; padding: 0 3px;
}
.msg-time { font-size: 10px; color: var(--text-secondary); }
.msg-copy-btn {
  width: 18px; height: 18px; border-radius: 4px; border: none;
  background: none; color: var(--text-secondary);
  display: flex; align-items: center; justify-content: center;
  cursor: pointer; padding: 0; opacity: 0;
  transition: opacity 0.12s, background 0.12s, color 0.12s;
}
.msg:hover .msg-copy-btn { opacity: 1; }
.msg-copy-btn:hover { background: rgba(0,0,0,0.07); color: var(--color-primary); }
.msg-copy-btn svg { display: block; }

/* ── 思考/工具动画 ── */
.thinking { display: flex; gap: 4px; align-items: center; padding: 16px 13px; }
.thinking span {
  display: inline-block; width: 6px; height: 6px; border-radius: 50%;
  background: var(--color-primary); animation: bounce 1.2s infinite; opacity: 0.6;
}
.thinking span:nth-child(2) { animation-delay: 0.2s; }
.thinking span:nth-child(3) { animation-delay: 0.4s; }
@keyframes bounce { 0%, 60%, 100% { transform: translateY(0); } 30% { transform: translateY(-5px); } }

/* 状态气泡只在生成开始时入场，后续状态切换只更新文字。 */
.status-pop { animation: statusPop 0.3s cubic-bezier(0.2, 0.8, 0.3, 1) both; }
@keyframes statusPop { from { opacity: 0; transform: translateY(7px) scale(0.96); } to { opacity: 1; transform: none; } }

.tool-bubble { display: flex; align-items: center; gap: 8px; color: var(--color-primary); }
.tool-spinner {
  width: 12px; height: 12px; border-radius: 50%; flex-shrink: 0;
  border: 2px solid rgba(123,127,178,0.25); border-top-color: var(--color-primary);
  animation: spin 0.7s linear infinite;
}
@keyframes spin { to { transform: rotate(360deg); } }
.tool-label { font-weight: 600; }

/* ── Markdown ── */
/* md 排版由通用组件 MarkdownView 提供；这里只保留聊天气泡的内边距 */
.md-body { padding: 10px 13px; }

/* ── 迷你播放器 ── */
.mini-player {
  position: fixed; right: 28px; box-sizing: border-box; width: 360px;   /* border-box 外宽 360，与小窗/气泡严格对齐 */
  transition: bottom 0.28s cubic-bezier(0.34, 1.2, 0.64, 1);
  background: var(--panel-bg); backdrop-filter: var(--glass-blur); -webkit-backdrop-filter: var(--glass-blur);
  border: 1px solid rgba(255,255,255,0.65); border-radius: 20px;
  box-shadow: var(--glass-shadow-lg); padding: 12px 14px 10px;
  display: flex; flex-direction: column; gap: 7px;   /* z-index 由 :style 动态(跟随聊天窗 ±1) */
}
.mp-info { display: flex; align-items: center; gap: 7px; min-width: 0; }
.mp-name { font-size: 12px; font-weight: 600; color: var(--text-primary); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; flex: 1; }
.mp-bars { display: flex; align-items: flex-end; gap: 2px; height: 14px; flex-shrink: 0; }
.mp-bars i { display: block; width: 2.5px; border-radius: 99px; background: rgba(100,110,200,0.55); height: 4px; }
.mp-bars--playing i { animation: mp-eq 0.55s ease-in-out infinite alternate; }
.mp-bars--playing i:nth-child(1) { animation-duration: 0.55s; }
.mp-bars--playing i:nth-child(2) { animation-duration: 0.42s; animation-delay: 0.1s; }
.mp-bars--playing i:nth-child(3) { animation-duration: 0.65s; animation-delay: 0.05s; }
.mp-bars--playing i:nth-child(4) { animation-duration: 0.48s; animation-delay: 0.15s; }
@keyframes mp-eq { from { height: 3px; } to { height: 13px; } }
.mp-seek-row { display: flex; align-items: center; gap: 6px; }
.mp-time { font-size: 10px; color: var(--text-secondary); font-variant-numeric: tabular-nums; flex-shrink: 0; }
.mp-track { flex: 1; height: 3px; border-radius: 99px; background: rgba(100,110,200,0.12); position: relative; cursor: pointer; }
.mp-track:hover .mp-thumb { opacity: 1; }
.mp-fill { height: 100%; border-radius: 99px; background: linear-gradient(to right, rgba(100,110,200,0.65), rgba(140,120,210,0.75)); pointer-events: none; }
.mp-thumb { position: absolute; top: 50%; transform: translate(-50%,-50%); width: 10px; height: 10px; border-radius: 50%; background: rgba(100,110,200,0.9); pointer-events: none; opacity: 0; transition: opacity 0.15s; }
.mp-btn--pin { width: 24px; height: 24px; border-radius: 6px; border: none; display: flex; align-items: center; justify-content: center; cursor: pointer; flex-shrink: 0; background: none; color: var(--text-secondary); transition: background 0.12s, color 0.12s; }
.mp-btn--pin svg { display: block; }
.mp-btn--pin:hover { background: rgba(100,110,200,0.12); color: rgba(100,110,200,0.9); }
.mp-btn--pinned { color: rgba(100,110,200,0.8); }
.mp-btn--pinned:hover { background: rgba(100,110,200,0.12); color: rgba(100,110,200,1); }
.mp-btn--close { width: 24px; height: 24px; border-radius: 6px; border: none; display: flex; align-items: center; justify-content: center; cursor: pointer; flex-shrink: 0; background: none; color: var(--text-secondary); transition: background 0.12s, color 0.12s; }
.mp-btn--close:hover { background: rgba(200,80,80,0.1) !important; color: rgba(200,80,80,0.8) !important; }
.mp-controls { display: grid; grid-template-columns: 1fr auto 1fr; align-items: center; }
.mp-btn { border: none; cursor: pointer; border-radius: 8px; display: flex; align-items: center; justify-content: center; transition: transform 0.15s, background 0.12s; }
.mp-btn--play { width: 34px; height: 34px; border-radius: 50%; background: linear-gradient(135deg, rgba(110,115,190,0.85), rgba(140,120,200,0.9)); color: white; justify-self: center; box-shadow: 0 3px 10px rgba(100,110,200,0.28), inset 0 1px 0 rgba(255,255,255,0.32); }
.mp-btn--play svg { display: block; }
.mp-btn--play:hover { transform: scale(1.08); }
.mp-btn--play:active { transform: scale(0.93); }
.mp-vol-group { display: flex; align-items: center; gap: 4px; justify-self: end; }
.mp-vol-btn { width: 22px; height: 22px; border: none; border-radius: 6px; background: none; color: var(--text-secondary); display: flex; align-items: center; justify-content: center; cursor: pointer; flex-shrink: 0; transition: background 0.12s, color 0.12s; }
.mp-vol-btn:hover { background: rgba(0,0,0,0.07); color: var(--text-primary); }
.mp-vol-btn svg { display: block; }
.mp-vol-slider { width: 60px; height: 3px; cursor: pointer; accent-color: rgba(100,110,200,0.75); }
/* 时长/曲线跟 .chat-open-enter-active/.chat-open-leave-active 严格对齐——播放器跟聊天
   窗口经常联动出现（比如小窗打开顶起播放器），用不同的时长/曲线会让两者一个先到位、
   一个还在动，看着不同步（2026-07-17 复现：播放器隐藏后再打开跟 guguchat 动画对不上）。 */
.mini-player-enter-active { transition: opacity 0.22s ease, transform 0.36s cubic-bezier(0.16, 1, 0.3, 1); }
.mini-player-leave-active { transition: opacity 0.18s ease-in, transform 0.22s cubic-bezier(0.7, 0, 0.84, 0); }
.mini-player-enter-from, .mini-player-leave-to { opacity: 0; transform: scale(0.05); }
</style>
