import { describe, expect, it, vi } from 'vitest'
import { createPlacemarkHistory, samePlacemarkHistoryValue, type PlacemarkHistoryChange } from '../src/client/placemark-history.ts'

function fixture() {
  const history = createPlacemarkHistory('track')
  history.reconcile('order', null)
  history.reconcile('edits', [])
  history.reconcile('groups', [])
  return history
}

describe('point editing session history', () => {
  it('keeps immutable snapshots separate from callers and notifies subscribers', () => {
    const history = fixture(), listener = vi.fn(), unsubscribe = history.subscribe(listener)
    const change: PlacemarkHistoryChange = {kind:'edits',before:[],after:[{id:'a',coordinates:[120,30],images:['https://example.com/a.jpg'],type:['风景点','营地'],hidden:true}]}
    const initial = history.getSnapshot()
    history.record(change)
    expect(history.getSnapshot()).not.toBe(initial)
    expect(history.getSnapshot()).toMatchObject({canUndo:true,canRedo:false})
    expect(listener).toHaveBeenCalledOnce()
    change.after[0].images!.push('https://example.com/b.jpg')
    change.after[0].type = []
    change.after[0].coordinates![0] = 121
    const saved=history.peek('undo')!
    expect(saved.after).toEqual([{id:'a',coordinates:[120,30],images:['https://example.com/a.jpg'],type:['风景点','营地'],hidden:true}])
    expect(Object.isFrozen(saved)).toBe(true)
    expect(Object.isFrozen(saved.after)).toBe(true)
    if (saved.kind !== 'edits') throw new Error('Expected edit history')
    expect(Object.isFrozen(saved.after[0])).toBe(true)
    expect(history.complete('undo',saved,saved.before)).toBe(true)
    expect(history.getSnapshot()).toMatchObject({canUndo:false,canRedo:true})
    unsubscribe()
    history.complete('redo',saved,saved.after)
    expect(listener).toHaveBeenCalledTimes(2)
  })

  it('retains redo after a no-op and clears it only for a new change', () => {
    const history=fixture()
    history.record({kind:'order',before:null,after:['b','a']})
    const previous=history.peek('undo')!
    expect(history.complete('undo',previous,null)).toBe(true)
    const snapshot=history.getSnapshot()
    history.record({kind:'edits',before:[],after:[]})
    expect(history.getSnapshot()).toBe(snapshot)
    expect(history.peek('redo')).toBe(previous)
    history.record({kind:'edits',before:[],after:[{id:'a',name:'新名称'}]})
    expect(history.peek('redo')).toBeUndefined()
    expect(history.peek('undo')?.kind).toBe('edits')
  })

  it('keeps loaded baselines without adding steps and invalidates either channel on an external change', () => {
    const history=fixture()
    history.record({kind:'edits',before:[],after:[{id:'a',name:'保存名称'},{id:'b',hidden:true}]})
    const snapshot=history.getSnapshot()
    history.reconcile('order',null)
    history.reconcile('edits',[{id:'b',hidden:true},{id:'a',name:'保存名称'}])
    expect(history.getSnapshot()).toBe(snapshot)
    history.reconcile('order',['a','b'])
    expect(history.getSnapshot()).toMatchObject({canUndo:false,canRedo:false})
    history.record({kind:'order',before:['a','b'],after:['b','a']})
    history.reconcile('edits',[{id:'a',name:'外部更新'}])
    expect(history.getSnapshot()).toMatchObject({canUndo:false,canRedo:false})
  })

  it('invalidates history instead of accepting an unexpected undo response', () => {
    const history=fixture()
    history.record({kind:'order',before:null,after:['b','a']})
    expect(history.complete('undo',history.peek('undo')!,['a','b'])).toBe(false)
    expect(history.getSnapshot()).toMatchObject({canUndo:false,canRedo:false})
  })

  it('records immutable group references and detects external group changes without touching leaf history snapshots',()=>{
    const history=fixture()
    const group={id:'group-00000000-0000-0000-0000-000000000001',name:'组名称',description:'',memberIds:['a','b'],coordinates:[120,30] as [number,number],cover:{pointId:'a',imageUrl:'https://example.com/a.jpg'}}
    history.record({kind:'groups',before:[],after:[group]})
    const change=history.peek('undo')!
    const snapshot=history.getSnapshot()
    history.reconcile('groups',[{...group,memberIds:['b','a']}])
    expect(history.getSnapshot()).toBe(snapshot)
    group.memberIds.push('c');group.coordinates[0]=121;group.cover.imageUrl='https://example.com/b.jpg'
    expect(change.after).toEqual([{...group,memberIds:['a','b'],coordinates:[120,30],cover:{pointId:'a',imageUrl:'https://example.com/a.jpg'}}])
    expect(history.complete('undo',change,[])).toBe(true)
    expect(history.complete('redo',change,change.after)).toBe(true)
    history.reconcile('groups',[{...group,memberIds:['a','b'],coordinates:[120.01,30],cover:{pointId:'a',imageUrl:'https://example.com/a.jpg'}}])
    expect(history.getSnapshot()).toMatchObject({canUndo:false,canRedo:false})
  })

  it('retains the latest fifty steps and moves them without adding new steps', () => {
    const history=fixture()
    history.reconcile('order',['p0'])
    for(let index=0;index<60;index++)history.record({kind:'order',before:[`p${index}`],after:[`p${index+1}`]})
    let undone=0
    while(history.peek('undo')) {
      const change=history.peek('undo')!
      expect(history.complete('undo',change,change.before)).toBe(true)
      undone++
    }
    expect(undone).toBe(50)
    expect(history.peek('redo')?.before).toEqual(['p10'])
    let redone=0
    while(history.peek('redo')) {
      const change=history.peek('redo')!
      expect(history.complete('redo',change,change.after)).toBe(true)
      redone++
    }
    expect(redone).toBe(50)
    expect(history.peek('undo')?.after).toEqual(['p60'])
  })

  it('does not retain snapshots beyond its memory allowance', () => {
    const history=fixture()
    const oversized=Array.from({length:210},(_,index)=>({id:`point-${index}`,description:'说'.repeat(10000)}))
    history.record({kind:'edits',before:[],after:oversized})
    expect(history.getSnapshot().canUndo).toBe(false)
    history.record({kind:'order',before:null,after:['a']})
    expect(history.getSnapshot().canUndo).toBe(true)
    const tooLarge=Array.from({length:500},(_,index)=>({id:`point-${index}`,description:'说'.repeat(10000)}))
    history.reconcile('edits',tooLarge)
    expect(history.getSnapshot()).toMatchObject({canUndo:false,canRedo:false})
  })

  it('compares edit values by normalized fields and stable IDs rather than object key order', () => {
    expect(samePlacemarkHistoryValue('edits',[{id:'a',name:'名称',type:[' 风景点 ','风景点']}],[{type:['风景点'],name:'名称',id:'a'}])).toBe(true)
    expect(samePlacemarkHistoryValue('order',['a','b'],['b','a'])).toBe(false)
  })
})

