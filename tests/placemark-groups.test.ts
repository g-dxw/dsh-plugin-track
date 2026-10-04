import { describe, expect, it } from 'vitest'
import type { PlacemarkGroup, TrackPlacemark } from '../src/protocol.ts'
import { groupCoverPhoto, groupHidden, groupMembers, groupPhotos, groupTypes, mergePlacemarkGroups, placemarkListItems, validatePlacemarkGroups } from '../src/track/placemark-groups.ts'

const firstId='group-00000000-0000-0000-0000-000000000001'
const secondId='group-00000000-0000-0000-0000-000000000002'
const group:PlacemarkGroup={id:firstId,name:'山景',description:'保留说明',memberIds:['c','a'],coordinates:[120,30],cover:{pointId:'c',imageUrl:'https://example.com/shared.jpg'}}
const points:TrackPlacemark[]=[
  {id:'a',name:'甲',description:'',coordinates:[120,30],images:['https://example.com/a.jpg','https://example.com/shared.jpg',' https://example.com/a.jpg '],type:[' 风景点 ','营地','风景点']},
  {id:'b',name:'乙',description:'',coordinates:[120.005,30],images:[],type:''},
  {id:'c',name:'丙',description:'',coordinates:[120.01,30],images:['https://example.com/shared.jpg'],type:' 补给点 '},
  {id:'d',name:'丁',description:'',coordinates:[120.015,30],images:['https://example.com/d.jpg'],type:['营地','休息点'],hidden:true},
]

describe('placemark group projections',()=>{
  it('uses the current flat order rather than member selection order without mutating data',()=>{
    const before=structuredClone({points,group})
    expect(groupMembers(group,points)).toEqual([points[0],points[2]])
    expect(groupMembers(group,[...points].reverse())).toEqual([points[2],points[0]])
    expect(groupMembers({...group,memberIds:['missing']},points)).toEqual([])
    expect({points,group}).toEqual(before)
  })
  it('deduplicates safe images per member while retaining the same image on two members',()=>{
    const memberGroup={...group,memberIds:['d','c','a']}
    expect(groupPhotos(memberGroup,points)).toEqual([
      {point:points[0],url:'https://example.com/a.jpg'},
      {point:points[0],url:'https://example.com/shared.jpg'},
      {point:points[2],url:'https://example.com/shared.jpg'},
    ])
    expect(groupCoverPhoto(memberGroup,points)).toEqual({point:points[2],url:'https://example.com/shared.jpg'})
    const unsafe={...points[0],images:['javascript:alert(1)','https://u:p@example.com/a.jpg','https://example.com/safe.jpg']}
    expect(groupPhotos(group,[unsafe])).toEqual([{point:unsafe,url:'https://example.com/safe.jpg'}])
  })
  it('falls back to the first visible image when a cover is hidden, removed or no longer present',()=>{
    const first={point:points[0],url:'https://example.com/a.jpg'}
    expect(groupCoverPhoto(group,points.map(point=>point.id==='c'?{...point,hidden:true}:point))).toEqual(first)
    expect(groupCoverPhoto(group,points.map(point=>point.id==='c'?{...point,images:[]}:point))).toEqual(first)
    expect(groupCoverPhoto({...group,cover:undefined},points)).toEqual(first)
    expect(groupCoverPhoto({...group,memberIds:['b'],cover:undefined},points)).toBeUndefined()
  })
  it('unions member types including hidden members while hiding an empty or wholly hidden group',()=>{
    const withHidden={...group,memberIds:['d','c','a']}
    expect(groupTypes(withHidden,points)).toEqual(['风景点','营地','补给点','休息点'])
    expect(groupHidden(withHidden,points)).toBe(false)
    expect(groupHidden({...withHidden,hidden:true},points)).toBe(true)
    expect(groupHidden({...group,memberIds:['d']},points)).toBe(true)
    expect(groupHidden({...group,memberIds:['missing']},points)).toBe(true)
    expect(groupHidden(group,points.map(point=>({...point,coordinates:[NaN,30]})))).toBe(true)
    expect(groupHidden({...group,memberIds:['b']},points)).toBe(false)
  })
  it('projects groups at the earliest member, retaining leaf numbers and separate group numbering',()=>{
    const other:PlacemarkGroup={id:secondId,name:'另一组',description:'',coordinates:[120,30],memberIds:['d']}
    const orphan={...other,id:'group-00000000-0000-0000-0000-000000000003',memberIds:['missing']}
    const before=structuredClone({points,group,other})
    expect(placemarkListItems(points,[orphan,other,group])).toEqual([
      {kind:'group',group,number:1,members:[points[0],points[2]]},
      {kind:'point',point:points[1],number:2},
      {kind:'group',group:other,number:2,members:[points[3]]},
    ])
    expect(placemarkListItems(points,[])).toEqual(points.map((point,index)=>({kind:'point',point,number:index+1})))
    expect({points,group,other}).toEqual(before)
  })
})

