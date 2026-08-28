<template>
  <main class="token-page">
    <div class="token-shell">
      <header class="token-header">
        <div class="brand-mark" aria-hidden="true">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
            <path d="M16 7h.01" />
            <path d="M3.4 18H12a8 8 0 0 0 8-8V7a4 4 0 0 0-7.28-2.3L2 20" />
            <path d="M20 7l2 .5-2 .5" />
            <path d="M10 18v3" />
            <path d="M14 17.75V21" />
          </svg>
        </div>
        <div class="heading"><h1>咕咕 Design Tokens</h1><p>{{ familyLabel }} · {{ familyDescription }}</p></div>
        <ThemeSwitcher :model-value="preference" :family="family" :palette="palette" @update:model-value="setTheme" @update:family="setFamily" @update:palette="setPalette" />
      </header>

      <section class="hero-note">
        <div class="lead"><b>01 · {{ familyLabel }} 是视觉身份</b><span>{{ familyDescription }}系统 chrome 和内容色分层，主题不会吞掉项目自己的颜色。</span></div>
        <div><b>02 · Light / Dark 独立于主题</b><span>Glass 与 Mono 各自拥有浅色和深色，组件消费同一套 semantic/component token。</span></div>
        <div><b>03 · 同结构直接比较</b><span>下面的项目页、按钮、输入、状态和浮层不换 DOM，只切换根节点令牌。</span></div>
      </section>

      <section class="theme-matrix">
        <button v-for="item in themeMatrix" :key="item.label" class="theme-cell" :class="[`theme-${item.family}-${item.mode}`, { active: family === item.family && resolved === item.mode }]" type="button" @click="applyTheme(item.family, item.mode)">
          <span class="theme-cell-preview" /><b>{{ item.label }}</b><span>{{ item.description }}</span>
        </button>
      </section>

      <section class="preview-frame">
        <aside class="preview-sidebar">
          <div class="gugu-logo"><span class="mini-mark" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M16 7h.01" /><path d="M3.4 18H12a8 8 0 0 0 8-8V7a4 4 0 0 0-7.28-2.3L2 20" /><path d="M20 7l2 .5-2 .5" /><path d="M10 18v3" /><path d="M14 17.75V21" /></svg></span><strong>咕咕</strong></div>
          <span class="nav-rule" />
          <div class="nav-group"><div class="nav-title">工作台</div><span class="nav-item active"><Icon name="navigation.projects" :size="14" />项目 <i>6</i></span><span class="nav-item"><Icon name="navigation.calendar" :size="14" />日历</span><span class="nav-item"><Icon name="admin.alarm" :size="14" />定时任务</span><span class="nav-item"><Icon name="canvas.graph" :size="14" />思维</span></div>
          <span class="nav-rule" />
          <div class="nav-group"><div class="nav-title">资源</div><span class="nav-item"><Icon name="file.folder" :size="14" />文件库</span><span class="nav-item"><Icon name="communication.customer" :size="14" />客户 <em>咕了</em></span><span class="nav-item"><Icon name="communication.team" :size="14" />团队 <em>咕了</em></span></div>
          <span class="nav-rule" />
          <div class="nav-group"><div class="nav-title">通知</div><span class="nav-item"><Icon name="admin.bell" :size="14" weight="bold" />通知 <i>2</i></span></div>
          <div class="user-card"><span class="avatar">C</span><div><b>小北</b><small>个人空间</small></div></div>
        </aside>

        <div class="preview-main">
          <div class="topbar"><div class="topbar-title"><b>项目</b><span>2026年8月15日 · 星期六</span></div><div class="search"><Icon name="action.search" :size="13" />搜索项目、文件、笔记 <kbd>⌘ K</kbd></div><button class="btn" type="button"><Icon name="action.upload" :size="13" />上传文件</button><button class="btn primary" type="button"><Icon name="action.add" :size="13" />新建项目</button></div>
          <div class="board-toolbar"><h2>项目看板</h2><span class="theme-badge"><i />{{ familyLabel }} · {{ modeLabel }}</span><span class="filter-chip">全部 12</span><span class="filter-chip">进行中 6</span><span class="spacer" /><span class="quiet">按阶段拖动项目</span></div>
          <div class="kanban">
            <div v-for="column in columns" :key="column.title" class="column"><div class="column-head"><i class="status-dot" :class="column.dot" /><b>{{ column.title }}</b><span>{{ column.count }}</span></div><div class="card-list"><article v-for="card in column.cards" :key="card.title" class="proj-card" :class="{ 'mini-card': card.mini }" :style="{ '--project-color': card.color }"><div class="card-body"><div class="card-top"><div class="proj-name">{{ card.title }}</div><div class="stars">{{ card.stars }}</div></div><div class="proj-meta"><span class="proj-client">{{ card.meta }}</span><span class="proj-stage">{{ card.stage }}</span></div><div class="card-footer"><div class="date-range"><Icon name="navigation.calendar" :size="11" /> <span class="deadline" :class="{ done: card.progress === 100 }">{{ card.date }}</span></div><div class="footer-right"><span class="file-badge"><Icon name="file.document" :size="9" /> {{ card.progress > 0 ? Math.max(1, Math.round(card.progress / 20)) : 0 }}</span><span class="progress-num">{{ card.progress }}%</span></div></div><div class="seg-bar-wrap"><i :style="{ width: `${card.progress}%` }" /></div></div></article></div></div>
          </div>
          <Transition name="mock-chat">
            <div v-if="chatOpen" class="mock-chat-window">
              <div class="mock-chat-header"><b>咕咕</b><span><i />在线</span><button type="button" aria-label="关闭聊天" @click="chatOpen = false"><PhX :size="13" /></button></div>
              <div class="mock-chat-messages"><div class="mock-msg ai">嗨，我是咕咕。这里是设计令牌页里的聊天窗样板。</div><div class="mock-msg user">帮我看看今天的项目进度</div><div class="mock-msg ai">进行中的项目有 6 个，最近截止的是 Runtime 接入。</div></div>
              <div class="mock-chat-composer"><button type="button" aria-label="添加附件"><Icon name="communication.chat" :size="15" /></button><span>问问项目进度、截止日期...</span><button class="mock-send" type="button" aria-label="发送"><Icon name="action.next" :size="14" weight="bold" /></button></div>
            </div>
          </Transition>
          <button class="gugu-fab" aria-label="打开咕咕聊天" @click="chatOpen = !chatOpen"><svg viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M16 7h.01" /><path d="M3.4 18H12a8 8 0 0 0 8-8V7a4 4 0 0 0-7.28-2.3L2 20" /><path d="M20 7l2 .5-2 .5" /><path d="M10 18v3" /><path d="M14 17.75V21" /></svg></button>
        </div>
      </section>

      <TokenSection index="00" title="Icon contract" subtitle="业务只声明语义，不直接绑定 Remix Icon；尺寸、色调和无障碍属性由统一入口管理。" code="icon">
        <div class="icon-contract-grid">
          <div v-for="sample in iconSamples" :key="sample.name" class="icon-contract-card">
            <Icon :name="sample.name" :size="sample.size" :tone="sample.tone" :title="sample.label" :decorative="false" />
            <div><b>{{ sample.label }}</b><code class="token-code">{{ sample.name }}</code></div>
          </div>
        </div>
      </TokenSection>

      <TokenSection index="01" title="Glass base palette" subtitle="Pearl、Iris、companion colors 共同构成主题的 primitive DNA。" code="primitive">
        <div class="swatch-grid"> <div v-for="token in primitiveTokens" :key="token.variable" class="swatch"><div class="swatch-color" :style="{ background: `var(${token.variable})` }" /><label>{{ token.name }}</label><code class="token-code">{{ token.variable }}</code></div></div>
      </TokenSection>

      <TokenSection index="02" title="Alpha & accent" subtitle="透明白、高光边、品牌色和状态色共同构成玻璃感。" code="primitive">
        <div class="swatch-grid"> <div v-for="token in accentTokens" :key="token.variable" class="swatch"><div class="swatch-color" :style="{ background: `var(${token.variable})` }" /><label>{{ token.name }}</label><code class="token-code">{{ token.variable }}</code></div></div>
      </TokenSection>

      <TokenSection index="03" title="Project colors" subtitle="真正有表现力的颜色留给项目与内容，而不是导航栏和所有玻璃面。" code="content palette">
        <div class="project-palette"><div v-for="token in projectTokens" :key="token.variable" class="project-chip"><i :style="{ background: `var(${token.variable})` }" /><span>{{ token.name }}<code class="token-code">{{ token.variable }}</code></span></div></div>
      </TokenSection>

      <TokenSection index="04" title="Semantic tokens" subtitle="业务组件同时不关心 theme family 与 light / dark，只消费这一层。" code="semantic">
        <div class="semantic-layout"><div class="semantic-list"><div v-for="token in semanticTokens" :key="token.variable" class="semantic-row"><i :style="{ background: `var(${token.variable})` }" /><code class="token-code">{{ token.variable }}</code><span class="semantic-description">{{ token.description }}</span><span class="value token-code" :title="valueOf(token)">{{ valueOf(token) }}</span></div></div><div class="control-stage"><button class="btn primary" type="button">主操作</button><button class="btn" type="button">次操作</button><div class="input">搜索项目、文件、笔记</div><div class="input focused">焦点输入状态</div><span class="tag success">已完成</span><span class="tag warning">临近截止</span><span class="tag danger">失败</span><span class="tag info">同步中</span></div></div>
      </TokenSection>

      <TokenSection index="05" title="Elevation" subtitle="Glass 使用环境高光 + 柔阴影建立层级；Mono 使用更克制的 surface elevation。" code="elevation">
        <div class="elevation-demo"><div v-for="item in elevations" :key="item.title" class="elev" :class="item.class"><b>{{ item.title }}</b><span>{{ item.description }}</span></div></div>
      </TokenSection>

      <TokenSection index="06" title="Theme contract" subtitle="两套主题共享组件 API，但可以拥有不同的视觉哲学。" code="usage">
        <div class="rule-grid"><div v-for="rule in rules" :key="rule.title" class="rule-card"><strong>{{ rule.title }}</strong><p>{{ rule.description }}</p></div></div>
        <div class="code-block">
          <button class="copy-btn" type="button" @click="copySnippet">{{ snippetCopied ? '已复制' : '复制当前核心令牌' }}</button>
          <div class="code-line"><span class="code-comment">:root</span><span class="code-punct">[data-family=</span><span class="code-value">"{{ family }}"</span><span class="code-punct">][data-theme=</span><span class="code-value">"{{ resolved }}"</span><span class="code-punct">] &#123;</span></div>
          <div class="code-line">&nbsp;&nbsp;<span class="code-property">--surface-card</span><span class="code-punct">: </span><span class="code-value">var(--glass-bg)</span><span class="code-punct">;</span></div>
          <div class="code-line">&nbsp;&nbsp;<span class="code-property">--content-primary</span><span class="code-punct">: </span><span class="code-value">var(--text-primary)</span><span class="code-punct">;</span></div>
          <div class="code-line">&nbsp;&nbsp;<span class="code-property">--action-primary</span><span class="code-punct">: </span><span class="code-value">var(--color-primary)</span><span class="code-punct">;</span></div>
          <div class="code-line"><span class="code-punct">&#125;</span></div>
        </div>
      </TokenSection>

      <TokenSection index="07" title="Token index" subtitle="字体、间距、圆角、动效和画布令牌的可复制索引。" code="all tokens">
        <div class="token-index"><div v-for="token in indexTokens" :key="token.variable" class="index-card"><div class="index-preview" :class="`preview-${token.type}`" :style="previewStyle(token)"><span v-if="token.type === 'font'">Aa</span><span v-else-if="token.type === 'duration'">→</span><span v-else-if="token.type === 'other'">{ }</span></div><button type="button" :title="`复制 ${token.variable}`" @click="copyToken(token)"><Icon name="status.success" v-if="copied === token.variable" :size="13" weight="bold" /><Icon name="action.copy" v-else :size="13" /></button><b>{{ token.name }}</b><code class="token-code">{{ token.variable }}</code><small class="token-code">{{ valueOf(token) }}</small></div></div>
      </TokenSection>

      <footer class="footer-note"><span>GUGU · Design Tokens · Glass / Mono</span><span>{{ familyLabel }} · {{ modeLabel }} · family × mode</span></footer>
    </div>
  </main>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import { useTheme, type ResolvedTheme, type ThemeFamily } from '@/composables/useTheme'
