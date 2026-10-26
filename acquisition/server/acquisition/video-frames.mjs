import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { AppError } from '../domain.mjs';
const exec = promisify(execFile);

// Read-only, bounded decoding of a private Drive video; never accepts a shell command or arbitrary URL.
export async function extractVideoFrames(bytes, {startSeconds=0,endSeconds=null,atSeconds}={}, env={}) {
  const dir=await mkdtemp(path.join(os.tmpdir(),'home-dream-frames-'));
  try {
    const file=path.join(dir,'source.mp4');await writeFile(file,bytes);
    const probe=await exec(env.FFPROBE_PATH||'ffprobe',['-v','error','-protocol_whitelist','file,pipe','-show_entries','format=duration','-of','json',file],{timeout:15000,maxBuffer:1024*1024});
    const duration=Number(JSON.parse(probe.stdout).format?.duration);
    if(!Number.isFinite(duration)||duration<=0||duration>3600)throw new AppError('Video duration is invalid or exceeds one hour.');
    const start=Math.max(0,startSeconds),end=Math.min(endSeconds??duration,duration);
    if(start>=end || (atSeconds!==undefined&&(atSeconds<start||atSeconds>=end)))throw new AppError('Requested timestamp is outside the video.');
    const times=atSeconds===undefined?[.15,.5,.85].map(r=>start+(end-start)*r):[Math.max(start,atSeconds-.5),atSeconds,Math.min(end-.01,atSeconds+.5)];
    const frames=[];
    for(const [i,time]of [...new Set(times)].entries()) {
      const output=path.join(dir,`${i}.jpg`);
      await exec(env.FFMPEG_PATH||'ffmpeg',['-v','error','-nostdin','-protocol_whitelist','file,pipe','-ss',String(time),'-i',file,'-frames:v','1','-vf',"scale=1280:720:force_original_aspect_ratio=decrease",'-threads','1','-q:v','4',output],{timeout:20000,maxBuffer:1024*1024});
      frames.push({frame:{atSeconds:time},image:{bytes:await readFile(output),mimeType:'image/jpeg'}});
    }
    return frames;
  } catch(error) {
    if(error instanceof AppError)throw error;
    throw new AppError(error.code==='ENOENT'?'Video decoding needs FFmpeg and FFprobe installed.':'Original video could not be decoded within the resource limit.',503);
  } finally {await rm(dir,{recursive:true,force:true});}
}