describe('placemark group validation',()=>{
  it('copies known fields, normalizes cover URLs, permits one member and preserves empty text',()=>{
    const original={...group,name:'',description:'',memberIds:['legacy-restored-id'],cover:{pointId:'legacy-restored-id',imageUrl:' https://example.com/a.jpg '},hidden:false}
    const expected={...original,cover:{pointId:'legacy-restored-id',imageUrl:'https://example.com/a.jpg'}}
    const [saved]=validatePlacemarkGroups([original])
    expect(saved).toEqual(expected)
    expect(saved).not.toBe(original)
    expect(saved.memberIds).not.toBe(original.memberIds)
    expect(saved.coordinates).not.toBe(original.coordinates)
    expect(saved.cover).not.toBe(original.cover)
    expect(original.cover.imageUrl).toBe(' https://example.com/a.jpg ')
    expect(validatePlacemarkGroups([])).toEqual([])
    expect(validatePlacemarkGroups([{...group,name:'名'.repeat(160),description:'\n'+'说'.repeat(9998)+'\n'}])[0].description).toHaveLength(10000)
  })
  it('accepts up to ten thousand unique recovered member IDs',()=>{
    const memberIds=Array.from({length:10000},(_,index)=>`recovered-${index}`)
    expect(validatePlacemarkGroups([{...group,memberIds,cover:undefined}])[0].memberIds).toEqual(memberIds)
    expect(()=>validatePlacemarkGroups([{...group,memberIds,cover:undefined},{...group,id:secondId,memberIds:['another'],cover:undefined}])).toThrow('10000')
  })
  it.each([
    {value:null}, {value:{}}, {value:new Array(1)}, {value:[[]]},
    {value:[{...group,id:'leaf-id'}]}, {value:[group,group]},
    {value:[{...group,name:null}]}, {value:[{...group,name:'名'.repeat(161)}]},
    {value:[{...group,description:42}]}, {value:[{...group,description:'说'.repeat(10001)}]},
    {value:[{...group,coordinates:[181,30]}]}, {value:[{...group,coordinates:[120,'30']}]}, {value:[{...group,coordinates:new Array(2)}]},
    {value:[{...group,memberIds:[]}]}, {value:[{...group,memberIds:['a','a']}]}, {value:[{...group,memberIds:new Array(1)}]},
    {value:[{...group,memberIds:[secondId]}]}, {value:[{...group,memberIds:['GROUP-00000000-0000-0000-0000-000000000002']}]},
    {value:[group,{...group,id:secondId}]}, {value:[{...group,memberIds:Array.from({length:10001},(_,index)=>`p${index}`)}]},
    {value:[{...group,cover:null}]}, {value:[{...group,cover:{pointId:'b',imageUrl:'https://example.com/a.jpg'}}]},
    {value:[{...group,cover:{pointId:'a',imageUrl:'javascript:alert(1)'}}]},
    {value:[{...group,cover:{pointId:'a',imageUrl:'https://u:p@example.com/a.jpg'}}]},
    {value:[{...group,hidden:'false'}]}, {value:[{...group,hidden:null}]},
    {value:Array.from({length:5001},()=>group)},
  ])('rejects invalid grouping $value',({value})=>expect(()=>validatePlacemarkGroups(value)).toThrow())
})