import { useDesignTokens } from '../composables/useDesignTokens'
import { tokenCatalog, type DesignToken } from '../data/tokenCatalog'
import ThemeSwitcher from './ThemeSwitcher.vue'
import TokenSection from './TokenSection.vue'
import Icon from '@/components/common/Icon.vue'
const { preference, resolved, family, palette, setTheme, setFamily, setPalette } = useTheme()
const { valueOf, copyToken: copy } = useDesignTokens()
const copied = ref<string | null>(null)
const snippetCopied = ref(false)
const chatOpen = ref(false)
const by = (predicate: (token: DesignToken) => boolean) => computed(() => tokenCatalog.filter(predicate))
const primitiveTokens = by(token => token.variable.startsWith('--palette-pearl-') || token.variable.startsWith('--palette-iris-'))
const accentTokens = by(token => token.variable.startsWith('--color-') || token.variable.startsWith('--alpha-') || (token.variable.startsWith('--palette-') && !token.variable.startsWith('--palette-pearl-') && !token.variable.startsWith('--palette-iris-')))
const projectTokens = by(token => token.variable.startsWith('--project-'))
const semanticTokens = by(token => token.category === 'semantic')
const indexTokens = by(token => token.category !== 'semantic')
const iconSamples = [
  { name: 'action.add', label: '添加', size: 'sm' as const, tone: 'active' as const },
  { name: 'action.search', label: '搜索', size: 'md' as const, tone: 'default' as const },
  { name: 'action.edit', label: '编辑', size: 'md' as const, tone: 'muted' as const },
  { name: 'action.delete', label: '删除', size: 'md' as const, tone: 'danger' as const },
  { name: 'file.folder', label: '文件夹', size: 'lg' as const, tone: 'default' as const },
  { name: 'status.success', label: '成功', size: 'sm' as const, tone: 'active' as const },
]
const familyLabel = computed(() => family.value === 'glass' ? 'Glass' : 'Mono · Pearl / Ink / Iris')
const modeLabel = computed(() => resolved.value === 'dark' ? 'Dark' : 'Light')
const familyDescription = computed(() => family.value === 'glass' ? '保留当前咕咕的柔光、透明层与紫灰环境色。' : '使用 Pearl / Ink 中性表面与 Iris 交互色，保留项目内容色。')
const themeMatrix: Array<{ family: ThemeFamily; mode: ResolvedTheme; label: string; description: string }> = [
  { family: 'glass', mode: 'light', label: 'Glass · Light', description: '当前 dev 主视觉' }, { family: 'glass', mode: 'dark', label: 'Glass · Dark', description: '深色玻璃' }, { family: 'mono', mode: 'light', label: 'Mono · Light', description: 'Pearl / Ink / Iris' }, { family: 'mono', mode: 'dark', label: 'Mono · Dark', description: '低彩深色工作台' },
]
const columns = [
  { title: '待处理', count: 3, dot: '', cards: [{ title: '角色立绘 · 夏季版本', meta: '个人创作', stage: '草图', date: '08/18 → 08/24', progress: 18, stars: '★★★', color: 'var(--project-rose)' }, { title: '作品集排版', meta: '《人生对比色》', stage: '整理', date: '08/30', progress: 8, stars: '★', color: 'var(--project-sand)', mini: true }] },
  { title: '进行中', count: 4, dot: 'iris', cards: [{ title: '咕咕 · 设计令牌系统', meta: 'Gugu', stage: '视觉规范', date: '08/12 → 08/17', progress: 62, stars: '★★★', color: 'var(--project-lilac)' }, { title: '桌面端交互原型', meta: 'Gugu Desktop', stage: '原型', date: '08/20', progress: 43, stars: '★★', color: 'var(--project-sky)' }, { title: 'LoopScope 0.1', meta: 'Agent Tooling', stage: '架构', date: '09/02', progress: 31, stars: '★★', color: 'var(--project-mauve)', mini: true }] },
  { title: '待确认', count: 2, dot: 'cyan', cards: [{ title: 'Interaction Runtime · Filesystem 接入', meta: 'Runtime', stage: '回归', date: '08/16', progress: 86, stars: '★★★', color: 'var(--project-blue)' }, { title: '新官网视觉稿', meta: 'Website', stage: 'Review', date: '08/19', progress: 74, stars: '★', color: 'var(--project-coral)', mini: true }] },
  { title: '已完成', count: 5, dot: 'green', cards: [{ title: '日历模块化重构', meta: 'Gugu', stage: '完成', date: '✓ 已完成', progress: 100, stars: '★★', color: 'var(--project-leaf)', mini: true }, { title: '文件页 Runtime-only', meta: 'Runtime', stage: '完成', date: '✓ 已完成', progress: 100, stars: '★★★', color: 'var(--project-sky)', mini: true }] },
]
const elevations = [{ title: 'Resting · 1', description: '项目卡 / 文件卡', class: 'one' }, { title: 'Raised · 2', description: 'Hover / Popover', class: 'two' }, { title: 'Floating · 3', description: 'Popup / Modal', class: 'three' }]
const rules = [{ title: 'Family ≠ Mode', description: 'Glass / Mono 定义视觉语言；Light / Dark 定义色彩模式，四种状态正交组合。' }, { title: 'One semantic contract', description: '组件只使用 surface、content、border、action、status 和 elevation。' }, { title: 'Glass may stay glass', description: 'Glass 允许普通卡片、侧栏和控制面继续使用半透明、高光与 blur。' }, { title: 'Mono stays quieter', description: 'Mono 内容面更实、更中性，Iris 主要承担交互语义。' }, { title: 'Content colors survive', description: '项目色、日历色和画布内容色属于内容层，两套主题都保留。' }, { title: 'Switch at the root', description: '根节点使用 data-family 与 data-theme，新增主题时无需复制组件 CSS。' }]

