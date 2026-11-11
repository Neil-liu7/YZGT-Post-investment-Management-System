import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
if(!existsSync('node_modules')){console.error('请先运行 npm ci');process.exit(1);}
await import('dotenv/config');
const child=spawn(process.execPath,['scripts/start.mjs'],{stdio:'inherit',windowsHide:true});let stopped=false;child.once('exit',()=>{stopped=true;});const port=process.env.PORT||8765;
let ready=false;for(let n=0;n<60&&!stopped;n++){await new Promise(r=>setTimeout(r,250));try{const r=await fetch(`http://127.0.0.1:${port}/health`);if(r.ok){ready=true;break;}}catch{}}
if(ready&&!stopped){const url=`http://127.0.0.1:${port}`;if(process.platform==='win32')spawn('cmd',['/c','start','',url],{windowsHide:true});else spawn('open',[url],{stdio:'ignore'});}else console.error('启动未就绪，请检查服务日志和 PORT 配置');
process.on('SIGINT',()=>child.kill());process.on('SIGTERM',()=>child.kill());
