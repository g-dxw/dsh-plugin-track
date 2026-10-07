import {describe, expect, it} from 'vitest'
import {editedMetrics} from '../src/track/edit.ts'
import {extractVideoMaterials, geoProjectFromVideoMaterials} from '../src/track/video-materials.ts'
import {fitVideoMaterialImages} from '../src/track/video-materials-layout.ts'
import {geoEvaluate} from '../src/track/geomotion.ts'
import type {TrackRecord} from '../src/protocol.ts'
const coordinates: TrackRecord['coordinates'] = [[114.1,27.5,500,null],[114.11,27.51,1000,null],[114.12,27.52,1500,null]]
const track: TrackRecord = {id:'layout-track',name:'真实路线',format:'gpx',filename:'route.gpx',createdAt:'2026-10-04',bytes:3,points:3,coordinates,metrics:editedMetrics(coordinates)}
const png='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j0p8AAAAASUVORK5CYII='
function setup(){
 const doc=extractVideoMaterials(track,[{id:'photo-point',name:'选图地点',description:'真实地点介绍',coordinates:[114.11,27.51],images:[]}])
 doc.markers[0].photo={dataUrl:png};doc.segments[0].description='第一段介绍'
 const project=geoProjectFromVideoMaterials(track,doc),scene=geoEvaluate(project,project.duration/2)
 return {doc,project,scene}
}
describe('prepared video material layout',()=>{
 it('fits a tall photo and its caption above the credits without changing the scene or saved layer',()=>{
  const {scene,project}=setup(),before=JSON.stringify({scene,project}),source=scene.images[0].style.src
  const fitted=fitVideoMaterialImages(scene,1920,1080,new Set([source]),()=>({width:576,height:1024}))
  const image=fitted.images[0],bottom=image.style.y*1080+image.style.width*1920*image.zoom/(576/1024)+30
  expect(bottom).toBeLessThanOrEqual(1080*.91+.001);expect(image.style.width).toBeLessThan(scene.images[0].style.width)
  expect(JSON.stringify({scene,project})).toBe(before);expect(image.style.caption).toBe('选图地点')
 })
 it('accounts for zoom, slide offset and the portrait output size',()=>{
  const {scene}=setup(),image=scene.images[0];image.zoom=1.1;image.offsetY=40
  const fitted=fitVideoMaterialImages(scene,1080,1920,new Set([image.style.src]),()=>({width:200,height:3000})),result=fitted.images[0],scale=1920/1080
  const bottom=result.style.y*1920+40*scale+result.style.width*1080*result.zoom/(200/3000)+30*scale
  expect(bottom).toBeLessThanOrEqual(1920*.91+.001)
 })
 it('keeps landscape photos and authored imported images unchanged and waits for real dimensions',()=>{
  const {scene}=setup(),source=scene.images[0].style.src
  expect(fitVideoMaterialImages(scene,1920,1080,new Set([source]),()=>({width:1600,height:900}))).toBe(scene)
  expect(fitVideoMaterialImages(scene,1920,1080,new Set(),()=>({width:100,height:3000}))).toBe(scene)
  expect(fitVideoMaterialImages(scene,1920,1080,new Set([source]),()=>null)).toBe(scene)
 })
 it('places section and point introductions below the selected multiline route facts',()=>{
  const {doc}=setup();doc.information.forEach(i=>{i.selected=true});doc.information[0].text='路线标题\n补充标题'
  const project=geoProjectFromVideoMaterials(track,doc),nodes=Object.values(project.nodes),section=nodes.find(n=>n.type==='text'&&n.id.startsWith('material-section'))!,point=nodes.find(n=>n.type==='text'&&n.id.startsWith('material-point'))!,info=nodes.find(n=>n.type==='text'&&n.id==='material-information')!
  if(section.type!=='text'||point.type!=='text'||info.type!=='text')throw new Error('Expected text layers')
  expect(section.y).toBeGreaterThan(info.y+(info.text.split('\n').length*24*1.22+12)/1080)
  expect(point.y).toBeGreaterThan(section.y+(section.text.split('\n').length*24*1.22+12)/1080)
 })
})