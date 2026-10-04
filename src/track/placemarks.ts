import type { TrackPlacemark } from '../protocol.ts'
import {localPlacemarkPhoto,placemarkPhotoUrl} from './placemark-photos.ts'

export function imageLink(value: string): string | null {
  const photo=localPlacemarkPhoto(value)
  if(photo)return placemarkPhotoUrl(photo.trackId,photo.filename)
  try {
    const url = new URL(value.trim())
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password ? url.href : null
  } catch { return null }
}

/** Read text and links only. Imported HTML is never attached to the live page. */
export function parseKmlPlacemarks(source: string): TrackPlacemark[] {
  const document = new DOMParser().parseFromString(source, 'application/xml')
  if (document.getElementsByTagName('parsererror').length) throw new Error('KML 标注点无法读取：XML 语法错误')
  const result: TrackPlacemark[] = []
  const children = (node: Element, name: string) => Array.from(node.getElementsByTagNameNS('*', name))
  const directChild = (node: Element, name: string) => Array.from(node.children).find(child => child.localName === name)
  for (const placemark of children(document.documentElement, 'Placemark')) {
    const geometry = children(placemark, 'Point')[0]
    const coordinateText = geometry && children(geometry, 'coordinates')[0]?.textContent?.trim()
    if (!coordinateText) continue
    const coordinateValues = coordinateText.split(/\s/u)[0].split(',')
    const [lon, lat] = coordinateValues.map(Number)
    if (!Number.isFinite(lon) || !Number.isFinite(lat) || Math.abs(lon) > 180 || Math.abs(lat) > 90) continue
    const rawElevation = coordinateValues[2]?.trim()
    const elevation = rawElevation && Number.isFinite(Number(rawElevation)) ? Number(rawElevation) : null
    const timestamp = directChild(placemark, 'TimeStamp')
    const rawTime = timestamp && directChild(timestamp, 'when')?.textContent?.trim()
    const parsedTime = rawTime ? Date.parse(rawTime) : Number.NaN
    const time = Number.isFinite(parsedTime) ? parsedTime : null
    const description = children(placemark, 'description')[0]
    const raw = description ? Array.from(description.childNodes).map(node => node.nodeType === 1 ? new XMLSerializer().serializeToString(node) : node.textContent || '').join('') : ''
    // The inert document supplies text and URL attributes without running markup.
    const inertMarkup = raw.replace(/\b(src|srcset|href|data|poster)\s*=/giu, 'data-trk-$1=')
    const html = new DOMParser().parseFromString(inertMarkup, 'text/html')
    html.querySelectorAll('script,style,iframe,object').forEach(element => element.remove())
    const candidates = [...html.querySelectorAll('img')].map(image => image.getAttribute('data-trk-src') || '')
    for (const anchor of html.querySelectorAll('a[data-trk-href]')) {
      const href = anchor.getAttribute('data-trk-href') || ''
      if (/\.(?:jpe?g|png|webp|gif|avif)(?:[?#]|$)/iu.test(href)) candidates.push(href)
    }
    const extra = children(placemark, 'ExtendedData')[0]?.textContent || ''
    for (const match of (raw + '\n' + extra).matchAll(/https?:\/\/[^\s<>"']+\.(?:jpe?g|png|webp|gif|avif)(?:\?[^\s<>"']*)?/giu)) candidates.push(match[0])
    const images = [...new Set(candidates.map(imageLink).filter((url): url is string => Boolean(url)))].slice(0, 30)
    if (result.length >= 5000) throw new Error('KML 标注点最多 5000 个')
    result.push({
      id: `kml-${result.length + 1}`,
      name: (directChild(placemark, 'name')?.textContent?.trim() || '').slice(0, 160),
      coordinates: [lon, lat],
      description: (html.body.textContent || '').trim().slice(0, 4000),
      images,
      elevation,
      time,
    })
  }
  return validatePlacemarks(result)
}

export function validatePlacemarks(value: unknown): TrackPlacemark[] {
  if (!Array.isArray(value) || value.length > 5000) throw new Error('KML 标注点最多 5000 个')
  const ids = new Set<string>()
  return value.map(raw => {
    if (!raw || typeof raw !== 'object') throw new Error('标注点格式无效')
    const item = raw as Partial<TrackPlacemark>
    if (typeof item.id !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/u.test(item.id) || ids.has(item.id)) throw new Error('标注点编号无效或重复')
    if (!Array.isArray(item.coordinates) || item.coordinates.length !== 2 || !item.coordinates.every(Number.isFinite) || Math.abs(item.coordinates[0]) > 180 || Math.abs(item.coordinates[1]) > 90) throw new Error('标注点坐标无效')
    if (typeof item.name !== 'string' || item.name.length > 160 || typeof item.description !== 'string' || item.description.length > 4000) throw new Error('标注点名称或说明无效')
    if (!Array.isArray(item.images) || item.images.length > 30 || item.images.some(url => typeof url !== 'string' || url.length > 4096 || !imageLink(url))) throw new Error('标注图片链接无效')
    if (item.elevation !== undefined && item.elevation !== null && (typeof item.elevation !== 'number' || !Number.isFinite(item.elevation))) throw new Error('标注点海拔无效')
    if (item.time !== undefined && item.time !== null && (typeof item.time !== 'number' || !Number.isFinite(item.time) || !Number.isFinite(new Date(item.time).getTime()))) throw new Error('标注点时间无效')
    ids.add(item.id)
    return {id: item.id, name: item.name.trim(), coordinates: [item.coordinates[0], item.coordinates[1]], description: item.description, images: [...new Set(item.images.map(url => imageLink(url)!))], ...(item.elevation !== undefined ? {elevation: item.elevation} : {}), ...(item.time !== undefined ? {time: item.time} : {})}
  })
}
