import {spawn} from 'node:child_process';
import {mkdtempSync,rmSync,writeFileSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve,sep} from 'node:path';
const root=mkdtempSync(join(tmpdir(),'yzgt-startup-'));const env={...process.env,PORT:'18965',DATABASE_FILE:join(root,'app.sqlite'),STORAGE_DIR:join(root,'storage'),BACKUP_DIR:join(root,'backups'),OUTBOUND_MODE:'mock',LLM_MODE:'mock',SCHEDULER_ENABLED:'false'};
let logs='';const child=spawn(process.execPath,['scripts/start.mjs'],{env,windowsHide:true});child.stdout.on('data',x=>logs+=String(x));child.stderr.on('data',x=>logs+=String(x));
try{let ready=false;for(let n=0;n<100;n++){try{const r=await fetch('http://127.0.0.1:18965/health');if(r.ok){ready=true;break;}}catch{}await new Promise(r=>setTimeout(r,100));}if(!ready)throw new Error(logs);
 const home=await fetch('http://127.0.0.1:18965/projects');if(!home.ok||!(await home.text()).includes('root'))throw new Error('构建页面不可用');
 for(const path of ['/.env','/var/app.sqlite','/storage/file.txt','/apps/server/src/app.ts']){if((await fetch('http://127.0.0.1:18965'+path)).status!==404)throw new Error('私有路径泄露');}
 const base='http://127.0.0.1:18965/api/v1';const created=await fetch(base+'/projects',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:'生产构建合成验证',company:'合成公司'})});const project=(await created.json()).data;
 for(const name of ['agreement.txt','agreement.docx','agreement.pdf']){const form=new FormData();form.append('file',new Blob([readFileSync(join('tests/fixtures',name))]),name);const response=await fetch(base+`/projects/${project.id}/documents`,{method:'POST',body:form});const d=(await response.json()).data;if(!response.ok||d.state!=='parsed')throw new Error('生产解析失败：'+JSON.stringify(d));}
 const second=spawn(process.execPath,['scripts/start.mjs'],{env,windowsHide:true});let error='';second.stderr.on('data',x=>error+=String(x));await new Promise<void>(r=>second.once('exit',()=>r()));if(!error.includes('已被占用'))throw new Error('端口冲突未正确报告');
 const result={production_start:'passed',html_route:'passed',private_paths:'passed',port_conflict:'passed',production_txt_docx_pdf:'passed',os:process.platform,port:18965};writeFileSync('docs/启动验证.json',JSON.stringify(result,null,2));console.log(result);
}finally{child.kill();await new Promise(r=>setTimeout(r,500));if(resolve(root).startsWith(resolve(tmpdir())+sep))rmSync(root,{recursive:true,force:true});}
