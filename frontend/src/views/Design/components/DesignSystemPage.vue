<template>
  <div class="design-page">
    <header class="design-hero">
      <div class="hero-copy">
        <div class="hero-title-row"><span class="eyebrow">GUGU · DESIGN</span><h1>Design Tokens</h1></div>
        <p>Glass / Mono × Light / Dark · 产品样板只消费真实 Semantic / Component tokens。</p>
      </div>
      <ThemeSwitcher :model-value="preference" :family="family" :palette="palette" @update:model-value="setTheme" @update:family="setFamily" @update:palette="setPalette" />
    </header>

    <main class="design-content">
      <div class="theme-matrix" aria-label="主题组合">
        <button
          v-for="choice in themeChoices"
          :key="choice.family + choice.mode"
          class="theme-cell"
          :class="[choice.family + '-' + choice.mode, { active: family === choice.family && resolved === choice.mode }]"
          @click="applyTheme(choice)"
        >
          <div class="theme-mini">
            <span class="mini-side"><i/><i/><i/></span>
            <span class="mini-canvas"><i/><i/><i/></span>
          </div>
          <span><strong>{{ choice.label }}</strong><small>{{ choice.note }}</small></span>
        </button>
      </div>

      <section class="design-section palette-section">
        <div class="section-heading">
          <div>
            <span class="section-kicker">PALETTE SYSTEM</span>
            <h2>主题配色色系</h2>
            <p>每套色板同时覆盖主操作、辅助色、表面和状态色；点击卡片切换当前配色。</p>
          </div>
          <span class="state-badge">{{ palette.toUpperCase() }}</span>
        </div>
        <div class="palette-gallery" aria-label="主题配色色系">
          <button
            v-for="item in paletteChoices"
            :key="item.value"
            type="button"
            class="palette-gallery-card"
            :class="{ active: palette === item.value }"
            :aria-pressed="palette === item.value"
            @click="setPalette(item.value)"
          >
            <div class="palette-gallery-head">
              <span class="palette-gallery-name">{{ item.label }}</span>
              <span class="palette-gallery-note">{{ item.note }}</span>
            </div>
            <div class="palette-swatches" aria-hidden="true">
              <i v-for="swatch in item.swatches" :key="swatch.label" :style="{ background: swatch.color }" />
            </div>
            <div class="palette-gallery-tokens">
              <span v-for="swatch in item.swatches" :key="swatch.label">{{ swatch.label }}</span>
            </div>
          </button>
        </div>
      </section>

      <section class="design-section product-section">
        <div class="section-heading">
          <div>
            <span class="section-kicker">01 · PRODUCT SAMPLE</span>
            <h2>真实项目页样板</h2>
            <p>Preview frame / Column 回到 token.html；项目卡使用真实 ProjectCard 的横向项目色、sheen、hover / active 动画。</p>
          </div>
          <span class="state-badge">{{ family.toUpperCase() }} · {{ resolved.toUpperCase() }}</span>
        </div>

        <div class="product-frame">
          <aside class="sample-sidebar">
            <div class="sample-logo"><span class="sample-logo-icon"><BirdIcon :size="18" /></span><strong>咕咕</strong></div>
            <nav class="sample-nav">
              <span class="sample-nav-label">工作台</span>
              <button class="sample-nav-item active"><PhStack :size="14" weight="bold" />项目<span class="nav-count">4</span></button>
              <button class="sample-nav-item"><PhCalendarBlank :size="14" weight="bold" />日历</button>
              <button class="sample-nav-item"><PhAlarm :size="14" weight="bold" />定时任务</button>
              <button class="sample-nav-item"><PhGraph :size="14" weight="bold" />思维</button>
              <div class="sample-divider" />
              <span class="sample-nav-label">资源</span>
              <button class="sample-nav-item"><PhFolder :size="14" weight="bold" />文件库</button>
              <button class="sample-nav-item muted"><PhAddressBook :size="14" weight="bold" />客户<span class="soon">咕了</span></button>
            </nav>
            <div class="sample-user"><span class="sample-avatar">C</span><div><strong>Coffeiz</strong><small>创作者</small></div></div>
          </aside>

          <div class="sample-main">
            <header class="sample-topbar topbar glass-card">
              <GlassBg />
              <div class="sample-title"><h1>项目</h1><p>8月15日 · 星期六</p></div>
              <div class="sample-search"><PhMagnifyingGlass :size="14" /><span>搜索项目、文件、日程、客户…</span><kbd>⌘ K</kbd></div>
              <div class="sample-top-actions">
                <button class="sample-ghost"><PhUploadSimple :size="13" weight="bold" />上传文件</button>
                <button class="sample-primary"><PhPlus :size="13" weight="bold" />新建项目</button>
              </div>
            </header>

            <div class="sample-board">
              <div v-for="column in projectColumns" :key="column.title" class="project-column glass-card">
                <header class="column-heading"><span class="column-dot" :style="{ background: column.dot }" /><strong>{{ column.title }}</strong><em>{{ column.cards.length }}</em></header>
                <article v-for="card in column.cards" :key="card.name" class="sample-project-card" :style="{ '--project-color': card.color }">
                  <div class="card-copy">
                    <div class="card-name-row"><strong>{{ card.name }}</strong><span class="stars">{{ card.stars }}</span></div>
                    <div class="card-meta"><span>{{ card.client }}</span><span class="stage-chip">{{ card.stage }}</span></div>
                    <div class="card-footer"><span><PhCalendarBlank :size="11" />{{ card.date }}</span><span>{{ card.done }}/{{ card.total }}</span></div>
                    <div class="seg-progress" aria-hidden="true"><i v-for="n in card.total" :key="n" :class="{ done: n <= card.done }" /></div>
                  </div>
                </article>
                <button class="add-project"><PhPlus :size="12" /> 添加项目</button>
              </div>
            </div>
          </div>

          <button class="sample-gugu-fab" title="切换 GuguChat" @click="chatOpen = !chatOpen"><BirdIcon :size="22" /></button>
          <GuguChatMock :open="chatOpen" @close="chatOpen = false" />
        </div>
      </section>

      <section class="design-section">
        <div class="section-heading"><div><span class="section-kicker">02 · FOUNDATIONS</span><h2>颜色、字体与空间</h2><p>公开 API 保持简单；内部 palette 只服务主题实现。字号 / 间距 / 圆角均不超过五档。</p></div></div>
        <div class="subsection first-subsection">
          <div class="subheading"><h3>System color</h3><p>主题切换只重新映射语义，不改组件代码。</p></div>
          <div class="token-grid color-grid">
            <article class="token-card color-card"><div class="color-swatch" style="background:var(--color-accent)" /><div class="token-meta"><strong>Accent</strong><code>--color-accent</code><span>强调 / 主操作前景</span></div></article>
            <article class="token-card color-card"><div class="color-swatch" style="background:var(--color-accent-muted)" /><div class="token-meta"><strong>Muted accent</strong><code>--color-accent-muted</code><span>弱强调 / 选中辅助</span></div></article>
            <article class="token-card color-card"><div class="color-swatch" style="background:var(--action-primary-bg)" /><div class="token-meta"><strong>Action fill</strong><code>--action-primary-bg</code><span>主按钮 / 今日日期底色</span></div></article>
            <article v-for="token in systemColors" :key="token.name" class="token-card color-card"><div class="color-swatch" :style="{ background: `var(${token.name})` }" /><div class="token-meta"><strong>{{ token.label }}</strong><code>{{ token.name }}</code><span>{{ token.note }}</span></div></article>
          </div>
        </div>
        <div class="subsection">
          <div class="subheading"><h3>Project color</h3><p>内容色跨 Glass / Mono 保持身份。</p></div>
          <div class="token-grid color-grid compact-colors">
            <article v-for="token in projectColors" :key="token.name" class="token-card color-card"><div class="color-swatch" :style="{ background: `var(${token.name})` }" /><div class="token-meta"><strong>{{ token.label }}</strong><code>{{ token.name }}</code></div></article>
          </div>
        </div>
        <div class="subsection">
          <div class="subheading"><h3>Scrollbar</h3><p>透明轨道、细滑块、安全边距；四个区域都是真实 overflow，可直接拖动。</p></div>
          <div class="scrollbar-token-layout">
            <div class="scrollbar-token-label">颜色</div>
            <div class="token-grid color-grid compact-colors">
              <article v-for="token in scrollbarColors" :key="token.name" class="token-card color-card scrollbar-token-card">
                <div class="color-swatch" :style="{ background: `var(${token.name})` }" />
                <div class="token-meta"><strong>{{ token.label }}</strong><code>{{ token.name }}</code><span>{{ token.note }}</span></div>
              </article>
            </div>
            <div class="scrollbar-token-label scrollbar-style-heading">交互样式 · 4 种</div>
            <div class="scrollbar-demo-grid">
              <article v-for="token in scrollbarStyles" :key="token.name" class="token-card scrollbar-style-card">
                <div class="scrollbar-live-surface" :class="`scrollbar-density-${token.density}`">
                  <span v-for="n in 9" :key="n">Scroll row {{ n }} · {{ token.label }}</span>
                </div>
                <div class="token-meta"><strong>{{ token.label }}</strong><code>{{ token.name }}</code><span>{{ token.note }}</span></div>
              </article>
              <article class="token-card scrollbar-style-card scrollbar-overflow-card">
                <div class="scrollbar-overflow-surface">
                  <div class="scrollbar-overflow-content"><span v-for="n in 9" :key="n">Overflow row {{ n }} · horizontal content preview · safe inset</span></div>
                </div>
                <div class="token-meta"><strong>Overflow X / Y</strong><code>overflow: auto</code><span>横向 + 纵向真实滚动条</span></div>
              </article>
            </div>
          </div>
        </div>
        <div class="subsection">
          <div class="subheading"><h3>Hover motion · 3</h3><p>悬停反馈统一为微交互、控件、卡片主体三档速度。</p></div>
          <div class="motion-token-grid">
            <article v-for="token in hoverMotionTokens" :key="token.name" class="token-card motion-token-card">
              <div class="motion-preview"><span class="motion-preview-dot" :style="{ '--motion-preview-duration': `var(${token.name})` }" /></div>
              <div class="token-meta"><strong>{{ token.label }}</strong><code>{{ token.name }}</code><span>{{ token.value }} · {{ token.note }}</span></div>
            </article>
          </div>
        </div>
        <div class="foundation-split">
          <div class="foundation-panel">
            <div class="subheading"><h3>Typography · 5</h3><p>11 / 12 / 14 / 16 / 20</p></div>
            <div class="type-list"><div v-for="row in typeScale" :key="row.token" class="type-row"><span class="type-sample" :style="{ fontSize: `var(${row.token})`, fontWeight: row.weight }">{{ row.sample }}</span><div class="type-meta"><strong>{{ row.role }}</strong><code>{{ row.token }}</code><small>{{ row.size }}</small></div></div></div>
          </div>
          <div class="foundation-panel">
            <div class="subheading"><h3>Spacing · 5</h3><p>4 / 8 / 12 / 16 / 24</p></div>
            <div class="space-list"><div v-for="item in spacingScale" :key="item.token" class="space-row"><code>{{ item.token }}</code><span class="space-bar" :style="{ width: `var(${item.token})` }" /><em>{{ item.value }}</em></div></div>
            <div class="radius-title"><h3>Radius · 5</h3><p>四档几何圆角 + pill</p></div>
            <div class="radius-row"><div v-for="item in radiusScale" :key="item.token" class="radius-item"><span :style="{ borderRadius: `var(${item.token})` }" /><code>{{ item.token }}</code><small>{{ item.value }}</small></div></div>
          </div>
        </div>
        <div class="subsection font-family-section">
          <div class="subheading"><h3>Font families · 4</h3><p>字体族与字号、字重、行高分离；组件只消费角色 token。</p></div>
          <div class="font-family-grid">
            <article v-for="item in fontFamilyTokens" :key="item.token" class="font-family-card">
              <div class="font-family-sample" :style="{ fontFamily: `var(${item.token})` }">{{ item.sample }}</div>
              <div class="font-family-meta"><strong>{{ item.role }}</strong><code>{{ item.token }}</code><span>{{ item.note }}</span></div>
            </article>
          </div>
        </div>
      </section>

      <section class="design-section">
        <div class="section-heading"><div><span class="section-kicker">03 · SEMANTIC TOKENS</span><h2>角色 + 实际使用模板</h2><p>每张卡直接演示它在 Surface / Text / Border / Action / Status 中的真实用法。</p></div></div>
        <div class="semantic-groups">
          <article v-for="group in semanticGroups" :key="group.title" class="semantic-group">
            <header><div><h3>{{ group.title }}</h3><p>{{ group.description }}</p></div><span>{{ group.tokens.length }}</span></header>
            <div class="semantic-grid">
              <div v-for="token in group.tokens" :key="token.name" class="token-card semantic-card">
                <div class="semantic-demo">
                  <div v-if="token.demo === 'surface'" class="surface-demo" :style="{ background: `var(${token.name})` }">Surface</div>
                  <div v-else-if="token.demo === 'text'" class="text-demo" :style="{ color: `var(${token.name})` }">咕咕正在整理项目</div>
                  <div v-else-if="token.demo === 'border'" class="border-demo" :style="{ borderColor: `var(${token.name})` }">Input / Card edge</div>
                  <button v-else-if="token.demo === 'action'" class="action-demo" :style="{ background: `var(${token.name})` }">新建项目</button>
                  <button v-else-if="token.demo === 'secondary'" class="secondary-demo" :style="secondaryDemoStyle(token)">上传文件</button>
                  <span v-else class="status-demo" :style="{ color: `var(${token.name})`, background: `color-mix(in srgb,var(${token.name}) 14%,transparent)` }"><i :style="{ background: `var(${token.name})` }" />{{ token.usage }}</span>
                </div>
                <div class="token-meta"><strong>{{ token.label }}</strong><code>{{ token.name }}</code><span>{{ token.usage }}</span></div>
              </div>
            </div>
          </article>
        </div>
      </section>

      <section class="design-section">
        <div class="section-heading"><div><span class="section-kicker">04 · ELEVATION</span><h2>真实产品层级</h2><p>Card rest / hover、Popup、GuguChat Window，而不是无语义阴影样片。</p></div></div>
        <div class="elevation-grid">
          <article class="elevation-case"><div class="mini-project" style="--project-color:var(--project-lilac)"><strong>项目卡 · Rest</strong><span>角色设定 · 2/4</span></div><div class="case-meta"><strong>Card rest</strong><code>--elevation-card</code><span>项目 / 文件卡</span></div></article>
          <article class="elevation-case"><div class="mini-project hover-case" style="--project-color:var(--project-sky)"><strong>项目卡 · Hover</strong><span>画册排版 · 3/4</span></div><div class="case-meta"><strong>Card hover</strong><code>--elevation-card-hover</code><span>真实 -2px 抬起</span></div></article>
          <article class="elevation-case"><div class="mini-popup"><strong>当前阶段</strong><span>✓ 草图确认</span><span>○ 线稿整理</span><button>＋ 添加待办</button></div><div class="case-meta"><strong>Popup</strong><code>--elevation-popup</code><span>菜单 / 搜索</span></div></article>
          <article class="elevation-case"><div class="mini-chat"><span><BirdIcon :size="15" /></span><div><strong>GuguChat</strong><small>Window level</small></div></div><div class="case-meta"><strong>Window</strong><code>--elevation-window</code><span>聊天 / 浮窗</span></div></article>
        </div>
      </section>

      <section class="design-section">
        <div class="section-heading"><div><span class="section-kicker">05 · COMPONENT CONTRACTS</span><h2>产品对象与组件表面</h2><p>业务组件只引用 Component contract；弹窗、输入、选择胶囊与 Mind 纸面直接消费真实 tokens，切换 Aero / Mono 与 Light / Dark 时无需页面分支。</p></div></div>
        <div class="component-strip">
          <div v-for="item in contracts" :key="item.name" class="contract-card">
            <span class="contract-icon" :class="{ gugu: item.name === 'Gugu', danger: item.name === 'Danger Action' }"><component :is="item.icon" :size="18" /></span>
            <div><strong>{{ item.name }}</strong><code>{{ item.token }}</code><small>{{ item.note }}</small></div>
            <button v-if="item.name === 'Danger Action'" class="danger-contract-btn">删除</button>
          </div>
        </div>

        <div class="contracts-detail">
          <div class="preview-grid surface-grid">
            <article class="preview-card">
              <div class="preview-stage panel-stage">
                <div class="panel-preview"><strong>Panel glass</strong><span>导航 / 双栏弹窗侧栏</span></div>
              </div>
              <div class="meta"><strong>Panel surface</strong><code>--panel-glass-*</code><span>panel-left / 毛玻璃侧栏</span></div>
            </article>
            <article class="preview-card">
              <div class="preview-stage modal-stage">
                <div class="modal-preview"><strong>Modal card</strong><span>统一描边、高光与窗口层级阴影</span></div>
              </div>
              <div class="meta"><strong>Modal surface</strong><code>--modal-card-*</code><span>BaseModal / 二次确认</span></div>
            </article>
            <article class="preview-card">
              <div class="preview-stage input-stage"><input class="contract-input" value="暗色输入框也消费同一角色" /></div>
              <div class="meta"><strong>Input</strong><code>--input-*</code><span>背景 / 边框 / focus / placeholder</span></div>
            </article>
          </div>

          <div class="subhead"><div><h3>Confirm dialog</h3><p>破坏性操作统一使用 Promise 确认服务；危险态、按钮与说明消费同一套组件 token。</p></div><code>--confirm-dialog-*</code></div>
          <div class="confirm-preview preview-card">
            <div class="confirm-preview-stage">
              <div class="confirm-preview-copy"><strong>统一二次确认</strong><span>点击预览真实 ConfirmDialog，不使用浏览器原生 confirm。</span></div>
              <button class="sample-primary" type="button" @click="openConfirmPreview">预览确认弹窗</button>
            </div>
            <div class="meta"><strong>Confirm dialog</strong><code>ConfirmDialog.vue</code><span>普通确认 / 警告 / 危险删除</span></div>
          </div>

          <div class="subhead"><div><h3>Secondary action</h3><p>次要按钮：顶栏「上传文件」等辅助操作。Rest / Hover 消费同一组 token，暗色自动切换为 surface 填充。</p></div><code>--action-secondary-*</code></div>
          <div class="secondary-demo-grid preview-card">
            <div class="secondary-demo-cell">
              <button class="secondary-sample">上传文件</button>
              <div class="meta"><strong>Rest</strong><code>--action-secondary-bg / border / fg</code><span>玻璃感浅填充 + 描边</span></div>
            </div>
            <div class="secondary-demo-cell">
              <button class="secondary-sample hovered">上传文件</button>
              <div class="meta"><strong>Hover</strong><code>--action-secondary-bg-hover / border-hover / fg-hover</code><span>提亮 + 前景加深</span></div>
            </div>
          </div>

          <div class="subhead"><div><h3>Choice capsule</h3><p>个人设置中的主题、模式、回复风格、多选工具统一调用。</p></div><code>--choice-chip-*</code></div>
          <div class="chip-demo preview-card">
            <button class="choice-chip">默认</button>
            <button class="choice-chip active">已选择</button>
            <button class="choice-chip">另一个选项</button>
          </div>

          <div class="subhead"><div><h3>Inline rename input</h3><p>文件卡与工作区重命名共用的小尺寸输入框契约。</p></div><code>--rename-input-*</code></div>
          <div class="rename-token-preview preview-card">
            <span class="rename-sizer"><span class="rename-ghost">参考素材</span><input class="rename-input-inline" value="参考素材" aria-label="重命名输入框示例" /></span>
          </div>
          <div class="token-grid compact-colors rename-token-grid">
            <article v-for="token in renameInputTokens" :key="token.name" class="token-card color-card">
              <div class="rename-token-swatch" :style="{ background: token.demo === 'surface' ? `var(${token.name})` : 'var(--surface-soft)' }">
                <span v-if="token.demo === 'radius'" :style="{ borderRadius: `var(${token.name})` }" />
                <span v-else-if="token.demo === 'size'" :style="{ width: `var(${token.name})`, height: '8px' }" />
                <code v-else>{{ token.value }}</code>
              </div>
              <div class="token-meta"><strong>{{ token.label }}</strong><code>{{ token.name }}</code><span>{{ token.note }}</span></div>
            </article>
          </div>

          <div class="subhead"><div><h3>Mind note palette</h3><p>保存的 amber / coral / blue / teal 不变；渲染色按当前主题 surface 自动混合。</p></div><code>--note-paper-*</code></div>
          <div class="note-grid">
            <article v-for="note in notes" :key="note.token" class="preview-card note-token">
              <div class="note-swatch" :style="{ background: `var(${note.token})` }"><strong>{{ note.label }}</strong><span>便签正文示例</span></div>
              <div class="meta"><code>{{ note.token }}</code><span>{{ note.note }}</span></div>
            </article>
          </div>
        </div>
      </section>

      <section class="design-section index-section">
        <div class="section-heading"><div><span class="section-kicker">06 · TOKEN INDEX</span><h2>统一索引卡</h2><p>与颜色卡、Semantic 卡使用同一套表面和文字规则。</p></div></div>
        <div class="index-groups"><article v-for="group in tokenIndex" :key="group.title" class="index-group"><header><h3>{{ group.title }}</h3><span>{{ group.items.length }}</span></header><div class="index-grid"><div v-for="item in group.items" :key="item" class="token-card index-card"><code>{{ item }}</code><span class="index-dot" :style="indexDotStyle(item)" /></div></div></article></div>
      </section>
    </main>
  </div>
