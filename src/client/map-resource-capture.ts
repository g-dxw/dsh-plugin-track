import {SVG_ANNOTATION_MAX_BYTES, SVG_ANNOTATION_MAX_PIXELS} from '../track/resources.ts'

export interface MapImageCaptureOptions {
  canvas: HTMLCanvasElement
  markers?: readonly HTMLButtonElement[]
  credits: readonly {label: string; url: string}[]
  background?: string
  /** Official provider logo, required by the selected map provider when applicable. */
  maptilerLogo?: string
}

const FONT = '12px system-ui, sans-serif', PADDING = 6, CREDIT_LINE = 16, TIMEOUT = 15000

function roundedRect(context: CanvasRenderingContext2D, x: number, y: number, width: number, height: number, radius: number): void {
  const r = Math.max(0, Math.min(radius, width / 2, height / 2))
  context.beginPath(); context.moveTo(x + r, y); context.lineTo(x + width - r, y)
  context.quadraticCurveTo(x + width, y, x + width, y + r); context.lineTo(x + width, y + height - r)
  context.quadraticCurveTo(x + width, y + height, x + width - r, y + height); context.lineTo(x + r, y + height)
  context.quadraticCurveTo(x, y + height, x, y + height - r); context.lineTo(x, y + r)
  context.quadraticCurveTo(x, y, x + r, y); context.closePath()
}

/** Wrap every character rather than discarding long provider names or unbroken labels. */
function wrapText(context: CanvasRenderingContext2D, text: string, width: number): string[] {
  const lines: string[] = []
  for (const paragraph of text.split('\n')) {
    let line = ''
    for (const char of Array.from(paragraph)) {
      if (line && context.measureText(line + char).width > width) {
        const space = line.lastIndexOf(' ')
        if (space > 0 && char !== ' ') {lines.push(line.slice(0, space)); line = line.slice(space + 1)}
        else {lines.push(line.trimEnd()); line = ''}
        // A long word may still exceed the available width after moving it.
        if (line && context.measureText(line + char).width > width) {lines.push(line); line = ''}
      }
      if (line || char !== ' ') line += char
    }
    if (line) lines.push(line.trimEnd())
  }
  return lines
}

function cssNumber(value: string, fallback = 0): number {
  const number = Number.parseFloat(value)
  return Number.isFinite(number) ? number : fallback
}

function visible(element: HTMLElement, style: CSSStyleDeclaration, rect: DOMRect): boolean {
  return !element.hidden && !element.closest('[hidden], [aria-hidden="true"]') && style.display !== 'none' &&
    style.visibility !== 'hidden' && style.visibility !== 'collapse' && cssNumber(style.opacity, 1) > 0 && rect.width > 0 && rect.height > 0
}

function shadow(context: CanvasRenderingContext2D, value: string): void {
  context.shadowColor = 'transparent'; context.shadowBlur = 0; context.shadowOffsetX = 0; context.shadowOffsetY = 0
  if (!value || value === 'none') return
  const color = value.match(/(?:rgba?|hsla?)\([^)]*\)|#[0-9a-f]{3,8}/i)?.[0]
  if (!color) return
  const numbers = value.replace(color, '').match(/-?(?:\d+\.?\d*|\.\d+)px/g)?.map(Number.parseFloat) ?? []
  context.shadowColor = color; context.shadowOffsetX = numbers[0] ?? 0; context.shadowOffsetY = numbers[1] ?? 0
  context.shadowBlur = Math.max(0, numbers[2] ?? 0)
}

function font(style: CSSStyleDeclaration): string {
  return `${style.fontStyle || 'normal'} ${style.fontWeight || '400'} ${style.fontSize || '12px'} ${style.fontFamily || 'system-ui, sans-serif'}`
}

