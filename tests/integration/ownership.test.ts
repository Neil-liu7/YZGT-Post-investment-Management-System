import {it,expect} from 'vitest';
import {Store} from '../../apps/server/src/store';
it('database refuses a task whose obligation belongs to another project',()=>{const s=new Store(':memory:');try{const a=s.create('projects',{name:'A'}),b=s.create('projects',{name:'B'});const o=s.create('obligations',{project_id:a.id,title:'A义务'});expect(()=>s.create('tasks',{project_id:b.id,obligation_id:o.id,occurrence_key:'once'})).toThrow();}finally{s.close();}});