describe('placemark group merging',()=>{
  const thirdId='group-00000000-0000-0000-0000-000000000003'
  const other:PlacemarkGroup={id:secondId,name:'营地',description:'第二段',memberIds:['d','b'],coordinates:[121,31],hidden:true,cover:{pointId:'d',imageUrl:'https://example.com/d.jpg'}}

  it('merges two groups in route order, retaining first identity, name, cover and visibility',()=>{
    const first={...group,description:' 第一段\n ',hidden:false}
    expect(mergePlacemarkGroups([first,other],points)).toEqual({
      id:firstId,name:'山景',description:' 第一段\n \n\n第二段',memberIds:['a','b','c','d'],
      coordinates:[120.01,30],hidden:false,cover:group.cover,
    })
  })

  it('merges three groups and uses the middle known member in the current display order',()=>{
    const first={...group,name:'',description:'一',memberIds:['c'],cover:undefined,hidden:true}
    const second={...other,description:'二',memberIds:['b'],cover:undefined,hidden:false}
    const third={...other,id:thirdId,description:'三',memberIds:['a'],cover:undefined}
    const reordered=[points[2],points[0],points[1],points[3]]
    const merged=mergePlacemarkGroups([first,second,third],reordered)
    expect(merged).toEqual({
      id:firstId,name:'',description:'一\n\n二\n\n三',memberIds:['c','a','b'],
      coordinates:[120,30],hidden:true,cover:{pointId:'c',imageUrl:'https://example.com/shared.jpg'},
    })
  })

  it('omits empty descriptions without trimming raw non-empty descriptions',()=>{
    expect(mergePlacemarkGroups([{...group,description:''},{...other,description:'  '}],points).description).toBe('  ')
    expect(mergePlacemarkGroups([{...group,description:'说明'},{...other,description:''}],points).description).toBe('说明')
    expect(mergePlacemarkGroups([{...group,description:''},{...other,description:''}],points).description).toBe('')
  })

  it('rejects descriptions exceeding the limit, including separators, without truncation',()=>{
    const first={...group,description:'一'.repeat(5000)}
    expect(mergePlacemarkGroups([first,{...other,description:'二'.repeat(4998)}],points).description).toHaveLength(10000)
    expect(()=>mergePlacemarkGroups([first,{...other,description:'二'.repeat(4999)}],points)).toThrow('10000')
    expect(first.description).toHaveLength(5000)
  })

  it('retains unresolved members and a valid unresolved cover after known members',()=>{
    const first={...group,memberIds:['legacy-a','c','legacy-b'],cover:{pointId:'legacy-a',imageUrl:' https://example.com/legacy.jpg '}}
    const second={...other,memberIds:['legacy-b','b','legacy-c'],cover:undefined}
    expect(mergePlacemarkGroups([first,second],points)).toEqual({
      id:firstId,name:'山景',description:'保留说明\n\n第二段',memberIds:['b','c','legacy-a','legacy-b','legacy-c'],
      coordinates:points[2].coordinates,cover:{pointId:'legacy-a',imageUrl:'https://example.com/legacy.jpg'},
    })
  })

  it('uses first coordinates when every member is unresolved and leaves missing covers absent',()=>{
    const first={...group,memberIds:['legacy-a'],cover:undefined}
    const second={...other,memberIds:['legacy-b'],cover:undefined}
    const merged=mergePlacemarkGroups([first,second],points)
    expect(merged.memberIds).toEqual(['legacy-a','legacy-b'])
    expect(merged.coordinates).toEqual(first.coordinates)
    expect(merged).not.toHaveProperty('cover')
    expect(merged).not.toHaveProperty('hidden')
  })

  it('uses the first visible merged photo as cover when the first group has no cover',()=>{
    const merged=mergePlacemarkGroups([{...group,memberIds:['b'],cover:undefined},{...other,memberIds:['d','a']}],points)
    expect(merged.cover).toEqual({pointId:'a',imageUrl:'https://example.com/a.jpg'})
  })

  it('deduplicates members and repeated selected IDs without repeating descriptions',()=>{
    const first={...group,memberIds:['c','a','a','missing']}
    const second={...other,memberIds:['c','b','missing','other-missing'],cover:undefined}
    const merged=mergePlacemarkGroups([first,second,{...first,description:'重复选择'}],points)
    expect(merged.memberIds).toEqual(['a','b','c','missing','other-missing'])
    expect(merged.description).toBe('保留说明\n\n第二段')
    expect(()=>mergePlacemarkGroups([],points)).toThrow('至少两个不同分组')
    expect(()=>mergePlacemarkGroups([group],points)).toThrow('至少两个不同分组')
    expect(()=>mergePlacemarkGroups([group,group],points)).toThrow('至少两个不同分组')
  })

  it('rejects an unsafe or nonmember first cover using existing validation',()=>{
    expect(()=>mergePlacemarkGroups([{...group,cover:{pointId:'unknown',imageUrl:'https://example.com/a.jpg'}},other],points)).toThrow('须属于组成员')
    expect(()=>mergePlacemarkGroups([{...group,cover:{pointId:'a',imageUrl:'javascript:alert(1)'}},other],points)).toThrow('链接无效')
  })

  it('does not mutate child data, groups, coordinates, images or cover objects',()=>{
    const inputs=structuredClone({groups:[group,other],points})
    const before=structuredClone(inputs)
    const merged=mergePlacemarkGroups(inputs.groups,inputs.points)
    expect(inputs).toEqual(before)
    expect(merged.memberIds).not.toBe(inputs.groups[0].memberIds)
    expect(merged.coordinates).not.toBe(inputs.points[2].coordinates)
    expect(merged.cover).not.toBe(inputs.groups[0].cover)
    merged.memberIds.push('new-member')
    merged.coordinates[0]=0
    if (merged.cover) merged.cover.imageUrl='https://example.com/changed.jpg'
    expect(inputs).toEqual(before)
  })
})