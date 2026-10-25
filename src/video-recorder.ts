import { mkdir, writeFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { performance } from 'node:perf_hooks';

type Rect={x:number;y:number;width:number;height:number};
function frameSize(data:Buffer) {
  if(data.length>=24&&data.subarray(0,4).equals(Buffer.from([137,80,78,71])))return {width:data.readUInt32BE(16),height:data.readUInt32BE(20)};
  if(data[0]===255&&data[1]===216)for(let at=2;at+9<data.length;) {
    if(data[at]!==255){at++;continue;}
    const marker=data[at+1],length=data.readUInt16BE(at+2);
    if(marker===217||marker===218||length<2)break;
    if([192,193,194,195,197,198,199,201,202,203,205,206,207].includes(marker))return {width:data.readUInt16BE(at+7),height:data.readUInt16BE(at+5)};
    at+=2+length;
  }
  throw new Error('Capture returned an unsupported image.');
}
export function videoBlurRegions(raw:any):Rect[] {
  if(raw===undefined)return [];
  if(!Array.isArray(raw)||raw.length>8)throw new Error('Choose up to 8 blur regions.');
  return raw.map(r=>{
    if(!r||!['x','y','width','height'].every(k=>Number.isSafeInteger(r[k]))||r.x<0||r.y<0||r.width<2||r.height<2||r.x+r.width>8192||r.y+r.height>8192)throw new Error('Blur regions need positive pixel bounds within the captured image.');
    return {x:r.x,y:r.y,width:r.width,height:r.height};
  });
}
function run(executable:string,args:string[],timeout=120000):Promise<string> {
  return new Promise((resolve,reject)=>execFile(executable,args,{windowsHide:true,timeout,maxBuffer:1024*1024},(error,stdout,stderr)=>error?reject(new Error(`Video encoder failed: ${String(stderr || error.message).slice(-1200)}`)):resolve(stdout)));
}
export function videoConcat(frames:{name:string;at:number}[],durationMs:number) {
  if(!frames.length)throw new Error('No video frames were captured.');
  let text='ffconcat version 1.0\n';
  for(let i=0;i<frames.length;i++) {
    const duration=Math.max(1,(frames[i+1]?.at??durationMs)-(i===0?0:frames[i].at));
    text+=`file '${frames[i].name}'\noption framerate 1000\nduration ${(duration/1000).toFixed(6)}\n`;
  }
  return text+`file '${frames.at(-1)!.name}'\noption framerate 1000\n`;
}

/** Capture source owns timing; encoder works only on local frames. */
export class VideoRecorder {
  private current:any=null;
  constructor(private root:string,private ffmpeg=process.env.EMPIR3_FFMPEG_PATH || 'ffmpeg') {}
  fail(error:any) { if(['starting','recording'].includes(this.current?.state)){this.current.error=String(error?.message || error);if(this.current.state==='recording')void this.stop().catch(()=>{});} }
  status() {
    const r=this.current;
    return r?{success:true,id:r.id,state:r.state,recording:r.state==='recording',surface:r.surface,target:r.target,frames:r.frames.length,
      elapsedMs:Math.round((r.stoppedAt??performance.now())-r.startedAt),error:r.error,result:r.result}:
      {success:true,state:'idle',recording:false};
  }
  async start(options:any,attach:(frame:(data:Buffer)=>Promise<void>)=>Promise<()=>Promise<void>>) {
    if(this.current && ['recording','starting','encoding'].includes(this.current.state))throw new Error('Stop and save the current video first.');
    const blur=videoBlurRegions(options.blurRegions);
    const maxDurationMs=Number(options.maxDurationMs??600000);
    if(!Number.isSafeInteger(maxDurationMs)||maxDurationMs<1000||maxDurationMs>600000)throw new Error('Video duration must be 1–600 seconds.');
    const r:any={id:randomUUID(),state:'starting',surface:options.surface,target:options.target,frames:[],bytes:0,startedAt:performance.now(),queue:Promise.resolve(),blur};
    this.current=r;
    try {
      await run(this.ffmpeg,['-version'],5000).catch(()=>{throw new Error('Video recording needs ffmpeg on PATH (or EMPIR3_FFMPEG_PATH). Install it, then retry.');});
      r.dir=join(this.root,r.id);await mkdir(r.dir,{recursive:true});
      r.startedAt=performance.now();
      const frame=(data:Buffer):Promise<void>=>{
        if(!['starting','recording'].includes(r.state)||r.error)return Promise.resolve();
        const at=performance.now()-r.startedAt;
        // Serialize disk writes; the source waits/acks after each accepted frame.
        r.queue=r.queue.then(async()=>{
          if(!Buffer.isBuffer(data)||!data.length)throw new Error('Empty video frame.');
          const size=frameSize(data);
          if(r.size&&(r.size.width!==size.width||r.size.height!==size.height))throw new Error('The capture size changed. Video stopped to preserve framing and blur bounds.');
          if(!r.size) {
            if(size.width<2||size.height<2||size.width>8192||size.height>8192)throw new Error('Capture dimensions are out of range.');
            if(r.blur.some((b:Rect)=>b.x+b.width>size.width||b.y+b.height>size.height))throw new Error('A blur region lies outside the captured image.');
            r.size=size;
          }
          if(r.bytes+data.length>512*1024*1024||r.frames.length>=18000)throw new Error('Capture limit reached; video was stopped.');
          const name=`frame-${String(r.frames.length).padStart(6,'0')}.${data[0]===0x89?'png':'jpg'}`;
          await writeFile(join(r.dir,name),data,{mode:0o600});r.frames.push({name,at});r.bytes+=data.length;
        }).catch((e:any)=>{r.error=e.message;if(r.state==='recording')void this.stop().catch(()=>{});});
        return r.queue;
      };
      r.detach=await attach(frame);
      await r.queue;
      if(r.error)throw new Error(r.error);
      r.state='recording';
      r.timer=setTimeout(()=>{void this.stop().catch(()=>{});},maxDurationMs);r.timer.unref?.();
      return this.status();
    }catch(error:any){r.state='failed';r.error=error.message;await r.detach?.().catch(()=>{});throw error;}
  }
  async stop():Promise<any> {
    const r=this.current;
    if(!r)throw new Error('No video recording is active.');
    if(r.stopping)return r.stopping;
    if(r.result)return r.result;
    if(r.state==='failed')throw new Error(r.error || 'Video capture failed.');
    if(r.state==='starting')throw new Error('Video capture is still starting.');
    r.stoppedAt=performance.now();r.state='encoding';clearTimeout(r.timer);
    r.stopping=(async()=>{
      try {
        await r.detach?.();await r.queue;
        const durationMs=Math.max(100,r.stoppedAt-r.startedAt);
        await writeFile(join(r.dir,'frames.ffconcat'),videoConcat(r.frames,durationMs));
        // Normalize dimensions, then blur only the saved image stream.
        let filter='[0:v]pad=ceil(iw/2)*2:ceil(ih/2)*2,format=yuv444p,setsar=1[v0]';
        r.blur.forEach((b:Rect,i:number)=>{
          const radius=Math.max(1,Math.min(10,Math.floor(Math.min(b.width,b.height)/2)));
          filter+=`;[v${i}]split[base${i}][region${i}];[region${i}]crop=${b.width}:${b.height}:${b.x}:${b.y},boxblur=luma_radius=${radius}:chroma_radius=${radius}:luma_power=2[blur${i}];[base${i}][blur${i}]overlay=${b.x}:${b.y}:format=yuv444[v${i+1}]`;
        });
        const output=join(r.dir,'video.mp4');
        await run(this.ffmpeg,['-hide_banner','-loglevel','error','-y','-safe','0','-f','concat','-i',join(r.dir,'frames.ffconcat'),
          '-filter_complex',filter,'-map',`[v${r.blur.length}]`,'-fps_mode','vfr','-c:v','libx264','-preset','veryfast','-crf','20','-pix_fmt','yuv420p','-movflags','+faststart',output]);
        const size=(await stat(output)).size;if(!size)throw new Error('The encoder produced an empty video.');
        const result={success:true,id:r.id,path:output,mimeType:'video/mp4',bytes:size,durationMs:Math.round(durationMs),frames:r.frames.length,
          surface:r.surface,target:r.target,blurRegions:r.blur,warning:r.error || undefined};
        await writeFile(join(r.dir,'recording.json'),JSON.stringify({...result,frames:r.frames},null,2));
        // Keep only the finished artifact and timing receipt after success.
        for(const f of r.frames)await rm(join(r.dir,f.name),{force:true});
        await rm(join(r.dir,'frames.ffconcat'),{force:true});
        r.result=result;r.state='saved';return result;
      }catch(error:any){r.state='failed';r.error=error.message;throw error;}
    })();
    return r.stopping;
  }
}
