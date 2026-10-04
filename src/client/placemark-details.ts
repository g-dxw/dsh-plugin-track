import type { PlacemarkGroup, TrackPlacemark } from '../protocol.ts'
import { imageLink } from '../track/placemarks.ts'
import { placemarkPhotoThumbnailUrl } from '../track/placemark-photo-assets.ts'
import { placemarkTypes } from '../track/placemark-edits.ts'
import { groupCoverPhoto, groupMembers, groupPhotos, groupTypes } from '../track/placemark-groups.ts'
import { placemarkTitle, formatPlacemarkElevation, formatPlacemarkTime, formatPlacemarkCoordinates } from '../track/placemark-format.ts'

export interface PlacemarkDetailsOptions {
  trackId?: string
  maxWidth?: number
  maxHeight?: number
  onViewImage?: (url: string, index: number) => void
  onEdit?: () => void
  editDisabled?: boolean
}

export type PlacemarkGroupPhoto = {pointId: string; url: string}
export interface PlacemarkGroupDetailsOptions extends PlacemarkDetailsOptions {
  selectedPointId?: string
  selectedPhoto?: PlacemarkGroupPhoto
  onChangePhoto?: (photo: PlacemarkGroupPhoto, focusLabel?: string) => void
}

/** Group slides keep the original child's metadata and image ownership. */
export function createPlacemarkGroupDetails(group: PlacemarkGroup, points: readonly TrackPlacemark[], onClose: () => void, options: PlacemarkGroupDetailsOptions = {}): HTMLDivElement {
  const photos = groupPhotos(group, points)
  const members = groupMembers(group, points)
  const cover = groupCoverPhoto(group, points)
  let index = options.selectedPhoto ? photos.findIndex(photo => photo.point.id === options.selectedPhoto?.pointId && photo.url === options.selectedPhoto.url)
    : options.selectedPointId ? photos.findIndex(photo => photo.point.id === options.selectedPointId)
    : Math.max(0, photos.findIndex(photo => photo.point.id === cover?.point.id && photo.url === cover.url))
  if (!photos.length) index = -1
  let point = members.find(member => member.id === options.selectedPointId) ?? photos[index]?.point ?? members.find(member => !member.hidden) ?? members[0]
  const shell = document.createElement('div')
  shell.className = 'trk-placemark-group-details'
  shell.setAttribute('role', 'dialog'); shell.setAttribute('aria-modal', 'false')
  shell.setAttribute('aria-label', `组详情：${group.name.trim() || '标记组'}`)
  shell.addEventListener('pointerdown', event => event.stopPropagation())
  const show = () => {
    const photo = photos[index]
    if (photo) point = photo.point
    const child = createPlacemarkDetails(point ? {...point, images: photo ? [photo.url] : []} : {
      id: group.id, name: '', description: '', coordinates: group.coordinates, images: [],
    }, onClose, {...options, onViewImage: photo && options.onViewImage ? () => options.onViewImage?.(photo.url, index) : undefined})
    child.removeAttribute('role'); child.removeAttribute('aria-modal'); child.removeAttribute('aria-label')
    child.dataset.groupMemberId = point?.id ?? ''
    const body = child.querySelector<HTMLDivElement>('.trk-placemark-details-body')!
    const childTitle = body.querySelector<HTMLElement>('.trk-placemark-details-title')
    if (childTitle) {childTitle.className = 'trk-placemark-details-member'; childTitle.setAttribute('aria-label', '当前子点')}
    body.querySelector('.trk-placemark-details-types')?.remove()
    const heading = document.createElement('div'); heading.className = 'trk-placemark-details-group-info'
    if (group.name.trim()) {const title = document.createElement('h4'); title.className = 'trk-placemark-details-title'; title.textContent = group.name; heading.append(title)}
    const types = groupTypes(group, points)
    if (types.length) {
      const badges = document.createElement('div'); badges.className = 'trk-placemark-details-types'
      for (const type of types) {const badge = document.createElement('span'); badge.className = 'trk-placemark-details-type'; badge.textContent = type; badges.append(badge)}
      heading.append(badges)
    }
    if (group.description.trim()) {const description = document.createElement('p'); description.className = 'trk-placemark-details-description'; description.textContent = group.description; heading.append(description)}
    body.prepend(heading)
    const info = document.createElement('div'); info.className = 'trk-placemark-group-info-scroll'
    const actions = body.querySelector('.trk-placemark-details-actions')
    for (const element of Array.from(body.children)) if (element !== actions) info.append(element)
    body.prepend(info)
    child.querySelector('.trk-placemark-details-edit')?.setAttribute('aria-label', '编辑标记组')
    if (photos.length) {
      const controls = document.createElement('div'); controls.className = 'trk-placemark-details-carousel'
      controls.setAttribute('aria-label', '组图片轮播')
      const previous = document.createElement('button'); previous.type = 'button'; previous.textContent = '‹'; previous.setAttribute('aria-label', '上一张组图片')
      const next = document.createElement('button'); next.type = 'button'; next.textContent = '›'; next.setAttribute('aria-label', '下一张组图片')
      const count = document.createElement('span'); count.setAttribute('aria-live', 'polite'); count.textContent = `${index < 0 ? 0 : index + 1} / ${photos.length}`
      previous.addEventListener('click', event => {event.stopPropagation(); advance(-1, '上一张组图片')})
      next.addEventListener('click', event => {event.stopPropagation(); advance(1, '下一张组图片')})
      controls.append(previous, count, next)
      if (actions) body.insertBefore(controls, actions); else body.append(controls)
    }
    shell.replaceChildren(child)
  }
  const advance = (step: number, focusLabel?: string) => {
    if (!photos.length) return
    index = index < 0 ? (step > 0 ? 0 : photos.length - 1) : (index + step + photos.length) % photos.length
    options.onChangePhoto?.({pointId: photos[index].point.id, url: photos[index].url}, focusLabel)
    show()
    if (focusLabel) shell.querySelector<HTMLButtonElement>(`[aria-label="${focusLabel}"]`)?.focus({preventScroll: true})
  }
  shell.addEventListener('keydown', event => {
    if ((event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') || event.altKey || event.ctrlKey || event.metaKey || !photos.length) return
    event.preventDefault(); event.stopPropagation(); advance(event.key === 'ArrowLeft' ? -1 : 1, event.key === 'ArrowLeft' ? '上一张组图片' : '下一张组图片')
  })
  show()
  return shell
}

/** One reusable DOM card for the WebGL popup and the offline map fallback. */
export function createPlacemarkDetails(point: TrackPlacemark, onClose: () => void, options: PlacemarkDetailsOptions = {}): HTMLDivElement {
  const name = placemarkTitle({...point, name: typeof point.name === 'string' ? point.name : ''})
  const label = name || '标注点'
  const maxWidth = typeof options.maxWidth === 'number' && Number.isFinite(options.maxWidth) && options.maxWidth > 0 ? options.maxWidth : 400
  const maxHeight = typeof options.maxHeight === 'number' && Number.isFinite(options.maxHeight) && options.maxHeight > 0 ? options.maxHeight : 240
  const details = document.createElement('div')
  details.className = 'trk-placemark-details'
  details.style.width = `${Math.min(280, maxWidth)}px`
  details.setAttribute('role', 'dialog')
  details.setAttribute('aria-modal', 'false')
  details.setAttribute('aria-label', `点位详情：${label}`)

  const close = document.createElement('button')
  close.type = 'button'
  close.className = 'trk-placemark-details-close'
  close.setAttribute('aria-label', '关闭点位详情')
  close.textContent = '×'
  close.addEventListener('click', event => {event.stopPropagation(); onClose()})

  const body = document.createElement('div')
  body.className = 'trk-placemark-details-body'
  if (name) {
    const title = document.createElement('h4')
    title.className = 'trk-placemark-details-title'
    title.textContent = name
    body.append(title)
  }
  const types = placemarkTypes(point)
  if (types.length) {
    const badges = document.createElement('div')
    badges.className = 'trk-placemark-details-types'
    for (const label of types) {
      const badge = document.createElement('span')
      badge.className = 'trk-placemark-details-type'
      badge.textContent = label
      badges.append(badge)
    }
    body.append(badges)
  }
  if (typeof point.description === 'string' && point.description.trim()) {
    const description = document.createElement('p')
    description.className = 'trk-placemark-details-description'
    description.textContent = point.description
    body.append(description)
  }
  const metadata = document.createElement('div')
  metadata.className = 'trk-placemark-details-metadata'
  const time = formatPlacemarkTime(point.time,point.timeSource)
  const values = [formatPlacemarkElevation(point.elevation), time ? `时间 ${time}` : '', formatPlacemarkCoordinates(point.coordinates)]
  for (const value of values.filter(Boolean)) {
    const item = document.createElement('p')
    item.className = 'trk-placemark-details-metadata-item'
    item.textContent = value
    metadata.append(item)
  }
  body.append(metadata)

  // Stored legacy metadata also passes through here; never assign unchecked URLs.
  const urls = Array.isArray(point.images)
    ? [...new Set(point.images.filter((value): value is string => typeof value === 'string').map(imageLink).filter((value): value is string => Boolean(value)))]
    : []
  const photoStates: ('loading' | 'ready' | 'error')[] = urls.map(() => 'loading')
  const updatePhotoState = () => {
    details.classList.toggle('trk-placemark-details-photo-loading', photoStates.includes('loading'))
    details.classList.toggle('trk-placemark-details-photo-error', photoStates.includes('error'))
    details.classList.toggle('trk-placemark-details-photo-ready', photoStates.length > 0 && photoStates.every(state => state === 'ready'))
  }
  details.classList.toggle('trk-placemark-details-with-photos', urls.length > 0)
  updatePhotoState()
  const photos = document.createElement('div')
  photos.className = 'trk-placemark-details-photos'
  photos.setAttribute('aria-label', '点位图片')
  if (!urls.length) {
    const empty = document.createElement('p')
    empty.className = 'trk-placemark-details-empty'
    empty.textContent = '暂无图片'
    photos.append(empty)
  }
  for (let index = 0; index < urls.length; index += 1) {
    const photo = document.createElement('div')
    photo.className = 'trk-placemark-details-photo'
    const showImage = () => {
      photoStates[index] = 'loading'
      updatePhotoState()
      const image = document.createElement('img')
      image.className = 'trk-placemark-details-image'
      image.alt = `${label} · 图片 ${index + 1}`
      image.loading = 'lazy'
      image.decoding = 'async'
      image.referrerPolicy = 'no-referrer'
      image.style.maxWidth = '100%'
      image.style.height = 'auto'
      image.addEventListener('load', () => {
        if (!photo.contains(image) || image.naturalWidth <= 0 || image.naturalHeight <= 0) return
        const scale = Math.min(1, maxWidth / image.naturalWidth, maxHeight / image.naturalHeight)
        const width = image.naturalWidth * scale
        image.style.width = `${width}px`
        if (index === 0) details.style.width = `${width}px`
        photoStates[index] = 'ready'
        updatePhotoState()
      }, {once: true})
      image.addEventListener('error', () => {
        // A late error from an image replaced during retry must not erase the new image.
        if (!photo.contains(image)) return
        const failure = document.createElement('div')
        failure.className = 'trk-placemark-details-error'
        failure.setAttribute('role', 'status')
        const message = document.createElement('span')
        message.textContent = `图片 ${index + 1} 加载失败`
        const retry = document.createElement('button')
        retry.type = 'button'
        retry.className = 'trk-placemark-details-retry'
        retry.textContent = '重试图片'
        retry.setAttribute('aria-label', `重试图片 ${index + 1}`)
        retry.addEventListener('click', event => {event.stopPropagation(); showImage()})
        failure.append(message, retry)
        photo.replaceChildren(failure)
        photoStates[index] = 'error'
        updatePhotoState()
      }, {once: true})
      image.src = options.trackId ? placemarkPhotoThumbnailUrl(options.trackId, urls[index]) : urls[index]
      if (options.onViewImage) {
        const view = document.createElement('button')
        view.className = 'trk-placemark-details-photo-button'
        view.type = 'button'
        view.setAttribute('aria-label', `查看图片 ${index + 1} 大图`)
        view.addEventListener('click', event => {event.stopPropagation(); options.onViewImage?.(urls[index], index)})
        view.append(image)
        photo.replaceChildren(view)
      } else photo.replaceChildren(image)
    }
    showImage()
    photos.append(photo)
  }
  const actions = document.createElement('div')
  actions.className = 'trk-placemark-details-actions'
  if (urls.length && options.onViewImage) {
    const view = document.createElement('button')
    view.type = 'button'
    view.className = 'trk-placemark-details-view'
    view.textContent = '查看大图'
    view.addEventListener('click', event => {event.stopPropagation(); options.onViewImage?.(urls[0], 0)})
    actions.append(view)
  }
  if (options.onEdit) {
    const edit = document.createElement('button')
    edit.type = 'button'
    edit.className = 'trk-placemark-details-edit'
    edit.textContent = '编辑'
    edit.setAttribute('aria-label', '编辑点位')
    edit.disabled = Boolean(options.editDisabled)
    edit.addEventListener('click', event => {event.stopPropagation(); if (!edit.disabled) options.onEdit?.()})
    actions.append(edit)
  }
  if (actions.childElementCount) body.append(actions)
  details.append(close, photos, body)
  details.addEventListener('keydown', event => {
    if (event.key !== 'Escape') return
    event.preventDefault()
    event.stopPropagation()
    onClose()
  })
  return details
}
