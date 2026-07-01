import type { vEnter } from '@/directives/enter'

declare module 'vue' {
  export interface GlobalDirectives {
    vEnter: typeof vEnter
  }
}

export {}
