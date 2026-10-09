import { describe, expect, it } from 'vitest'
import { editedPlacemarks, patchPlacemarkEdits, placemarkTypes, snapPlacemarkToTrack, validatePlacemarkEdits } from '../src/track/placemark-edits.ts'
import type { TrackPlacemark, TrackPoint } from '../src/protocol.ts'
const point: TrackPlacemark = {id:'kml-1',name:'山口',description:'保留',coordinates:[120,30],elevation:100,time:123,images:['https://example.com/photo.jpg']}

describe('point association overrides', () => {
  it('combines photo and position edits without changing the original point or its time', () => {
    const edits = patchPlacemarkEdits([{id:point.id,images:[]}],[{id:point.id,coordinates:[120.01,30.01],elevation:200}])
    const [changed] = editedPlacemarks([point],edits)
    expect(changed).toMatchObject({coordinates:[120.01,30.01],images:[],elevation:200,time:123,name:'山口',description:'保留'})
    expect(point.coordinates).toEqual([120,30]); expect(point.images).toHaveLength(1)
    expect(editedPlacemarks([point],[])[0]).toBe(point)
  })
  it('merges names, descriptions, custom types and hidden state while preserving source metadata', () => {
    const original = {...point, type: '原始类型', hidden: true}
    const copy = structuredClone(original)
    const previous = [{id: point.id, coordinates: [120.01,30.01] as [number,number], elevation: 200, images: []}]
    const edits = patchPlacemarkEdits(previous, [{id: point.id, name: '', description: '', type: '', hidden: false}])
    expect(editedPlacemarks([original], edits)).toEqual([{...original, coordinates:[120.01,30.01], elevation:200, images:[], name:'', description:'', type:'', hidden:false}])
    expect(original).toEqual(copy)
    const hidden = editedPlacemarks([point], [{id: point.id, type:'山间补给与拍照', hidden:true}])
    expect(hidden).toHaveLength(1)
    expect(hidden[0]).toMatchObject({id:point.id, type:'山间补给与拍照', hidden:true, time:123, name:'山口', description:'保留'})
  })
  it('accepts empty text and maximum information lengths without normalizing description formatting', () => {
    const edits = [{id:point.id, name:'名'.repeat(160), description:'\n'+'说'.repeat(9998)+'\n', type:'类'.repeat(64), hidden:false}]
    expect(validatePlacemarkEdits(edits)).toEqual(edits)
    expect(validatePlacemarkEdits([{id:point.id, name:'', description:'', type:'', hidden:true}])).toEqual([{id:point.id, name:'', description:'', type:'', hidden:true}])
    expect(validatePlacemarkEdits([{id:point.id, images:[], coordinates:[120,30], elevation:100}])).toEqual([{id:point.id, images:[], coordinates:[120,30], elevation:100}])
  })
  it('normalizes multiple types without mutating the submitted array and preserves old strings', () => {
    const types = [' 风景点 ', '补给点', '风景点', ' 营地 ']
    const before = [...types]
    const [edit] = validatePlacemarkEdits([{id:point.id, type:types}])
    expect(edit.type).toEqual(['风景点','补给点','营地'])
    expect(edit.type).not.toBe(types)
    expect(types).toEqual(before)
    for (const type of ['', ' ', '  原始类型  ']) {
      expect(validatePlacemarkEdits([{id:point.id, type}])).toEqual([{id:point.id, type}])
    }
    const maximum = Array.from({length:20}, (_, index) => `标签${index}`)
    expect(validatePlacemarkEdits([{id:point.id,type:maximum}])[0].type).toEqual(maximum)
    expect(validatePlacemarkEdits([{id:point.id,type:[' '+ '类'.repeat(64) +' ']}])[0].type).toEqual(['类'.repeat(64)])
  })
  it('clears selected types with an empty array while retaining all other point fields', () => {
    const original = {...point, type:['风景点','补给点'], hidden:true}
    const copy = structuredClone(original)
    const edits = patchPlacemarkEdits([{id:point.id,name:'已修改',description:'已修改说明',images:[],hidden:false}], [{id:point.id,type:[]}])
    expect(edits).toEqual([{id:point.id,name:'已修改',description:'已修改说明',images:[],hidden:false,type:[]}])
    expect(editedPlacemarks([original],edits)).toEqual([{...original,name:'已修改',description:'已修改说明',images:[],hidden:false,type:[]}])
    expect(original).toEqual(copy)
    expect(editedPlacemarks([{...point,type:'旧标签'}],[{id:point.id,type:[]}])[0].type).toEqual([])
  })
  it('reads either type format safely for display and removes duplicate or empty labels', () => {
    const types = [' 风景点 ', '', '补给点', '风景点', '  ']
    expect(placemarkTypes({type:types})).toEqual(['风景点','补给点'])
    expect(types).toEqual([' 风景点 ', '', '补给点', '风景点', '  '])
    expect(placemarkTypes({type:' 自定义补给点 '})).toEqual(['自定义补给点'])
    for (const value of [{}, {type:''}, {type:'  '}, {type:42}, {type:null}, null]) expect(placemarkTypes(value as never)).toEqual([])
    expect(placemarkTypes({type:[null,42,{},['nested'],' 补给点 ','补给点','']} as never)).toEqual(['补给点'])
  })
  it.each([
    {type:21}, {type:null}, {type:{}}, {type:['']}, {type:['  ']}, {type:[null]}, {type:[['补给点']]},
    {type:['类'.repeat(65)]}, {type:Array.from({length:21},()=> '同一标签')}, {type:new Array(1)},
  ])('rejects invalid multiple type values $type', ({type}) => expect(() => validatePlacemarkEdits([{id:point.id,type}])).toThrow())
  it('snaps a drag onto the route segment and uses its interpolated altitude', () => {
    const track: TrackPoint[] = [[120,30,100,100],[120.01,30,200,200]]
    const patch = snapPlacemarkToTrack(point,[120.005,30.004],track)
    expect(patch.coordinates![0]).toBeCloseTo(120.005); expect(patch.coordinates![1]).toBe(30)
    expect(patch.elevation).toBeCloseTo(150); expect(patch).not.toHaveProperty('time')
    expect(track).toEqual([[120,30,100,100],[120.01,30,200,200]])
  })
  it('keeps unknown altitude null and handles date-line segment interpolation', () => {
    expect(snapPlacemarkToTrack(point,[120.005,30],[[120,30,null,null],[120.01,30,200,null]]).elevation).toBeNull()
    const patch = snapPlacemarkToTrack(point,[-180,0.001],[[179.9,0,10,null],[-179.9,0,20,null]])
    expect(Math.abs(patch.coordinates![0])).toBeCloseTo(180); expect(patch.elevation).toBeCloseTo(15)
  })
  it('rejects missing valid route coordinates instead of guessing a point', () => {
    expect(() => snapPlacemarkToTrack(point,[120,30],[])).toThrow('没有可对应')
  })
  it.each([
    {value:[{id:'a',coordinates:[181,30]}]},
    {value:[{id:'a',images:['javascript:alert(1)']}]},
    {value:[{id:'a',images:['https://u:p@example.com/a.jpg']}]},
    {value:[{id:'a',elevation:NaN}]},
    {value:[{id:'a'},{id:'a'}]},
    {value:[{id:'a',name:null}]},
    {value:[{id:'a',name:42}]},
    {value:[{id:'a',name:'名'.repeat(161)}]},
    {value:[{id:'a',description:[]}]},
    {value:[{id:'a',description:'说'.repeat(10001)}]},
    {value:[{id:'a',type:['补给',42]}]},
    {value:[{id:'a',type:'类'.repeat(65)}]},
    {value:[{id:'a',hidden:'true'}]},
    {value:[{id:'a',hidden:0}]},
    {value:[{id:'a',hidden:null}]},
  ])('rejects invalid overrides $value', ({value}) => expect(() => validatePlacemarkEdits(value)).toThrow())
})

