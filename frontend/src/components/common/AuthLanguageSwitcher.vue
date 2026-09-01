<template>
  <div class="language-switcher" role="group" :aria-label="t('common.language')">
    <button v-for="option in localeOptions" :key="option.value" type="button"
      :class="{ active: locale === option.value }" @click="changeLocale(option.value)">
      {{ option.label }}
    </button>
  </div>
</template>

<script setup lang="ts">
import { ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { localeOptions, setLocale, type SupportedLocale } from '@/i18n'

const { t, locale: i18nLocale } = useI18n()
const locale = ref(i18nLocale.value as SupportedLocale)

function changeLocale(value: SupportedLocale) {
  setLocale(value, true)
  locale.value = value
}
</script>

<style scoped>
.language-switcher { display: flex; justify-content: center; gap: 4px; pointer-events: auto; }
.language-switcher button {
  border: 0; border-radius: 6px; padding: 4px 7px;
  background: transparent; color: var(--content-tertiary);
  font: 11px var(--font-sans); cursor: pointer;
  transition: background-color var(--motion-hover-control) var(--motion-ease-standard), color var(--motion-hover-control) var(--motion-ease-standard);
}
.language-switcher button:hover { background: var(--surface-soft-hover); color: var(--content-primary); }
.language-switcher button.active { background: var(--selection-bg); color: var(--action-primary); font-weight: 600; }
</style>
