import { createApp } from './app';
import { config } from './config';
const runtime=createApp();
let running=false;
async function tick(recovery=false){if(running)return;running=true;try{for(const o of runtime.store.all('obligations'))if(o.rule.kind==='recurring'&&!runtime.store.require('projects',o.project_id).archived)runtime.business.generate(o);await runtime.notifications.tick({recovery});await runtime.notifications.processQueue();}catch(e){console.error('后台任务失败：',e instanceof Error?e.message:'未知错误');}finally{running=false;}}
const server=runtime.app.listen(config.port,config.host,()=>{console.log(`亦庄国投投后管理系统 http://${config.host}:${config.port}（模型 ${config.llm_mode} / 通知 ${config.outbound_mode}）`);void tick(true);});
server.on('error',(error:any)=>{console.error(error.code==='EADDRINUSE'?`端口 ${config.port} 已被占用，请修改 .env PORT；不会终止其他程序。`:error.message);process.exitCode=1;});
const timer=setInterval(()=>void tick(),60000);timer.unref();
const queueTimer=setInterval(()=>{void runtime.notifications.processQueue().catch(()=>console.error('发送队列处理失败，请查看通知记录'));},1000);queueTimer.unref();
const shutdown=()=>{clearInterval(timer);clearInterval(queueTimer);server.close(()=>{runtime.store.close();process.exit(0);});};process.on('SIGINT',shutdown);process.on('SIGTERM',shutdown);
