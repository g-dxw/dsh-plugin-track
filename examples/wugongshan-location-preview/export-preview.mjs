/** Optional automated export through the actual GeoMotionEditor UI. */
import {mkdirSync,readFileSync,statSync,writeFileSync} from 'node:fs';
import {dirname,join} from 'node:path';
import {fileURLToPath} from 'node:url';
const folder=dirname(fileURLToPath(import.meta.url));
const project=JSON.parse(readFileSync(join(folder,'project.json'),'utf8'));
const output=join(folder,'media');mkdirSync(output,{recursive:true});
let chromium;
try{({chromium}=await import('playwright'));}catch{throw new Error('Optional export requires Playwright: install playwright locally and run npx playwright install chromium. The editor itself does not require Playwright.');}
const browser=await chromium.launch({headless:true,...(process.env.TRACK_DEMO_CHROMIUM?{executablePath:process.env.TRACK_DEMO_CHROMIUM}:{}),args:['--enable-webgl','--ignore-gpu-blocklist','--disable-background-timer-throttling','--disable-renderer-backgrounding']});
const page=await browser.newPage({viewport:{width:1680,height:1080},deviceScaleFactor:1,acceptDownloads:true});
const errors=[];page.on('pageerror',error=>errors.push(String(error)));
await page.addInitScript(()=>{window.__encodedFrames=0;if(window.VideoEncoder){const encode=VideoEncoder.prototype.encode;VideoEncoder.prototype.encode=function(frame,...args){window.__encodedFrames++;return encode.call(this,frame,...args);};}});
try{
  await page.goto(process.env.TRACK_DEMO_URL||'http://127.0.0.1:51222/',{waitUntil:'domcontentloaded'});
  await page.getByLabel('镜头时长（秒）',{exact:true}).waitFor({timeout:60000});
  await page.waitForFunction(()=>!document.querySelector('.trk-gm-preview-help button')?.disabled&&!document.querySelector('.trk-gm-scene-error'),{timeout:60000});
  const duration=Number(await page.getByLabel('镜头时长（秒）',{exact:true}).inputValue());
  if(duration!==project.document.duration)throw new Error('Saved camera duration differs from the shipped example. Export edited projects directly in the UI.');
  await page.getByRole('button',{name:'导出 WebM 视频',exact:true}).click();
  await page.waitForFunction(()=>document.querySelector('.trk-gm-video a')||document.querySelector('.trk-gm-alert'),{timeout:900000});
  if(await page.locator('.trk-gm-alert').count())throw new Error(await page.locator('.trk-gm-alert').innerText());
  const pending=page.waitForEvent('download');await page.getByRole('link',{name:'下载视频',exact:true}).click();
  const video=join(output,'wugongshan-location-preview.webm');await(await pending).saveAs(video);
  const encodedFrames=await page.evaluate(()=>window.__encodedFrames);
  const expectedFrames=Math.ceil(duration*project.document.fps);
  const health=await(await page.request.get(new URL('/preview/health',page.url()).href)).json();
  if(encodedFrames!==expectedFrames||!health.ok||errors.length)throw new Error('Export verification failed: '+JSON.stringify({encodedFrames,expectedFrames,health,errors}));
  const report={ok:true,output:'media/wugongshan-location-preview.webm',bytes:statSync(video).size,encodedFrames,expectedFrames,sourcePreserved:health.ok,scope:['SC02','SC03','SC04A'],fullFilmApproved:false,completedAt:new Date().toISOString()};
  writeFileSync(join(output,'export-report.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report));
}finally{await browser.close();}
