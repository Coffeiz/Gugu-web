declare module 'katex/contrib/auto-render' {
  interface Delimiter {
    left: string
    right: string
    display: boolean
  }

  interface AutoRenderOptions {
    delimiters?: Delimiter[]
    ignoredTags?: string[]
    trust?: boolean
    throwOnError?: boolean
    maxExpand?: number
    maxSize?: number
  }

  function renderMathInElement(element: HTMLElement, options?: AutoRenderOptions): void
  export default renderMathInElement
}
