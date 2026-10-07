import {readFileSync} from 'node:fs';
import {join} from 'node:path';

/** Reconstruct only the geometry and named points required by this camera demo. */
export function createDemoSource(folder, envelope) {
  const meta=JSON.parse(readFileSync(join(folder,'source.json'),'utf8'));
  const document=envelope.document;
  const runs=meta.trackRouteIds.map((id,index)=>{
    const node=document.nodes[id];
    if(node?.type!=='route'||node.coords.length!==meta.trackRunLengths[index])throw new Error('示例基础线路记录段不完整');
    return node.coords;
  });
  const coordinates=runs.flatMap(run=>run.map(coord=>[coord[0],coord[1],null,null]));
  const segmentStarts=[];let cursor=0;
  for(const run of runs){segmentStarts.push(cursor);cursor+=run.length;}
  const placemarks=meta.trailPlacemarkNodeIds.map((id,index)=>{
    const marker=document.nodes[id];
    if(marker?.type!=='marker')throw new Error('示例路线节点不完整');
    return {id:'demo-point-'+(index+1),name:marker.label||marker.name,coordinates:[...marker.coord],description:'',images:[],elevation:null,time:null};
  });
  const bbox=coordinates.reduce((box,point)=>[Math.min(box[0],point[0]),Math.min(box[1],point[1]),Math.max(box[2],point[0]),Math.max(box[3],point[1])],[Infinity,Infinity,-Infinity,-Infinity]);
  const track={id:meta.trackId,name:'武功山反穿 · 镜头示例',filename:'wugongshan-location-demo.gpx',format:'gpx',createdAt:'1970-01-01T00:00:00.000Z',bytes:0,points:coordinates.length,metrics:{...meta.metrics,duration:0,bbox},coordinates,placemarks,segmentStarts};
  const state={version:1,revision:0,added:[],deletedIds:[],edits:[],order:null,groups:[],routeContext:{segmentStarts,references:placemarks}};
  return {track,state,meta};
}
