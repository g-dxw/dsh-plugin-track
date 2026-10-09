/** Rasterize the plugin's own escaped SVG to a bounded PNG for the image service. */
export async function svgToPng(svg: string, maximumSize = 1536): Promise<string> {
  const url = URL.createObjectURL(new Blob([svg], {type: 'image/svg+xml;charset=utf-8'}))
  const picture = new Image()
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await new Promise<void>((resolve, reject) => {
      picture.onload = () => resolve()
      picture.onerror = () => reject(new Error('无法生成轨迹参考图'))
      timer = setTimeout(() => reject(new Error('轨迹参考图生成超时')), 10000)
      picture.src = url
    })
    const width = picture.naturalWidth || picture.width, height = picture.naturalHeight || picture.height
    if (!width || !height) throw new Error('轨迹参考图尺寸无效')
    const scale = Math.min(1, maximumSize / Math.max(width, height))
    const canvas = document.createElement('canvas')
    canvas.width = Math.max(1, Math.round(width * scale)); canvas.height = Math.max(1, Math.round(height * scale))
    const context = canvas.getContext('2d')
    if (!context) throw new Error('当前设备无法生成参考图')
    context.drawImage(picture, 0, 0, canvas.width, canvas.height)
    return canvas.toDataURL('image/png')
  } finally {
    clearTimeout(timer)
    picture.onload = null; picture.onerror = null
    URL.revokeObjectURL(url)
  }
}
