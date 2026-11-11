import { mkdirSync,copyFileSync,readFileSync,writeFileSync,existsSync,readdirSync,statSync,unlinkSync,renameSync } from 'node:fs';
import { resolve,join,dirname,sep } from 'node:path';
import { createHash } from 'node:crypto';
import { Store,AppError } from './store';
import { Business } from './business';
import Database from 'better-sqlite3';
const hash=(b:Buffer|string)=>createHash('sha256').update(b).digest('hex');
export async function backup(store:Store,storage:string,destination:string){
 const dir=resolve(destination);if(existsSync(dir))throw new AppError('BACKUP_EXISTS','备份目录已存在');mkdirSync(dir,{recursive:true});writeFileSync(join(dir,'INCOMPLETE'),'备份尚未封口');
 // SQLite online backup captures one consistent database snapshot. Immutable attachment names permit copying afterwards.
 await store.db.backup(join(dir,'app.sqlite'));const snap=new Store(join(dir,'app.sqlite'));const docs=snap.all('documents').filter(d=>d.storage_name);snap.close();const files:any[]=[];
 for(const d of docs){const src=join(storage,d.storage_name);if(!existsSync(src))throw new AppError('MISSING_ATTACHMENT',`附件缺失：${d.id}`);const digest=hash(readFileSync(src));if(!d.sha256||digest!==d.sha256)throw new AppError('CHECKSUM_MISMATCH',`原件摘要不匹配，可能损坏：${d.id}`);const relative=`storage/${d.storage_name}`;mkdirSync(dirname(join(dir,relative)),{recursive:true});copyFileSync(src,join(dir,relative));files.push({path:relative,sha256:digest,document_id:d.id});}
 files.push({path:'app.sqlite',sha256:hash(readFileSync(join(dir,'app.sqlite')))});writeFileSync(join(dir,'manifest.tmp'),JSON.stringify({format_version:1,sealed:true,created_at:store.clock().toISOString(),files},null,2));unlinkSync(join(dir,'INCOMPLETE'));renameSync(join(dir,'manifest.tmp'),join(dir,'manifest.json'));return {directory:dir,files:files.length,sealed:true};
}
export function restore(from:string,to:string){const source=resolve(from),target=resolve(to);if(existsSync(target))throw new AppError('RESTORE_TARGET_EXISTS','恢复目标必须是尚不存在的新目录');const manifest=JSON.parse(readFileSync(join(source,'manifest.json'),'utf8'));if(!manifest.sealed||existsSync(join(source,'INCOMPLETE')))throw new AppError('INCOMPLETE_BACKUP','备份未封口');if(!Array.isArray(manifest.files))throw new AppError('INVALID_MANIFEST','备份清单无效');for(const f of manifest.files){const full=resolve(source,f.path);if(!full.startsWith(source+sep))throw new AppError('INVALID_MANIFEST','非法路径');if(hash(readFileSync(full))!==f.sha256)throw new AppError('CHECKSUM_MISMATCH','备份摘要校验失败');}if(manifest.format_version!==1||manifest.files.filter((f:any)=>f.path==='app.sqlite').length!==1||new Set(manifest.files.map((f:any)=>f.path)).size!==manifest.files.length)throw new AppError('INVALID_MANIFEST','备份必须包含唯一数据库和完整清单');
 const sourceDb=new Database(join(source,'app.sqlite'),{readonly:true,fileMustExist:true});try{const check=sourceDb.pragma('quick_check') as any[];if(check[0].quick_check!=='ok'||(sourceDb.pragma('foreign_key_check') as unknown[]).length)throw new AppError('INVALID_DATABASE','备份数据库校验失败');const docs=(sourceDb.prepare('SELECT id,data FROM documents').all() as any[]).map(r=>({...JSON.parse(r.data),id:r.id})).filter(d=>d.storage_name);for(const d of docs){if(!manifest.files.some((f:any)=>f.document_id===d.id&&f.path===`storage/${d.storage_name}`&&f.sha256===d.sha256))throw new AppError('MISSING_ATTACHMENT','附件摘要与关联校验失败');}}finally{sourceDb.close();}
 mkdirSync(target,{recursive:true});for(const f of manifest.files){mkdirSync(dirname(join(target,f.path)),{recursive:true});copyFileSync(join(source,f.path),join(target,f.path));}return {directory:target,verified:true};}
