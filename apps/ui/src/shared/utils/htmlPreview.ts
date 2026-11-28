const HTML_PREVIEW_CSP = [
  'default-src data: blob: http: https:',
  "script-src 'unsafe-inline' 'unsafe-eval' data: blob: http: https:",
  'connect-src http: https: ws: wss:',
  "object-src 'none'",
  'frame-src data: blob: http: https:',
  'form-action http: https:',
  'base-uri about:',
  'img-src data: blob: http: https:',
  "style-src 'unsafe-inline' data: blob: http: https:",
  'font-src data: blob: http: https:',
  'media-src data: blob: http: https:',
].join('; ')

/**
 * Build the isolated srcdoc used by the HTML previewer.
 * `about:srcdoc` as the base keeps fragment-only links inside the uploaded
 * document instead of resolving them against the Gugu page URL.
 */
export function createHtmlPreviewDocument(source: string): string {
  return `<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${HTML_PREVIEW_CSP}"><base href="about:srcdoc">${source}`
}
