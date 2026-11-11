import { spawn } from 'node:child_process';
import 'dotenv/config';
const children:any[]=[];const executable=process.execPath;
function run(args:string[]){const child=spawn(executable,args,{stdio:'inherit',windowsHide:true});children.push(child);child.on('exit',code=>{if(code)stop();});return child;}
run(['--import','tsx','apps/server/src/index.ts']);
let ready=false;for(let n=0;n<60;n++){try{const r=await fetch(`http://127.0.0.1:${process.env.PORT||8765}/health`);if(r.ok){ready=true;break;}}catch{}await new Promise(r=>setTimeout(r,250));}
if(ready)run(['node_modules/vite/bin/vite.js','--config','apps/web/vite.config.ts']);else{console.error('后端未就绪，请检查端口和数据库');stop();}
function stop(){for(const child of children)child.kill();process.exit();}process.on('SIGINT',stop);process.on('SIGTERM',stop);