export class LegacyImporter {
 constructor(public store:Store,public business:Business){}
 private readonly rollbackTables=['projects','events','documents','clauses','obligations','tasks','legacy_mappings'];
 private rollbackConflicts(imp:any){
  const blocked:any[]=[];
  if(!Array.isArray(imp.created_records))return [{table:'imports',id:imp.id,reason:'snapshot_unavailable',message:'该历史批次没有创建快照，需人工处理'}];
  const created=new Set<string>(imp.created_records.map((r:any)=>`${r.table}:${r.id}`));
  for(const record of imp.created_records){
   if(!this.rollbackTables.includes(record.table)){blocked.push({table:record.table,id:record.id,reason:'invalid_snapshot'});continue;}
   const current=this.store.get(record.table,record.id);
   if(!current||current.version!==record.version||hash(JSON.stringify(current))!==hash(JSON.stringify(record.snapshot)))blocked.push({table:record.table,id:record.id,reason:current?'modified':'missing',expected_version:record.version,current_version:current?.version??null,message:'导入后记录已修改或缺失，停止自动撤回'});
  }
  const ids=(table:string)=>new Set<string>(imp.created_records.filter((r:any)=>r.table===table).map((r:any)=>r.id));
  const projects=ids('projects'),tasks=ids('tasks'),obligations=ids('obligations'),documents=ids('documents');
  for(const table of ['events','documents','clauses','obligations','tasks','evidence','extractions','drafts','reminders','notifications']){
   for(const row of this.store.all(table))if(!created.has(`${table}:${row.id}`)&&(projects.has(row.project_id)||tasks.has(row.task_id)||obligations.has(row.obligation_id)||documents.has(row.document_id)))blocked.push({table,id:row.id,reason:'new_dependent_record',message:'该项目存在导入后新增业务，停止自动撤回'});
  }
  return blocked;
 }
 rollbackPreview(id:string,reason:string):any{return this.store.transaction(()=>{
  if(typeof reason!=='string'||!reason.trim()||reason.length>20000)throw new AppError('REASON_REQUIRED','撤回需填写有效原因');
  const imp=this.store.require('imports',id);
  if(imp.state!=='committed')throw new AppError('IMPORT_NOT_COMMITTED','仅可撤回已提交且尚未撤回的导入批次',409);
  const blocked=this.rollbackConflicts(imp);
  const plan=this.store.create('change_plans',{operation:'legacy_rollback',import_id:id,baseline_version:imp.version,state:'preview',reason:reason.trim(),can_rollback:blocked.length===0,blocked_records:blocked,affected_records:imp.created_records||[],expires_at:new Date(this.store.clock().getTime()+900000).toISOString()});
  return {...plan,plan_id:plan.id};
 });}
 rollback(id:string,plan_id:string):any{return this.store.transaction(()=>{
  const imp=this.store.require('imports',id),plan=this.store.require('change_plans',plan_id);
  if(plan.operation!=='legacy_rollback'||plan.import_id!==id)throw new AppError('PLAN_IMPORT_MISMATCH','撤回计划不属于该导入批次',409);
  if(plan.state==='committed'&&imp.state==='rolled_back')return imp;
  if(imp.state!=='committed'||plan.state!=='preview'||imp.version!==plan.baseline_version)throw new AppError('PLAN_STALE','导入状态已改变，请重新预览',409);
  if(plan.expires_at<=this.store.clock().toISOString())throw new AppError('PLAN_EXPIRED','撤回计划已过期，请重新预览',409);
  const blocked=this.rollbackConflicts(imp);
  if(!plan.can_rollback||blocked.length)throw new AppError('ROLLBACK_CONFLICT','导入后已有业务修改，停止自动撤回',409,{blocked_records:blocked.length?blocked:plan.blocked_records});
  const now=this.store.clock().toISOString();
  for(const record of imp.created_records){
   const before=this.store.require(record.table,record.id);
   const changes=record.table==='legacy_mappings'?{state:'rolled_back',rolled_back_at:now}:{archived:true,deleted_at:now,rollback_import_id:id};
   const after=this.store.update(record.table,record.id,record.version,changes);
   this.store.audit(record.table,record.id,'legacy_rollback',before,after,plan.reason);
  }
  const result=this.store.update('imports',id,imp.version,{state:'rolled_back',rolled_back_at:now,rollback_reason:plan.reason,rollback_plan_id:plan.id});
  this.store.audit('imports',id,'legacy_rollback',imp,result,plan.reason);
  this.store.update('change_plans',plan.id,plan.version,{state:'committed',committed_at:now});
  return result;
 });}
 preview(source_namespace:string,source:any){if(!source_namespace?.trim())throw new AppError('NAMESPACE_REQUIRED','请填写稳定来源命名空间');if(!Array.isArray(source.projects))throw new AppError('INVALID_LEGACY','旧数据须包含 projects 数组');const issues:any[]=[];const seen=new Set();let count=0;for(const p of source.projects){if(!p.id||seen.has('p'+p.id))issues.push({blocking:true,message:'项目旧 ID 缺失或重复'});seen.add('p'+p.id);for(const t of p.tasks||[]){count++;const key=`t${p.id}:${t.id}`;if(!t.id||seen.has(key))issues.push({blocking:true,message:'事项旧 ID 缺失或重复'});seen.add(key);} }
 const digest=hash(JSON.stringify(source));for(const mapping of this.store.all('legacy_mappings',{source_namespace})){const p=source.projects.find((x:any)=>String(x.id)===mapping.legacy_id);if(mapping.state==='rolled_back')issues.push({blocking:true,message:'该来源命名空间已撤回，保留映射，请人工处理后再导入'});if(mapping.entity_type==='project'&&p&&hash(JSON.stringify(p))!==mapping.source_hash)issues.push({blocking:true,message:`旧项目 ${p.id} 内容变化，保留新版数据，请人工处理`});}
 return this.store.create('imports',{source_namespace,source,source_hash:digest,project_count:source.projects.length,task_count:count,issues,warnings:['全部旧期限保留为历史估算，正式期限待审核','原件缺失标记待补传；不继承凭据与提醒开关'],state:'preview'});}
 confirm(id:string){return this.store.transaction(()=>{const imp=this.store.require('imports',id);if(imp.state==='committed')return imp;if(imp.state==='rolled_back'||this.store.all('legacy_mappings',{source_namespace:imp.source_namespace}).some(mapping=>mapping.state==='rolled_back'))throw new AppError('IMPORT_ROLLED_BACK','该批次或来源已撤回，不能自动重新导入',409);if(imp.issues.some((i:any)=>i.blocking))throw new AppError('IMPORT_CONFLICT','请先修复预览中的冲突');const priorIds=new Map(this.rollbackTables.map(table=>[table,new Set(this.store.all(table).map(row=>row.id))]));const map=(kind:string,old:string)=>this.store.all('legacy_mappings',{source_namespace:imp.source_namespace,entity_type:kind,legacy_id:old})[0];let created=0;
 for(const p of imp.source.projects){if(map('project',String(p.id)))continue;const project=this.store.create('projects',{name:p.name||'历史项目',company:p.company||'',owner_label:p.owner||'',notes:'历史导入，待核对',archived:false,deleted_at:null,task_order_version:1});this.store.create('legacy_mappings',{source_namespace:imp.source_namespace,entity_type:'project',legacy_id:String(p.id),new_id:project.id,source_hash:hash(JSON.stringify(p)),import_id:id,state:'active'});created++;
 for(const [kind,date] of [['签署',p.agreementSignDate],['出资',p.actualInvestDate||p.investmentDate]])if(date)this.store.create('events',{project_id:project.id,name:`历史${kind}（待核对）`,occurred_on:date,status:'needs_review',event_type:kind});
 for(const file of p.uploadedFiles||[])this.store.create('documents',{project_id:project.id,original_name:typeof file==='string'?file:file.name||file.fileName||'历史文件',state:'needs_file',storage_name:null,sha256:null,file_version:1,source_type:'legacy'});
 const unknownEvent=(p.tasks||[]).some((task:any)=>!task.dueDate)?this.store.create('events',{project_id:project.id,name:'原起算事件待核实',occurred_on:null,status:'needs_review',event_type:'legacy_unknown',source_type:'legacy'}):null;
 for(const t of p.tasks||[]){const base={schema_version:1,confirmation_status:'needs_review',original_expression:`历史 days=${t.days??'未知'}，${t.dueDate?'历史估算日期待核定':'截止日和原起算条件未知，零偏移仅作待审核占位'}`,convention:{end_day_adjustment:'none',month_end:'clamp',calendar_id:null,calendar_version:null}};const rule=t.dueDate?{...base,kind:'fixed',date:t.dueDate}:{...base,kind:'relative',anchor:{type:'event',event_id:unknownEvent.id},offsets:[{amount:0,unit:'calendar_day',include_start_day:false}]};const o=this.business.createObligation(project.id,{title:t.title||'历史事项',description:t.desc||t.description||'',owner_label:t.owner||'',source_type:'legacy',source_description:'旧系统迁移，来源待核实',rule});const task=o.tasks[0];this.store.update('tasks',task.id,task.version,{status:['pending','doing','done','cancelled'].includes(t.status)?t.status:'pending',legacy_original:t,historical_estimated_due_on:t.dueDate||null,completed_on:null,completed_by:null});this.store.create('legacy_mappings',{source_namespace:imp.source_namespace,entity_type:'task',legacy_id:`${p.id}:${t.id}`,new_id:task.id,source_hash:hash(JSON.stringify(t)),import_id:id,state:'active'});}
 for(const a of p.agreements||[])for(const c of a.clauses||[])this.store.create('clauses',{project_id:project.id,document_id:null,text:c.text||c.content||JSON.stringify(c),clause_number:c.number||'',source_type:'legacy',verification_state:'needs_review'});
 this.store.audit('projects',project.id,'legacy_import',null,project);}
 const created_records=this.rollbackTables.flatMap(table=>this.store.all(table).filter(row=>!priorIds.get(table)!.has(row.id)).map(row=>({table,id:row.id,version:row.version,snapshot:row})));
 return this.store.update('imports',id,imp.version,{state:'committed',created_projects:created,created_records,reconciliation:{expected_projects:imp.project_count,expected_tasks:imp.task_count,mapped_projects:this.store.all('legacy_mappings',{source_namespace:imp.source_namespace,entity_type:'project'}).length,mapped_tasks:this.store.all('legacy_mappings',{source_namespace:imp.source_namespace,entity_type:'task'}).length}});});}
}
export function directoryEmpty(path:string){return !existsSync(path)||!readdirSync(path).some(x=>statSync(join(path,x)).isFile());}
