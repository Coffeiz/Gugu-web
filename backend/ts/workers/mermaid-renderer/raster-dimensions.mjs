const MAX_DIMENSION = 8_192
const MAX_PIXELS = 5_000_000
const TARGET_RASTER_SCALE = 2

/** 在边长与像素预算内计算 Mermaid SVG 的 PNG 输出尺寸。 */
export function calculateMermaidRasterDimensions(width, height) {
  if (
    !Number.isFinite(width) || !Number.isFinite(height) || width < 1 || height < 1 ||
    width > MAX_DIMENSION || height > MAX_DIMENSION
  ) {
    throw new Error('pixel_limit_exceeded')
  }

  const rasterScale = Math.min(
    TARGET_RASTER_SCALE,
    MAX_DIMENSION / width,
    MAX_DIMENSION / height,
    Math.sqrt(MAX_PIXELS / (width * height)),
  )
  const rasterWidth = Math.max(1, Math.floor(width * rasterScale))
  const rasterHeight = Math.max(1, Math.floor(height * rasterScale))
  if (
    rasterWidth > MAX_DIMENSION || rasterHeight > MAX_DIMENSION ||
    rasterWidth * rasterHeight > MAX_PIXELS
  ) {
    throw new Error('pixel_limit_exceeded')
  }

  return { width: rasterWidth, height: rasterHeight }
}