function drawMarkerPart(context: CanvasRenderingContext2D, element: HTMLElement, mapRect: DOMRect, label: boolean): void {
  const style = getComputedStyle(element), rect = element.getBoundingClientRect()
  if (!visible(element, style, rect)) return
  const x = rect.left - mapRect.left, y = rect.top - mapRect.top, width = rect.width, height = rect.height
  if (x + width <= 0 || x >= mapRect.width || y + height <= 0 || y >= mapRect.height) return
  const text = (element.textContent ?? '').replace(/\s+/g, ' ').trim()
  context.save()
  try {
    context.globalAlpha = (Number.isFinite(context.globalAlpha) ? context.globalAlpha : 1) * cssNumber(style.opacity, 1)
    context.font = font(style); context.textAlign = 'center'; context.textBaseline = 'middle'
    if (label) {
      const lineHeight = cssNumber(style.lineHeight, cssNumber(style.fontSize, 12) * 1.375)
      const lines = wrapText(context, text, width).slice(0, Math.max(1, Math.floor((height + .5) / lineHeight)))
      const strokeColor = style.textShadow.match(/(?:rgba?|hsla?)\([^)]*\)|#[0-9a-f]{3,8}/i)?.[0]
      // Clip at the actual visible label box, matching the map's current name toggle and line clamp.
      context.beginPath(); context.rect(x, y, width, height); context.clip()
      context.lineWidth = 2; context.lineJoin = 'round'; context.fillStyle = style.color || '#fff'
      lines.forEach((line, index) => {
        const textY = y + (index + .5) * lineHeight
        if (strokeColor) {context.strokeStyle = strokeColor; context.strokeText(line, x + width / 2, textY)}
        context.fillText(line, x + width / 2, textY)
      })
      return
    }
    const border = cssNumber(style.borderTopWidth), radius = cssNumber(style.borderTopLeftRadius)
    shadow(context, style.boxShadow)
    roundedRect(context, x, y, width, height, radius)
    context.fillStyle = border > 0 ? style.borderTopColor || '#fff' : style.backgroundColor || '#c83532'; context.fill()
    shadow(context, 'none')
    if (border > 0) {
      roundedRect(context, x + border, y + border, Math.max(0, width - border * 2), Math.max(0, height - border * 2), Math.max(0, radius - border))
      context.fillStyle = style.backgroundColor || '#c83532'; context.fill()
    }
    context.fillStyle = style.color || '#fff'; context.fillText(text, x + width / 2, y + height / 2)
    // Selection outlines and button focus rings are editor chrome and intentionally excluded.
  } finally {context.restore()}
}

async function loadLogo(url: string): Promise<HTMLImageElement> {
  const image = new Image(); image.crossOrigin = 'anonymous'
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await new Promise<void>((resolve, reject) => {
      image.onload = () => resolve(); image.onerror = () => reject(new Error('MapTiler 标志加载失败，请重试或切换底图'))
      timer = setTimeout(() => reject(new Error('MapTiler 标志加载超时，请重试或切换底图')), TIMEOUT)
      image.src = url
    })
    return image
  } finally {clearTimeout(timer); image.onload = null; image.onerror = null}
}

async function encode(canvas: HTMLCanvasElement): Promise<Blob> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await new Promise<Blob>((resolve, reject) => {
      timer = setTimeout(() => reject(new Error('地图 PNG 生成超时，请重试')), TIMEOUT)
      canvas.toBlob(blob => blob?.size ? resolve(blob) : reject(new Error('地图 PNG 生成失败，请重试')), 'image/png')
    })
  } catch (error) {
    if (error instanceof DOMException && error.name === 'SecurityError') throw new Error('地图素材不允许导出，请切换底图后重试')
    throw error
  } finally {clearTimeout(timer)}
}