function applyTheme(nextFamily: ThemeFamily, nextMode: ResolvedTheme): void { setFamily(nextFamily); setTheme(nextMode) }
async function copyToken(token: DesignToken): Promise<void> { if (await copy(token)) copied.value = token.variable }
function previewStyle(token: DesignToken): Record<string, string> {
  if (token.type === 'color') return { background: `var(${token.variable})` }
  if (token.type === 'size') return { '--token-size': `var(${token.variable})` }
  if (token.type === 'shadow') return { boxShadow: `var(${token.variable})` }
  if (token.type === 'font') return { fontSize: `var(${token.variable})` }
  if (token.type === 'duration') return { animationDuration: `var(${token.variable})` }
  return {}
}
async function copySnippet(): Promise<void> {
  const snippet = `:root[data-family="${family.value}"][data-theme="${resolved.value}"] {\n  --surface-card: var(--glass-bg);\n  --content-primary: var(--text-primary);\n  --action-primary: var(--color-primary);\n}`
  await navigator.clipboard?.writeText(snippet)
  snippetCopied.value = true
  window.setTimeout(() => { snippetCopied.value = false }, 1400)
}
</script>

<style scoped>
.token-page { height: 100%; overflow-y: auto; box-sizing: border-box; padding: 28px; color: var(--content-primary); background: var(--surface-page); font-family: var(--font-sans); }
.icon-contract-grid { display: grid; grid-template-columns: repeat(6, minmax(0, 1fr)); gap: 10px; }
.icon-contract-card { display: flex; align-items: center; gap: 10px; min-width: 0; padding: 12px; border: 1px solid var(--border-subtle); border-radius: var(--radius-sm); color: var(--content-secondary); background: var(--surface-card); }
.icon-contract-card > div { display: grid; min-width: 0; gap: 3px; }
.icon-contract-card b { color: var(--content-primary); font-size: 11px; font-weight: 600; }
.icon-contract-card code { overflow: hidden; color: var(--content-tertiary); text-overflow: ellipsis; white-space: nowrap; }
.token-shell { max-width: 1480px; margin: 0 auto; }
.token-header { display: flex; align-items: center; gap: 18px; margin-bottom: 20px; }
.brand-mark { display: grid; place-items: center; width: 44px; height: 44px; border-radius: 14px; color: #fff; background: var(--brand-gradient); box-shadow: 0 8px 24px rgba(94,82,145,.22), inset 0 1px 0 rgba(255,255,255,.32); }
.brand-mark svg { width: 25px; height: 25px; }
.heading { min-width: 0; }.heading h1 { margin: 0; font-size: 24px; letter-spacing: -.025em; }.heading p { margin: 5px 0 0; color: var(--content-secondary); font-size: 12px; }
.token-header :deep(.theme-controls) { margin-left: auto; }
.hero-note { display: grid; grid-template-columns: 1.2fr 1fr 1fr; gap: 1px; margin-bottom: 20px; overflow: hidden; border: 1px solid var(--border-subtle); border-radius: var(--radius-lg); background: var(--border-subtle); box-shadow: var(--shadow-rest); }
.hero-note > div { min-height: 70px; padding: 16px 18px; background: var(--surface-card); backdrop-filter: blur(12px); }.hero-note b { display: block; margin-bottom: 5px; font-size: 12px; }.hero-note span { display: block; color: var(--content-secondary); font-size: 11px; line-height: 1.55; }.hero-note .lead b { color: var(--selection-fg); }
.theme-matrix { display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px; margin-bottom: 20px; }.theme-cell { padding: 10px; border: 1px solid var(--border-subtle); border-radius: 13px; color: var(--content-primary); text-align: left; background: var(--surface-base); box-shadow: var(--shadow-rest); cursor: pointer; transition: transform var(--motion-default), box-shadow var(--motion-default), background var(--motion-default); }.theme-cell:hover { transform: translateY(-2px); background: var(--surface-raised); box-shadow: var(--shadow-hover); }.theme-cell.active { border-color: var(--border-strong); }.theme-cell b { display: block; font-size: 11px; }.theme-cell > span:last-child { display: block; margin-top: 4px; color: var(--content-tertiary); font-size: 9px; }.theme-cell-preview { position: relative; display: block; height: 48px; margin-bottom: 8px; overflow: hidden; border: 1px solid var(--border-hairline); border-radius: 9px; background: var(--surface-canvas); }.theme-cell-preview::before { content: ''; position: absolute; top: 8px; bottom: 8px; left: 8px; width: 25%; border: 1px solid var(--border-subtle); border-radius: 6px; background: var(--surface-sidebar); }.theme-cell-preview::after { content: ''; position: absolute; top: 8px; right: 8px; left: 39%; height: 13px; border: 1px solid var(--border-subtle); border-radius: 6px; background: var(--surface-card); box-shadow: 0 18px 0 var(--surface-card), 0 36px 0 var(--surface-card); }.preview-glass-light { background: linear-gradient(145deg, #e8e9ee, #bfc4d2); }.preview-glass-dark { background: linear-gradient(145deg, #0e101a, #13152a); }.preview-mono-light { background: linear-gradient(145deg, #f5f3f6, #eeecf0); }.preview-mono-dark { background: linear-gradient(145deg, #1c1921, #17151b); }
.preview-frame { position: relative; display: grid; grid-template-columns: 214px 1fr; height: 650px; overflow: hidden; border: 1px solid var(--border-default); border-radius: 22px; background: var(--app-background); box-shadow: var(--shadow-3); }.preview-sidebar { display: flex; flex-direction: column; padding: 22px 12px 14px; border-right: 1px solid var(--border-subtle); background: var(--surface-sidebar); box-shadow: inset -1px 0 0 var(--border-highlight); backdrop-filter: blur(var(--glass-blur)); }.gugu-logo { display: flex; align-items: center; gap: 9px; padding: 0 10px 18px; font-size: 15px; font-weight: 700; }.mini-mark { display: grid; place-items: center; width: 31px; height: 31px; border-radius: 10px; color: #fff; background: var(--brand-gradient); box-shadow: inset 0 1px 0 rgba(255,255,255,.3); }.mini-mark svg { width: 19px; height: 19px; }.nav-rule { height: 1px; margin: 5px 7px 12px; background: var(--border-hairline); }.nav-group { display: grid; gap: 1px; margin-bottom: 8px; }.nav-group small { padding: 0 10px 5px; color: var(--content-tertiary); font-size: 9px; font-weight: 700; letter-spacing: .07em; }.nav-item { display: flex; align-items: center; min-height: 34px; gap: 9px; padding: 0 10px; border-radius: 9px; color: var(--content-secondary); font-size: 12px; }.nav-item svg { flex: 0 0 auto; opacity: .86; }.nav-item:hover { color: var(--content-primary); background: var(--surface-soft-hover); }.nav-item.active { color: var(--selection-fg); background: var(--selection-bg); font-weight: 650; }.nav-item i, .nav-item em { margin-left: auto; font-size: 9px; font-style: normal; }.nav-item i { min-width: 18px; padding: 1px 5px; border-radius: var(--radius-pill); color: var(--selection-fg); background: var(--action-soft); text-align: center; }.nav-item em { color: var(--content-tertiary); font-size: 8px; }.user-card { display: flex; align-items: center; gap: 8px; margin-top: auto; padding: 8px; border: 1px solid var(--border-subtle); border-radius: 11px; background: var(--surface-card); box-shadow: var(--shadow-1); }.user-card div { display: grid; gap: 2px; }.user-card b { font-size: 11px; }.user-card small { color: var(--content-tertiary); font-size: 9px; }.avatar { display: grid; place-items: center; width: 29px; height: 29px; border-radius: var(--radius-pill); color: #fff; background: var(--brand-gradient); font-size: 10px; font-weight: 700; }
.preview-main { position: relative; min-width: 0; overflow: hidden; padding: 78px 18px 16px; background: var(--surface-base); }.topbar { position: absolute; top: 16px; right: 18px; left: 18px; display: flex; align-items: center; height: 50px; gap: 12px; padding: 0 14px; border: 1px solid var(--border-subtle); border-radius: 14px; background: var(--surface-floating); box-shadow: var(--shadow-rest); backdrop-filter: blur(16px); }.topbar-title { min-width: 150px; }.topbar-title b, .topbar-title span { display: block; }.topbar-title b { font-size: 15px; }.topbar-title span { margin-top: 2px; color: var(--content-tertiary); font-size: 9px; }.search { display: flex; align-items: center; width: min(260px, 32%); height: 30px; gap: 7px; margin-left: auto; padding: 0 10px; border-radius: 9px; color: var(--content-tertiary); background: var(--surface-soft); font-size: 10px; }.search kbd { margin-left: auto; padding: 1px 4px; border: 1px solid var(--border-subtle); border-radius: 5px; background: var(--surface-card); font-size: 8px; }.btn { height: 30px; padding: 0 10px; border: 1px solid var(--border-default); border-radius: 8px; color: var(--content-primary); background: var(--surface-card); box-shadow: var(--shadow-rest); cursor: pointer; font: 620 10px var(--font-sans); }.btn:hover { transform: translateY(-1px); box-shadow: var(--shadow-hover); }.btn.primary { border-color: transparent; color: var(--content-inverse); background: var(--action-primary); }.board-toolbar { display: flex; align-items: center; height: 38px; gap: 8px; margin-bottom: 10px; }.board-toolbar h2 { margin: 0; font-size: 12px; }.theme-badge, .filter-chip { padding: 4px 7px; border: 1px solid var(--border-hairline); border-radius: var(--radius-pill); color: var(--content-secondary); background: var(--surface-soft); font-size: 9px; }.theme-badge { display: inline-flex; align-items: center; gap: 5px; color: var(--selection-fg); background: var(--action-soft); font-family: var(--font-mono); }.theme-badge i { width: 6px; height: 6px; border-radius: 50%; background: var(--action-primary); }.quiet { margin-left: auto; color: var(--content-tertiary); font-size: 9px; }.kanban { display: grid; grid-template-columns: repeat(4, minmax(145px, 1fr)); height: calc(100% - 48px); gap: 10px; overflow: hidden; }.column { min-width: 0; height: 100%; padding: 10px; overflow: hidden; border: 1px solid var(--border-hairline); border-radius: 14px; background: var(--surface-soft); }.column-head { display: flex; align-items: center; height: 26px; gap: 6px; padding: 0 3px 7px; }.column-head b { font-size: 10px; }.column-head > span { color: var(--content-tertiary); font-size: 9px; }.status-dot { width: 7px; height: 7px; border-radius: 50%; }.card-list { display: flex; flex-direction: column; gap: 8px; }.project-card { position: relative; min-height: 105px; padding: 11px 11px 10px; overflow: hidden; border: 1px solid var(--border-subtle); border-radius: var(--radius-md); background: linear-gradient(to right, var(--surface-card-solid), color-mix(in srgb, var(--surface-card-solid) 75%, var(--project-color)) 72%), var(--project-color); box-shadow: var(--shadow-rest); transition: transform var(--motion-default), box-shadow var(--motion-default), background var(--motion-default); }.project-card:hover { transform: translateY(-2px); box-shadow: var(--shadow-hover); }.project-top { display: flex; align-items: flex-start; gap: 6px; }.project-name { flex: 1; font-size: 11px; font-weight: 650; line-height: 1.35; }.stars { color: var(--project-color); font-size: 8px; }.project-meta, .project-foot { display: flex; align-items: center; justify-content: space-between; margin-top: 8px; color: var(--content-tertiary); font-size: 9px; }.stage { padding: 2px 5px; border-radius: 5px; color: var(--content-secondary); background: var(--surface-soft); }.project-foot { margin-top: 10px; color: var(--content-secondary); }.pct { margin-left: auto; }.progress { height: 3px; margin-top: 6px; overflow: hidden; border-radius: var(--radius-pill); background: var(--surface-soft); }.progress i { display: block; height: 100%; border-radius: inherit; background: var(--project-color); }.project-card.mini { min-height: 83px; }.project-card.mini .project-meta { margin-top: 6px; }.project-card.mini .project-foot { margin-top: 8px; }.gugu-fab { position: absolute; right: 22px; bottom: 20px; display: grid; place-items: center; width: 46px; height: 46px; border: 1px solid rgba(255,255,255,.22); border-radius: 16px; color: var(--content-inverse); background: linear-gradient(135deg, var(--action-primary), var(--color-secondary)); box-shadow: 0 12px 28px color-mix(in srgb, var(--action-primary) 35%, transparent); }
.token-section { margin-top: 24px; padding: 20px; border: 1px solid var(--border-subtle); border-radius: 18px; background: var(--surface-base); box-shadow: var(--shadow-rest); backdrop-filter: blur(12px); }.section-head { display: flex; align-items: end; gap: 12px; margin-bottom: 14px; }.section-head h2 { margin: 0; font-size: 15px; }.section-head p { margin: 3px 0 0; color: var(--content-tertiary); font-size: 10px; }.section-head code { margin-left: auto; padding: 4px 7px; border-radius: 6px; color: var(--selection-fg); background: var(--action-soft); font: 10px var(--font-mono); }.swatch-grid { display: grid; grid-template-columns: repeat(10, minmax(56px, 1fr)); gap: 7px; }.swatch-color { height: 58px; border: 1px solid var(--border-hairline); border-radius: 10px; box-shadow: inset 0 1px 0 var(--border-highlight); }.swatch label { display: block; margin-top: 5px; overflow: hidden; color: var(--content-tertiary); font-size: 8px; text-overflow: ellipsis; white-space: nowrap; }.swatch code { display: block; margin-top: 2px; overflow: hidden; color: var(--content-secondary); font: 8px var(--font-mono); text-overflow: ellipsis; white-space: nowrap; }.project-palette { display: grid; grid-template-columns: repeat(8, 1fr); gap: 8px; }.project-chip { overflow: hidden; border: 1px solid var(--border-subtle); border-radius: 12px; background: var(--surface-card); }.project-chip i { display: block; height: 37px; }.project-chip span { display: block; padding: 7px; color: var(--content-secondary); font-size: 8px; }.project-chip code { display: block; margin-top: 3px; color: var(--content-tertiary); font: 8px var(--font-mono); }.semantic-layout { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; }.semantic-list { display: grid; grid-template-columns: repeat(2, 1fr); gap: 7px; }.semantic-row { display: flex; align-items: center; min-width: 0; gap: 8px; padding: 7px 8px; border-radius: 9px; background: var(--surface-soft); }.semantic-row i { flex: 0 0 auto; width: 20px; height: 20px; border: 1px solid var(--border-subtle); border-radius: 6px; box-shadow: var(--shadow-rest); }.semantic-row code { flex: 1; overflow: hidden; font: 9px var(--font-mono); text-overflow: ellipsis; white-space: nowrap; }.semantic-row span { max-width: 45%; overflow: hidden; color: var(--content-tertiary); font-size: 8px; text-overflow: ellipsis; white-space: nowrap; }.control-stage { display: flex; flex-wrap: wrap; align-items: center; align-content: center; gap: 8px; padding: 16px; border: 1px solid var(--border-hairline); border-radius: 14px; background: var(--surface-soft); }.input { display: flex; align-items: center; min-width: 190px; height: 34px; padding: 0 10px; border: 1px solid var(--border-default); border-radius: var(--radius-sm); color: var(--content-secondary); background: var(--surface-card); font-size: 10px; }.input.focused { border-color: var(--focus-ring); box-shadow: 0 0 0 3px var(--focus-ring); }.tag { padding: 4px 7px; border-radius: 999px; font-size: 9px; font-weight: 620; }.tag.success { color: var(--status-success); background: var(--status-success-bg); }.tag.warning { color: var(--status-warning); background: var(--status-warning-bg); }.tag.danger { color: var(--status-danger); background: var(--status-danger-bg); }.tag.info { color: var(--color-tertiary); background: var(--action-soft); }
.elevation-demo { display: grid; grid-template-columns: repeat(3, 1fr); gap: 14px; padding: 10px; }.elev { display: flex; flex-direction: column; align-items: center; justify-content: center; height: 108px; gap: 7px; border: 1px solid var(--border-subtle); border-radius: 14px; background: var(--surface-card-solid); }.elev b { font-size: 10px; }.elev span { color: var(--content-tertiary); font-size: 8px; }.elev.one { box-shadow: var(--shadow-rest); }.elev.two { box-shadow: var(--shadow-hover); }.elev.three { box-shadow: var(--shadow-popup); }.rule-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 14px; }.rule-card { padding: 14px; border: 1px solid var(--border-subtle); border-radius: 13px; background: var(--surface-card); }.rule-card strong { display: block; margin-bottom: 5px; font-size: 11px; }.rule-card p { margin: 0; color: var(--content-secondary); font-size: 9px; line-height: 1.55; }.code-block { margin: 14px 0 0; padding: 14px; overflow: auto; border: 1px solid rgba(255,255,255,.07); border-radius: 13px; color: #d9d4df; background: #1e1c23; font: 10px/1.65 var(--font-mono); }.token-index { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 8px; }.index-card { position: relative; display: grid; gap: 4px; min-width: 0; padding: 12px; border: 1px solid var(--border-subtle); border-radius: var(--radius-sm); background: var(--surface-card); }.index-card button { position: absolute; top: 9px; right: 9px; border: 0; border-radius: var(--radius-xs); padding: 5px; color: var(--content-secondary); background: transparent; cursor: pointer; }.index-card button:hover { color: var(--content-primary); background: var(--surface-soft-hover); }.index-card b { padding-right: 28px; font-size: 11px; }.index-card code, .index-card small { overflow: hidden; color: var(--content-secondary); font-size: 9px; text-overflow: ellipsis; white-space: nowrap; }.footer-note { display: flex; justify-content: space-between; gap: 12px; padding: 18px 2px 4px; color: var(--content-tertiary); font-size: 9px; }
/* 语义令牌行与 token.html 保持相同的说明和值列层级。 */
.semantic-row .semantic-description { max-width: 30%; overflow: hidden; color: var(--content-tertiary); font: 400 8px/normal var(--font-sans); text-overflow: ellipsis; white-space: nowrap; }
.semantic-row .value { max-width: 45%; overflow: hidden; color: var(--content-tertiary); font: 400 8px/normal var(--font-mono); text-align: right; text-overflow: ellipsis; white-space: nowrap; }
.token-code { font-family: var(--font-mono); font-size: 10px; font-weight: 400; line-height: normal; letter-spacing: normal; }
.index-card code, .index-card small { font-family: var(--font-mono); font-weight: 400; line-height: normal; }
.index-preview { position: relative; display: grid; place-items: center; width: 100%; height: 40px; margin-bottom: 3px; overflow: hidden; border: 1px solid var(--border-hairline); border-radius: var(--radius-sm); color: var(--content-secondary); background: var(--surface-soft); font: 10px var(--font-mono); }
.index-preview.preview-color { border-color: var(--border-subtle); }
.index-preview.preview-size::before { content: ''; display: block; width: min(82%, var(--token-size, 16px)); height: 7px; border-radius: var(--radius-pill); background: var(--action-primary); }
.index-preview.preview-shadow { background: var(--surface-card-solid); }
.index-preview.preview-font { font-family: var(--font-sans); color: var(--content-primary); }
.index-preview.preview-duration span { display: block; width: 26px; height: 3px; border-radius: var(--radius-pill); background: var(--action-primary); }
.index-preview.preview-other { color: var(--content-tertiary); font-size: 12px; }

/* 与 token.html 的样板组件契约保持一致，覆盖早期页面草稿中的近似值。 */
.token-page { background: var(--app-background); background-attachment: fixed; font-family: var(--font-sans); font-size: 16px; font-weight: 400; line-height: normal; -webkit-font-smoothing: antialiased; }
.token-page button, .token-page input { font: inherit; }
.nav-title { padding: 0 10px 5px; color: var(--content-tertiary); font-size: 9px; font-weight: 700; letter-spacing: var(--tracking-label); }
.nav-rule { height: 1px; margin: 6px 4px; background: var(--divider-line); }
.nav-item { min-height: 0; margin: 0; padding: 10px 12px; border: 1px solid transparent; border-radius: var(--radius-sm); font-size: 14px; transition: all .15s; }
.nav-item:hover { color: var(--content-primary); background: var(--sidebar-item-hover); }
.nav-item.active { color: var(--sidebar-item-active-fg); background: var(--sidebar-item-active); border-color: rgba(255,255,255,.62); box-shadow: inset 0 1px 0 rgba(255,255,255,.85); font-weight: 700; }
.proj-card { position: relative; display: flex; flex-shrink: 0; min-height: 105px; overflow: hidden; cursor: pointer; border: 1px solid var(--project-card-border); border-radius: var(--card-radius); background: linear-gradient(to right, var(--project-card-overlay-start) 0%, var(--project-card-overlay-end) 40%), var(--project-color); box-shadow: var(--project-card-shadow); transition: transform .25s cubic-bezier(.34,1.2,.64,1), box-shadow .25s ease, background .25s ease-out, border-color .18s ease; }
.proj-card::before { content: ''; position: absolute; inset: 0; border-radius: inherit; background: linear-gradient(to bottom, var(--project-card-sheen-rest) 0%, transparent 50%); box-shadow: inset 0 1px 0 var(--project-card-highlight-rest); pointer-events: none; }
.proj-card::after { content: ''; position: absolute; inset: 0; border-radius: inherit; background: linear-gradient(to bottom, var(--project-card-sheen-hover) 0%, var(--project-card-sheen-hover-mid) 45%, transparent 100%); box-shadow: inset 0 1px 0 var(--project-card-highlight-hover); opacity: 0; transition: opacity .25s ease; pointer-events: none; }
.proj-card:hover { transform: translateY(-2px); border-color: var(--project-card-hover-border); box-shadow: var(--project-card-hover-shadow); }
.proj-card:hover::after { opacity: 1; }
.proj-card .card-body { display: flex; flex: 1; min-width: 0; flex-direction: column; gap: 8px; padding: 13px 13px 11px; }
.proj-card .card-top { display: flex; align-items: flex-start; gap: 6px; }
.proj-card .proj-name { display: -webkit-box; flex: 1; overflow: hidden; color: var(--content-primary); font-size: 13px; font-weight: 500; line-height: 1.35; -webkit-box-orient: vertical; -webkit-line-clamp: 2; }
.proj-card .stars { flex: 0 0 auto; color: var(--project-color); font-size: 8px; letter-spacing: -1px; }
.proj-card .proj-meta { display: flex; align-items: center; justify-content: space-between; gap: 6px; }
.proj-card .proj-client { flex: 1; overflow: hidden; color: var(--content-secondary); font-size: 11px; line-height: 1.15; text-overflow: ellipsis; white-space: nowrap; }
.proj-card .proj-stage { flex-shrink: 0; padding: 2px 5px; border-radius: 5px; color: var(--content-secondary); background: var(--surface-soft); font-size: 10px; line-height: 1.15; white-space: nowrap; }
.proj-card .card-footer { display: flex; align-items: center; margin-top: auto; color: var(--content-secondary); font-size: 9px; }
.proj-card .date-range, .proj-card .footer-right { display: flex; align-items: center; gap: 4px; min-width: 0; }
.proj-card .footer-right { margin-left: auto; gap: 8px; }
.proj-card .file-badge { display: inline-flex; align-items: center; gap: 2px; }
.proj-card .progress-num { font-variant-numeric: tabular-nums; }
.proj-card .deadline.done { color: var(--success-fg); }
.proj-card .seg-bar-wrap { display: flex; height: 3px; margin-top: 0; overflow: hidden; border-radius: var(--radius-pill); background: var(--surface-soft); }
.proj-card .seg-bar-wrap i { display: block; height: 100%; border-radius: inherit; background: var(--project-color); }
.proj-card.mini-card { min-height: 83px; }
.proj-card.mini-card .card-body { gap: 6px; padding-top: 10px; padding-bottom: 9px; }
.code-block { position: relative; margin-top: 14px; padding: 14px; overflow: auto; border: 1px solid rgba(255,255,255,.07); border-radius: 13px; color: #d9d4df; background: #1e1c23; font: 10px/1.65 var(--font-mono); }
.code-line { min-width: max-content; white-space: pre; }
.code-comment { color: #8e8796; }
.code-property { color: #a89fd2; }
.code-value { color: #c8b8a7; }
.code-punct { color: #d9d4df; }
.copy-btn { position: absolute; top: 8px; right: 8px; border: 1px solid rgba(255,255,255,.1); border-radius: 7px; padding: 4px 7px; color: #d9d4df; background: rgba(255,255,255,.07); cursor: pointer; font: 9px var(--font-sans); }
.copy-btn:hover { background: rgba(255,255,255,.13); }
.theme-cell { box-shadow: var(--shadow-rest); transition: .18s var(--motion-ease-standard); }
.theme-cell:hover { transform: translateY(-1px); box-shadow: var(--shadow-hover); }
.theme-cell.active { outline: 2px solid var(--focus-ring); outline-offset: 1px; }
.theme-cell-preview { border-color: rgba(127,127,127,.16); background: var(--mini-bg); }
.theme-cell-preview::before { border-color: var(--mini-border); background: var(--mini-side); }
.theme-cell-preview::after { border-color: var(--mini-border); background: var(--mini-card); box-shadow: 0 6px 0 var(--mini-card), 0 12px 0 var(--mini-card); }
.theme-glass-light .theme-cell-preview { --mini-bg: linear-gradient(160deg,#e8e9ee,#9aa2b8); --mini-side: rgba(255,255,255,.42); --mini-card: rgba(255,255,255,.62); --mini-border: rgba(255,255,255,.72); }
.theme-glass-dark .theme-cell-preview { --mini-bg: linear-gradient(145deg,#0e101a,#13152a); --mini-side: rgba(255,255,255,.05); --mini-card: rgba(255,255,255,.07); --mini-border: rgba(255,255,255,.12); }
.theme-mono-light .theme-cell-preview { --mini-bg: linear-gradient(#f5f3f6,#eeecf0); --mini-side: rgba(248,246,249,.84); --mini-card: rgba(255,255,255,.74); --mini-border: rgba(42,35,49,.08); }
.theme-mono-dark .theme-cell-preview { --mini-bg: linear-gradient(#1c1921,#17151b); --mini-side: rgba(25,23,30,.86); --mini-card: rgba(38,34,43,.78); --mini-border: rgba(255,255,255,.08); }
.preview-main { background: var(--app-background); }
.preview-frame { box-shadow: var(--shadow-popup); }
.user-card { box-shadow: var(--shadow-rest); }
.topbar { background: var(--topbar-bg); border-color: var(--topbar-border); box-shadow: var(--topbar-shadow); backdrop-filter: blur(var(--topbar-blur)); transition: background .18s var(--motion-ease-standard), border-color .18s ease, box-shadow .18s ease; }
.topbar:hover { background: var(--topbar-bg-hover); box-shadow: var(--topbar-shadow-hover); }
.btn { display: inline-flex; align-items: center; gap: 5px; box-shadow: var(--shadow-rest); transition: .18s var(--motion-ease-standard); }
.btn:hover { box-shadow: var(--shadow-hover); }
.board-toolbar .spacer { flex: 1; }
.column { background: var(--column-bg); }
.status-dot { background: var(--content-tertiary); }
.status-dot.iris { background: var(--iris-500); }
.status-dot.cyan { background: var(--cyan-500); }
.status-dot.green { background: var(--green-500); }
.project-card { border-color: var(--project-card-border); border-radius: var(--card-radius); background: linear-gradient(to right, var(--project-card-overlay-start) 0%, var(--project-card-overlay-end) 40%), var(--project-color); box-shadow: var(--project-card-shadow); transition: transform .25s cubic-bezier(.34,1.2,.64,1), box-shadow .25s ease, background .25s ease-out, border-color .18s ease; }
.project-card:hover { box-shadow: var(--project-card-hover-shadow); border-color: var(--project-card-hover-border); }
.project-card::before { content: ''; position: absolute; inset: 0; border-radius: inherit; background: linear-gradient(to bottom, var(--project-card-sheen-rest) 0%, transparent 50%); box-shadow: inset 0 1px 0 var(--project-card-highlight-rest); pointer-events: none; }
.project-card::after { content: ''; position: absolute; inset: 0; border-radius: inherit; background: linear-gradient(to bottom, var(--project-card-sheen-hover) 0%, var(--project-card-sheen-hover-mid) 45%, transparent 100%); box-shadow: inset 0 1px 0 var(--project-card-highlight-hover); opacity: 0; transition: opacity .25s ease; pointer-events: none; }
.project-card:hover::after { opacity: 1; }
.project-card.mini-card { min-height: 83px; }
.project-card.mini-card .project-meta { margin-top: 6px; }
.project-card.mini-card .project-foot { margin-top: 8px; }
.project-foot .done { color: var(--success-fg); }
.gugu-fab { color: #fff; background: var(--brand-gradient); box-shadow: 0 12px 28px rgba(77,65,119,.22); }
.gugu-fab { position: absolute; right: 22px; bottom: 20px; display: flex; align-items: center; justify-content: center; width: 50px; height: 50px; padding: 0; border: 0; border-radius: 50%; background: var(--chat-fab-gradient); box-shadow: var(--chat-fab-shadow); cursor: pointer; transition: transform .2s ease, box-shadow .2s ease; }
.gugu-fab:hover { transform: scale(1.08); box-shadow: var(--chat-fab-hover-shadow); }
.gugu-fab svg { position: relative; z-index: 1; width: 22px; height: 22px; }
.control-stage .btn { box-shadow: none; transition: background .15s ease, color .15s ease, border-color .15s ease; }
.control-stage .btn:hover { transform: none; box-shadow: none; background: var(--surface-soft-hover); }
.control-stage .btn.primary:hover { color: var(--content-inverse); background: var(--action-primary-hover); }
.mock-chat-window { position: absolute; right: 22px; bottom: 82px; z-index: 3; display: flex; flex-direction: column; width: min(360px, calc(100% - 44px)); height: 390px; overflow: hidden; border: 1px solid var(--glass-border); border-radius: 20px; background: var(--glass-bg); box-shadow: var(--shadow-popup); backdrop-filter: blur(28px); }
.mock-chat-header { display: flex; align-items: center; min-height: 52px; gap: 10px; padding: 0 14px; border-bottom: 1px solid var(--border-subtle); color: var(--content-primary); }
.mock-chat-header b { font-size: 14px; }
.mock-chat-header span { display: inline-flex; align-items: center; gap: 4px; margin-left: auto; color: var(--status-success); font-size: 10px; }
.mock-chat-header span i { width: 6px; height: 6px; border-radius: 50%; background: var(--status-success); }
.mock-chat-header button, .mock-chat-composer > button { display: grid; place-items: center; border: 0; border-radius: 7px; color: var(--content-secondary); background: transparent; cursor: pointer; }
.mock-chat-header button { width: 26px; height: 26px; }
.mock-chat-header button:hover, .mock-chat-composer > button:hover { color: var(--content-primary); background: var(--surface-soft-hover); }
.mock-chat-messages { display: flex; flex: 1; flex-direction: column; gap: 10px; padding: 16px 14px; overflow: auto; }
.mock-msg { max-width: 78%; padding: 8px 10px; border-radius: 12px; color: var(--content-primary); font-size: 12px; line-height: 1.5; }
.mock-msg.ai { align-self: flex-start; background: var(--surface-card); }
.mock-msg.user { align-self: flex-end; color: var(--content-inverse); background: var(--action-primary); }
.mock-chat-composer { display: flex; align-items: center; min-height: 50px; gap: 8px; padding: 8px 10px; border-top: 1px solid var(--border-subtle); color: var(--content-tertiary); font-size: 12px; }
.mock-chat-composer > span { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.mock-chat-composer > button { width: 28px; height: 28px; flex: 0 0 auto; }
.mock-chat-composer .mock-send { color: var(--content-inverse); background: var(--action-primary); }
.mock-chat-composer .mock-send:hover { color: var(--content-inverse); background: var(--action-primary-hover); }
.mock-chat-enter-active, .mock-chat-leave-active { transform-origin: bottom right; transition: opacity .2s ease, transform .2s ease; }
.mock-chat-enter-from, .mock-chat-leave-to { opacity: 0; transform: scale(.82); }

@media (max-width: 1050px) { .token-page { padding: 18px; }.hero-note { grid-template-columns: 1fr; }.preview-frame { grid-template-columns: 180px 1fr; }.kanban { grid-template-columns: repeat(3, minmax(150px, 1fr)); overflow-x: auto; }.column:last-child { display: none; }.rule-grid { grid-template-columns: 1fr; }.swatch-grid { grid-template-columns: repeat(5, 1fr); } }
@media (max-width: 640px) { .token-page { padding: 12px; }.token-header { align-items: flex-start; flex-wrap: wrap; }.token-header :deep(.theme-controls) { width: 100%; margin-left: 0; }.preview-frame { grid-template-columns: 1fr; height: 560px; }.preview-sidebar { display: none; }.preview-main { padding-right: 10px; padding-left: 10px; }.topbar { right: 10px; left: 10px; }.search { display: none; }.kanban { grid-template-columns: repeat(2, minmax(150px, 1fr)); }.column:nth-child(n+3) { display: none; }.semantic-layout { grid-template-columns: 1fr; }.project-palette, .swatch-grid { grid-template-columns: repeat(4, 1fr); }.semantic-list, .token-index { grid-template-columns: 1fr; }.footer-note { flex-direction: column; } }
</style>
