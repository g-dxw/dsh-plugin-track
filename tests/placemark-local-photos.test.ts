import {describe,expect,it} from 'vitest'
import {imageLink,validatePlacemarks} from '../src/track/placemarks.ts'
import {validatePlacemarkEdits} from '../src/track/placemark-edits.ts'
import {groupCoverPhoto,groupPhotos,validatePlacemarkGroups} from '../src/track/placemark-groups.ts'
import {validatePlacemarkState,effectivePlacemarks,removeStatePlacemarks} from '../src/track/placemark-state.ts'
import {localPlacemarkPhoto,placemarkPhotoUrl} from '../src/track/placemark-photos.ts'
import type {PlacemarkGroup,TrackPlacemark} from '../src/protocol.ts'

const filename='a'.repeat(64)+'.jpg'
const url=placemarkPhotoUrl('track-1',filename)
const point:TrackPlacemark={id:'kml-1',name:'本地照片点',coordinates:[120,30],description:'',images:[url,'https://example.com/remote.jpg']}
const group:PlacemarkGroup={id:'group-11111111-1111-4111-8111-111111111111',name:'图片组',description:'',coordinates:[120,30],memberIds:['kml-1'],cover:{pointId:'kml-1',imageUrl:url}}

describe('persistent local placemark image references',()=>{
  it('normalizes only the exact plugin image reference alongside remote URLs',()=>{
    expect(localPlacemarkPhoto(url)).toEqual({trackId:'track-1',filename})
    expect(imageLink(url)).toBe(url)
    expect(imageLink('/api/cqai-track/placemark-photo?photo='+filename+'&id=track-1')).toBe(url)
    expect(imageLink('https://example.com/remote.jpg')).toBe('https://example.com/remote.jpg')
    expect(validatePlacemarks([point])[0].images).toEqual(point.images)
    expect(validatePlacemarkEdits([{id:point.id,images:point.images}])[0].images).toEqual(point.images)
  })
  it.each([
    'file:///C:/private/photo.jpg','C:\\private\\photo.jpg','data:image/png;base64,YQ==','blob:http://localhost/id',
    '/api/cqai-track/source?id=track-1','/private/photo.jpg',
    '/api/cqai-track/placemark-photo?id=../private&photo='+filename,
    '/api/cqai-track/placemark-photo?id=track-1&photo=../source.kml',
    '/api/cqai-track/placemark-photo?id=track-1&photo='+filename+'&extra=1',
    '/api/cqai-track/placemark-photo?id=track-1&id=track-2&photo='+filename,
    '/api/cqai-track/placemark-photo?id=track-1&photo='+filename+'#extra',
  ])('rejects arbitrary local paths and malformed references: %s',value=>{
    expect(localPlacemarkPhoto(value)).toBeNull();expect(imageLink(value)).toBeNull()
    expect(()=>validatePlacemarkEdits([{id:point.id,images:[value]}])).toThrow()
  })
  it('preserves local and remote image order in group cover and carousel',()=>{
    expect(validatePlacemarkGroups([group])[0].cover!.imageUrl).toBe(url)
    expect(groupCoverPhoto(group,[point])!.url).toBe(url)
    expect(groupPhotos(group,[point]).map(photo=>photo.url)).toEqual(point.images)
    expect(groupPhotos(group,[{...point,hidden:true}])).toEqual([])
  })
  it('keeps local references in the complete snapshot for deletion and restoration',()=>{
    const state=validatePlacemarkState({version:1,revision:1,added:[],deletedIds:[],edits:[{id:point.id,images:point.images}],order:[point.id],groups:[group],routeContext:null})
    const removed=removeStatePlacemarks([point],state,[point.id])
    expect(effectivePlacemarks([point],removed)).toEqual([]);expect(removed.groups).toEqual([])
    const restored=validatePlacemarkState(JSON.parse(JSON.stringify(state)))
    expect(effectivePlacemarks([point],restored)[0].images).toEqual(point.images)
    expect(restored.groups[0].cover!.imageUrl).toBe(url)
  })
})