/** Capture only the current rendered map, its visible point markers and required provider attribution. */
export async function captureMapImage({canvas: source, markers = [], credits, background = '#fff', maptilerLogo}: MapImageCaptureOptions): Promise<Blob> {
  const mapRect = source.getBoundingClientRect()
  if (!Number.isFinite(source.width) || !Number.isFinite(source.height) || source.width <= 0 || source.height <= 0 ||
    !Number.isFinite(mapRect.width) || !Number.isFinite(mapRect.height) || mapRect.width <= 0 || mapRect.height <= 0) throw new Error('地图画面尚未就绪，请稍后重试')
  const captured = document.createElement('canvas'), context = captured.getContext('2d')
  if (!context) throw new Error('当前设备无法生成地图 PNG')
  const unique = credits.filter((credit, index) => credits.findIndex(item => item.label === credit.label && item.url === credit.url) === index)
  context.font = FONT
  const creditLines = wrapText(context, unique.map(credit => credit.label).join(' · '), Math.max(1, mapRect.width - 2 * PADDING))
  const logoWidth = Math.min(67, Math.max(1, mapRect.width - 2 * PADDING))
  const logoHeight = maptilerLogo ? Math.ceil(20 * logoWidth / 67) + PADDING : 0
  const footerCssHeight = creditLines.length || maptilerLogo ? PADDING * 2 + logoHeight + creditLines.length * CREDIT_LINE : 0
  const naturalHeight = source.height + footerCssHeight * source.width / mapRect.width
  const scale = Math.min(1, 4096 / Math.max(source.width, naturalHeight), Math.sqrt(SVG_ANNOTATION_MAX_PIXELS / (source.width * naturalHeight)))
  captured.width = Math.max(1, Math.floor(source.width * scale)); captured.height = Math.max(1, Math.floor(naturalHeight * scale))
  const mapHeight = Math.min(captured.height, Math.max(1, Math.floor(source.height * scale)))
  const scaleX = captured.width / mapRect.width, scaleY = mapHeight / mapRect.height
  context.fillStyle = background; context.fillRect(0, 0, captured.width, mapHeight)
  // Freeze source pixels and all live DOM information before the first asynchronous operation.
  context.drawImage(source, 0, 0, captured.width, mapHeight)
  context.save(); context.beginPath(); context.rect(0, 0, captured.width, mapHeight); context.clip()
  context.scale(scaleX, scaleY)
  for (const marker of markers) {
    const style = getComputedStyle(marker), rect = marker.getBoundingClientRect()
    if (!visible(marker, style, rect)) continue
    context.save()
    context.globalAlpha = cssNumber(style.opacity, 1)
    for (const selector of ['.trk-map-placemark-name', '.trk-map-placemark-dot', '.trk-map-placemark-count']) {
      const part = marker.querySelector<HTMLElement>(selector)
      if (part) drawMarkerPart(context, part, mapRect, selector.endsWith('-name'))
    }
    context.restore()
  }
  context.restore()
  if (footerCssHeight) {
    context.save(); context.fillStyle = '#fff'; context.fillRect(0, mapHeight, captured.width, captured.height - mapHeight)
    context.translate(0, mapHeight); context.scale(scaleX, scaleX)
    context.font = FONT; context.fillStyle = '#333'; context.textAlign = 'left'; context.textBaseline = 'middle'
    creditLines.forEach((line, index) => context.fillText(line, PADDING, PADDING + logoHeight + (index + .5) * CREDIT_LINE))
    context.restore()
  }
  if (maptilerLogo) {
    const logo = await loadLogo(maptilerLogo)
    context.drawImage(logo, PADDING * scaleX, mapHeight + PADDING * scaleX, logoWidth * scaleX, 20 * logoWidth / 67 * scaleX)
  }
  const encoded = document.createElement('canvas'), encoder = encoded.getContext('2d')
  if (!encoder) throw new Error('当前设备无法生成地图 PNG')
  for (let attempt = 0, factor = 1; attempt < 6; attempt++, factor *= .75) {
    encoded.width = Math.max(1, Math.floor(captured.width * factor)); encoded.height = Math.max(1, Math.floor(captured.height * factor))
    encoder.drawImage(captured, 0, 0, encoded.width, encoded.height)
    const blob = await encode(encoded)
    if (blob.type !== 'image/png') throw new Error('当前设备未返回 PNG 格式')
    if (blob.size <= SVG_ANNOTATION_MAX_BYTES) return blob
  }
  throw new Error('地图 PNG 仍超过 10 MiB，请缩小地图区域后重试')
}
