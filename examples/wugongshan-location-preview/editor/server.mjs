/** Editable native GeoMotion example, with source data reconstructed from project.json. */
import {createServer} from 'vite';
import {existsSync,mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createDemoSource} from '../demo-source.mjs';

const folder=dirname(fileURLToPath(import.meta.url));
const demoFolder=resolve(folder,'..'),root=resolve(folder,'../../..');
const port=Number(process.env.TRACK_DEMO_PORT||51222);
if(!Number.isInteger(port)||port<1024||port>65535)throw new Error('TRACK_DEMO_PORT must be an integer between 1024 and 65535');
const url='http://127.0.0.1:'+port+'/';
const seedFile=join(demoFolder,'project.json');
const seed=JSON.parse(readFileSync(seedFile,'utf8'));
const {track,state,meta}=createDemoSource(demoFolder,seed),trackId=track.id;
const runtime=join(demoFolder,'runtime'),runtimeHome=join(runtime,'dsh-home'),cache=join(runtime,'dem-cache');
const isolatedTrack=join(runtimeHome,'track',trackId);
for(const directory of [runtime,cache,isolatedTrack])mkdirSync(directory,{recursive:true});
const env={DSH_HOME:runtimeHome};
const hash=value=>createHash('sha256').update(value).digest('hex');
const seedHash=hash(readFileSync(seedFile));
const generated=[['track.json',track],['placemark-state.json',state]].map(([name,data])=>({name,bytes:JSON.stringify(data)}));
for(const {name,bytes}of generated){
  const file=join(isolatedTrack,name);
  if(existsSync(file)&&hash(readFileSync(file))!==hash(bytes))throw new Error('示例源数据与工程不一致，请先导出保存的镜头，再移走 runtime 目录后重启');
  if(!existsSync(file))writeFileSync(file,bytes);
}
const evidence={updatedAt:'',freshTiles:0,maxFreshTiles:256,dem:[]},pending=new Map();
const saveEvidence=()=>{evidence.updatedAt=new Date().toISOString();writeFileSync(join(runtime,'network-evidence.json'),JSON.stringify(evidence,null,2));};
const json=(res,status,value)=>{res.writeHead(status,{'content-type':'application/json; charset=utf-8','cache-control':'no-store'});res.end(JSON.stringify(value));};
function permitted(req){
  if(!['127.0.0.1','::1','::ffff:127.0.0.1'].includes(req.socket.remoteAddress||''))return false;
  const origin=req.headers.origin;
  if(origin&&origin!=='http://'+req.headers.host&&origin!=='https://'+req.headers.host)return false;
  if(req.headers['sec-fetch-site']==='cross-site')return false;
  return req.method==='GET'||req.method==='HEAD'||req.headers['x-cqai-track']==='1';
}
function health(){
  const preserved=generated.map(({name,bytes})=>({name,unchanged:hash(readFileSync(join(isolatedTrack,name)))===hash(bytes)}));
  const seedUnchanged=hash(readFileSync(seedFile))===seedHash;
  return {ok:seedUnchanged&&preserved.every(file=>file.unchanged),trackId,pointCount:track.coordinates.length,segmentStarts:track.segmentStarts,isolatedData:true,seedUnchanged,preserved};
}
async function serveDEM(res,z,x,y){
  if(!Number.isInteger(z)||z<0||z>12||!Number.isInteger(x)||!Number.isInteger(y)||x<0||y<0||x>=2**z||y>=2**z)return json(res,400,{error:'Invalid DEM viewport tile'});
  const name=z+'-'+x+'-'+y+'.webp',file=join(cache,name);
  try{
    const cached=existsSync(file);
    if(!cached){
      if(!pending.has(name)){
        if(evidence.freshTiles>=evidence.maxFreshTiles)return json(res,429,{error:'Preview DEM viewport budget reached'});
        evidence.freshTiles++;
        pending.set(name,(async()=>{
          const response=await fetch('https://tiles.mapterhorn.com/'+z+'/'+x+'/'+y+'.webp',{signal:AbortSignal.timeout(12000)});
          if(!response.ok)throw new Error('DEM HTTP '+response.status);
          const bytes=Buffer.from(await response.arrayBuffer());
          if(bytes.length>2_000_000)throw new Error('DEM viewport tile is unexpectedly large');
          writeFileSync(file,bytes);
        })().finally(()=>pending.delete(name)));
      }
      await pending.get(name);
    }
    const bytes=readFileSync(file);
    res.writeHead(200,{'content-type':'image/webp','cache-control':'public,max-age=86400'});res.end(bytes);
    evidence.dem.push({z,x,y,status:200,source:cached?'demo-cache':'viewport-mapterhorn-network',bytes:bytes.length});
  }catch(error){evidence.dem.push({z,x,y,status:502,error:String(error)});if(!res.headersSent)json(res,502,{error:String(error)});else res.end();}
  finally{if(evidence.dem.length>2000)evidence.dem.splice(0,evidence.dem.length-2000);saveEvidence();}
}
async function body(req){
  const chunks=[];let size=0;
  for await(const chunk of req){size+=chunk.length;if(size>24*1024*1024)throw new Error('Preview request exceeds 24 MiB');chunks.push(Buffer.from(chunk));}
  return chunks.length?JSON.parse(Buffer.concat(chunks).toString('utf8')):{};
}
let artifacts,projects,placemarks,geoMotion;
async function serveAPI(req,res,address){
  if(!permitted(req))return json(res,403,{error:'仅允许本机应用访问'});
  const action=address.pathname.split('/').at(-1),id=address.searchParams.get('id')||trackId;
  if(id!==trackId)return json(res,404,{error:'示例轨迹不存在'});
  try{
    if(req.method==='POST'&&action==='geomotion-project'){
      const request=await body(req);
      if(!request||typeof request!=='object'||Array.isArray(request)||request.id!==trackId)return json(res,400,{error:'示例轨迹编号无效'});
      return json(res,200,{project:projects.writeGeoMotionProject(trackId,request.project,request.expectedRevision,env)});
    }
    if(req.method!=='GET')return json(res,405,{error:'示例仅允许保存独立镜头工程'});
    if(action==='geomotion-project')return json(res,200,{project:projects.readGeoMotionProject(trackId,env)});
    if(action==='tracks')return json(res,200,artifacts.listTracks(env));
    if(action==='track')return json(res,200,artifacts.readTrack(trackId,env));
    if(action==='placemark-state')return json(res,200,{state:placemarks.readPlacemarkState(trackId,env)});
    if(action==='placemark-photo-cache')return json(res,200,{assets:[]});
    if(action==='annotations')return json(res,200,{annotations:[],saved:false});
    return json(res,404,{error:'此示例未启用该接口'});
  }catch(error){if(!res.headersSent)json(res,error instanceof projects.GeoMotionProjectError?error.status:400,{error:error instanceof Error?error.message:String(error)});else res.end();}
}
const vite=await createServer({
  configFile:false,root,
  optimizeDeps:{entries:[join(folder,'index.html')],include:['react','react-dom/client','maplibre-gl','mediabunny']},
  cacheDir:join(runtime,'vite-cache'),
  server:{host:'127.0.0.1',port,strictPort:true,hmr:false,watch:{ignored:['**/examples/wugongshan-location-preview/runtime/**','**/outputs/**']},fs:{strict:true,allow:[root]}},
  plugins:[
    {name:'native-editor-css-text',enforce:'pre',resolveId(source){if(source==='maplibre-gl/dist/maplibre-gl.css')return '\0preview-maplibre-css';},load(id){if(id==='\0preview-maplibre-css')return 'export default '+JSON.stringify(readFileSync(join(root,'node_modules/maplibre-gl/dist/maplibre-gl.css'),'utf8'));}},
    {name:'viewport-dem-cache',enforce:'pre',transform(code,id){if(id.replaceAll('\\','/').endsWith('/src/track/basemaps.ts'))return code.replace('https://tiles.mapterhorn.com/{z}/{x}/{y}.webp','/preview/dem/{z}/{x}/{y}.webp');}},
    {name:'isolated-native-editor-runtime',configureServer(server){server.middlewares.use((req,res,next)=>{
      const address=new URL(req.url,url);
      if(address.pathname==='/'){req.url='/examples/wugongshan-location-preview/editor/index.html';return next();}
      if(address.pathname==='/favicon.ico'){res.statusCode=204;return res.end();}
      if(address.pathname==='/preview/health'){if(!permitted(req))return json(res,403,{error:'仅允许本机应用访问'});return json(res,200,health());}
      if(address.pathname==='/preview/project-download'){
        if(req.method!=='GET'||!permitted(req))return json(res,403,{error:'仅允许本机应用访问'});
        const project=projects.readGeoMotionProject(trackId,env);
        res.writeHead(200,{'content-type':'application/json; charset=utf-8','content-disposition':'attachment; filename="wugongshan-location-project.json"','cache-control':'no-store'});return res.end(JSON.stringify(project,null,2));
      }
      const tile=address.pathname.match(/^\/preview\/dem\/(\d+)\/(\d+)\/(\d+)\.webp$/);
      if(tile){if(!permitted(req))return json(res,403,{error:'仅允许本机应用访问'});void serveDEM(res,...tile.slice(1).map(Number));return;}
      if(address.pathname.startsWith('/api/cqai-track/')){void serveAPI(req,res,address);return;}
      next();
    });}},
  ],
});
try{
  [artifacts,projects,placemarks,geoMotion]=await Promise.all([vite.ssrLoadModule('/src/artifacts.ts'),vite.ssrLoadModule('/src/geomotion-project-store.ts'),vite.ssrLoadModule('/src/placemark-state-store.ts'),vite.ssrLoadModule('/src/track/geomotion.ts')]);
  const sourceFingerprint=geoMotion.createGeoMotionProject(track,track.placemarks,[]).sourceFingerprint;
  if(!projects.readGeoMotionProject(trackId,env))projects.writeGeoMotionProject(trackId,{...seed,sourceFingerprint},null,env);
  await vite.listen();
  const details={url,trackId,pointCount:track.coordinates.length,segmentStarts:track.segmentStarts,sourceFingerprint,layers:Object.keys(seed.document.nodes).length,duration:seed.document.duration,scope:meta.preview.sceneIds,fullFilmApproved:false};
  writeFileSync(join(runtime,'runtime.json'),JSON.stringify(details,null,2));saveEvidence();console.log(JSON.stringify(details));
}catch(error){await vite.close();throw error;}
const stop=async()=>{await vite.close();saveEvidence();process.exit(0);};
process.on('SIGINT',stop);process.on('SIGTERM',stop);
