import { accessSync,constants,mkdirSync } from 'node:fs';
import { resolve,join } from 'node:path';
import net from 'node:net';
import { config } from '../apps/server/src/config';
import { Store } from '../apps/server/src/store';
import { backup,restore } from '../apps/server/src/maintenance';
const action=process.argv[2];
try{
 if(action==='restore'){const from=process.argv[process.argv.indexOf('--from')+1],to=process.argv[process.argv.indexOf('--to')+1];if(!process.argv.includes('--from')||!process.argv.includes('--to'))throw new Error('用法：npm run restore -- --from <备份目录> --to <全新目录>');console.log(restore(from,to));}
 else if(action==='doctor'){
 const [major,minor,patch]=process.versions.node.split('.').map(Number);if(major<22||(major===22&&(minor<22||(minor===22&&patch<2))))throw new Error('请安装 Node.js >=22.22.2 LTS');
 for(const path of [resolve('var'),config.storage_dir,config.backup_dir]){mkdirSync(path,{recursive:true});accessSync(path,constants.W_OK);}
 const db=new Store(':memory:');db.close();
 await new Promise<void>((done,reject)=>{const s=net.createServer();s.once('error',()=>reject(new Error(`端口 ${config.port} 被占用，请停止自己的服务或更改 PORT`)));s.listen(config.port,config.host,()=>s.close(()=>done()));});
 if(config.llm_mode==='live'&&(!process.env.GLM_API_KEY||process.env.ALLOW_EXTERNAL_MODEL!=='true'))throw new Error('真实模型需要 GLM_API_KEY 和 ALLOW_EXTERNAL_MODEL=true');
 console.log(`Node ${process.versions.node} / SQLite / 可写目录 / 端口 ${config.port}：正常；模型=${config.llm_mode}，通知=${config.outbound_mode}，定时=${config.scheduler_enabled}`);
 }else {const store=new Store(config.database_file);if(action==='migrate')console.log('迁移成功，schema '+(store.db.prepare('SELECT max(version) AS version FROM migrations').get() as any).version+'，保留已有数据');else if(action==='backup')console.log(await backup(store,config.storage_dir,join(config.backup_dir,'backup-'+Date.now())));else throw new Error('未知命令');store.close();}
}catch(e){console.error(e instanceof Error?e.message:e);process.exitCode=1;}
