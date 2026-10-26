import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AppError } from '../domain.mjs';

const worker = fileURLToPath(new URL('../../tools/browser_outreach.py', import.meta.url));
// Runs exactly one approved outreach job. Never retries an uncertain UI write.
export async function runBrowserOutreach({ job, contact, env, dataDir, stillEligible = () => true }) {
  if (contact.demo || !/^[a-zA-Z0-9_.]+$/.test(contact.handle)) throw new AppError('Browser automation requires a real, reviewed Instagram handle.', 409);
  if (!env.ANTHROPIC_API_KEY || !env.ANTHROPIC_MODEL || !env.BROWSER_PROFILE_DIR) throw new AppError('Browser Use requires Claude credentials and a dedicated signed-in browser profile.', 503);
  const directory = path.join(dataDir, 'browser-jobs', job.id);
  mkdirSync(directory, { recursive:true });
  const resultFile = path.join(directory, 'result.json');
  // A prior result is evidence for reconciliation, never permission to run again.
  if (existsSync(resultFile)) return JSON.parse(readFileSync(resultFile,'utf8'));
  if (!stillEligible()) throw new AppError('Outreach was cancelled before browser execution.',409);
  const payload = { jobId:job.id, handle:contact.handle, text:job.text, resultFile, profileDir:path.resolve(env.BROWSER_PROFILE_DIR), executablePath:env.BROWSER_EXECUTABLE_PATH || null };
  writeFileSync(path.join(directory,'request.json'),JSON.stringify({jobId:job.id,handle:contact.handle,text:job.text},null,2));
  const childEnv = Object.fromEntries(['PATH','HOME','USERPROFILE','SYSTEMROOT','SystemRoot','TEMP','TMP','DISPLAY','WAYLAND_DISPLAY','XDG_RUNTIME_DIR'].filter(key=>process.env[key]).map(key=>[key,process.env[key]]));
  Object.assign(childEnv,{ANTHROPIC_API_KEY:env.ANTHROPIC_API_KEY,ANTHROPIC_MODEL:env.ANTHROPIC_MODEL,ANONYMIZED_TELEMETRY:'false',BROWSER_USE_LOGGING_LEVEL:'error'});
  let reason='Browser exited without a verified result.';
  await new Promise(resolve=>{
    const child=spawn(env.BROWSER_PYTHON || 'python3',[worker],{env:childEnv,cwd:directory,stdio:['pipe','ignore','ignore']});
    const timeout=setTimeout(()=>{reason='Browser time limit reached; verify before retrying.';child.kill();},180000);
    const check=setInterval(()=>{if(!stillEligible()){reason='Conversation changed during browser execution; verify the result.';child.kill();}},250);
    const done=()=>{clearTimeout(timeout);clearInterval(check);resolve();};
    child.once('error',()=>{reason='Browser worker could not start; check the Python environment.';done();});child.once('close',done);
    child.stdin.on('error',()=>{});child.stdin.end(JSON.stringify(payload));
  });
  if (existsSync(resultFile)) {
    const result=JSON.parse(readFileSync(resultFile,'utf8'));
    // Model-reported UI success is not independently verified delivery.
    return {...result,status:'send_unknown',externalId:null};
  }
  return {status:'send_unknown',externalId:null,evidence:reason,error:reason};
}