</template>

<script setup lang="ts">
import { h, ref } from 'vue'
import { PhAddressBook, PhAlarm, PhBrowser, PhCalendarBlank, PhFolder, PhGraph, PhMagnifyingGlass, PhPlus, PhSidebarSimple, PhStack, PhTrash, PhUploadSimple } from '@phosphor-icons/vue'
import { useTheme, type ThemePalette } from '@/composables/useTheme'
import ThemeSwitcher from './ThemeSwitcher.vue'
import GuguChatMock from './GuguChatMock.vue'
import GlassBg from '@/components/common/GlassBg.vue'
import { confirmDialog } from '@/composables/useConfirmDialog'

const { preference, resolved, family, palette, setTheme, setFamily, setPalette } = useTheme()
const chatOpen = ref(false)
async function openConfirmPreview() {
  await confirmDialog({
    title: '删除项目',
    message: '项目中的内容将一并删除，此操作不可恢复。',
    tone: 'danger',
    confirmText: '删除',
  })
}
const themeChoices = [
  { family:'glass', mode:'light', label:'Glass Light', note:'原始咕咕玻璃' },
  { family:'glass', mode:'dark', label:'Glass Dark', note:'低亮度透明层' },
  { family:'mono', mode:'light', label:'Mono Light', note:'Pearl / Ink / Iris' },
  { family:'mono', mode:'dark', label:'Mono Dark', note:'低拟态实体表面' },
] as const
function applyTheme(choice: typeof themeChoices[number]) { setFamily(choice.family); setTheme(choice.mode) }
const paletteChoices: Array<{ value: ThemePalette; label: string; note: string; swatches: Array<{ label: string; color: string }> }> = [
  { value: 'mist', label: 'Mist', note: '轻盈通透的柔和雾色', swatches: [
    { label: 'Primary', color: '#7b7fb2' }, { label: 'Surface', color: '#eef0f6' }, { label: 'Success', color: '#5a9e88' }, { label: 'Danger', color: '#c85a5a' },
  ] },
  { value: 'cafe', label: 'Cafe', note: '温暖咖啡棕色系', swatches: [
    { label: 'Primary', color: '#746b78' }, { label: 'Surface', color: '#f7f5f8' }, { label: 'Success', color: '#5e8877' }, { label: 'Danger', color: '#a65d60' },
  ] },
  { value: 'rose', label: 'Rose', note: '低饱和玫瑰邻近色', swatches: [
    { label: 'Primary', color: '#c98f98' }, { label: 'Surface', color: '#f7eff0' }, { label: 'Success', color: '#89a58e' }, { label: 'Danger', color: '#bd7c82' },
  ] },
  { value: 'sky', label: 'Sky', note: '低饱和天空邻近色', swatches: [
    { label: 'Primary', color: '#83a9c2' }, { label: 'Surface', color: '#edf4f7' }, { label: 'Success', color: '#84a598' }, { label: 'Danger', color: '#b98087' },
  ] },
  { value: 'sage', label: 'Sage', note: '低饱和鼠尾草邻近色', swatches: [
    { label: 'Primary', color: '#84ab9e' }, { label: 'Surface', color: '#edf5f2' }, { label: 'Success', color: '#789d8c' }, { label: 'Danger', color: '#b98186' },
  ] },
]

