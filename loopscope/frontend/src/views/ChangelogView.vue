<template>
  <div class="changelog">
    <header><span class="eyebrow">LOOPSCOPE</span><h1>Changelog</h1><p>产品能力与 Trace 协议的可见变更。</p></header>
    <article v-for="release in releases" :key="release.version" class="release ls-card">
      <div class="release-meta"><strong>{{ release.version }}</strong><span>{{ release.date }}</span></div>
      <h2>{{ release.title }}</h2>
      <ul><li v-for="item in release.items" :key="item">{{ item }}</li></ul>
    </article>
  </div>
</template>

<script setup lang="ts">
const releases = [
  {
    version: '0.2.0', date: '2026-08-17', title: 'Context & Usage Provenance',
    items: [
      'Monitor 从独立路由改为当前 Session 内的布局模式，切换 Session 时保持同一工作流。',
      'Span 增加 Python 文件 / module / function / line 来源，并将 Input、Output、Source、Attributes 分开展开。',
      'Context Assembly 可展开 DB / Memory / Prompt file / cache prefix / dynamic suffix 等来源，Prompt 文件可单独查看正文。',
      'Run 与 LLM Span 增加 input / output / cache read / fresh input token；Context 与 Tool 显示估算 token impact。',
      'SQLite 0.1 数据库自动迁移 code / usage / token impact 字段，无需删库。',
    ],
  },
  {
    version: '0.1.0', date: '2026-08-17', title: 'First usable loop debugger',
    items: [
      '独立 frontend / backend / SQLite / Docker 边界。',
      '多 Session 真实对话与普通 / 详细模式。',
      'Run / Span trace、Prompt / model draft / Tool / Guard 输入输出检查。',
      '独立 Design Tokens 页面与 Gugu /dev 入口。',
    ],
  },
]
</script>

<style scoped>
.changelog { max-width:860px; margin:0 auto; padding:42px 36px 80px; }
.eyebrow { font-size:9px; letter-spacing:.13em; color:var(--content-tertiary); }
header h1 { margin:4px 0; font-size:26px; } header p { margin:0; color:var(--content-secondary); font-size:12px; }
.release { margin-top:18px; padding:18px 20px; }
.release-meta { display:flex; gap:8px; align-items:center; color:var(--content-tertiary); font:10px var(--font-mono); }
.release-meta strong { color:var(--action-primary); }
.release h2 { margin:7px 0 10px; font-size:15px; }
ul { margin:0; padding-left:18px; display:grid; gap:7px; color:var(--content-secondary); font-size:11px; line-height:1.65; }
</style>
