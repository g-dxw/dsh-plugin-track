import {afterEach, describe, expect, it} from 'vitest'
import {createServer, type IncomingMessage, type Server, type ServerResponse} from 'node:http'
import {copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, unlinkSync, writeFileSync} from 'node:fs'
import {basename, dirname, join, resolve} from 'node:path'
import {tmpdir} from 'node:os'
import {Readable} from 'node:stream'
import sharp from 'sharp'
import {writeTrack, trackDir} from '../src/artifacts.ts'
import {uploadResource, updateResource} from '../src/resource-store.ts'
import {ensureTrackAgentWorkspace} from '../src/track-agent-store.ts'
import {AgentImageReferenceError, prepareAgentImageReference, readAgentImageReference, validateAgentImageReferenceInput} from '../src/agent-image-references.ts'
import {handleAgentImageReferenceRoute} from '../src/agent-image-reference-routes.ts'
import {AGENT_IMAGE_REFERENCE_API, type AgentImageReference} from '../src/track/image-agent-references.ts'
import {permitted} from '../src/index.ts'
import type {TrackInput} from '../src/protocol.ts'

const roots: string[] = [], servers: Server[] = []
afterEach(async () => {
  for (const server of servers.splice(0)) {server.closeAllConnections(); await new Promise<void>(done => server.close(() => done()))}
  for (const root of roots.splice(0)) {
    if (dirname(resolve(root)) !== resolve(tmpdir()) || !basename(root).startsWith('cqai-agent-image-')) throw new Error('Unexpected image reference fixture')
    rmSync(root, {recursive: true, force: true})
  }
})
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64')
const input: TrackInput = {filename: 'route.gpx', source: '<gpx>source</gpx>', name: '真实山路', points: [[120,30,100,null],[120.01,30,110,null]], metrics: {distance:1000,elevationGain:10,elevationLoss:0,duration:0,elevationMax:110,elevationMin:100,bbox:[120,30,120.01,30]}}
function fixture() {const root = mkdtempSync(join(tmpdir(), 'cqai-agent-image-')); roots.push(root); const env = {...process.env, DSH_HOME: root}, track = writeTrack(input, env); return {root, env, id: track.id}}
function request(bytes: Buffer, mime: string): IncomingMessage {const stream = Readable.from([bytes]) as unknown as IncomingMessage; stream.headers = {'content-type': mime}; return stream}
async function asset(env: NodeJS.ProcessEnv, id: string, bytes = PNG) {return uploadResource(id, request(bytes,'image/png'), {kind:'image',name:'山脊原照'}, env)}
async function server(handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>): Promise<string> {
  const instance = createServer((req,res) => {void Promise.resolve(handler(req,res)).catch(error => {res.writeHead(500);res.end(String(error))})}); servers.push(instance)
  await new Promise<void>(done => instance.listen(0,'127.0.0.1',done))
  return 'http://127.0.0.1:' + (instance.address() as {port:number}).port
}