const BirdIcon = (props: { size?: number }) => h('svg', { width:props.size ?? 18,height:props.size ?? 18,viewBox:'0 0 24 24',fill:'none',stroke:'currentColor','stroke-width':'1.7','stroke-linecap':'round','stroke-linejoin':'round' }, [
  h('path',{d:'M16 7h.01'}),h('path',{d:'M3.4 18H12a8 8 0 0 0 8-8V7a4 4 0 0 0-7.28-2.3L2 20'}),h('path',{d:'M20 7l2 .5-2 .5'}),h('path',{d:'M10 18v3'}),h('path',{d:'M14 17.75V21'}),
])

const projectColumns = [
  { title:'待开始', dot:'var(--project-sand)', cards:[
    { name:'夏日插画',client:'个人创作',stage:'构思',date:'8/18 → 8/25',done:1,total:4,stars:'★★☆',color:'var(--project-sand)' },
    { name:'网站作品集',client:'Coffeiz',stage:'素材',date:'8/20 → 9/02',done:1,total:5,stars:'★☆☆',color:'var(--project-mauve)' },
  ]},
  { title:'进行中', dot:'var(--action-primary)', cards:[
    { name:'角色设定',client:'原创项目',stage:'线稿',date:'8/12 → 8/19',done:2,total:4,stars:'★★★',color:'var(--project-lilac)' },
    { name:'画册排版',client:'人生对比色',stage:'版式',date:'8/10 → 8/22',done:3,total:4,stars:'★★☆',color:'var(--project-sky)' },
  ]},
  { title:'待确认', dot:'var(--project-rose)', cards:[
    { name:'封面设计',client:'委托',stage:'配色确认',date:'8/14 → 8/20',done:3,total:5,stars:'★★☆',color:'var(--project-rose)' },
  ]},
  { title:'已完成', dot:'var(--status-success)', cards:[
    { name:'七月头像稿',client:'委托',stage:'完成',date:'8/06',done:4,total:4,stars:'★★☆',color:'var(--project-leaf)' },
  ]},
]