describe('computed point location edits',()=>{
  it('preserves derived time source and selected passage through validation, merge and clearing unknown metadata',()=>{
    const edit={id:point.id,time:5000,timeSource:'estimated' as const,routePosition:{startIndex:1,endIndex:2,fraction:.5}}
    const validated=validatePlacemarkEdits([edit])
    expect(validated).toEqual([edit]);expect(validated[0].routePosition).not.toBe(edit.routePosition)
    expect(editedPlacemarks([point],validated)[0]).toMatchObject({time:5000,timeSource:'estimated',routePosition:edit.routePosition,name:point.name,images:point.images})
    expect(editedPlacemarks([point],patchPlacemarkEdits(validated,[{id:point.id,time:null,timeSource:'unknown',elevation:null}]))[0]).toMatchObject({time:null,timeSource:'unknown',elevation:null,routePosition:edit.routePosition})
    expect(editedPlacemarks([point],[{id:point.id,coordinates:[120.01,30]}])[0].time).toBe(point.time)
  })
  it('rejects non-epoch timestamps, bad time sources and malformed route positions',()=>{
    const invalid=[{time:NaN},{time:Infinity},{time:1e20},{time:'2026-01-01'},{timeSource:null},{timeSource:'raw'},{timeSource:1},
      {routePosition:null},{routePosition:{startIndex:0,endIndex:2,fraction:.5}},{routePosition:{startIndex:0,endIndex:1,fraction:2}}]
    for(const patch of invalid)expect(()=>validatePlacemarkEdits([{id:point.id,...patch}])).toThrow()
  })
  it('does not let a previous route anchor redirect a fresh group/legacy snap',()=>{
    const track:TrackPoint[]=[[120,30,100,1000],[120.02,30,200,2000]]
    const anchored={...point,routePosition:{startIndex:0,endIndex:1,fraction:0}}
    const snapped=snapPlacemarkToTrack(anchored,[120.015,30],track)
    expect(snapped.coordinates).toEqual([120.015,30])
    expect(snapped.elevation).toBeCloseTo(175,8)
  })
})