describe('native Agent image snapshots', () => {
  it('copies real image bytes into its route project with stable identity and leaves originals/user instructions intact', async () => {
    const {env,id} = fixture(), photo = await asset(env,id), originalRoute = readFileSync(join(trackDir(id,env),'track.json')), workspace = ensureTrackAgentWorkspace(env,id)
    writeFileSync(join(workspace.path,'AGENTS.md'),'用户自己的 Agent 要求')
    const value = {kind:'resource',trackId:id,assetId:photo.id}
    const first = await prepareAgentImageReference(value,{env}), second = await prepareAgentImageReference(value,{env})
    expect(second.referenceId).toBe(first.referenceId); expect(second.filePath).toBe(first.filePath)
    expect(first).toMatchObject({name:'山脊原照.png',mime:'image/png',width:1,height:1,source:value})
    expect(dirname(first.filePath)).toBe(join(workspace.path,'image-references'))
    expect(first.clipboardText).toContain('read_image(' + JSON.stringify({file_path:first.filePath}) + ')')
    expect(readAgentImageReference(first.referenceId,env,id).reference).toEqual(first)
    expect((await sharp(readFileSync(first.filePath)).metadata()).format).toBe('png')
    expect(readdirSync(dirname(first.filePath))).toHaveLength(2)
    expect(readFileSync(join(workspace.path,'AGENTS.md'),'utf8')).toBe('用户自己的 Agent 要求')
    expect(readFileSync(join(trackDir(id,env),'track.json'))).toEqual(originalRoute)
    await updateResource(id,photo.id,{name:'改名后的山脊'},env)
    expect((await prepareAgentImageReference(value,{env})).referenceId).toBe(first.referenceId)
  })
  it('checks route ownership and media kind before preparing a workspace', async () => {
    const {env,id,root} = fixture(), photo = await asset(env,id), other = writeTrack({...input,source:'<gpx>other</gpx>'},env).id
    await expect(prepareAgentImageReference({kind:'resource',trackId:other,assetId:photo.id},{env})).rejects.toMatchObject({status:404})
    const wav = Buffer.alloc(84); wav.write('RIFF');wav.writeUInt32LE(76,4);wav.write('WAVE',8);wav.write('fmt ',12);wav.writeUInt32LE(16,16);wav.writeUInt16LE(1,20);wav.writeUInt16LE(1,22);wav.writeUInt32LE(8000,24);wav.writeUInt32LE(16000,28);wav.writeUInt16LE(2,32);wav.writeUInt16LE(16,34);wav.write('data',36);wav.writeUInt32LE(40,40)
    const audio = await uploadResource(id,request(wav,'audio/wav'),{kind:'audio',name:'环境声'},env)
    await expect(prepareAgentImageReference({kind:'resource',trackId:id,assetId:audio.id},{env})).rejects.toThrow('仅支持引用图片')
    expect(existsSync(join(root,'track-agent'))).toBe(false)
    for (const value of [{kind:'resource',trackId:'../bad',assetId:photo.id},{kind:'featured',key:'../bad'},{kind:'featured',key:'travel-natural-photo',trackId:'../bad'},{kind:'template',sourceId:'canghe',caseId:'538',trackId:42},{kind:'template',sourceId:'../../outside',caseId:'538'},{kind:'resource',trackId:id,assetId:photo.id,url:'http://evil.example'}]) expect(() => validateAgentImageReferenceInput(value)).toThrow(AgentImageReferenceError)
  })
  it('fully decodes images and bounds the prepared copy without modifying the original dimensions', async () => {
    const {env,id} = fixture(), original = await sharp({create:{width:8000,height:100,channels:4,background:{r:10,g:40,b:70,alpha:.5}}}).png().toBuffer(), photo = await asset(env,id,original)
    const ref = await prepareAgentImageReference({kind:'resource',trackId:id,assetId:photo.id},{env})
    expect(ref.width).toBe(2048); expect(ref.height).toBe(26); expect(ref.bytes).toBeLessThanOrEqual(8*1024*1024)
    expect((await sharp(readFileSync(ref.filePath)).metadata()).hasAlpha).toBe(true)
    expect((await sharp(original).metadata()).width).toBe(8000)
    const origin = await server((_req,res) => {res.writeHead(200,{'content-type':'image/png'});res.end('<html>not image</html>')})
    await expect(prepareAgentImageReference({kind:'featured',key:'travel-natural-photo'},{env,hostOrigin:()=>origin})).rejects.toMatchObject({status:409})
  })
  it('serves only owned snapshots and refuses tampered manifests, files and symlink directories', async () => {
    const {env,id} = fixture(), photo = await asset(env,id), ref = await prepareAgentImageReference({kind:'resource',trackId:id,assetId:photo.id},{env})
    expect(() => readAgentImageReference('../outside',env,id)).toThrow('编号无效')
    const manifestPath = join(dirname(ref.filePath),ref.referenceId+'.json'), originalManifest = readFileSync(manifestPath,'utf8'), manifest = JSON.parse(originalManifest)
    manifest.filename = '../../outside.png'; writeFileSync(manifestPath,JSON.stringify(manifest)); expect(() => readAgentImageReference(ref.referenceId,env,id)).toThrow('记录无效')
    writeFileSync(manifestPath,originalManifest); const originalBytes=readFileSync(ref.filePath);writeFileSync(ref.filePath,Buffer.alloc(originalBytes.length));expect(()=>readAgentImageReference(ref.referenceId,env,id)).toThrow('内容已改变')
    writeFileSync(ref.filePath,originalBytes);expect(readAgentImageReference(ref.referenceId,env,id).body).toEqual(originalBytes)
    const second = fixture(), outside = mkdtempSync(join(tmpdir(),'cqai-agent-image-'));roots.push(outside);const directory=join(ensureTrackAgentWorkspace(second.env,second.id).path,'image-references')
    symlinkSync(outside,directory,'junction')
    try {const image=await asset(second.env,second.id);await expect(prepareAgentImageReference({kind:'resource',trackId:second.id,assetId:image.id},{env:second.env})).rejects.toThrow('目录无效');expect(readdirSync(outside)).toEqual([])}
    finally {unlinkSync(directory)}
  })
})

