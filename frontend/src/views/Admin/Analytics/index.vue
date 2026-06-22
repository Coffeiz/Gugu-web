<template>
  <div class="analytics-page">
    <div class="page-header">
      <div class="page-title-block">
        <h2 class="page-title">数据分析</h2>
        <p class="page-desc">用户趋势、对话用量、存储统计</p>
      </div>
    </div>
    <div class="placeholder">
      <svg width="40" height="40" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.2"
        stroke-linecap="round" stroke-linejoin="round" style="opacity:.2">
        <path d="M2 12l3-4 3 2 3-5 3 3"/>
        <path d="M2 14h12"/>
      </svg>
      <span>开发中</span>
    </div>
  </div>
</template>

<style scoped>
.analytics-page { min-height: 100%; }
.page-header      { padding: 32px 36px 0; }
.page-title-block { display: flex; flex-direction: column; }
.page-title       { font-size: 22px; font-weight: 700; color: rgba(255,255,255,0.92); line-height: 1; }
.page-desc        { font-size: 12px; color: rgba(255,255,255,0.35); margin-top: 6px; }
.placeholder {
  display: flex; flex-direction: column; align-items: center; justify-content: center;
  gap: 14px; height: 300px; color: rgba(255,255,255,0.2); font-size: 14px;
}
</style>