const systemColors = [
  ['Primary','--color-primary','主操作 / 品牌动作'],['Text','--color-text','主要内容'],['Muted','--color-muted','次级内容'],['Surface','--color-surface','实体表面'],['Line','--color-line','控件 / 分隔'],['Success','--color-success','完成 / 在线'],['Warning','--color-warning','临期 / 休息'],['Danger','--color-danger','错误 / 删除'],['Info','--color-info','信息提示'],
].map(([label,name,note])=>({label,name,note}))
const projectColors = [['Lilac','--project-lilac'],['Rose','--project-rose'],['Sky','--project-sky'],['Leaf','--project-leaf'],['Sand','--project-sand'],['Coral','--project-coral'],['Blue','--project-blue'],['Mauve','--project-mauve']].map(([label,name])=>({label,name}))
const scrollbarColors = [
  { label: 'Track', name: '--scrollbar-track', note: '滚动轨道', kind: 'color' },
  { label: 'Thumb', name: '--scrollbar-thumb', note: '静止滑块', kind: 'color' },
  { label: 'Thumb hover', name: '--scrollbar-thumb-hover', note: '悬停滑块', kind: 'color' },
]
const scrollbarStyles = [
  { label: 'Default', name: '--scrollbar-size-default', note: '页面 / 普通容器', kind: 'size', density: 'default' },
  { label: 'Compact', name: '--scrollbar-size-compact', note: '紧凑列表', kind: 'size', density: 'compact' },
  { label: 'Editor', name: '--scrollbar-size-editor', note: '编辑器', kind: 'size', density: 'editor' },
]
const hoverMotionTokens = [
  { label: 'Micro', name: '--motion-hover-micro', value: '120ms', note: '连接点 / 箭头 / 轻量状态' },
  { label: 'Control', name: '--motion-hover-control', value: '150ms', note: '按钮 / 输入框 / 附加交互' },
  { label: 'Card', name: '--motion-hover-card', value: '250ms', note: '卡片抬起 / 阴影 / 高光' },
]
const typeScale = [
  {role:'Caption',token:'--font-size-xs',size:'11px',weight:500,sample:'项目阶段 · 刚刚更新'},
  {role:'Secondary',token:'--font-size-sm',size:'12px',weight:400,sample:'明天下午留给角色设定'},
  {role:'Body / Nav',token:'--font-size-md',size:'14px',weight:500,sample:'咕咕正在整理今天的项目进度。'},
  {role:'Section',token:'--font-size-lg',size:'16px',weight:600,sample:'Semantic Tokens'},
  {role:'Title',token:'--font-size-xl',size:'20px',weight:700,sample:'Design Tokens'},
]
const fontFamilyTokens = [
  { role:'Body', token:'--font-family-body', sample:'咕咕正在整理今天的项目进度。', note:'正文 / 项目卡 / 聊天气泡' },
  { role:'UI', token:'--font-family-ui', sample:'新建项目 · 上传文件 · 保存', note:'导航 / 按钮 / 表单控件' },
  { role:'Heading', token:'--font-family-heading', sample:'Design Tokens', note:'页面标题 / 区块标题' },
  { role:'Mono', token:'--font-family-mono', sample:'GET /api/v1/projects 200', note:'代码 / 日志 / 路径' },
]
const spacingScale = [['--space-xs','4px'],['--space-sm','8px'],['--space-md','12px'],['--space-lg','16px'],['--space-xl','24px']].map(([token,value])=>({token,value}))
const radiusScale = [['--radius-xs','6px'],['--radius-sm','10px'],['--radius-md','14px'],['--radius-lg','20px'],['--radius-pill','pill']].map(([token,value])=>({token,value}))
const semanticGroups = [
  {title:'Surface',description:'页面、面板、浮层。',tokens:[{label:'Page',name:'--surface-page',usage:'App 背景',demo:'surface'},{label:'Sidebar',name:'--surface-sidebar',usage:'侧栏',demo:'surface'},{label:'Raised',name:'--surface-raised',usage:'控件 / 气泡',demo:'surface'},{label:'Floating',name:'--surface-floating',usage:'Popup / Window',demo:'surface'}]},
  {title:'Content',description:'文字只按角色分层。',tokens:[{label:'Primary',name:'--content-primary',usage:'标题 / 正文',demo:'text'},{label:'Secondary',name:'--content-secondary',usage:'元信息',demo:'text'},{label:'Tertiary',name:'--content-tertiary',usage:'提示 / 时间',demo:'text'},{label:'Disabled',name:'--content-disabled',usage:'不可用',demo:'text'}]},
  {title:'Border',description:'边框表达层级与焦点。',tokens:[{label:'Subtle',name:'--border-subtle',usage:'分隔 / 内层边',demo:'border'},{label:'Default',name:'--border-default',usage:'控件边缘',demo:'border'},{label:'Strong',name:'--border-strong',usage:'Glass / Popup',demo:'border'},{label:'Focus',name:'--border-focus',usage:'键盘焦点',demo:'border'}]},
  {title:'Action',description:'Iris 只承担动作。',tokens:[{label:'Primary',name:'--action-primary',usage:'主按钮前景',demo:'action'},{label:'Fill',name:'--action-primary-bg',usage:'主按钮 / 今日日期底色',demo:'action'},{label:'Hover',name:'--action-primary-hover',usage:'主操作 hover',demo:'action'},{label:'Secondary',name:'--action-secondary-bg',usage:'次要按钮背景',demo:'secondary'},{label:'Secondary hover',name:'--action-secondary-bg-hover',usage:'次要按钮 hover',demo:'secondary'},{label:'Secondary border',name:'--action-secondary-border',usage:'次要按钮边框',demo:'secondary'},{label:'Secondary fg',name:'--action-secondary-fg',usage:'次要按钮前景',demo:'secondary'},{label:'Selection',name:'--selection-bg',usage:'选中背景',demo:'surface'}]},
  {title:'Status',description:'状态色不参与环境装饰。',tokens:[{label:'Success',name:'--status-success',usage:'在线 / 完成',demo:'status'},{label:'Warning',name:'--status-warning',usage:'临期 / 休息',demo:'status'},{label:'Danger',name:'--status-danger',usage:'错误 / 删除',demo:'status'},{label:'Info',name:'--status-info',usage:'信息提示',demo:'status'}]},
]
const contracts = [
  {name:'Sidebar',token:'--sidebar-*',note:'导航 / 用户卡',icon:PhSidebarSimple},
  {name:'Topbar',token:'--topbar-*',note:'滚动后出现玻璃',icon:PhBrowser},
  {name:'Project Card',token:'--project-card-*',note:'真实项目色与动画',icon:PhStack},
  {name:'Gugu',token:'--gugu-*',note:'FAB / Chat',icon:BirdIcon},
  {name:'Danger Action',token:'--danger-button-*',note:'删除 / 清空 / 注销',icon:PhTrash},
  {name:'Confirm Dialog',token:'--confirm-dialog-*',note:'统一二次确认',icon:PhTrash},
]
const tokenIndex = [
  {title:'Foundations',items:['--font-family-body','--font-family-ui','--font-family-heading','--font-family-mono','--font-size-xs','--font-size-sm','--font-size-md','--font-size-lg','--font-size-xl','--space-xs','--space-sm','--space-md','--space-lg','--space-xl','--radius-xs','--radius-sm','--radius-md','--radius-lg','--radius-pill','--scrollbar-size-default','--scrollbar-size-compact','--scrollbar-size-editor','--scrollbar-safe-inset']},
  {title:'Semantic',items:['--color-primary','--color-accent','--color-accent-muted','--action-primary-bg','--action-secondary-bg','--action-secondary-border','--action-secondary-fg','--surface-hover-tint','--color-text','--color-muted','--color-surface','--surface-floating','--content-primary','--border-subtle','--status-success','--elevation-popup']},
  {title:'Components',items:['--sidebar-item-active','--topbar-bg','--confirm-dialog-width','--confirm-dialog-bg','--confirm-dialog-padding','--confirm-dialog-icon-fg','--confirm-dialog-confirm-bg','--confirm-dialog-danger-confirm-bg','--danger-button-fg','--danger-button-bg','--danger-button-bg-hover','--danger-button-border','--danger-button-border-hover','--motion-hover-micro','--motion-hover-control','--motion-hover-card','--card-motion','--card-overlay-motion','--calendar-grid-line','--calendar-weekend-bg','--calendar-today-date-bg','--scrollbar-track','--scrollbar-thumb','--scrollbar-thumb-hover','--scrollbar-overlay-right-offset','--scrollbar-column-right-offset','--scrollbar-overlay-z-index','--scrollbar-overlay-modal-z-index','--scrollbar-overlay-transition','--scrollbar-overlay-track-inset','--project-card-shadow','--project-card-motion','--gugu-chat-bg','--gugu-chat-sidebar-bg','--gugu-fab-bg']},
]
function indexDotStyle(token:string){return /color|surface|content|border|action|status|danger|bg|active|calendar/.test(token)?{background:`var(${token})`}:{background:'var(--action-primary)'}}
/* 次要按钮样板：按 token 角色决定把当前 token 映射到背景 / 边框 / 前景，其余属性用配套 token。 */
function secondaryDemoStyle(token:{name:string}){
  const name = token.name
  const base = { background:'var(--action-secondary-bg)', borderColor:'var(--action-secondary-border)', color:'var(--action-secondary-fg)' }
  if (name.includes('bg')) return { ...base, background:`var(${name})` }
  if (name.includes('border')) return { ...base, borderColor:`var(${name})` }
  if (name.includes('fg')) return { ...base, color:`var(${name})` }
  return base
}
const renameInputTokens = [
  { label:'Height', name:'--rename-input-height', value:'20px', note:'标题/文件名内联编辑高度', demo:'size' },
  { label:'Padding', name:'--rename-input-padding', value:'0 4px', note:'紧凑文字内边距', demo:'surface' },
  { label:'Radius', name:'--rename-input-radius', value:'4px', note:'小输入框圆角', demo:'radius' },
  { label:'Background', name:'--rename-input-bg', value:'var(--input-bg)', note:'主题输入框底色', demo:'surface' },
  { label:'Border', name:'--rename-input-border', value:'var(--input-border)', note:'主题输入框边框', demo:'surface' },
  { label:'Foreground', name:'--rename-input-fg', value:'var(--input-fg)', note:'主题输入框文字', demo:'surface' },
]

const notes = [
  { label: 'Default', token: '--note-surface', note: '时间流默认纸面' },
  { label: 'Amber', token: '--note-paper-amber', note: '橙色便签' },
  { label: 'Coral', token: '--note-paper-coral', note: '红色便签' },
  { label: 'Blue', token: '--note-paper-blue', note: '蓝色便签' },
  { label: 'Teal', token: '--note-paper-teal', note: '青色便签' },
]
</script>