describe('official template reference resolution', () => {
  it('fetches packaged featured images directly and validates dynamic template images against the actual host list', async () => {
    const {env} = fixture(), calls: {path:string;body:string}[]=[]
    const origin = await server(async(req,res) => {
      let body='';for await(const part of req)body+=String(part);calls.push({path:req.url!,body})
      if(req.url==='/api/dsh-imagegen/templates/list'){res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({ok:true,sourceId:'canghe',cases:[{id:538,title:'真实原案例',image:'case538.jpg'}]}))}
      else if(req.url==='/api/dsh-imagegen/templates/image/canghe/case538.jpg'){res.writeHead(200,{'content-type':'image/jpeg'});res.end(PNG)}
      else {res.writeHead(404);res.end()}
    })
    const options={env,hostOrigin:()=>origin}
    const featured=await prepareAgentImageReference({kind:'featured',key:'travel-natural-photo'},options)
    expect(featured.name).toContain('原案例效果参考');expect(calls).toEqual([{path:'/api/dsh-imagegen/templates/image/canghe/case538.jpg',body:''}])
    calls.length=0
    const template=await prepareAgentImageReference({kind:'template',sourceId:'canghe',caseId:'538'},options)
    expect(template.source).toEqual({kind:'template',sourceId:'canghe',caseId:'538',image:'case538.jpg'})
    expect(calls).toEqual([{path:'/api/dsh-imagegen/templates/list',body:JSON.stringify({source:'canghe'})},{path:'/api/dsh-imagegen/templates/image/canghe/case538.jpg',body:''}])
    calls.length=0
    await expect(prepareAgentImageReference({kind:'template',sourceId:'canghe',caseId:'538',image:'https://evil.example/image.png'},options)).rejects.toThrow('不匹配')
    expect(calls).toHaveLength(1)
    await expect(prepareAgentImageReference({kind:'template',sourceId:'canghe',caseId:'999999'},options)).rejects.toMatchObject({status:404})
    await expect(prepareAgentImageReference({kind:'featured',key:'missing-key'},options)).rejects.toMatchObject({status:404})
  })
  it('isolates the same featured or source template in each route project and refuses cross-scope reads', async () => {
    const {env,id}=fixture(), other=writeTrack({...input,source:'<gpx>another route</gpx>'},env).id
    const origin=await server((req,res)=>{
      if(req.url==='/api/dsh-imagegen/templates/list'){res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({ok:true,sourceId:'canghe',cases:[{id:538,title:'真实原案例',image:'case538.jpg'}]}))}
      else {res.writeHead(200,{'content-type':'image/png'});res.end(PNG)}
    })
    const options={env,hostOrigin:()=>origin}
    for(const selected of [{kind:'featured',key:'travel-natural-photo'},{kind:'template',sourceId:'canghe',caseId:'538'}]){
      const first=await prepareAgentImageReference({...selected,trackId:id},options), second=await prepareAgentImageReference({...selected,trackId:other},options)
      expect(first.referenceId).not.toBe(second.referenceId);expect(first.filePath).not.toBe(second.filePath)
      expect(dirname(first.filePath)).toBe(join(ensureTrackAgentWorkspace(env,id).path,'image-references'))
      expect(dirname(second.filePath)).toBe(join(ensureTrackAgentWorkspace(env,other).path,'image-references'))
      expect(first.source.trackId).toBe(id);expect(second.source.trackId).toBe(other)
      expect(new URL(first.fileUrl,'http://localhost').searchParams.get('trackId')).toBe(id)
      expect(readAgentImageReference(first.referenceId,env,id).reference).toEqual(first)
      expect(()=>readAgentImageReference(first.referenceId,env,other)).toThrow('不存在')
      expect(()=>readAgentImageReference(first.referenceId,env)).toThrow('不存在')
      // A copied manifest remains owned by its original route and cannot cross-admit an image.
      const target=join(ensureTrackAgentWorkspace(env,other).path,'image-references');mkdirSync(target,{recursive:true})
      copyFileSync(first.filePath,join(target,basename(first.filePath)))
      copyFileSync(join(dirname(first.filePath),first.referenceId+'.json'),join(target,first.referenceId+'.json'))
      expect(()=>readAgentImageReference(first.referenceId,env,other)).toThrow('不属于当前轨迹')
    }
    const global=await prepareAgentImageReference({kind:'featured',key:'travel-natural-photo'},options)
    const nullGlobal=await prepareAgentImageReference({kind:'featured',key:'travel-natural-photo',trackId:null},options)
    expect(nullGlobal).toEqual(global);expect(global.fileUrl).not.toContain('trackId=')
    expect(readAgentImageReference(global.referenceId,env,null).reference).toEqual(global)
    await expect(prepareAgentImageReference({kind:'featured',key:'travel-natural-photo',trackId:'missing-track'},options)).rejects.toMatchObject({status:404})
  })
  it('carries only the admitted Desktop capability through template GET and POST without disclosing it', async () => {
    const {env,id}=fixture(), token=Buffer.alloc(32,7).toString('base64url'), calls: {path:string;headers:IncomingMessage['headers']}[]=[]
    const origin=await server(async(req,res)=>{
      if(req.headers['x-dsh-desktop-renderer']!==token){res.writeHead(403);res.end('forbidden');return}
      if(req.url?.startsWith('/api/cqai-track/')){
        if(!permitted(req)){res.writeHead(403);res.end();return}
        await handleAgentImageReferenceRoute(req,res,new URL(req.url,'http://localhost'),{env,hostOrigin:()=>origin});return
      }
      calls.push({path:req.url!,headers:req.headers})
      if(req.url==='/api/dsh-imagegen/templates/list'){res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({ok:true,sourceId:'canghe',cases:[{id:538,title:'真实原案例',image:'case538.jpg'}]}))}
      else{res.writeHead(200,{'content-type':'image/png'});res.end(PNG)}
    })
    const selected={kind:'featured',key:'travel-natural-photo'}
    // The old background fetch had no Electron session, and Desktop rejects that request.
    await expect(prepareAgentImageReference(selected,{env,hostOrigin:()=>origin})).rejects.toMatchObject({status:502,message:expect.stringContaining('HTTP 403')})
    const post=(input:unknown,authenticated=true)=>fetch(origin+AGENT_IMAGE_REFERENCE_API,{method:'POST',headers:{'content-type':'application/json','x-cqai-track':'1',cookie:'private-browser-session=do-not-forward','x-unrelated-header':'do-not-forward',...(authenticated?{'x-dsh-desktop-renderer':token}:{})},body:JSON.stringify(input)})
    expect((await post(selected,false)).status).toBe(403)
    for(const input of [{...selected,trackId:id},{kind:'template',sourceId:'canghe',caseId:'538',trackId:id}]){
      const response=await post(input);expect(response.status).toBe(200)
      const result=await response.json() as {reference:AgentImageReference}
      expect(JSON.stringify(result)).not.toContain(token)
      expect(result.reference.clipboardText).not.toContain('x-dsh-desktop-renderer')
      expect(result.reference.source.trackId).toBe(id);expect(new URL(result.reference.fileUrl,'http://localhost').searchParams.get('trackId')).toBe(id)
      const manifest=readFileSync(join(dirname(result.reference.filePath),result.reference.referenceId+'.json'),'utf8')
      expect(manifest).not.toContain(token);expect(manifest).not.toContain('private-browser-session')
    }
    expect(calls.map(call=>call.path)).toEqual(['/api/dsh-imagegen/templates/image/canghe/case538.jpg','/api/dsh-imagegen/templates/list','/api/dsh-imagegen/templates/image/canghe/case538.jpg'])
    for(const call of calls){expect(call.headers['x-dsh-desktop-renderer']).toBe(token);expect(call.headers.cookie).toBeUndefined();expect(call.headers['x-unrelated-header']).toBeUndefined();expect(call.headers['x-cqai-track']).toBeUndefined()}
  })
  it('drops malformed Desktop capabilities and never follows redirects carrying one', async () => {
    const {env}=fixture(), token=Buffer.alloc(32,8).toString('base64url'), observed: unknown[]=[]
    const outside=await server((req,res)=>{observed.push(req.headers);res.writeHead(200);res.end(PNG)})
    let mode='image',header:unknown
    const origin=await server((req,res)=>{header=req.headers['x-dsh-desktop-renderer'];if(mode==='redirect'){res.writeHead(302,{location:outside+'/image.png'});res.end()}else{res.writeHead(200,{'content-type':'image/png'});res.end(PNG)}})
    const selected={kind:'featured',key:'travel-natural-photo'}
    await prepareAgentImageReference(selected,{env,hostOrigin:()=>origin,desktopRendererAccess:'invalid-access'})
    expect(header).toBeUndefined()
    mode='redirect'
    await expect(prepareAgentImageReference(selected,{env,hostOrigin:()=>origin,desktopRendererAccess:token})).rejects.toMatchObject({status:502})
    expect(header).toBe(token);expect(observed).toEqual([])
  })
  it('refuses a host list that belongs to a different template source', async () => {
    const {env}=fixture(),calls:string[]=[]
    const origin=await server((req,res)=>{calls.push(req.url!);res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({ok:true,sourceId:'vibeui',cases:[{id:538,image:'case538.jpg'}]}))})
    await expect(prepareAgentImageReference({kind:'template',sourceId:'canghe',caseId:'538'},{env,hostOrigin:()=>origin})).rejects.toMatchObject({status:502})
    expect(calls).toEqual(['/api/dsh-imagegen/templates/list'])
  })
  it('refuses request-provided destinations, redirects and over-limit streams without writing references', async () => {
    const {env,root}=fixture();const selected={kind:'featured',key:'travel-natural-photo'}
    for(const host of ['https://evil.example','http://localhost:1234','http://127.0.0.1:1234/path','http://user:pass@127.0.0.1:1234'])await expect(prepareAgentImageReference(selected,{env,hostOrigin:()=>host})).rejects.toMatchObject({status:503})
    let mode='redirect', redirected=0
    const origin=await server((req,res)=>{if(req.url==='/outside')redirected++;if(mode==='redirect'){res.writeHead(302,{location:'/outside'});res.end()}else{res.writeHead(200,{'content-length':String(20*1024*1024+1)});res.end()}})
    await expect(prepareAgentImageReference(selected,{env,hostOrigin:()=>origin})).rejects.toMatchObject({status:502});expect(redirected).toBe(0)
    mode='oversize';await expect(prepareAgentImageReference(selected,{env,hostOrigin:()=>origin})).rejects.toMatchObject({status:413})
    expect(existsSync(join(root,'track-agent'))).toBe(false)
  })
})

