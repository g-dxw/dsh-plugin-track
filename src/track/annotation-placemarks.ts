import type { PlacemarkGroup, TrackPlacemark, TrackPoint } from '../protocol.ts'
import { ANNOTATION_KINDS, annotationsFromPlacemarks, type TrackAnnotation } from './annotations.ts'
import { placemarkTypes } from './placemark-edits.ts'
import { groupCoverPhoto, groupHidden, groupPhotos, groupTypes, placemarkListItems } from './placemark-groups.ts'

export interface AnnotationPlacemarkState {points: TrackPlacemark[]; groups: PlacemarkGroup[]}

/** One source node per group, in the same order as the point editor. */
export function annotationPlacemarkNodes({points, groups}: AnnotationPlacemarkState): TrackPlacemark[] {
  return placemarkListItems(points, groups).map(item => {
    if (item.kind === 'point') return item.point
    const {group} = item, cover = groupCoverPhoto(group, points)
    const images = [...new Set([...(cover ? [cover.url] : []), ...groupPhotos(group, points).map(photo => photo.url)])].slice(0, 30)
    return {id: group.id, name: group.name, description: group.description, coordinates: group.coordinates, images, type: groupTypes(group, points), hidden: groupHidden(group, points)}
  })
}

/** The point editor owns metadata and geographic anchors; SVG owns presentation. */
function synchronizeSourceAnnotation(annotation: TrackAnnotation, node: TrackPlacemark, coordinates: readonly TrackPoint[]): TrackAnnotation {
  const source = annotationsFromPlacemarks([node], coordinates)[0]
  const kind = ANNOTATION_KINDS.find(kind => placemarkTypes(node).includes(kind.label))?.id
  const photo = annotation.photo?.sourceUrl && !source.imageUrls?.includes(annotation.photo.sourceUrl) ? undefined : annotation.photo
  return {...annotation, label: node.name.trim() || '未命名点位', description: node.description, imageUrls: source.imageUrls,
    sourceCoordinates: [...node.coordinates], pointIndex: source.pointIndex, kind, photo, visible: annotation.visible ?? true}
}

export function initialPlacemarkAnnotations(state: AnnotationPlacemarkState, coordinates: readonly TrackPoint[]): TrackAnnotation[] {
  return annotationPlacemarkNodes(state).filter(point => !point.hidden).slice(0, 100).map(node => synchronizeSourceAnnotation(annotationsFromPlacemarks([node], coordinates)[0], node, coordinates))
}

/** Source visibility gates rendering without erasing the user's saved artwork. */
export function projectPlacemarkAnnotations(annotations: readonly TrackAnnotation[], state: AnnotationPlacemarkState, coordinates: readonly TrackPoint[]): TrackAnnotation[] {
  const nodes = new Map(annotationPlacemarkNodes(state).map(point => [point.id, point]))
  const groupsByMember = new Map(state.groups.flatMap(group => group.memberIds.map(id => [id, group] as const)))
  const linked = new Set(annotations.map(item => item.sourceId).filter(Boolean)), emitted = new Set<string>()
  const result: TrackAnnotation[] = []
  for (const annotation of annotations) {
    if (!annotation.sourceId) {result.push(annotation); continue}
    const group = groupsByMember.get(annotation.sourceId)
    if (group && !linked.has(group.id)) {
      const node = nodes.get(group.id)
      if (node && !node.hidden && !emitted.has(group.id)) {
        result.push(synchronizeSourceAnnotation(annotationsFromPlacemarks([node], coordinates)[0], node, coordinates)); emitted.add(group.id)
      }
    }
    const node = nodes.get(annotation.sourceId)
    if (node && !node.hidden) result.push(synchronizeSourceAnnotation(annotation, node, coordinates))
  }
  return result
}

/** Canvas gestures edit the projection while retaining suppressed source members. */
export function mergePlacemarkAnnotationEdits(stored: readonly TrackAnnotation[], displayed: readonly TrackAnnotation[], next: readonly TrackAnnotation[]): TrackAnnotation[] {
  const before = new Map(displayed.map(item => [item.id, item])), after = new Map(next.map(item => [item.id, item]))
  const ids = new Set(stored.map(item => item.id))
  return [...stored.flatMap(item => {
    if (!before.has(item.id)) return [item]
    const previous = before.get(item.id)!
    let changed = after.get(item.id)
    if (!changed) return []
    if (JSON.stringify(changed) === JSON.stringify(previous)) return [item]
    // A removed source photo is suppressed by the projection; unrelated styling keeps its saved layout.
    if (item.sourceId && item.photo?.sourceUrl && !previous.photo && !changed.photo) changed = {...changed, photo: item.photo}
    // Keep the source-derived default implicit unless the display switch itself changed.
    if (item.visible === undefined && changed.visible === before.get(item.id)?.visible) {
      const {visible: _default, ...edited} = changed
      return [edited]
    }
    return [changed]
  }), ...next.filter(item => !ids.has(item.id) && (!before.has(item.id) || JSON.stringify(item) !== JSON.stringify(before.get(item.id))))]
}