<style scoped>
.motion-token-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:var(--design-grid-gap)}.motion-token-card{overflow:hidden}.motion-preview{height:76px;display:flex;align-items:center;padding:0 var(--space-lg);border-bottom:1px solid var(--border-hairline);background:var(--surface-soft)}.motion-preview-dot{width:22px;height:22px;border-radius:var(--radius-pill);background:var(--action-primary);box-shadow:0 3px 10px color-mix(in srgb,var(--action-primary) 28%,transparent);transition:transform var(--motion-preview-duration) var(--motion-ease-emphasis)}.motion-token-card:hover .motion-preview-dot{transform:translateX(calc(100% + 120px))}.design-page{min-height:100vh;background:var(--surface-page);color:var(--content-primary);font-family:var(--font-sans);font-synthesis:none;-webkit-font-smoothing:antialiased}
.design-hero{position:fixed;top:0;right:0;left:0;z-index:50;min-height:58px;display:flex;align-items:center;gap:var(--space-xl);padding:var(--space-sm) clamp(var(--space-lg),4vw,56px);background:color-mix(in srgb,var(--surface-glass) 78%,transparent);border-bottom:1px solid var(--border-strong);backdrop-filter:blur(18px);-webkit-backdrop-filter:blur(18px)}
.hero-copy{min-width:0;max-width:760px}.hero-title-row{display:flex;align-items:baseline;gap:var(--space-sm)}.eyebrow,.section-kicker{color:var(--content-tertiary);font-size:var(--font-size-xs);font-weight:var(--font-weight-semibold);letter-spacing:var(--tracking-label)}.hero-copy h1{margin:0;padding-block:2px;font-size:var(--font-size-xl);line-height:var(--line-height-tight)}.hero-copy p{margin-top:var(--space-xs);color:var(--content-secondary);font-size:var(--font-size-xs);line-height:var(--line-height-ui);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.design-content{width:min(1440px,100%);margin:0 auto;padding:calc(58px + var(--space-xl) + var(--space-lg)) clamp(var(--space-lg),4vw,56px) 72px}
.theme-matrix{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:var(--space-sm);margin-bottom:var(--space-xl)}
.palette-section{margin-bottom:var(--design-section-gap)}.palette-gallery{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:var(--design-grid-gap)}.palette-gallery-card{display:flex;flex-direction:column;gap:var(--space-md);min-width:0;padding:var(--space-lg);text-align:left;color:var(--content-primary);background:var(--design-card-bg);border:1px solid var(--design-card-border);border-radius:var(--design-card-radius);box-shadow:var(--elevation-card);cursor:pointer;transition:background var(--motion-hover-control),border-color var(--motion-hover-control),box-shadow var(--motion-hover-control),transform var(--motion-hover-control)}.palette-gallery-card:hover{background:var(--surface-raised);border-color:var(--border-hover);box-shadow:var(--elevation-card-hover);transform:translateY(-1px)}.palette-gallery-card.active{border-color:var(--action-outline);box-shadow:0 0 0 2px var(--action-soft),var(--elevation-card)}.palette-gallery-head{display:flex;align-items:baseline;justify-content:space-between;gap:var(--space-sm)}.palette-gallery-name{font-weight:var(--font-weight-semibold)}.palette-gallery-note{color:var(--content-tertiary);font-size:var(--font-size-xs)}.palette-swatches{display:grid;grid-template-columns:repeat(4,1fr);gap:var(--space-xs);height:36px}.palette-swatches i{display:block;border-radius:var(--radius-xs);box-shadow:inset 0 1px 0 rgba(255,255,255,.28),inset 0 -1px 0 rgba(0,0,0,.08)}.palette-gallery-tokens{display:flex;justify-content:space-between;color:var(--content-tertiary);font-size:var(--font-size-xs)}
.theme-cell{min-width:0;padding:var(--space-sm);display:flex;align-items:center;gap:var(--space-sm);border:1px solid var(--border-subtle);border-radius:var(--radius-md);color:var(--content-secondary);background:var(--surface-base);box-shadow:var(--elevation-card);font-family:var(--font-sans);text-align:left;cursor:pointer;transition:transform .18s var(--ease-standard),box-shadow .18s var(--ease-standard),outline-color .18s ease}
.theme-cell:hover{transform:translateY(-1px);box-shadow:var(--elevation-card-hover)}.theme-cell.active{outline:2px solid var(--focus-ring);outline-offset:1px}.theme-cell>span:last-child{min-width:0;display:flex;flex-direction:column}.theme-cell strong{font-size:var(--font-size-sm);color:var(--content-primary)}.theme-cell small{margin-top:var(--space-xs);font-size:var(--font-size-xs);color:var(--content-tertiary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.theme-mini{width:72px;height:42px;flex-shrink:0;display:grid;grid-template-columns:20px 1fr;overflow:hidden;border:1px solid rgba(100,100,120,.12);border-radius:var(--radius-sm);background:var(--preview-bg)}.mini-side{padding:5px 3px;display:flex;flex-direction:column;gap:3px;background:var(--preview-side)}.mini-side i{height:3px;border-radius:var(--radius-pill);background:var(--preview-line)}.mini-canvas{padding:6px;display:flex;flex-direction:column;gap:4px}.mini-canvas i{height:7px;border:1px solid var(--preview-border);border-radius:4px;background:var(--preview-card)}
.glass-light{--preview-bg:linear-gradient(145deg,#e8e9ee,#a7afc2);--preview-side:rgba(255,255,255,.48);--preview-card:rgba(255,255,255,.72);--preview-line:#7b7fb2;--preview-border:rgba(255,255,255,.75)}
.glass-dark{--preview-bg:linear-gradient(145deg,#0e101a,#17192b);--preview-side:rgba(28,30,47,.88);--preview-card:rgba(255,255,255,.07);--preview-line:#9590c4;--preview-border:rgba(255,255,255,.10)}
.mono-light{--preview-bg:linear-gradient(180deg,#f5f3f6,#eeecf0);--preview-side:#f8f6f9;--preview-card:#fbfafc;--preview-line:#7067a5;--preview-border:rgba(42,35,49,.09)}
.mono-dark{--preview-bg:linear-gradient(180deg,#1c1921,#17151b);--preview-side:#201d25;--preview-card:#24212a;--preview-line:#a49acb;--preview-border:rgba(255,255,255,.08)}
.design-section{position:relative;margin-bottom:var(--design-section-gap);padding:var(--space-xl);background:var(--design-section-bg);border:1px solid var(--design-section-border);border-radius:var(--design-section-radius);box-shadow:var(--design-section-shadow),inset 0 1px 0 var(--design-section-highlight);backdrop-filter:blur(18px);-webkit-backdrop-filter:blur(18px)}
.product-section{padding:0;background:transparent;border:0;border-radius:0;box-shadow:none;backdrop-filter:none;-webkit-backdrop-filter:none}
:global(html[data-family='mono']) .design-section:not(.product-section){background:var(--surface-base);border-color:var(--border-subtle);box-shadow:var(--elevation-card);backdrop-filter:none;-webkit-backdrop-filter:none}
.section-heading{display:flex;align-items:flex-end;justify-content:space-between;gap:var(--space-xl);margin-bottom:var(--space-lg)}.section-heading h2{margin-top:var(--space-xs);font-size:var(--font-size-lg);font-weight:var(--font-weight-semibold)}.section-heading p{max-width:820px;margin-top:var(--space-xs);color:var(--content-secondary);font-size:var(--font-size-sm);line-height:var(--line-height-body)}.state-badge{padding:var(--space-xs) var(--space-sm);border:1px solid var(--border-subtle);border-radius:var(--radius-pill);color:var(--selection-fg);background:var(--selection-bg);font-size:var(--font-size-xs);font-weight:var(--font-weight-semibold)}
.product-frame{position:relative;height:650px;display:grid;grid-template-columns:var(--sidebar-width) 1fr;overflow:hidden;border:1px solid var(--border-default);border-radius:var(--radius-lg);background:var(--app-background);box-shadow:var(--elevation-popup)}
.sample-sidebar{height:100%;display:flex;flex-direction:column;padding:var(--space-xl) var(--space-md) var(--space-md);background:var(--sidebar-bg);border-right:1px solid var(--border-subtle);box-shadow:inset -1px 0 0 var(--sidebar-highlight);backdrop-filter:blur(20px);-webkit-backdrop-filter:blur(20px)}
:global(html[data-family='mono']) .sample-sidebar{background:var(--chrome-glass-bg);border-right-color:var(--chrome-glass-border);box-shadow:var(--chrome-glass-shadow);backdrop-filter:var(--chrome-glass-blur);-webkit-backdrop-filter:var(--chrome-glass-blur)}
.sample-logo{display:flex;align-items:center;justify-content:center;gap:var(--space-sm);margin-bottom:var(--space-xl)}.sample-logo-icon{width:34px;height:34px;display:grid;place-items:center;border-radius:var(--radius-sm);color:#fff;background:var(--brand-gradient)}.sample-logo strong{font-size:var(--font-size-lg)}.sample-nav{flex:1;display:flex;flex-direction:column;gap:var(--space-xs)}.sample-nav-label{padding:var(--space-xs) var(--space-sm);color:var(--sidebar-label-fg);font-size:var(--font-size-xs);font-weight:var(--font-weight-semibold);letter-spacing:var(--tracking-label)}.sample-divider{height:1px;margin:var(--space-sm) var(--space-xs);background:var(--divider-line)}
.sample-nav-item{width:100%;display:flex;align-items:center;gap:var(--space-sm);padding:var(--space-sm) var(--space-md);border:1px solid transparent;border-radius:var(--radius-sm);color:var(--sidebar-item-fg);background:transparent;font:var(--font-weight-regular) var(--font-size-md) var(--font-sans);text-align:left}.sample-nav-item.active{color:var(--sidebar-item-active-fg);background:var(--sidebar-item-active);border-color:var(--sidebar-item-active-border);box-shadow:var(--sidebar-item-active-shadow);font-weight:var(--font-weight-bold)}.nav-count{margin-left:auto;padding:1px var(--space-xs);border-radius:var(--radius-pill);color:#fff;background:color-mix(in srgb,var(--action-primary) 42%,transparent);font-size:var(--font-size-xs)}.sample-nav-item.muted,.soon{color:var(--content-tertiary)}.soon{margin-left:auto;font-size:var(--font-size-xs)}.sample-user{display:flex;align-items:center;gap:var(--space-sm);padding:var(--space-sm);border:1px solid var(--sidebar-user-border);border-radius:var(--radius-md);background:var(--sidebar-user-bg)}.sample-avatar{width:32px;height:32px;display:grid;place-items:center;border-radius:var(--radius-pill);color:#fff;background:var(--brand-gradient);font-size:var(--font-size-sm);font-weight:var(--font-weight-bold)}.sample-user div{display:flex;flex-direction:column}.sample-user strong{font-size:var(--font-size-sm)}.sample-user small{font-size:var(--font-size-xs);color:var(--content-tertiary)}
.sample-main{position:relative;min-width:0;overflow:hidden}.sample-topbar{position:absolute;top:var(--space-lg);left:var(--space-lg);right:var(--space-lg);z-index:5;height:50px;display:flex;align-items:center;gap:var(--space-md);padding:0 var(--space-md)}.sample-title{display:flex;align-items:baseline;gap:var(--space-sm);white-space:nowrap}.sample-title h3{font-size:var(--font-size-lg)}.sample-title span{font-size:var(--font-size-xs);color:var(--content-tertiary)}.sample-search{height:var(--control-sm);min-width:180px;max-width:320px;flex:1;margin-left:auto;display:flex;align-items:center;gap:var(--space-sm);padding:0 var(--space-sm);border:1px solid var(--control-border);border-radius:var(--control-radius);color:var(--content-secondary);background:color-mix(in srgb,var(--control-bg) 74%,transparent);font-size:var(--font-size-xs)}.sample-search span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.sample-search kbd{margin-left:auto;color:var(--content-tertiary);font-size:var(--font-size-xs)}.sample-top-actions{display:flex;gap:var(--space-sm)}.sample-ghost,.sample-primary{height:var(--control-sm);display:flex;align-items:center;gap:var(--space-xs);padding:0 var(--space-sm);border-radius:var(--control-radius);font:var(--font-weight-medium) var(--font-size-xs) var(--font-sans)}.sample-ghost{border:1px solid var(--control-border);color:var(--content-secondary);background:var(--control-bg)}.sample-primary{border:0;color:var(--content-on-accent);background:var(--action-primary-bg);box-shadow:var(--elevation-card)}
.sample-board{height:100%;padding:82px var(--space-lg) var(--space-lg);display:grid;grid-template-columns:repeat(4,minmax(145px,1fr));gap:var(--space-sm);overflow:hidden}.project-column{min-width:0;height:100%;padding:var(--space-sm);overflow:hidden}.column-heading{height:26px;display:flex;align-items:center;gap:var(--space-xs);padding:0 var(--space-xs) var(--space-sm)}.column-heading strong{font-size:var(--font-size-sm);font-weight:var(--font-weight-semibold)}.column-heading em{margin-left:auto;color:var(--content-tertiary);font:normal var(--font-size-xs) var(--font-mono)}.column-dot{width:7px;height:7px;border-radius:var(--radius-pill)}
.sample-project-card{position:relative;min-height:105px;overflow:hidden;margin-bottom:var(--space-sm);border:1px solid var(--project-card-border);border-radius:var(--project-card-radius);corner-shape:squircle;background:linear-gradient(to right,var(--project-card-gradient-start) 0%,var(--project-card-gradient-end) 40%),var(--project-color);box-shadow:var(--project-card-shadow);will-change:transform;transition:var(--project-card-motion)}.sample-project-card::before,.sample-project-card::after{content:'';position:absolute;inset:0;border-radius:inherit;corner-shape:squircle;pointer-events:none}.sample-project-card::before{background:var(--project-card-sheen-rest);box-shadow:inset 0 1px 0 var(--project-card-highlight-rest)}.sample-project-card::after{opacity:0;background:var(--project-card-sheen-hover);box-shadow:inset 0 1px 0 var(--project-card-highlight-hover);transition:var(--card-overlay-motion)}.sample-project-card:hover{transform:translateY(-2px);border-color:var(--project-card-hover-border);box-shadow:var(--project-card-hover-shadow)}.sample-project-card:hover::after{opacity:1}.sample-project-card:active{transform:translateY(1px);opacity:.93}.card-copy{position:relative;z-index:1;padding:var(--space-md);display:flex;flex-direction:column;gap:var(--space-sm)}.card-name-row,.card-meta,.card-footer{display:flex;align-items:center;justify-content:space-between;gap:var(--space-xs)}.card-name-row strong{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:var(--font-size-md);font-weight:var(--font-weight-medium)}.stars{color:var(--action-primary);font-size:var(--font-size-xs);letter-spacing:-.08em}.card-meta,.card-footer{font-size:var(--font-size-xs);color:var(--content-secondary)}.stage-chip{padding:1px var(--space-xs);border-radius:var(--radius-pill);background:var(--surface-soft)}.card-footer>span:first-child{display:flex;align-items:center;gap:var(--space-xs)}.seg-progress{height:4px;display:flex;gap:2px}.seg-progress i{flex:1;border-radius:var(--radius-pill);background:var(--surface-soft-hover)}.seg-progress i.done{background:var(--project-color)}.add-project{width:100%;height:30px;display:flex;align-items:center;justify-content:center;gap:var(--space-xs);border:1px dashed var(--border-subtle);border-radius:var(--radius-sm);color:var(--content-tertiary);background:transparent;font:var(--font-size-xs) var(--font-sans)}
.sample-gugu-fab{position:absolute;right:var(--floating-edge);bottom:var(--floating-edge);z-index:16;width:var(--gugu-fab-size);height:var(--gugu-fab-size);display:grid;place-items:center;border:1px solid var(--gugu-fab-border);border-radius:var(--radius-pill);color:var(--content-on-accent);background:var(--gugu-fab-bg);box-shadow:var(--gugu-fab-shadow);cursor:pointer;transition:transform .2s ease,box-shadow .2s ease}.sample-gugu-fab:hover{transform:scale(1.08);box-shadow:var(--gugu-fab-hover-shadow)}
.subsection{margin-top:var(--space-xl)}.first-subsection{margin-top:0}.subheading,.radius-title{display:flex;align-items:baseline;gap:var(--space-md);margin-bottom:var(--space-md)}.subheading h3,.radius-title h3{font-size:var(--font-size-md);line-height:var(--line-height-ui)}.subheading p,.radius-title p{font-size:var(--font-size-xs);line-height:var(--line-height-body);color:var(--content-tertiary)}.token-grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:var(--design-grid-gap)}.token-card{min-width:0;border:1px solid var(--design-card-border);border-radius:var(--design-card-radius);background:var(--design-card-bg);box-shadow:var(--elevation-card)}.color-card{overflow:hidden}.color-swatch{height:76px;border-bottom:1px solid var(--border-hairline)}.compact-colors .color-swatch{height:56px}.token-meta{padding:var(--space-md);display:flex;flex-direction:column;gap:var(--space-xs)}.token-meta strong,.case-meta strong{font-size:var(--font-size-sm);line-height:var(--line-height-ui)}.token-meta code,.case-meta code,.type-meta code,.space-row code,.radius-item code,.contract-card code,.index-card code{color:var(--selection-fg);font:var(--font-size-xs)/var(--line-height-ui) var(--font-mono);overflow-wrap:anywhere}.token-meta span,.case-meta span{color:var(--content-tertiary);font-size:var(--font-size-xs);line-height:var(--line-height-body)}
.scrollbar-token-layout{display:block}.scrollbar-token-label{margin-bottom:var(--space-sm);color:var(--content-tertiary);font-size:var(--font-size-xs);font-weight:var(--font-weight-semibold)}.scrollbar-style-heading{margin-top:var(--space-lg)}.scrollbar-demo-grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:var(--design-grid-gap)}.scrollbar-style-card{overflow:hidden}.scrollbar-live-surface,.scrollbar-overflow-surface{height:150px;overflow:auto;scrollbar-gutter:stable;padding:var(--space-sm);border-bottom:1px solid var(--border-hairline);background:var(--surface-soft)}.scrollbar-live-surface span,.scrollbar-overflow-content span{display:block;padding:var(--space-xs) var(--space-sm);border-bottom:1px solid var(--border-hairline);color:var(--content-secondary);font-size:var(--font-size-xs);white-space:nowrap}.scrollbar-overflow-content{min-width:620px}.scrollbar-live-surface span:last-child,.scrollbar-overflow-content span:last-child{border-bottom:0}
.foundation-split{display:grid;grid-template-columns:1.15fr .85fr;gap:var(--design-grid-gap);margin-top:var(--space-xl)}.foundation-panel{padding:var(--space-lg);border:1px solid var(--border-subtle);border-radius:var(--radius-md);background:var(--surface-soft)}.type-row{min-height:62px;display:grid;grid-template-columns:1fr 180px;align-items:center;gap:var(--space-lg);border-top:1px solid var(--border-hairline)}.type-row:first-child{border-top:0}.type-sample{min-width:0;padding-block:2px;line-height:var(--line-height-body);white-space:nowrap;overflow:visible;text-overflow:ellipsis}.type-meta,.radius-item{display:flex;flex-direction:column;gap:var(--space-xs)}.type-meta strong{font-size:var(--font-size-sm);line-height:var(--line-height-ui)}.type-meta small,.radius-item small{font-size:var(--font-size-xs);line-height:var(--line-height-ui);color:var(--content-tertiary)}.space-list{display:flex;flex-direction:column;gap:var(--space-sm)}.space-row{display:grid;grid-template-columns:110px 1fr 40px;align-items:center;gap:var(--space-sm)}.space-bar{height:7px;border-radius:var(--radius-pill);background:var(--action-primary)}.space-row em{font:normal var(--font-size-xs)/var(--line-height-ui) var(--font-mono);color:var(--content-tertiary)}.radius-title{margin-top:var(--space-xl);padding-top:var(--space-lg);border-top:1px solid var(--border-hairline)}.radius-row{display:grid;grid-template-columns:repeat(5,1fr);gap:var(--space-sm)}.radius-item>span{width:42px;height:32px;border:1px solid var(--border-default);background:var(--selection-bg)}
.semantic-groups{display:flex;flex-direction:column;gap:var(--space-md)}.semantic-group{padding:var(--space-lg);border:1px solid var(--border-subtle);border-radius:var(--radius-md);background:var(--surface-soft)}.semantic-group>header{display:flex;justify-content:space-between;margin-bottom:var(--space-md)}.semantic-group h3{font-size:var(--font-size-md)}.semantic-group p{margin-top:var(--space-xs);font-size:var(--font-size-xs);color:var(--content-tertiary)}.semantic-group>header>span{font:var(--font-size-xs) var(--font-mono);color:var(--content-tertiary)}.semantic-grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:var(--space-sm)}.semantic-card{overflow:hidden}.semantic-demo{height:78px;padding:var(--space-md);display:flex;align-items:center;justify-content:center;border-bottom:1px solid var(--border-hairline);background:var(--surface-soft)}.surface-demo{width:100%;height:100%;display:grid;place-items:center;border:1px solid var(--border-subtle);border-radius:var(--radius-sm);font-size:var(--font-size-xs)}.text-demo{width:100%;font-size:var(--font-size-md);font-weight:var(--font-weight-medium)}.border-demo{width:100%;height:40px;display:flex;align-items:center;padding:0 var(--space-sm);border:1px solid;border-radius:var(--radius-sm);background:var(--surface-raised);font-size:var(--font-size-xs);color:var(--content-tertiary)}.action-demo{height:34px;padding:0 var(--space-md);border:0;border-radius:var(--radius-sm);color:var(--content-on-accent);font:var(--font-weight-medium) var(--font-size-sm) var(--font-sans)}.secondary-demo{height:34px;padding:0 var(--space-md);border:1px solid;border-radius:var(--radius-sm);font:var(--font-weight-medium) var(--font-size-sm) var(--font-sans)}.status-demo{display:inline-flex;align-items:center;gap:var(--space-xs);padding:var(--space-xs) var(--space-sm);border-radius:var(--radius-pill);font-size:var(--font-size-sm)}.status-demo i{width:6px;height:6px;border-radius:var(--radius-pill)}
.elevation-grid,.component-strip{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:var(--design-grid-gap)}.elevation-case{min-height:230px;padding:var(--space-lg);display:flex;flex-direction:column;justify-content:center;gap:var(--space-lg);border:1px solid var(--border-hairline);border-radius:var(--radius-md);background:var(--surface-soft)}.mini-project{position:relative;min-height:88px;padding:var(--space-md);display:flex;flex-direction:column;gap:var(--space-sm);overflow:hidden;border:1px solid var(--project-card-border);border-radius:var(--project-card-radius);background:linear-gradient(to right,var(--project-card-gradient-start) 0%,var(--project-card-gradient-end) 40%),var(--project-color);box-shadow:var(--project-card-shadow)}.mini-project strong,.mini-project span{position:relative;z-index:1}.mini-project span{font-size:var(--font-size-sm);color:var(--content-secondary)}.hover-case{transform:translateY(-2px);box-shadow:var(--project-card-hover-shadow)}.mini-popup{width:190px;align-self:center;padding:var(--space-md);display:flex;flex-direction:column;gap:var(--space-sm);border:1px solid var(--popup-border);border-radius:var(--popup-radius);background:var(--popup-background);box-shadow:var(--elevation-popup)}.mini-popup span{font-size:var(--font-size-sm);color:var(--content-secondary)}.mini-popup button{padding:var(--space-xs);border:0;border-radius:var(--radius-xs);color:var(--action-primary);background:var(--action-soft)}.mini-chat{width:190px;height:90px;align-self:center;display:flex;align-items:center;gap:var(--space-sm);padding:var(--space-md);border:1px solid var(--gugu-chat-border);border-radius:var(--gugu-chat-radius);background:var(--gugu-chat-bg);box-shadow:var(--gugu-chat-shadow)}.mini-chat>span{width:32px;height:32px;display:grid;place-items:center;border-radius:var(--radius-pill);color:var(--content-on-accent);background:var(--gugu-fab-bg)}.mini-chat div,.case-meta{display:flex;flex-direction:column;gap:var(--space-xs)}.mini-chat small{font-size:var(--font-size-xs);color:var(--content-tertiary)}
.contract-card{min-height:94px;display:flex;align-items:center;gap:var(--space-md);padding:var(--space-lg);border:1px solid var(--design-card-border);border-radius:var(--design-card-radius);background:var(--design-card-bg)}.contract-icon{width:38px;height:38px;display:grid;place-items:center;flex-shrink:0;border-radius:var(--radius-sm);color:var(--action-primary);background:var(--action-soft)}.contract-icon.gugu{color:var(--content-on-accent);background:var(--gugu-fab-bg)}.contract-icon.danger{color:var(--danger-button-fg);background:var(--danger-button-bg);border:1px solid var(--danger-button-border)}.contract-card div{min-width:0;display:flex;flex-direction:column;gap:var(--space-xs)}.contract-card strong{font-size:var(--font-size-sm)}.contract-card small{font-size:var(--font-size-xs);color:var(--content-tertiary)}.danger-contract-btn{margin-left:auto;flex-shrink:0;padding:6px 11px;border:1px solid var(--danger-button-border);border-radius:var(--danger-button-radius);color:var(--danger-button-fg);background:var(--danger-button-bg);font:600 var(--font-size-xs) var(--font-sans);transition:background-color var(--motion-hover-control) var(--motion-ease-standard),border-color var(--motion-hover-control) var(--motion-ease-standard)}.danger-contract-btn:hover{background:var(--danger-button-bg-hover);border-color:var(--danger-button-border-hover)}
.index-groups{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:var(--design-grid-gap)}.index-group{padding:var(--space-md);border:1px solid var(--border-subtle);border-radius:var(--radius-md);background:var(--surface-soft)}.index-group header{display:flex;justify-content:space-between;margin-bottom:var(--space-sm)}.index-group h3{font-size:var(--font-size-sm)}.index-group header span{font:var(--font-size-xs) var(--font-mono);color:var(--content-tertiary)}.index-grid{display:flex;flex-direction:column;gap:var(--space-xs)}.index-card{min-height:38px;padding:var(--space-sm);display:flex;align-items:center;justify-content:space-between;box-shadow:none}.index-dot{width:18px;height:18px;border:1px solid var(--border-subtle);border-radius:var(--radius-xs)}
@media(max-width:1100px){.theme-matrix,.palette-gallery,.token-grid,.semantic-grid,.elevation-grid,.component-strip{grid-template-columns:repeat(2,minmax(0,1fr))}.scrollbar-demo-grid{grid-template-columns:repeat(2,minmax(0,1fr))}.index-groups{grid-template-columns:1fr}.sample-sidebar{width:188px}.product-frame{grid-template-columns:188px 1fr}.sample-search{display:none}}
@media(max-width:760px){.design-hero{position:fixed;flex-direction:column;align-items:flex-start}.design-content{padding-top:calc(112px + var(--space-xl))}.hero-copy p{white-space:normal}.theme-matrix,.palette-gallery,.token-grid,.semantic-grid,.elevation-grid,.component-strip,.scrollbar-demo-grid{grid-template-columns:1fr}.foundation-split{grid-template-columns:1fr}.product-frame{grid-template-columns:1fr}.sample-sidebar{display:none}.sample-board{grid-template-columns:repeat(4,220px);overflow-x:auto}.sample-topbar{left:var(--space-md);right:var(--space-md)}.sample-title span,.sample-ghost{display:none}.type-row{grid-template-columns:1fr;padding:var(--space-sm) 0}.radius-row{grid-template-columns:repeat(3,1fr)}}
.sample-main > .sample-topbar { --gb-tint: var(--glass-bg); top: 20px; right: 24px; left: 20px; z-index: 40; height: auto; min-height: 52px; gap: 14px; padding: 14px 20px; isolation: isolate; overflow: visible; }
.sample-main > .sample-topbar:hover { --gb-tint: var(--glass-bg-hover); }
.project-column.glass-card { --glass-card-background: var(--column-bg); --glass-card-background-hover: var(--column-bg); }
.sample-main > .sample-topbar .sample-title { min-width: 150px; display: block; }
.sample-main > .sample-topbar .sample-title h1 { margin: 0; font-size: 20px; font-weight: 700; line-height: 1.2; }
.sample-main > .sample-topbar .sample-title p { margin: 2px 0 0; color: var(--content-secondary); font-size: 12px; }
.sample-main > .sample-topbar .sample-search { height: auto; min-height: 32px; max-width: 320px; gap: 8px; padding: 8px 12px; border: 1px solid color-mix(in srgb, var(--control-border) 70%, transparent); background: color-mix(in srgb, var(--control-bg) 74%, transparent); font-size: 11px; }
.sample-main > .sample-topbar .sample-search kbd { margin-left: auto; color: var(--content-tertiary); font-size: 9px; }
.sample-main > .sample-topbar .sample-top-actions { gap: 8px; }
.sample-main > .sample-topbar .sample-ghost, .sample-main > .sample-topbar .sample-primary { height: 32px; padding: 0 12px; border-radius: var(--radius-sm); font-size: 11px; }
.sample-main > .sample-topbar .sample-ghost { border: 1px solid color-mix(in srgb, var(--control-border) 75%, transparent); color: var(--content-secondary); background: color-mix(in srgb, var(--control-bg) 74%, transparent); box-shadow: none; }
.sample-main > .sample-topbar .sample-primary { color: var(--content-on-accent); background: var(--action-primary-bg); box-shadow: none; }
@media(max-width:760px){.sample-main > .sample-topbar{left:var(--space-md);right:var(--space-md)}.sample-main > .sample-topbar .sample-search{display:none}.sample-main > .sample-topbar .sample-ghost{display:none}}
@media(max-width:760px){.motion-token-grid{grid-template-columns:1fr}}
.contracts-detail{margin-top:var(--space-xl);padding-top:var(--space-xl);border-top:1px solid var(--border-hairline)}.contracts-detail .preview-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:var(--design-grid-gap)}.contracts-detail .preview-card{overflow:hidden;border:1px solid var(--design-card-border);border-radius:var(--design-card-radius);background:var(--design-card-bg);box-shadow:var(--elevation-card)}.contracts-detail .preview-stage{height:150px;display:grid;place-items:center;padding:var(--space-lg);background:var(--surface-soft);border-bottom:1px solid var(--border-hairline)}
.contracts-detail .panel-stage{background:linear-gradient(145deg,color-mix(in srgb,var(--action-primary) 12%,var(--surface-base)),var(--surface-base))}.contracts-detail .panel-preview{width:76%;height:104px;padding:var(--space-md);display:flex;flex-direction:column;gap:var(--space-xs);background:var(--panel-glass-bg);border:1px solid var(--panel-glass-border);border-radius:var(--radius-lg);box-shadow:var(--panel-glass-shadow);backdrop-filter:var(--panel-glass-blur)}.contracts-detail .panel-preview strong,.contracts-detail .modal-preview strong{font-size:var(--font-size-sm)}.contracts-detail .panel-preview span,.contracts-detail .modal-preview span{color:var(--content-secondary);font-size:var(--font-size-xs)}
.contracts-detail .modal-preview{width:82%;padding:var(--space-lg);display:flex;flex-direction:column;gap:var(--space-xs);background:var(--modal-card-bg);border:1px solid var(--modal-card-border);border-radius:var(--radius-lg);box-shadow:var(--modal-card-shadow),inset 0 1px 0 var(--modal-card-highlight)}.contracts-detail .contract-input{width:90%;height:38px;padding:0 var(--space-md);border:1px solid var(--input-border);border-radius:var(--input-radius);outline:none;color:var(--input-fg);background:var(--input-bg);font:var(--font-size-sm) var(--font-sans)}.contracts-detail .contract-input:focus{background:var(--input-bg-focus);border-color:var(--input-border-focus);box-shadow:var(--input-focus-shadow)}
.confirm-preview{overflow:hidden}.confirm-preview-stage{min-height:132px;display:flex;align-items:center;justify-content:space-between;gap:var(--space-lg);padding:var(--space-lg);background:var(--surface-soft);border-bottom:1px solid var(--border-hairline)}.confirm-preview-copy{display:flex;flex-direction:column;gap:var(--space-xs)}.confirm-preview-copy strong{font-size:var(--font-size-sm)}.confirm-preview-copy span{max-width:360px;color:var(--content-tertiary);font-size:var(--font-size-xs);line-height:var(--line-height-body)}
.contracts-detail .meta{padding:var(--space-md);display:flex;flex-direction:column;gap:var(--space-xs)}.contracts-detail .meta strong{font-size:var(--font-size-sm)}.contracts-detail .meta code,.contracts-detail .subhead code{color:var(--selection-fg);font:var(--font-size-xs) var(--font-mono)}.contracts-detail .meta span{color:var(--content-tertiary);font-size:var(--font-size-xs)}
.contracts-detail .subhead{display:flex;align-items:end;justify-content:space-between;gap:var(--space-md);margin:var(--space-xl) 0 var(--space-md)}.contracts-detail .subhead h3{font-size:var(--font-size-md)}.contracts-detail .subhead p{margin-top:var(--space-xs);color:var(--content-tertiary);font-size:var(--font-size-xs)}.contracts-detail .secondary-demo-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:var(--design-grid-gap);padding:var(--space-lg)}.contracts-detail .secondary-demo-cell{display:flex;flex-direction:column;align-items:center;gap:var(--space-md)}.contracts-detail .secondary-sample{height:34px;padding:0 var(--space-md);border:1px solid var(--action-secondary-border);border-radius:var(--radius-sm);color:var(--action-secondary-fg);background:var(--action-secondary-bg);font:var(--font-weight-medium) var(--font-size-sm) var(--font-sans)}.contracts-detail .secondary-sample.hovered{color:var(--action-secondary-fg-hover);background:var(--action-secondary-bg-hover);border-color:var(--action-secondary-border-hover)}.contracts-detail .secondary-demo-cell .meta{align-items:center;text-align:center}.contracts-detail .chip-demo{min-height:90px;display:flex;align-items:center;gap:var(--space-sm);padding:var(--space-lg)}.contracts-detail .choice-chip{padding:6px 14px;border:1px solid var(--choice-chip-border);border-radius:var(--choice-chip-radius);color:var(--choice-chip-fg);background:var(--choice-chip-bg);font:500 var(--font-size-sm) var(--font-sans)}.contracts-detail .choice-chip:hover{color:var(--choice-chip-fg-hover);background:var(--choice-chip-bg-hover);border-color:var(--choice-chip-border-hover)}.contracts-detail .choice-chip.active{color:var(--choice-chip-fg-active);background:var(--choice-chip-bg-active);border-color:var(--choice-chip-border-active);font-weight:600}
.contracts-detail .note-grid{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:var(--design-grid-gap)}.contracts-detail .note-swatch{height:118px;padding:var(--space-md);display:flex;flex-direction:column;gap:var(--space-sm);border-bottom:1px solid var(--border-hairline)}.contracts-detail .note-swatch strong{font-size:var(--font-size-md)}.contracts-detail .note-swatch span{color:var(--content-secondary);font-size:var(--font-size-sm)}
@media(max-width:1000px){.contracts-detail .preview-grid{grid-template-columns:1fr}.contracts-detail .note-grid{grid-template-columns:repeat(2,minmax(0,1fr))}}@media(max-width:640px){.contracts-detail .note-grid{grid-template-columns:1fr}}
.font-family-section{margin-top:var(--space-xl)}.font-family-grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:var(--space-sm)}.font-family-card{min-width:0;overflow:visible;border:1px solid var(--border-subtle);border-radius:var(--radius-md);background:var(--surface-soft)}.font-family-sample{min-height:84px;display:flex;align-items:center;padding:var(--space-xl) var(--space-lg);border-bottom:1px solid var(--border-hairline);font-size:var(--font-size-md);line-height:var(--line-height-body);color:var(--content-primary)}.font-family-meta{display:flex;flex-direction:column;gap:var(--space-xs);padding:var(--space-md)}.font-family-meta strong{font-size:var(--font-size-sm);line-height:var(--line-height-ui)}.font-family-meta code{overflow:hidden;color:var(--selection-fg);font:var(--font-size-xs)/var(--line-height-ui) var(--font-mono);text-overflow:ellipsis;white-space:nowrap}.font-family-meta span{color:var(--content-tertiary);font-size:var(--font-size-xs);line-height:var(--line-height-body)}
@media(max-width:1100px){.font-family-grid{grid-template-columns:repeat(2,minmax(0,1fr))}}@media(max-width:640px){.font-family-grid{grid-template-columns:1fr}}
.contracts-detail .choice-chip { padding: var(--choice-chip-padding); }
.rename-token-preview { min-height: 74px; display: flex; align-items: center; padding: var(--space-lg); overflow: visible; }
.rename-token-preview .rename-sizer { min-width: 86px; }
.rename-token-grid { margin-top: var(--space-md); }
.rename-token-swatch { height: 56px; display: grid; place-items: center; border-bottom: 1px solid var(--border-hairline); }
.rename-token-swatch > span { display: block; min-width: 38px; height: 20px; border: 1px solid var(--border-default); background: var(--surface-raised); }
.rename-token-swatch code { color: var(--content-secondary); font: var(--font-size-xs) var(--font-mono); }
</style>