describe('Agent image reference HTTP transport', () => {
  it('uses the existing host access gate and exposes exact owned bytes for native draft attachments', async () => {
    const {env,id}=fixture(),photo=await asset(env,id)
    const origin=await server(async(req,res)=>{if(!permitted(req)){res.writeHead(403);res.end();return}if(!await handleAgentImageReferenceRoute(req,res,new URL(req.url!,'http://localhost'),{env})){res.writeHead(404);res.end()}})
    const request={kind:'resource',trackId:id,assetId:photo.id}
    const post=(body:unknown,headers:Record<string,string>={'x-cqai-track':'1'})=>fetch(origin+AGENT_IMAGE_REFERENCE_API,{method:'POST',headers:{'content-type':'application/json',...headers},body:JSON.stringify(body)})
    expect((await post(request,{})).status).toBe(403);expect((await post(request,{'x-cqai-track':'1',origin:'https://evil.example'})).status).toBe(403)
    const response=await post(request);expect(response.status).toBe(200);const {reference}=await response.json() as {reference:AgentImageReference}
    const bytes=await fetch(origin+reference.fileUrl);expect(bytes.status).toBe(200);expect(bytes.headers.get('x-content-type-options')).toBe('nosniff');expect(Buffer.from(await bytes.arrayBuffer())).toEqual(readFileSync(reference.filePath))
    const head=await fetch(origin+reference.fileUrl,{method:'HEAD'});expect(head.status).toBe(200);expect(head.headers.get('content-length')).toBe(String(reference.bytes));expect((await head.arrayBuffer()).byteLength).toBe(0)
    expect((await fetch(origin+reference.fileUrl,{headers:{origin:'https://evil.example'}})).status).toBe(403)
    expect((await fetch(origin+reference.fileUrl+'&referenceId=duplicate')).status).toBe(400)
    expect((await fetch(origin+reference.fileUrl+'&trackId='+encodeURIComponent(id))).status).toBe(400)
    const unscoped=reference.fileUrl.split('&trackId=')[0]
    expect((await fetch(origin+unscoped)).status).toBe(404)
    expect((await fetch(origin+unscoped+'&trackId=../outside')).status).toBe(400)
    const other=writeTrack({...input,source:'<gpx>other transport route</gpx>'},env).id
    expect((await fetch(origin+unscoped+'&trackId='+encodeURIComponent(other))).status).toBe(404)
    expect((await fetch(origin+reference.fileUrl+'&path=../../outside')).status).toBe(400)
    expect((await fetch(origin+AGENT_IMAGE_REFERENCE_API)).status).toBe(405)
    expect((await post({kind:'resource',trackId:id,assetId:'missing'})).status).toBe(404)
    expect((await post({kind:'featured',key:'x',padding:'x'.repeat(128*1024)})).status).toBe(413)
  })
})

