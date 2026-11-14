import { expect, test } from '@playwright/test'

const palettes = ['mist', 'cafe', 'rose', 'sky', 'sage']

test('所有浅色配色和材质下的分隔线与虚线边界都有可见对比', async ({ page }) => {
  await page.goto('/skills')
  await expect(page.locator('.skills-panel')).toBeVisible()

  const samples = await page.evaluate((palettes) => {
    const root = document.documentElement
    const previous = {
      theme: root.dataset.theme,
      family: root.dataset.family,
      palette: root.dataset.palette,
    }
    const probe = document.createElement('div')
    probe.style.cssText = [
      'position:fixed',
      'left:-10000px',
      'top:0',
      'width:100px',
      'height:8px',
      'border-top:1px solid var(--content-divider)',
      'border-bottom:1px dashed var(--content-outline)',
    ].join(';')
    document.body.append(probe)

    const canvas = document.createElement('canvas')
    canvas.width = 1
    canvas.height = 1
    const context = canvas.getContext('2d')
    if (!context) throw new Error('无法创建颜色对比画布')

    const distanceFromWhite = (color: string) => {
      context.fillStyle = '#fff'
      context.fillRect(0, 0, 1, 1)
      context.fillStyle = color
      context.fillRect(0, 0, 1, 1)
      const [red, green, blue] = context.getImageData(0, 0, 1, 1).data
      return Math.sqrt((255 - red) ** 2 + (255 - green) ** 2 + (255 - blue) ** 2)
    }

    try {
      return palettes.flatMap(palette => ['glass', 'mono'].map(family => {
        root.dataset.theme = 'light'
        root.dataset.family = family
        root.dataset.palette = palette
        const style = getComputedStyle(probe)
        return {
          palette,
          family,
          solidDividerDistance: distanceFromWhite(style.borderTopColor),
          dashedOutlineDistance: distanceFromWhite(style.borderBottomColor),
        }
      }))
    } finally {
      probe.remove()
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete root.dataset[key]
        else root.dataset[key] = value
      }
    }
  }, palettes)

  for (const sample of samples) {
    expect(
      sample.solidDividerDistance,
      `${sample.palette}/${sample.family} 浅色分隔线不应融入白色背景`,
    ).toBeGreaterThanOrEqual(10)
    expect(
      sample.dashedOutlineDistance,
      `${sample.palette}/${sample.family} 浅色虚线边界不应融入白色背景`,
    ).toBeGreaterThanOrEqual(10)
  }
})

test('日历侧栏的组间分隔线跟随主题内容色，不受卡片描边样式覆盖', async ({ page }) => {
  await page.goto('/calendar')
  const sidebar = page.locator('.cal-sidebar')
  await expect(sidebar).toBeVisible()
  const dividers = sidebar.locator('.sidebar-divider')
  await expect(dividers).toHaveCount(3)

  const samples = await dividers.evaluateAll((lines, palettes) => {
    const root = document.documentElement
    const previous = { theme: root.dataset.theme, family: root.dataset.family, palette: root.dataset.palette }
    const reference = document.createElement('span')
    reference.style.cssText = 'position:absolute;background-color:var(--content-divider)'
    lines[0].parentElement!.append(reference)

    try {
      return ['light', 'dark'].flatMap(theme => ['glass', 'mono'].flatMap(family => palettes.map(palette => {
        Object.assign(root.dataset, { theme, family, palette })
        return {
          name: `${theme}/${family}/${palette}`,
          expectedColor: getComputedStyle(reference).backgroundColor,
          colors: lines.map(line => getComputedStyle(line).backgroundColor),
        }
      })))
    } finally {
      reference.remove()
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete root.dataset[key]
        else root.dataset[key] = value
      }
    }
  }, palettes)

  for (const { name, colors, expectedColor } of samples) {
    expect(colors, `${name} 日历侧栏三个分隔线颜色`).toEqual(Array(3).fill(expectedColor))
  }
})
