import { computed, ref } from 'vue'

export type ButtonFeedbackPreference = 'optimistic' | 'off'

const STORAGE_KEY = 'gugu-button-feedback'
const preference = ref<ButtonFeedbackPreference>(readPreference())

function readPreference(): ButtonFeedbackPreference {
  return localStorage.getItem(STORAGE_KEY) === 'off' ? 'off' : 'optimistic'
}

function apply() {
  document.documentElement.dataset.buttonFeedback = preference.value
}

export function initializeButtonFeedback() {
  apply()
}

export function useButtonFeedback() {
  function setButtonFeedback(value: ButtonFeedbackPreference) {
    preference.value = value
    localStorage.setItem(STORAGE_KEY, value)
    apply()
  }

  return {
    buttonFeedback: computed(() => preference.value),
    setButtonFeedback,
  }
}
