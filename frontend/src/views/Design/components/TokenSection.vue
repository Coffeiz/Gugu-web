<template>
  <section class="token-section">
    <div class="section-head">
      <div>
        <h2>{{ index }} · {{ title }}</h2>
        <p>{{ subtitle }}</p>
      </div>
      <code class="token-code">{{ code }}</code>
    </div>
    <slot />
  </section>
</template>

<script setup lang="ts">
defineProps<{
  index: string
  title: string
  subtitle: string
  code: string
}>()
</script>

<style scoped>
.token-section {
  margin-top: 24px;
  padding: 20px;
  border: 1px solid var(--border-subtle);
  border-radius: 18px;
  background: var(--surface-base);
  box-shadow: var(--shadow-rest);
  backdrop-filter: blur(12px);
}

.section-head {
  display: flex;
  align-items: end;
  gap: 12px;
  margin-bottom: 14px;
}

.section-head h2 {
  margin: 0;
  font-size: 15px;
}

.section-head p {
  margin: 3px 0 0;
  color: var(--content-tertiary);
  font-size: 10px;
}

.section-head code {
  margin-left: auto;
  padding: 4px 7px;
  border-radius: 6px;
  color: var(--selection-fg);
  background: var(--action-soft);
  font: 10px var(--font-mono);
}

@media (max-width: 640px) {
  .section-head {
    align-items: flex-start;
    flex-direction: column;
  }

  .section-head code {
    margin-left: 0;
  }
}
</style>
