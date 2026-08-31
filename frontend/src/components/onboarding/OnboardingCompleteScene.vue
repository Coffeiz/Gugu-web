<template>
  <div class="complete-scene" aria-hidden="true">
    <div class="complete-orbit orbit-a" />
    <div class="complete-orbit orbit-b" />
    <div class="complete-center">
      <span class="complete-logo">咕</span>
      <strong>{{ t('onboardingUi.completeTitle') }}</strong>
      <small>{{ t('onboardingUi.completeHint') }}</small>
    </div>

    <div class="complete-chip chip-locale">
      <span>✓</span><b>{{ t('onboardingUi.steps.locale') }}</b>
    </div>
    <div class="complete-chip chip-style">
      <span>✓</span><b>{{ t('onboardingUi.steps.style') }}</b>
    </div>
    <div class="complete-chip chip-model">
      <span>✓</span><b>{{ t('onboardingUi.steps.model') }}</b>
    </div>
    <div class="complete-chip chip-im">
      <span>✓</span><b>{{ t('onboardingUi.steps.im') }}</b>
    </div>

    <i class="spark spark-a">✦</i>
    <i class="spark spark-b">✧</i>
    <i class="spark spark-c">✦</i>
  </div>
</template>

<script setup lang="ts">
import { useI18n } from 'vue-i18n'
const { t } = useI18n()
</script>

<style scoped>
.complete-scene {
  position: relative;
  width: 100%;
  height: 100%;
  overflow: hidden;
  background:
    radial-gradient(circle at 50% 44%, var(--action-soft-hover), transparent 27%),
    var(--surface-page);
}

.complete-orbit {
  position: absolute;
  left: 50%;
  top: 46%;
  border: 1px dashed var(--action-outline);
  border-radius: 50%;
  transform: translate(-50%, -50%);
  opacity: .48;
}
.orbit-a { width: 360px; height: 190px; }
.orbit-b { width: 540px; height: 270px; opacity: .24; }

.complete-center {
  position: absolute;
  left: 50%;
  top: 43%;
  width: 230px;
  min-height: 150px;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: var(--space-xs);
  padding: var(--space-lg);
  transform: translate(-50%, -50%);
  border: 1px solid var(--glass-card-border);
  border-radius: var(--radius-lg);
  background: var(--glass-card-background);
  box-shadow: var(--elevation-window);
  backdrop-filter: var(--glass-card-blur);
  -webkit-backdrop-filter: var(--glass-card-blur);
}
.complete-logo {
  width: 50px;
  height: 50px;
  display: grid;
  place-items: center;
  margin-bottom: var(--space-xs);
  border-radius: var(--radius-md);
  background: var(--action-primary-bg);
  color: var(--content-on-accent);
  box-shadow: var(--elevation-card-hover);
  font-size: var(--font-size-lg);
  font-weight: var(--font-weight-bold);
}
.complete-center strong { font-size: var(--font-size-md); }
.complete-center small {
  max-width: 190px;
  color: var(--content-tertiary);
  font-size: var(--font-size-xs);
  line-height: 1.45;
  text-align: center;
}

.complete-chip {
  position: absolute;
  min-width: 126px;
  height: 42px;
  display: flex;
  align-items: center;
  gap: var(--space-sm);
  padding: 0 var(--space-md);
  border: 1px solid var(--border-subtle);
  border-radius: var(--card-radius);
  background: var(--surface-raised);
  box-shadow: var(--elevation-card);
  color: var(--content-secondary);
  animation: chip-in var(--motion-default) var(--motion-ease-emphasis) both;
}
.complete-chip span {
  width: 20px;
  height: 20px;
  display: grid;
  place-items: center;
  border-radius: 50%;
  background: var(--status-success-bg);
  color: var(--status-success);
  font-size: 10px;
  font-weight: var(--font-weight-bold);
}
.complete-chip b { font-size: var(--font-size-xs); font-weight: var(--font-weight-semibold); }
.chip-locale { left: 16%; top: 25%; animation-delay: 40ms; }
.chip-style { right: 15%; top: 22%; animation-delay: 90ms; }
.chip-model { left: 18%; top: 61%; animation-delay: 140ms; }
.chip-im { right: 17%; top: 59%; animation-delay: 190ms; }
@keyframes chip-in {
  from { opacity: 0; transform: translateY(8px) scale(.97); }
  to { opacity: 1; transform: translateY(0) scale(1); }
}

.spark {
  position: absolute;
  color: var(--action-primary);
  font-style: normal;
  opacity: .55;
  animation: spark-float 2.8s ease-in-out infinite;
}
.spark-a { left: 29%; top: 18%; }
.spark-b { right: 28%; top: 47%; animation-delay: -.8s; }
.spark-c { left: 34%; bottom: 15%; animation-delay: -1.4s; }
@keyframes spark-float {
  0%,100% { transform: translateY(0) rotate(0); opacity: .35; }
  50% { transform: translateY(-6px) rotate(10deg); opacity: .75; }
}
</style>
