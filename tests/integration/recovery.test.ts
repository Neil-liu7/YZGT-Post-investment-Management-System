import {it,expect} from 'vitest';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve,sep} from 'node:path';
import {Store} from '../../apps/server/src/store';
import {createApp} from '../../apps/server/src/app';
it('restart marks interrupted extraction failed so it can be retried instead of remaining queued forever',()=>{const root=mkdtempSync(join(tmpdir(),'yzgt-recovery-'));let reopened:any;try{const file=join(root,'app.sqlite');const s=new Store(file);const p=s.create('projects',{name:'合成恢复'});const d=s.create('documents',{project_id:p.id,state:'parsed',text:'合成协议'});const run=s.create('extractions',{project_id:p.id,document_id:d.id,state:'running'});s.close();reopened=createApp({database_file:file,storage_dir:join(root,'storage')});expect(reopened.store.require('extractions',run.id)).toMatchObject({state:'failed'});expect(reopened.store.require('extractions',run.id).error).toMatch(/重启|中断/);}finally{reopened?.store.close();if(resolve(root).startsWith(resolve(tmpdir())+sep))rmSync(root,{recursive:true,force:true});}});