// Unified state excludes saved revisions and derived immutable route baselines.
describe('complete point state history',()=>{
  const baseline=()=>({added:[],deletedIds:[],edits:[],order:null,groups:[],routeContext:null})
  it('captures immutable lifecycle snapshots without retaining response revision',()=>{
    const history=createPlacemarkHistory('track'),before=baseline(),after={...baseline(),deletedIds:['a'],order:['b'],edits:[{id:'b',name:'保留'}]}
    history.reconcile('state',before);history.record({kind:'state',before,after})
    after.deletedIds.push('b');after.edits[0].name='后来更改'
    const saved=history.peek('undo')!;if(saved.kind!=='state')throw new Error('Expected full state')
    expect(saved.after.deletedIds).toEqual(['a']);expect(saved.after.edits).toEqual([{id:'b',name:'保留'}]);expect(Object.isFrozen(saved.after)).toBe(true);expect(Object.isFrozen(saved.after.deletedIds)).toBe(true)
    expect(history.complete('undo',saved,saved.before)).toBe(true);expect(history.complete('redo',saved,saved.after)).toBe(true)
  })
  it('ignores revisions and restored route references in comparisons and retries',()=>{
    const history=createPlacemarkHistory('track'),before=baseline(),after={...baseline(),edits:[{id:'a',name:'名称'}]}
    history.reconcile('state',before);history.record({kind:'state',before,after});const change=history.peek('undo')!,snapshot=history.getSnapshot()
    const context={segmentStarts:[0],references:[{id:'a',name:'原点',description:'',images:[],coordinates:[120,30] as [number,number],time:100}]}
    history.reconcile('state',{...after,routeContext:context});expect(history.getSnapshot()).toBe(snapshot);expect(history.peek('undo')).toBe(change)
    expect(samePlacemarkHistoryValue('state',{...after,version:1,revision:10} as never,{...after,version:1,revision:11,routeContext:context} as never)).toBe(true)
  })
  it('keeps point source order significant when untimed added points change order',()=>{
    const context={segmentStarts:[0],references:[]},base={name:'',description:'',coordinates:[120,30] as [number,number],images:[],elevation:null,time:null,timeSource:'unknown' as const,routePosition:{startIndex:0,endIndex:0,fraction:0}}
    const a={...base,id:'local-00000000-0000-0000-0000-000000000001'},b={...base,id:'local-00000000-0000-0000-0000-000000000002'}
    expect(samePlacemarkHistoryValue('state',{...baseline(),added:[a,b],routeContext:context},{...baseline(),added:[b,a],routeContext:context})).toBe(false)
  })
  it('normalizes edit and deletion set order without invalidating history',()=>{
    const left={...baseline(),deletedIds:['c','d'],edits:[{id:'a',name:'名称'},{id:'b',hidden:true}]},right={...baseline(),deletedIds:['d','c'],edits:[{id:'b',hidden:true},{name:'名称',id:'a'}]}
    expect(samePlacemarkHistoryValue('state',left,right)).toBe(true)
  })
  it('invalidates unified history after external relationships changed',()=>{
    const history=createPlacemarkHistory('track'),before=baseline(),after={...baseline(),deletedIds:['a']}
    history.reconcile('state',before);history.record({kind:'state',before,after});history.reconcile('state',{...after,order:['b']});expect(history.getSnapshot()).toMatchObject({canUndo:false,canRedo:false})
  })
  it('retains redo after a normalized full state no-op and rejects mismatched completion',()=>{
    const history=createPlacemarkHistory('track'),before=baseline(),after={...baseline(),deletedIds:['a']}
    history.reconcile('state',before);history.record({kind:'state',before,after});const change=history.peek('undo')!;expect(history.complete('undo',change,before)).toBe(true)
    history.record({kind:'state',before,after:{...before,routeContext:{segmentStarts:[0],references:[]}}});expect(history.peek('redo')).toBe(change)
    expect(history.complete('redo',change,{...after,deletedIds:['b']})).toBe(false);expect(history.getSnapshot()).toMatchObject({canUndo:false,canRedo:false})
  })
})
