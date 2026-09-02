export interface DevToolEntry {
  path?: string
  href?: string
  labelKey: string
  descriptionKey: string
  eyebrowKey?: string
  external?: boolean
}

function loopScopeUrl() {
  const configured = import.meta.env.VITE_LOOPSCOPE_URL
  if (configured) return configured
  return `${window.location.protocol}//${window.location.hostname}:4319`
}

export const devToolRegistry: DevToolEntry[] = [
  {
    href: loopScopeUrl(),
    labelKey: 'devHome.tools.loopScope.label',
    eyebrowKey: 'devHome.tools.loopScope.eyebrow',
    descriptionKey: 'devHome.tools.loopScope.description',
    external: true,
  },
  {
    path: '/dev/onboarding',
    labelKey: 'devHome.tools.onboarding.label',
    eyebrowKey: 'devHome.tools.onboarding.eyebrow',
    descriptionKey: 'devHome.tools.onboarding.description',
  },
  {
    path: '/dev/email',
    labelKey: 'devHome.tools.email.label',
    eyebrowKey: 'devHome.tools.email.eyebrow',
    descriptionKey: 'devHome.tools.email.description',
  },
]
