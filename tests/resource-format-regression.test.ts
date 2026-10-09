import {afterEach,describe,expect,it} from 'vitest'
import {mkdtempSync,readFileSync,readdirSync,rmSync} from 'node:fs'
import {basename,dirname,join,resolve} from 'node:path'
import {tmpdir} from 'node:os'
import {Readable} from 'node:stream'
import type {IncomingMessage} from 'node:http'
import {trackDir,writeTrack} from '../src/artifacts.ts'
import {readResources,resourceFile,uploadResource} from '../src/resource-store.ts'
import type {TrackInput} from '../src/protocol.ts'
// Tiny actual files generated with FFmpeg 8.1.1 (one VP9 Matroska frame / 50 ms ADTS AAC).
// Embedded fixtures keep the regression independent of a terminal media installation.
const AAC=Buffer.from('//FsQC5f/N4CAExhdmM2Mi4yOC4xMDEAAiRnUSGWKisZFG59qXlVdazM8fEvVVeWmRESw/Oew7d6b7//b37Wfz32HOvRdK9f4dDktQ6hyGzb7yPqZQUr0BL8L8JT0DwkX4b5MqJgilIx4SnoLyRL8L4UnoHikY+GMTKiQEvydHJqtB4uhSya/f7826zLLQxrHR2Ntxar0GJ0vuSclwXEudK+3pk8O/tMN5svO69nobleKlaGUbTwNXMsnxNolzGnSw0pNCDPtXgbWZVUkFVCjL+lu3A0INKl17Hmlp0tJPXskx038KK9ldFTStJOU7tKelHnKgWlOqd53olOVnnKcWlOpHnKiVpWGfh5SEoPXoEEfD4kNhRj0RCUfiQYRj5SBnS9eh0iMfiQMox8rEseJBhGPlIGUeLDCMfiwZRxqYRx4sMI45WAOONhhHHiwZRxsMAfn4sbD0PzzPSAfQ42OkA/PxY0H0ONjpAPz42NpRxmeP/xbEApf/wBADOsjIothojFJhu/60NbzUVvfUkyRNxERAZ6/1EgA/FQ/4HOoMBByTcX94kAHNV/yj6z67mmAfXv+X7a8s84YSDTjixV4SC2OLFXhILY4zBXhhJT1+bwSvDCQ8cZkfDAyAybNihZGdagMp6eVO5HE2Fw9Z1io4ey7TlMLRWbKrEPwPqvwN54d/my//p8VbltW135Xkeq5S+prNlViLebLOqXUlPRzljIxqkBlPNihWrVSAabYsWGEgtjjMVeGAtjjMleGDnTjMj4YOdOMyPXg4NjMhV4OLUzG94cmZ33m+G8+h/4T7l8Nu+5/g3vDkzO+5/g2fQ/8J9y+G8+g/wb3hyZnfc/wbPC/mT7l8N59D/wPcsmZ33P8Gzwv5k+4+G8+h/4T7lkbd9z/BveF/Mn3HwbPof+E+5ZG3dB/ge8OTMn34A=','base64')
const MKV=Buffer.from('GkXfo6NChoEBQveBAULygQRC84EIQoKIbWF0cm9za2FCh4EEQoWBAhhTgGcBAAAAAAACKxFNm3TAv4TvL/eMTbuLU6uEFUmpZlOsgaFNu4tTq4QWVK5rU6yB8U27jFOrhBJUw2dTrIIBU027jFOrhBxTu2tTrIICD+wBAAAAAAAAUwAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAFUmpZsu/hKiSRqgq17GDD0JATYCNTGF2ZjYyLjEyLjEwMVdBjUxhdmY2Mi4xMi4xMDFzpJCJeOgpBYcM2YEANmzPzpA1RImIQI9AAAAAAAAWVK5r3b+EVWBZu64BAAAAAAAATteBAXPFiJLEawEmkgtQnIEAIrWcg3VuZIiBAIaFVl9WUDmDgQEj44OEO5rKAOCQsIEQuoEQmoECVbCEVbmBAVXugQDsAQAAAAAAAAIAABJUw2dAhr+EetSAt3NzoGPAgGfImkWjh0VOQ09ERVJEh41MYXZmNjIuMTIuMTAxc3PaY8CLY8WIksRrASaSC1BnyKVFo4dFTkNPREVSRIeYTGF2YzYyLjI4LjEwMSBsaWJ2cHgtdnA5Z8ihRaOIRFVSQVRJT05Eh5MwMDowMDowMS4wMDAwMDAwMDAAH0O2dau/hMzgq37ngQCjoIEAAICCSYNCAADwAPYAOCQcGEoAADBgAAAQv//9SIwAHFO7a5e/hDwCp0a7j7OBALeK94EB8YIB3/CBCQ==','base64')
const roots:string[]=[]
afterEach(()=>{for(const root of roots.splice(0)){if(dirname(resolve(root))!==resolve(tmpdir())||!basename(root).startsWith('cqai-resource-format-'))throw new Error('Unexpected media fixture');rmSync(root,{recursive:true,force:true})}})
const input:TrackInput={filename:'original.gpx',source:'<gpx>original</gpx>',points:[[120,30,100,null],[120.01,30,110,null]],metrics:{distance:1000,elevationGain:10,elevationLoss:0,duration:0,elevationMax:110,elevationMin:100,bbox:[120,30,120.01,30]}}
function setup(){const root=mkdtempSync(join(tmpdir(),'cqai-resource-format-'));roots.push(root);const env={...process.env,DSH_HOME:root};return {env,id:writeTrack(input,env).id}}
function req(bytes:Buffer,mime:string){const stream=Readable.from([bytes.subarray(0,7),bytes.subarray(7,36),bytes.subarray(36)]) as unknown as IncomingMessage;stream.headers={'content-type':mime};return stream}
describe('real AAC and Matroska format identity',()=>{
  it('stores real ADTS as AAC and real Matroska as MKV, retaining original bytes across reopen',async()=>{
    const {env,id}=setup()
    const audio=await uploadResource(id,req(AAC,'audio/aac'),{name:'环境声.aac',kind:'audio'},env)
    const video=await uploadResource(id,req(MKV,'video/x-matroska'),{name:'山谷镜头.mkv',kind:'video'},env)
    expect(audio).toMatchObject({kind:'audio',mime:'audio/aac',bytes:AAC.length});expect(video).toMatchObject({kind:'video',mime:'video/x-matroska',bytes:MKV.length})
    expect(readdirSync(join(trackDir(id,env),'media')).sort().map(name=>name.split('.').at(-1))).toEqual(['mkv','aac'].sort())
    expect(readFileSync((await resourceFile(id,audio.id,env)).path!)).toEqual(AAC);expect(readFileSync((await resourceFile(id,video.id,env)).path!)).toEqual(MKV)
    expect(readResources(id,env).assets.map(asset=>asset.mime)).toEqual(['audio/aac','video/x-matroska'])
  })
  it('rejects relabeling ADTS as MP3 or Matroska as WebM instead of silently treating containers as equivalent',async()=>{
    const {env,id}=setup()
    await expect(uploadResource(id,req(AAC,'audio/mpeg'),{name:'wrong.mp3',kind:'audio'},env)).rejects.toThrow('不匹配')
    await expect(uploadResource(id,req(MKV,'video/webm'),{name:'wrong.webm',kind:'video'},env)).rejects.toThrow('不匹配')
    expect(readResources(id,env).assets).toEqual([]);expect(readdirSync(join(trackDir(id,env),'media'))).toEqual([])
  })
})
