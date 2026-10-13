"use strict";
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { JSDOM } = require('jsdom');
const { IDBFactory } = require('fake-indexeddb');
const read = file => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
function context(extra = {}) {
  const values = new Map();
  const c = { console: { error() {} }, Promise, Date, Number, Map, Set, setTimeout, clearTimeout,
    localStorage: { getItem: k => values.get(k) || null, setItem: (k,v) => values.set(k,v), removeItem: k => values.delete(k) },
    PMS: { utils: { deepClone: x => x === undefined ? undefined : structuredClone(x) } }, ...extra };
  c.window = c;
  vm.createContext(c);
  c.load = file => vm.runInContext(read(file), c);
  return c;
}
function browser() {
  const dom = new JSDOM('<body><main><button id="trigger">Open</button></main><div id="modal-root"></div><div id="toast-root"></div></body>', {runScripts:'outside-only', pretendToBeVisual:true});
  const w = dom.window;
  w.PMS = { i18n: { t: () => 'إغلاق' } };
  for (const f of ['dom','modal','dropdown']) w.eval(read('js/ui/' + f + '.js'));
  return dom;
}
test('failed saves retain backoff and retry successfully without another edit', async () => {
  const timers = [], events = [];
  let calls = 0, fail = true;
  const c = context({setTimeout:(fn,ms)=>{const t={fn,ms,cancelled:false};timers.push(t);return t;},clearTimeout:t=>{if(t)t.cancelled=true;}});
  Object.assign(c.PMS, {bus:{emit:n=>events.push(n)},storage:{save:()=>{calls++;return fail?Promise.reject(new Error('quota')):Promise.resolve();}},schema:{VERSION:1,defaultData:()=>({settings:{},taskStatuses:[],projectStatuses:[],priorities:[]})}});
  c.load('js/core/history.js');c.load('js/services/project-hierarchy.js');c.load('js/core/store.js');
  c.PMS.store.setData({settings:{},meta:{},tasks:[]});
  await c.PMS.store.flush();
  const retry = timers.find(t=>t.ms===3000);
  assert.ok(retry && !retry.cancelled);assert.equal(calls,2);
  fail=false;await retry.fn();
  assert.equal(calls,3);assert.ok(events.includes('save:done'));
});
test('storage restores the newest fallback and clears it only after a successful primary save', async () => {
  const c=context({indexedDB:new IDBFactory()});c.load('js/data/storage-idb.js');
  await c.PMS.storage.save({tasks:[{id:'old'}]});
  const old=JSON.parse(JSON.stringify(await c.PMS.storage.load()));
  c.localStorage.setItem('pms-data',JSON.stringify({__pmsStorage:1,revision:Date.now()+1000,data:{tasks:[{id:'new'}]}}));
  assert.equal((await c.PMS.storage.load()).tasks[0].id,'new');
  await c.PMS.storage.save({tasks:[{id:'latest'}]});
  assert.equal(c.localStorage.getItem('pms-data'),null);
  assert.equal((await c.PMS.storage.load()).tasks[0].id,'latest');
  assert.ok(Number.isFinite((await c.PMS.storage.load()).meta.localSaveRevision));
  assert.equal(old.tasks[0].id,'old');
  c.localStorage.setItem('pms-data',JSON.stringify({tasks:[{id:'legacy'}],meta:{updatedAt:'2099-01-01T00:00:00Z'}}));
  assert.equal((await c.PMS.storage.load()).tasks[0].id,'legacy');
  await c.PMS.storage.clear();assert.equal(await c.PMS.storage.load(),null);
});
test('corrupt stored data cannot become a silently empty new installation',async()=>{
  const c=context();c.load('js/data/storage-idb.js');c.localStorage.setItem('pms-data','{bad');
  await assert.rejects(c.PMS.storage.load(),/could not be read/);
  assert.equal(c.localStorage.getItem('pms-data'),'{bad');
});
test('history reverses edits, insertions, deletions and ordering while retaining only changed records',()=>{
  const c=context();c.load('js/core/history.js');
  const before={tasks:Array.from({length:500},(_,i)=>({id:String(i),title:'Task '+i})),settings:{theme:'light'}};
  const after=structuredClone(before);after.tasks[250].title='edited';
  const patches=c.PMS.history.diff(before,after);
  assert.equal(patches[0].records.length,1);
  assert.ok(JSON.stringify(patches).length<JSON.stringify(before).length);
  c.PMS.history.apply(after,patches,'before');assert.deepEqual(after,before);
  c.PMS.history.apply(after,patches,'after');assert.equal(after.tasks[250].title,'edited');
  const next=structuredClone(after);next.tasks.splice(10,1);next.tasks.unshift({id:'new',title:'New'});next.tasks.reverse();next.settings.theme='dark';
  const multi=c.PMS.history.diff(after,next), restored=structuredClone(next);
  c.PMS.history.apply(restored,multi,'before');assert.deepEqual(restored,after);
  c.PMS.history.apply(restored,multi,'after');assert.deepEqual(restored,next);
});
test('dropdown cleans exact listener references, including immediate close',async()=>{
  const dom=browser(),w=dom.window,adds=[],removes=[];
  const add=w.document.addEventListener.bind(w.document),remove=w.document.removeEventListener.bind(w.document);
  w.document.addEventListener=(type,fn,...rest)=>{if(type==='mousedown')adds.push(fn);return add(type,fn,...rest);};
  w.document.removeEventListener=(type,fn,...rest)=>{if(type==='mousedown')removes.push(fn);return remove(type,fn,...rest);};
  const trigger=w.document.getElementById('trigger');
  for(let i=0;i<3;i++){w.PMS.dropdown.attach(trigger,[{label:'Item'}]);await new Promise(r=>setTimeout(r,5));w.PMS.dropdown.close();}
  assert.equal(adds.length,3);for(let i=0;i<3;i++)assert.equal(adds[i],removes[i]);
  w.PMS.dropdown.attach(trigger,[{label:'Item'}]);w.PMS.dropdown.close();await new Promise(r=>setTimeout(r,5));assert.equal(adds.length,3);
  dom.window.close();
});
test('modal traps focus, isolates background, labels its title and closes exactly once',()=>{
  const dom=browser(),w=dom.window,trigger=w.document.getElementById('trigger');let closed=0;trigger.focus();
  const dialog=w.PMS.modal.open({title:'Title',content:w.PMS.dom.h('input'),footer:[{label:'Save'}],onClose:()=>{closed++;w.PMS.modal.close();}});
  assert.equal(w.document.getElementById(dialog.modal.getAttribute('aria-labelledby')).textContent,'Title');
  assert.equal(w.document.querySelector('main').inert,true);
  const buttons=dialog.modal.querySelectorAll('button');buttons[buttons.length-1].focus();
  w.document.dispatchEvent(new w.KeyboardEvent('keydown',{key:'Tab',bubbles:true,cancelable:true}));assert.equal(w.document.activeElement,buttons[0]);
  w.document.dispatchEvent(new w.KeyboardEvent('keydown',{key:'Tab',shiftKey:true,bubbles:true,cancelable:true}));assert.equal(w.document.activeElement,buttons[buttons.length-1]);
  w.document.dispatchEvent(new w.KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}));
  assert.equal(closed,1);assert.equal(w.document.activeElement,trigger);assert.ok(!w.document.querySelector('main').inert);
  w.PMS.modal.open({title:'Again',onClose:()=>closed++});w.document.querySelector('.modal-overlay').dispatchEvent(new w.MouseEvent('mousedown',{bubbles:true}));assert.equal(closed,2);
  dom.window.close();
});
test('view refresh preserves text focus and ignores unrelated activity changes',()=>{
  const dom=browser(),w=dom.window,container=w.document.querySelector('main');
  const render=()=>{container.innerHTML='<input name="query" value="hello">';};render();
  const input=container.querySelector('input');input.focus();input.setSelectionRange(2,4);container.scrollTop=30;
  w.PMS.dom.refresh(container,render);
  assert.equal(w.document.activeElement,container.querySelector('input'));assert.equal(w.document.activeElement.selectionStart,2);assert.equal(container.scrollTop,30);
  assert.equal(w.PMS.dom.affects({collections:['activities']},['tasks']),false);
  assert.equal(w.PMS.dom.affects({collections:['tasks']},['tasks']),true);
  assert.equal(w.PMS.dom.affects({desc:'setData'},['tasks']),true);dom.window.close();
});
test('concurrent flushes complete in order without a circular promise dependency',async()=>{
  let release;const writes=[];
  const c=context();
  Object.assign(c.PMS,{bus:{emit(){}},storage:{save:payload=>{writes.push(payload);return writes.length===1?new Promise(r=>release=r):Promise.resolve();}},schema:{VERSION:1,defaultData:()=>({settings:{},taskStatuses:[],projectStatuses:[],priorities:[]})}});
  c.load('js/core/history.js');c.load('js/services/project-hierarchy.js');c.load('js/core/store.js');c.PMS.store.setData({settings:{},meta:{},tasks:[]});
  const first=c.PMS.store.flush();await Promise.resolve();
  const second=c.PMS.store.flush();release();
  let timeout;
  await Promise.race([Promise.all([first,second]),new Promise((_,reject)=>timeout=setTimeout(()=>reject(new Error('flush deadlocked')),300))]).finally(()=>clearTimeout(timeout));
  assert.equal(writes.length,2);
});
test('failed mutations roll back and record changes identify their affected collections',()=>{
 const c=context({setTimeout:()=>1,clearTimeout(){}}),events=[];
 Object.assign(c.PMS,{bus:{emit:(name,event)=>{if(name==='store:changed')events.push(event);}},schema:{VERSION:1,defaultData:()=>({settings:{},taskStatuses:[],projectStatuses:[],priorities:[]})}});
 c.load('js/services/program-progress.js');c.load('js/core/history.js');c.load('js/services/project-hierarchy.js');c.load('js/core/store.js');c.PMS.store.setData({settings:{},meta:{},tasks:[{id:'one',title:'before'}]});
 assert.throws(()=>c.PMS.store.commit(d=>{d.tasks[0].title='broken';throw new Error('mutation');}));
 assert.equal(c.PMS.store.data.tasks[0].title,'before');assert.equal(c.PMS.store.canUndo(),false);
 c.PMS.store.commit(d=>{d.tasks[0].title='after';},'edit');
 assert.ok(events.at(-1).collections.includes('tasks'));assert.equal(events.at(-1).ids.tasks[0],'one');
 c.PMS.store.undo();assert.equal(c.PMS.store.data.tasks[0].title,'before');c.PMS.store.redo();assert.equal(c.PMS.store.data.tasks[0].title,'after');
});
test('cloud signup claims bootstrap in one transaction and strips member person impersonation',async()=>{
 const documents=new Map();let transactions=0,uid='first',verified=null;
 const ref=key=>({key,get:()=>Promise.resolve({exists:documents.has(key),data:()=>documents.get(key)}),set:value=>{documents.set(key,value);return Promise.resolve();}});
 const firestore={doc:ref,collection:name=>({doc:id=>ref(name+'/'+id)}),runTransaction:async fn=>{
   transactions++;const pending=[];const result=await fn({get:r=>r.get(),set:(r,v)=>pending.push([r.key,v])});
   for(const [key,value]of pending)documents.set(key,value);return result;
 }};
 const c=context({firebase:{apps:[],initializeApp:()=>({}),app:()=>({}),firestore:()=>firestore,auth:()=>({createUserWithEmailAndPassword:()=>Promise.resolve({user:{uid}})})}});
 Object.assign(c.PMS,{ids:{uuid:()=>String(documents.size)},cloudConfig:{projectId:'demo'},cloudBridge:{markVerified:id=>verified=id}});
 c.load('js/services/sync-mirror.js');c.load('js/services/sync-firestore.js');
 const first=await c.PMS.cloudsync.signUpWithPassword({email:'first@example.com',password:'password',personId:'first-person'});
 assert.equal(first.role,'admin');assert.equal(first.personId,'first-person');assert.equal(documents.get('zms_auth/bootstrap').firstUid,'first');assert.equal(transactions,1);assert.equal(verified,'first');
 uid='second';const second=await c.PMS.cloudsync.signUpWithPassword({email:'second@example.com',password:'password',role:'admin',personId:'first-person'});
 assert.equal(second.role,'member');assert.equal(second.personId,null);assert.equal(documents.get('zms_auth_users/second').personId,null);assert.equal(transactions,2);
});
test('project hierarchy repairs self-parent, cycles and missing parents without losing records',()=>{
 const c=context();c.load('js/services/project-hierarchy.js');
 const projects=[{id:'Testing',parentId:'Testing'},{id:'a',parentId:'b'},{id:'b',parentId:'a'},{id:'orphan',parentId:'missing'},{id:'root',parentId:null},{id:'child',parentId:'root'}];
 const fixed=c.PMS.projectHierarchy.repair(projects);
 assert.equal(fixed.length,3);assert.equal(projects.length,6);assert.equal(projects[0].parentId,null);assert.equal(projects[5].parentId,'root');
 assert.equal(c.PMS.projectHierarchy.repair(projects).length,0);
 for(const p of projects)assert.equal(c.PMS.projectHierarchy.canParent(projects,p.id,p.parentId),true);
 assert.equal(c.PMS.projectHierarchy.canParent(projects,'root','child'),false);
 assert.equal(c.PMS.projectHierarchy.canParent(projects,'root','root'),false);
 assert.equal(c.PMS.projectHierarchy.canParent(projects,'root','missing'),false);
});
test('Testing is visible after loading legacy data and editor/CRUD prevent cycles',()=>{
 const html=read('index.html'),dom=new JSDOM(html,{url:'http://localhost/',runScripts:'outside-only',pretendToBeVisual:true}),w=dom.window;
 w.__ZMS_TEST__=true;
 for(const m of html.matchAll(/<script src="([^"]+)"><\/script>/g)){const src=m[1].split('?')[0];if(src!=='js/main.js')w.eval(read(src));}
 w.PMS.cloudConfig={};const data=w.PMS.schema.defaultData();
 data.projects=[{id:'testing',name:'Testing',parentId:'testing'},{id:'child',name:'Child',parentId:'testing'}];
 data.tasks=[{id:'task',title:'Preserved task',projectId:'testing'}];w.PMS.store.setData(data);
 w.PMS.auth.createUser({username:'hierarchy-admin',password:'test-password'});w.PMS.auth.login('hierarchy-admin','test-password');
 const projects=w.PMS.repos.projects;
 assert.equal(projects.get('testing').parentId,null);
 const root=w.document.getElementById('view-root');w.PMS.registry.getView('projects').render(root,{});
 assert.ok(root.textContent.includes('Testing'));assert.ok(root.textContent.includes('Child'));
 assert.equal(projects.update('testing',{parentId:'child'}).error,'parentId');
 assert.equal(projects.update('testing',{parentId:'testing'}).error,'parentId');
 assert.equal(projects.add({id:'bad',name:'Bad',parentId:'bad'}).error,'parentId');assert.equal(projects.get('bad'),null);
 w.PMS.editors.openProjectEditor(projects.get('testing'),{});
 const options=Array.from(w.document.querySelectorAll('.modal [name="parentId"] option')).map(el=>el.value);
 assert.ok(!options.includes('testing'));assert.ok(!options.includes('child'));
 w.PMS.modal.close();assert.equal(w.PMS.repos.tasks.get('task').projectId,'testing');
 dom.window.close();
});
test('startup persists repaired legacy project links without changing task associations',async()=>{
 const timers=[],saved=[];const raw={schemaVersion:1,settings:{},meta:{},projects:[{id:'testing',name:'Testing',parentId:'testing'}],tasks:[{id:'task',title:'Task',projectId:'testing'}]};
 const c=context({setTimeout:(fn,ms)=>{timers.push({fn,ms});return timers.length;},clearTimeout(){}});
 Object.assign(c.PMS,{bus:{emit(){}},storage:{load:()=>Promise.resolve(raw),save:data=>{saved.push(data);return Promise.resolve();}},schema:{VERSION:1,defaultData:()=>({settings:{},taskStatuses:[],projectStatuses:[],priorities:[]})}});
 c.load('js/services/program-progress.js');c.load('js/core/history.js');c.load('js/services/project-hierarchy.js');c.load('js/core/store.js');
 await c.PMS.store.init();assert.equal(c.PMS.store.data.projects[0].parentId,null);
 await timers.find(t=>t.ms===300).fn();assert.equal(saved.length,1);assert.equal(saved[0].projects[0].parentId,null);assert.equal(saved[0].tasks[0].projectId,'testing');
});

function appFixture() {
 const html=read('index.html'),dom=new JSDOM(html,{url:'http://localhost/',runScripts:'outside-only',pretendToBeVisual:true}),w=dom.window;
 w.__ZMS_TEST__=true;
 for(const m of html.matchAll(/<script src="([^"]+)"><\/script>/g)){const src=m[1].split('?')[0];if(src!=='js/main.js')w.eval(read(src));}
 w.PMS.cloudConfig={};w.PMS.store.setData(w.PMS.schema.defaultData());
 w.PMS.auth.createUser({username:'review-admin',password:'test-password'});w.PMS.auth.login('review-admin','test-password');
 return {dom,w,p:w.PMS};
}
test('pillar deletion cleans subtasks and incoming links and undo restores everything',()=>{
 const {dom,p}=appFixture();try{
 const parent=p.repos.projects.add({name:'Parent'}),child=p.repos.projects.add({name:'Child',parentId:parent.id}),other=p.repos.projects.add({name:'Other'});
 const a=p.repos.tasks.add({title:'Deleted',projectId:child.id}),b=p.repos.tasks.add({title:'Kept',projectId:other.id});
 const sub=p.repos.subtasks.add({title:'Sub',taskId:a.id});p.repos.tasks.addDependency(b.id,a.id,'FS',0);p.repos.tasks.link(a.id,b.id);
 const before=JSON.stringify(p.store.data.tasks);p.repos.projects.remove(parent.id);
 assert.equal(p.repos.tasks.get(a.id),null);assert.equal(p.repos.subtasks.get(sub.id),null);
 assert.equal(p.repos.tasks.dependenciesOf(b.id).length,0);assert.equal(p.repos.tasks.linksOf(b.id).length,0);
 p.store.undo();assert.equal(JSON.stringify(p.store.data.tasks),before);assert.ok(p.repos.subtasks.get(sub.id));
 }finally{dom.window.close();}
});
test('every dependency write path refuses cycles, invalid lag, duplicates and missing tasks',()=>{
 const {dom,p}=appFixture();try{
 const a=p.repos.tasks.add({title:'A'}),b=p.repos.tasks.add({title:'B'}),c=p.repos.tasks.add({title:'C'});
 p.repos.tasks.addDependency(b.id,a.id,'FS',0);p.repos.tasks.addDependency(c.id,b.id,'SS',-2);
 assert.equal(p.repos.tasks.setDependency(a.id,c.id,'FS',0).error,'cycle');
 assert.equal(p.repos.tasks.setDependency(a.id,a.id,'FS',0).error,'self');
 assert.equal(p.repos.tasks.setDependency(a.id,'missing','FS',0).error,'notfound');
 for(const lag of [Infinity,NaN,1.5])assert.ok(p.repos.tasks.setDependency(c.id,a.id,'FS',lag).error);
 assert.equal(p.repos.tasks.update(c.id,{dependencies:[a.id,a.id]}).error,'duplicate');
 assert.equal(p.repos.tasks.add({id:'self',title:'Invalid',dependencies:['self']}).error,'self');
 assert.equal(p.repos.tasks.get('self'),null);
 assert.equal(p.repos.tasks.add({title:'Premature start',status:'inprogress',dependencies:[a.id]}).error,'blocked');assert.equal(p.repos.tasks.dependenciesOf(c.id)[0].id,b.id);
 const analysis=p.dependencies.analyzeCached(p.store.data);p.repos.tasks.removeDependency(c.id,b.id);
 assert.notEqual(p.dependencies.analyzeCached(p.store.data),analysis);
 }finally{dom.window.close();}
});
test('FF and SF constrain completion, while FS and SS constrain starting',()=>{
 const {dom,p}=appFixture();try{
 for(const type of ['FS','SS','FF','SF']){
  const pred=p.repos.tasks.add({title:type+' predecessor',status:'todo',plannedSubtasks:0});
  const succ=p.repos.tasks.add({title:type+' successor',status:'todo',plannedSubtasks:0,dependencies:[{id:pred.id,type,lag:0}]});
  const start=p.repos.tasks.setStatus(succ.id,'inprogress');
  if(type==='FS'||type==='SS')assert.equal(start.error,'blocked');
  else {assert.equal(start.error,undefined);assert.equal(p.repos.tasks.setStatus(succ.id,'done').error,'blocked');}
 }
 }finally{dom.window.close();}
});
test('dependency fields have labels, full relationship names, search and duplicate/cycle guards',()=>{
 const {dom,w,p}=appFixture();try{
 const a=p.repos.tasks.add({title:'Alpha'}),b=p.repos.tasks.add({title:'Beta'}),c=p.repos.tasks.add({title:'Gamma'});
 p.repos.tasks.addDependency(c.id,b.id,'FS',0);
 const control=p.forms.buildControl({type:'dependencies',excludeId:b.id},[{id:a.id,type:'FF',lag:-1}]);
 w.document.body.appendChild(control.el);
 const row=control.el.querySelector('.dep-row');assert.equal(row.querySelectorAll('label').length,3);
 assert.ok(row.querySelectorAll('select')[1].options[0].textContent.includes('FS —'));
 assert.equal([...row.querySelector('select').options].find(o=>o.value===c.id).disabled,true);
 control.el.querySelector(':scope > button').click();
 const rows=control.el.querySelectorAll('.dep-row');
 assert.equal([...rows[1].querySelector('select').options].find(o=>o.value===a.id).disabled,true);
 assert.ok(rows[0].querySelector('input[type=search]').getAttribute('aria-label'));
 rows[0].querySelector('button').click();assert.equal(control.el.querySelectorAll('.dep-row').length,1);
 p.editors.openTaskEditor(b,{});const form=p.modal.body.querySelector('form');
 assert.equal(form.reportValidity(),true,'closed person-creation controls must not block saving');
 }finally{dom.window.close();}
});
test('sync merges different fields and refuses overlapping edits without losing either version',()=>{
 const c=context();c.load('js/services/sync-mirror.js');const mirror=c.PMS.syncMirror.create('test');
 const base={id:'task',title:'Original',description:'Original note',dependencies:[],updatedAt:'1'};
 const local={...base,title:'Local title',updatedAt:'2'},remote={...base,description:'Remote note',updatedAt:'3'};
 const merged=mirror.mergeRecord(base,local,remote);
 assert.equal(merged.title,'Local title');assert.equal(merged.description,'Remote note');
 assert.throws(()=>mirror.mergeRecord(base,local,{...remote,title:'Remote title'}),e=>e.code==='sync-conflict'&&e.fields.includes('title'));
 const tracked=mirror.recordTrack('tasks',base);base.title='Changed outside';assert.equal(tracked.snapshot.title,'Original');
 assert.equal(mirror.equal({a:1,b:{x:2,y:3}},{b:{y:3,x:2},a:1}),true);
});
test('adding a cloud member uses the admin callable and preserves person link and session',async()=>{
 const {dom,w,p}=appFixture();try{
 const person=p.repos.people.add({name:'Invitee',email:'invitee@example.com'});let received=null,invited=null;
 const session=p.auth.currentUser().id;
 p.cloudsync.isConfigured=()=>true;
 p.cloudsync.createMemberAccount=async opts=>{received=opts;return {uid:'new-member'};};
 p.cloudsync.resetPassword=async email=>{invited=email;};
 p.cloudsync.signUpWithPassword=()=>{throw new Error('must not switch auth session');};
 p.registry.getView('settings').render(w.document.getElementById('view-root'));
 const buttons=[...w.document.querySelectorAll('.settings-nav button')];buttons.find(b=>b.textContent===p.i18n.t('auth.accounts')).click();
 const add=[...w.document.querySelectorAll('.settings-body button')].find(b=>b.textContent.includes(p.i18n.t('auth.addCloudAccount')));assert.ok(add);add.click();
 const form=p.modal.body.querySelector('form');
 form.querySelector('.field[data-key=email] input').value='invitee@example.com';
 form.querySelector('.field[data-key=personId] select').value=person.id;
 assert.equal(form.querySelectorAll('input[type=password]').length,0);
 w.document.querySelector('.modal-footer button:last-child').click();await new Promise(r=>setTimeout(r,10));
 assert.equal(received.personId,person.id);assert.equal(invited,'invitee@example.com');assert.equal(p.auth.currentUser().id,session);
 }finally{dom.window.close();}
});

async function syncFixture(user={id:'admin',cloudUid:'admin',role:'admin',personId:'admin-person'}, sharedDocuments) {
 const documents=sharedDocuments || new Map(),queries=[],writes=[],control={beforeRead:null,beforeQuery:null,beforeWrite:null};
 const snapshot=key=>({exists:documents.has(key),data:()=>structuredClone(documents.get(key))});
 const ref=key=>({key,get:async()=>{if(control.beforeRead)await control.beforeRead(key);return snapshot(key);},set:async(value,opts)=>{if(control.beforeWrite)await control.beforeWrite(key,value);documents.set(key,opts&&opts.merge?{...(documents.get(key)||{}),...structuredClone(value)}:structuredClone(value));writes.push(key);},delete:async()=>{documents.delete(key);writes.push(key);}});
 const col=(name,filters=[])=>({doc:id=>ref(name+'/'+id),where:(...filter)=>col(name,filters.concat([filter])),get:async()=>{
  if(control.beforeQuery)await control.beforeQuery(name,filters);
  queries.push([name,filters]);const records=[...documents.entries()].filter(([key,value])=>key.startsWith(name+'/')&&filters.every(([field,op,wanted])=>op==='array-contains'?(value[field]||[]).includes(wanted):value[field]===wanted));
  return {forEach:fn=>records.forEach(([key])=>fn({...snapshot(key),id:key.split('/')[1]}))};
 }});
 const firestore={doc:ref,collection:name=>col(name),runTransaction:async fn=>{
  const pending=[];const result=await fn({get:r=>r.get(),set:(r,value)=>pending.push(()=>r.set(value)),update:(r,value)=>pending.push(()=>r.set(value,{merge:true})),delete:r=>pending.push(()=>r.delete())});
  for(const operation of pending)await operation();return result;
 }};
 const c=context({console:{error(){},warn(){},info(){}},setInterval:()=>1,clearInterval(){},addEventListener(){},removeEventListener(){},document:{addEventListener(){},removeEventListener(){}}});
 c.firebase={apps:[],initializeApp:()=>({}),app:()=>({}),firestore:()=>firestore,auth:()=>({currentUser:{uid:user.cloudUid}})};
 Object.assign(c.PMS,{ids:{uuid:()=> 'page-id'},cloudConfig:{projectId:'demo'},auth:{currentUser:()=>user},bus:{on:()=>()=>{},emit(){}},i18n:{t:key=>key},toast:{show(){}},schema:{VERSION:1,defaultData:()=>({settings:{}})},store:{initialized:true,data:{meta:{},settings:{},users:[],tasks:[],projects:[],people:[],departments:[],subtasks:[]},commit:fn=>fn(c.PMS.store.data),flush:()=>Promise.resolve(),setData:data=>{c.PMS.store.data=structuredClone(data);}}});
 c.load('js/services/sync-mirror.js');c.load('js/services/sync-firestore.js');
 await c.PMS.cloudsync.enable();
 return {c,p:c.PMS,documents,queries,writes,control,mirror:c.PMS.syncMirror.create('pms-cloud-mirror'),close:()=>c.PMS.cloudsync.disable()};
}
test('public cloud push combines concurrent fields and resolves overlapping conflicts',async()=>{
 const {p,documents,mirror,close}=await syncFixture();try{
 const base={id:'task',title:'Original',description:'Note',updatedAt:'2026-01-01'};
 mirror.setCollection('tasks',{task:mirror.recordTrack('tasks',base)});
 documents.set('zms_tasks/task',{...base,description:'Changed remotely',updatedAt:'2026-01-03'});
 p.store.data.tasks=[{...base,title:'Changed locally',updatedAt:'2026-01-02'}];
 assert.equal(await p.cloudsync.push(),true);
 assert.equal(documents.get('zms_tasks/task').title,'Changed locally');
 assert.equal(documents.get('zms_tasks/task').description,'Changed remotely');
 assert.equal(p.store.data.tasks[0].description,'Changed remotely');
 p.store.data.tasks[0].title='My next title';p.store.data.tasks[0].updatedAt='2026-01-05';
 documents.set('zms_tasks/task',{...documents.get('zms_tasks/task'),title:'Their next title',updatedAt:'2026-01-06'});
 assert.equal(await p.cloudsync.push(),false);assert.equal(p.store.data.tasks[0].title,'My next title');
 assert.equal(p.cloudsync.conflicts().length,1);
 assert.equal(p.cloudsync.resolveConflict('tasks/task',true),true);assert.equal(await p.cloudsync.push(),true);
 assert.equal(documents.get('zms_tasks/task').title,'My next title');assert.equal(p.cloudsync.conflicts().length,0);
 }finally{await close();}
});
test('public cloud push refuses deleting a remotely edited record and can restore cloud version',async()=>{
 const {p,documents,mirror,close}=await syncFixture();try{
 const base={id:'task',title:'Original',updatedAt:'1'};
 mirror.setCollection('tasks',{task:mirror.recordTrack('tasks',base)});
 documents.set('zms_tasks/task',{...base,title:'New remote edit',updatedAt:'2'});
 p.store.data.projects=[{id:'project',name:'Project'}];
 assert.equal(await p.cloudsync.push(),false);assert.ok(documents.has('zms_tasks/task'));
 p.cloudsync.resolveConflict('tasks/task',false);
 assert.equal(p.store.data.tasks[0].title,'New remote edit');
 }finally{await close();}
});
test('public member pull uses scoped queries, deduplicates rows and drops stale private records',async()=>{
 const user={id:'member',cloudUid:'member',role:'member',personId:'person'};
 const {p,documents,queries,close}=await syncFixture(user);try{
 documents.set('zms_meta/state',{updatedAt:'2026-01-03'});
 documents.set('zms_tasks/visible',{id:'visible',title:'Own task',assignees:['person'],createdByPersonId:'person',updatedAt:'2026-01-02'});
 documents.set('zms_subtasks/visible-sub',{id:'visible-sub',taskId:'visible',title:'Allowed subtask',updatedAt:'2026-01-02'});
 documents.set('zms_subtasks/private-sub',{id:'private-sub',taskId:'private',title:'Private subtask',updatedAt:'2026-01-02'});
 documents.set('zms_tasks/private',{id:'private',title:'Private task',assignees:['other'],createdByPersonId:'other',updatedAt:'2026-01-02'});
 p.store.data.tasks=[{id:'private',title:'Old broad cache',assignees:['other']}];p.store.data.activities=[{id:'old-private-log',entityName:'Private task'}];
 assert.equal(await p.cloudsync.pull('merge'),true);
 assert.equal(p.store.data.tasks.length,1);assert.equal(p.store.data.tasks[0].id,'visible');assert.equal(p.store.data.activities.length,0);
 assert.equal(p.store.data.subtasks.length,1);assert.equal(p.store.data.subtasks[0].id,'visible-sub');
 for(const name of ['zms_tasks','zms_meetings'])assert.ok(queries.filter(q=>q[0]===name).every(q=>q[1].length===1));
 assert.equal(queries.some(q=>q[0]==='zms_activities'),false);
 }finally{await close();}
});

test('cloud pull retains conflicting offline edits even with an older client clock',async()=>{
 const {p,documents,mirror,close}=await syncFixture();try{
 const base={id:'task',title:'Original',updatedAt:'2026-01-02'};
 mirror.setCollection('tasks',{task:mirror.recordTrack('tasks',base)});
 documents.set('zms_meta/state',{updatedAt:'2026-01-03'});
 p.store.data.tasks=[{...base,title:'Offline edit',updatedAt:'2026-01-01'}];
 assert.equal(await p.cloudsync.pull('merge'),false);
 assert.equal(p.store.data.tasks[0].title,'Offline edit');assert.equal(p.cloudsync.conflicts()[0].remote,null);
 }finally{await close();}
});
test('automatic pull detects a changed remote clock even when that clock is behind locally',async()=>{
 const {p,documents,close}=await syncFixture();try{
 p.store.data.meta.updatedAt='2026-02-01';
 documents.set('zms_meta/state',{updatedAt:'2026-01-01'});
 documents.set('zms_tasks/task',{id:'task',title:'Remote edit with slower clock',updatedAt:'2026-01-01'});
 assert.equal(await p.cloudsync.pull(),true);assert.equal(p.store.data.tasks[0].title,'Remote edit with slower clock');
 }finally{await close();}
});
test('UI full-edit permissions match cloud roles and pillar ownership',()=>{
 const {dom,p}=appFixture();try{
 const person=p.repos.people.add({name:'Manager'}),other=p.repos.people.add({name:'Other manager'});
 const managed=p.repos.projects.add({name:'Managed',managerId:person.id}),foreign=p.repos.projects.add({name:'Foreign',managerId:other.id});
 const own=p.repos.tasks.add({title:'Own pillar',projectId:managed.id,assignees:[person.id]}),unassigned=p.repos.tasks.add({title:'Foreign',projectId:foreign.id}),assigned=p.repos.tasks.add({title:'Foreign assigned',projectId:foreign.id,assignees:[person.id]});
 const account=p.auth.createUser({username:'scoped-manager',password:'test-password'}).user;
 p.auth.updateUser(account.id,{role:'manager',personId:person.id});p.auth.login('scoped-manager','test-password');
 assert.equal(p.auth.canEditTask(own),true);assert.equal(p.auth.canEditTask(unassigned),false);
 assert.equal(p.auth.canEditTask(assigned),false);assert.equal(p.auth.canChangeStatus(assigned),true);
 assert.equal(p.auth.canChangeStatus(unassigned),false);
 p.auth.logout();p.auth.login('review-admin','test-password');p.auth.updateUser(account.id,{role:'member'});p.auth.logout();p.auth.login('scoped-manager','test-password');
 assert.equal(p.auth.canEditTask(own),false);assert.equal(p.auth.canChangeStatus(own),true);
 p.editors.openTaskEditor(own,{});assert.equal(p.modal.body.querySelectorAll('.dep-input').length,0);
 }finally{dom.window.close();}
});
test('cloud completion preserves a newer edit made while a write is in flight',async()=>{
 const {p,documents,mirror,control,close}=await syncFixture();try{
 const base={id:'task',title:'Original',updatedAt:'1'};
 mirror.setCollection('tasks',{task:mirror.recordTrack('tasks',base)});documents.set('zms_tasks/task',base);
 p.store.data.tasks=[{...base,title:'First edit',updatedAt:'2'}];
 let release,entered;const blocked=new Promise(r=>release=r),started=new Promise(r=>entered=r);
 control.beforeRead=async key=>{if(key==='zms_tasks/task'){entered();await blocked;}};
 const pending=p.cloudsync.push();await started;
 p.store.data.tasks[0].title='Second edit';p.store.data.tasks[0].updatedAt='3';
 release();assert.equal(await pending,true);control.beforeRead=null;
 assert.equal(p.store.data.tasks[0].title,'Second edit');assert.equal(documents.get('zms_tasks/task').title,'First edit');
 assert.equal(await p.cloudsync.push(),true);assert.equal(documents.get('zms_tasks/task').title,'Second edit');
 }finally{await close();}
});
test('legacy cycles elsewhere do not prevent repairing a separate dependency chain',()=>{
 const {dom,p}=appFixture();try{
 p.store.commit(d=>{d.tasks.push({id:'bad-a',title:'Bad A',dependencies:['bad-b']},{id:'bad-b',title:'Bad B',dependencies:['bad-a']});},'legacy-cycle');
 const a=p.repos.tasks.add({title:'Healthy A'}),b=p.repos.tasks.add({title:'Healthy B'});
 assert.equal(p.repos.tasks.addDependency(b.id,a.id,'FS',0).error,undefined);
 assert.equal(p.repos.tasks.removeDependency(b.id,a.id),true);
 assert.equal(p.repos.tasks.removeDependency('bad-a','bad-b'),true);
 assert.equal(p.dependencies.analyze(p.store.data).cyclic,false);
 }finally{dom.window.close();}
});
test('members receive conflict resolution after editing without an added toolbar button',async()=>{
 const {dom,w,p}=appFixture();try{
 p.auth.createUser({username:'conflict-member',password:'test-password'});p.auth.logout();p.auth.login('conflict-member','test-password');
 let pending=[{key:'tasks/own',id:'own',local:{title:'My edit'},remote:{title:'Cloud edit'},fields:['title']}],choice=null;
 p.cloudsync.conflicts=()=>pending;
 p.cloudsync.resolveConflict=(key,keepLocal)=>{choice={key,keepLocal};pending=[];p.bus.emit('cloud:conflict',{resolved:true});return true;};
 p.app.applyLocale();assert.equal(w.document.getElementById('sync-conflicts-btn'),null);
 p.modal.open({title:'Unsaved editor',content:w.PMS.dom.h('input',{value:'Keep this input'})});
 p.bus.emit('cloud:conflict',{key:'tasks/own'});await new Promise(r=>setTimeout(r,20));
 assert.equal(p.modal.body.querySelector('input').value,'Keep this input');
 p.modal.close();await new Promise(r=>setTimeout(r,300));
 assert.equal(p.auth.currentUser().role,'member');assert.ok(p.modal.isOpen);
 assert.ok(p.modal.body.textContent.includes('My edit'));assert.ok(p.modal.body.textContent.includes('Cloud edit'));
 [...p.modal.body.querySelectorAll('button')].find(b=>b.textContent===p.i18n.t('cloud.keepLocal')).click();
 assert.deepEqual(choice,{key:'tasks/own',keepLocal:true});assert.equal(p.modal.isOpen,false);
 }finally{dom.window.close();}
});

test('old rules denying subtasks do not suppress manager task pulls or erase local subtasks',async()=>{
 const {p,documents,control,mirror,close}=await syncFixture({id:'manager',cloudUid:'manager',role:'manager',personId:'person'});try{
 documents.set('zms_meta/state',{updatedAt:'2026-01-03'});
 documents.set('zms_tasks/task',{id:'task',title:'Shared task',assignees:['person'],updatedAt:'2026-01-02'});
 p.store.data.subtasks=[{id:'local-sub',taskId:'task',title:'Pending local work'}];
 const original={old:mirror.recordTrack('subtasks',{id:'old',taskId:'task',updatedAt:'1'})};mirror.setCollection('subtasks',original);
 control.beforeQuery=async name=>{if(name==='zms_subtasks')throw Object.assign(new Error('Old rules'),{code:'permission-denied'});};
 assert.equal(await p.cloudsync.pull('merge'),true);
 assert.equal(p.store.data.tasks[0].title,'Shared task');assert.equal(p.store.data.subtasks[0].id,'local-sub');
 assert.equal(JSON.stringify(mirror.forCollection('subtasks')),JSON.stringify(original));
 assert.ok(p.cloudsync.status().unavailableCollections.includes('subtasks'));
 control.beforeQuery=null;documents.set('zms_subtasks/local-sub',{id:'local-sub',taskId:'task',title:'Synced work'});
 assert.equal(await p.cloudsync.pull(),true);assert.equal(p.cloudsync.status().unavailableCollections.length,0);
 }finally{await close();}
});
test('primary task permission errors remain visible and never replace local data with an empty dataset',async()=>{
 const {p,documents,control,close}=await syncFixture();try{
 documents.set('zms_meta/state',{updatedAt:'2026-01-03'});p.store.data.tasks=[{id:'local',title:'Keep local task'}];
 control.beforeQuery=async name=>{if(name==='zms_tasks')throw Object.assign(new Error('Denied'),{code:'permission-denied'});};
 assert.equal(await p.cloudsync.pull('merge'),false);assert.equal(p.store.data.tasks[0].title,'Keep local task');
 assert.equal(p.cloudsync.status().error,'permission-denied');
 }finally{await close();}
});
test('existing save indicator reports cloud failure without adding a button',()=>{
 const {dom,w,p}=appFixture();try{
 p.app.applyLocale();p.cloudsync.status=()=>({error:'permission-denied',unavailableCollections:[]});
 p.bus.emit('cloud:state',{});p.bus.emit('save:done',{});
 assert.ok(w.document.getElementById('save-indicator').textContent.includes(p.i18n.t('save.cloudFailed')));
 assert.equal(w.document.getElementById('sync-conflicts-btn'),null);
 }finally{dom.window.close();}
});

test('admin task upload is not blocked by the nonexistent legacy subtask wrapper',async()=>{
 const {p,documents,control,close}=await syncFixture();try{
 documents.set('zms_meta/state',{updatedAt:'2026-01-03'});
 documents.set('zms_tasks/task',{id:'task',title:'Original',updatedAt:'2026-01-02'});
 control.beforeQuery=async name=>{if(name==='zms_subtasks')throw Object.assign(new Error('Old rules'),{code:'permission-denied'});};
 control.beforeRead=async key=>{if(key==='zms_subtasks/data')throw new Error('This collection never had a legacy wrapper');};
 assert.equal(await p.cloudsync.pull('merge'),true);
 p.store.data.tasks[0].title='Publish this task edit';p.store.data.tasks[0].updatedAt='2026-01-04';
 p.store.data.subtasks=[{id:'pending-sub',taskId:'task',title:'Do not erase'}];
 assert.equal(await p.cloudsync.push(),true);
 assert.equal(documents.get('zms_tasks/task').title,'Publish this task edit');assert.equal(p.store.data.subtasks[0].title,'Do not erase');
 assert.equal(documents.has('zms_subtasks/pending-sub'),false);
 }finally{await close();}
});
test('startup repairs an empty task cache even when the shared clock has not changed',async()=>{
 const {p,documents,close}=await syncFixture({id:'manager',cloudUid:'manager',role:'manager',personId:'person'});try{
 const at='2026-01-03';documents.set('zms_meta/state',{updatedAt:at});
 documents.set('zms_tasks/task',{id:'task',title:'Task written before clock update',updatedAt:'2026-01-02'});
 p.store.data.meta.updatedAt=at;p.store.data.projects=[{id:'project',name:'Cached pillar'}];p.store.data.tasks=[];
 await p.cloudsync.boot();assert.equal(p.store.data.tasks[0].title,'Task written before clock update');
 }finally{await close();}
});

test('startup uploads unpublished local tasks after merging an equal-clock cloud snapshot',async()=>{
 const {p,documents,close}=await syncFixture();try{
 const at='2026-01-03';documents.set('zms_meta/state',{updatedAt:at});
 p.store.data.meta.updatedAt=at;p.store.data.tasks=[{id:'local-only',title:'Publish existing local task',updatedAt:'2026-01-02'}];
 await p.cloudsync.boot();assert.equal(documents.get('zms_tasks/local-only').title,'Publish existing local task');
 }finally{await close();}
});

test('cloud success never hides a failed local save',()=>{
 const {dom,w,p}=appFixture();try{
 p.app.applyLocale();p.cloudsync.status=()=>({error:null,unavailableCollections:[]});
 p.bus.emit('save:error',{message:'Test quota failure'});p.bus.emit('cloud:state',{pushed:true});
 assert.ok(w.document.getElementById('save-indicator').textContent.includes(p.i18n.t('save.error')));
 p.bus.emit('save:done',{});assert.ok(w.document.getElementById('save-indicator').textContent.includes(p.i18n.t('save.saved')));
 }finally{dom.window.close();}
});

test('activity history retains more than 500 events and account refresh renders one timeline',async()=>{
 const {dom,w,p}=appFixture();try{
 p.store.data.activities=Array.from({length:501},(_,i)=>({id:'history-'+i,entity:'task',actor:'User '+i,at:'2026-01-01',updatedAt:'2026-01-01'}));
 p.repos.tasks.add({title:'New work'});assert.equal(p.store.data.activities.length,502);
 p.store.data.accountEvents=[{id:'account',kind:'account.signin',actor:'Another user',at:'2026-01-02'}];
 p.activity.refreshAccountEvents=()=>Promise.resolve(p.store.data.accountEvents);
 const cleanup=p.registry.getView('activity').render(w.document.getElementById('view-root'));await new Promise(r=>setTimeout(r,10));cleanup();
 assert.equal(w.document.querySelectorAll('.act-list').length,1);
 assert.equal(w.document.querySelectorAll('.act-row').length,503);
 }finally{dom.window.close();}
});
test('offline activities survive newer cloud clocks and upload after normal startup',async()=>{
 const {p,documents,close}=await syncFixture();try{
 p.store.data.activities=[{id:'offline',actorId:'admin',actor:'Offline admin',updatedAt:'2025-01-01',at:'2025-01-01'}];
 documents.set('zms_meta/state',{updatedAt:'2026-01-01'});
 documents.set('zms_activities/remote',{id:'remote',actorId:'other',actor:'Other user',updatedAt:'2026-01-01',at:'2026-01-01'});
 await p.cloudsync.enable();
 assert.ok(p.store.data.activities.some(e=>e.id==='offline'));
 assert.ok(documents.has('zms_activities/offline'));
 assert.ok(documents.has('zms_activities/remote'));
 }finally{await close();}
});
test('member and manager activities reach an admin on independent clients without exposing global logs to members',async()=>{
 const documents=new Map();
 const member=await syncFixture({id:'member-local',cloudUid:'member',role:'member',personId:'member-person'},documents);
 const manager=await syncFixture({id:'manager-local',cloudUid:'manager',role:'manager',personId:'manager-person'},documents);
 const admin=await syncFixture(undefined,documents);
 try{
 for(const [client,id,actor]of [[member,'member-action','Member'],[manager,'manager-action','Manager']]){
  client.p.store.data.activities=[{id,actor,actorId:id==='member-action'?'member-local':'manager-local',updatedAt:'2025-01-01',at:'2025-01-01',entity:'task',action:'status'}];
  assert.equal(await client.p.cloudsync.push(),true);
 }
 assert.equal(await admin.p.cloudsync.pull('merge'),true);
 assert.deepEqual(Array.from(admin.p.store.data.activities,e=>e.actor).sort(),['Manager','Member']);
 assert.equal(await member.p.cloudsync.pull('merge'),true);
 assert.equal(member.p.store.data.activities.length,0);
 assert.equal(member.queries.some(q=>q[0]==='zms_activities'),false);
 }finally{await member.close();await manager.close();await admin.close();}
});
test('missing local activity rows never delete cloud history without an explicit clear',async()=>{
 const {p,documents,mirror,close}=await syncFixture();try{
 documents.set('zms_activities/history',{id:'history',actor:'Other user',updatedAt:'1'});
 mirror.setCollection('activities',{history:true});
 p.store.data.activities=[];p.store.data.tasks=[{id:'new',title:'New task'}];
 assert.equal(await p.cloudsync.push(),true);
 assert.ok(documents.has('zms_activities/history'));
 }finally{await close();}
});
test('explicit activity clearing records deletion intent and preserves concurrent new events',async()=>{
 const {dom,p}=appFixture();try{
 p.store.data.activities=[{id:'old',actor:'Old user'}];p.activity.clear();
 assert.equal(p.store.data.activities.length,0);assert.deepEqual(Array.from(p.store.data.activityDeletedIds),['old']);
 }finally{dom.window.close();}
 const client=await syncFixture();try{
 client.documents.set('zms_meta/state',{updatedAt:'2026-01-02'});
 client.documents.set('zms_activities/old',{id:'old',updatedAt:'2026-01-01'});
 client.documents.set('zms_activities/new',{id:'new',actor:'New concurrent user',updatedAt:'2026-01-02'});
 client.mirror.setCollection('activities',{old:true});client.p.store.data.activityDeletedIds=['old'];
 assert.equal(await client.p.cloudsync.pull('merge'),true);
 assert.deepEqual(Array.from(client.p.store.data.activities,e=>e.id),['new']);
 assert.equal(await client.p.cloudsync.push(),true);
 assert.equal(client.documents.has('zms_activities/old'),false);assert.equal(client.documents.has('zms_activities/new'),true);
 }finally{await client.close();}
});
test('successful immutable event writes stay tracked when the shared clock write fails',async()=>{
 const {p,documents,control,mirror,close}=await syncFixture();try{
 p.store.data.activities=[{id:'event',actor:'Member',updatedAt:'1'}];
 let failClock=true;
 control.beforeWrite=async key=>{
  if(key==='zms_meta/state'&&failClock)throw new Error('Network interrupted');
  if(key==='zms_activities/event'&&documents.has(key))throw new Error('Immutable event cannot be overwritten');
 };
 assert.equal(await p.cloudsync.push(),false);assert.ok(documents.has('zms_activities/event'));
 assert.equal(mirror.forCollection('activities').event,true);
 failClock=false;assert.equal(await p.cloudsync.push(),true);assert.ok(documents.has('zms_meta/state'));
 }finally{await close();}
});
test('offline record deletions survive startup reconciliation and conflict with remote edits',async()=>{
 const {p,documents,mirror,close}=await syncFixture();try{
 const base={id:'deleted',title:'Deleted offline',updatedAt:'2026-01-01'};
 mirror.setCollection('tasks',{deleted:mirror.recordTrack('tasks',base)});
 documents.set('zms_meta/state',{updatedAt:'2026-01-02'});documents.set('zms_tasks/deleted',base);
 await p.cloudsync.enable();assert.equal(p.store.data.tasks.length,0);assert.equal(documents.has('zms_tasks/deleted'),false);
 mirror.setCollection('tasks',{deleted:mirror.recordTrack('tasks',base)});
 documents.set('zms_tasks/deleted',{...base,title:'Edited by another user',updatedAt:'2026-01-03'});
 assert.equal(await p.cloudsync.pull('merge'),false);assert.equal(p.cloudsync.conflicts().length,1);
 assert.equal(p.store.data.tasks.length,0);assert.equal(documents.get('zms_tasks/deleted').title,'Edited by another user');
 }finally{await close();}
});

test('reference dataset uploads retain remote additions and merge concurrent fields',async()=>{
 const {p,documents,mirror,close}=await syncFixture();try{
 const base={id:'person',name:'Original',email:'old@example.com',updatedAt:'1'};
 mirror.setCollection('people',{person:mirror.recordTrack('people',base)});
 documents.set('zms_people/data',{items:[{...base,email:'remote@example.com',updatedAt:'3'},{id:'other',name:'Added by another user',updatedAt:'3'}]});
 p.store.data.people=[{...base,name:'Local edit',updatedAt:'2'}];
 assert.equal(await p.cloudsync.push(),true);
 const rows=documents.get('zms_people/data').items;
 assert.equal(rows.length,2);assert.equal(rows.find(r=>r.id==='person').email,'remote@example.com');assert.equal(rows.find(r=>r.id==='person').name,'Local edit');
 }finally{await close();}
});
test('reference dataset overlapping edits raise a conflict and preserve both copies',async()=>{
 const {p,documents,mirror,close}=await syncFixture();try{
 const base={id:'person',name:'Original',updatedAt:'1'};
 mirror.setCollection('people',{person:mirror.recordTrack('people',base)});
 documents.set('zms_people/data',{items:[{...base,name:'Remote edit',updatedAt:'3'}]});
 p.store.data.people=[{...base,name:'Local edit',updatedAt:'2'}];
 assert.equal(await p.cloudsync.push(),false);assert.equal(p.store.data.people[0].name,'Local edit');
 assert.equal(documents.get('zms_people/data').items[0].name,'Remote edit');assert.equal(p.cloudsync.conflicts()[0].collection,'people');
 }finally{await close();}
});

test('sign-in events identify the new cloud user even before local session adoption',async()=>{
 const {c,p,documents,close}=await syncFixture();try{
 const auth={currentUser:{uid:'new-user'},signInWithEmailAndPassword:async()=>({user:{uid:'new-user',email:'new@example.com'}})};
 c.firebase.auth=()=>auth;
 documents.set('zms_auth_users/new-user',{displayName:'New User',role:'member',active:true});
 const result=await p.cloudsync.signInWithPassword({email:'new@example.com',password:'test-password'});
 assert.equal(result.uid,'new-user');
 const event=Array.from(documents.entries()).find(([key])=>key.startsWith('zms_account_events/'))[1];
 assert.equal(event.actor,'New User');assert.equal(event.actorUid,'new-user');assert.equal(event.actorRole,'member');assert.equal(event.target,'new@example.com');
 }finally{await close();}
});
test('typed dependencies enforce their own start or finish gate and retain signed lag',()=>{
 const {dom,p}=appFixture();try{
 for(const type of ['FS','SS','FF','SF']){
  const pred=p.repos.tasks.add({title:type+' predecessor',status:'todo',plannedSubtasks:0,startDate:'2026-01-01',dueDate:'2026-01-05'});
  const succ=p.repos.tasks.add({title:type+' successor',status:'todo',plannedSubtasks:0,startDate:'2026-01-03',dueDate:'2026-01-08',dependencies:[{id:pred.id,type,lag:-2}]});
  assert.deepEqual(JSON.parse(JSON.stringify(p.repos.tasks.dependenciesOf(succ.id))),[{id:pred.id,type,lag:-2}]);
  assert.equal(p.dependencies.blocking(p.store.data,succ,'inprogress').length,(type==='FS'||type==='SS')?1:0);
  assert.equal(p.dependencies.blocking(p.store.data,succ,'done').length,1);
  p.repos.tasks.setStatus(pred.id,'inprogress');
  assert.equal(p.dependencies.blocking(p.store.data,succ,'done').length,(type==='FS'||type==='FF')?1:0);
  p.repos.tasks.setStatus(pred.id,'done');assert.equal(p.dependencies.blocking(p.store.data,succ,'done').length,0);
  const n=p.store.data.activities.length;
  assert.ok(p.repos.tasks.update(succ.id,{dependencies:[{id:succ.id,type:'FS',lag:0}]}).error);
  assert.equal(p.store.data.activities.length,n,'refused links must not log a successful edit');
 }
 }finally{dom.window.close();}
});

test('subtask creation, status edits, comments and checklist changes enter the global activity timeline',()=>{
 const {dom,p}=appFixture();try{
 const task=p.repos.tasks.add({title:'Audit task',status:'todo'});
 const sub=p.repos.subtasks.add({taskId:task.id,title:'Audited subtask',status:'todo'});
 p.repos.subtasks.update(sub.id,{status:'done'});
 p.repos.tasks.update(task.id,{comments:[{id:'comment',text:'A note'}]});
 p.repos.tasks.update(task.id,{checklist:[{id:'check',text:'Check',done:true}]});
 const entries=p.activity.entries();
 assert.ok(entries.some(e=>e.entity==='subtask'&&e.action==='created'&&e.entityName==='Audited subtask'));
 assert.ok(entries.some(e=>e.entity==='subtask'&&e.action==='status'));
 assert.ok(entries.some(e=>e.entityId===task.id&&e.detail==='comments'));
 assert.ok(entries.some(e=>e.entityId===task.id&&e.detail==='checklist'));
 assert.ok(entries.every(e=>e.actor==='review-admin'||e.actor===''));
 }finally{dom.window.close();}
});

test('a legacy cleanup probe failure cannot hide successfully uploaded activity entries',async()=>{
 const {p,documents,control,mirror,close}=await syncFixture();try{
 p.store.data.activities=[{id:'acknowledged',actor:'Admin',updatedAt:'1'}];
 control.beforeRead=async key=>{if(key==='zms_projects/data')throw new Error('Cleanup probe interrupted');};
 assert.equal(await p.cloudsync.push(),false);
 assert.ok(documents.has('zms_activities/acknowledged'));assert.equal(mirror.forCollection('activities').acknowledged,true);
 control.beforeRead=null;
 control.beforeWrite=async key=>{if(key==='zms_activities/acknowledged'&&documents.has(key))throw new Error('Immutable event cannot be overwritten');};
 assert.equal(await p.cloudsync.push(),false,'no outstanding writes after successful clock publication');
 assert.equal(p.cloudsync.status().error,'Cleanup probe interrupted');
 }finally{await close();}
});

test('an in-flight task edit retains both its newer local field and concurrent cloud-only fields',async()=>{
 const {p,documents,mirror,control,close}=await syncFixture();try{
 const base={id:'task',title:'Original',description:'Original note',updatedAt:'1'};
 mirror.setCollection('tasks',{task:mirror.recordTrack('tasks',base)});
 documents.set('zms_tasks/task',{...base,description:'Other user note',updatedAt:'3'});
 p.store.data.tasks=[{...base,title:'First local title',updatedAt:'2'}];
 let release,entered;const blocked=new Promise(r=>release=r),started=new Promise(r=>entered=r);
 control.beforeRead=async key=>{if(key==='zms_tasks/task'){entered();await blocked;}};
 const upload=p.cloudsync.push();await started;p.store.data.tasks[0].title='Newest local title';p.store.data.tasks[0].updatedAt='4';release();
 assert.equal(await upload,true);control.beforeRead=null;
 assert.equal(p.store.data.tasks[0].title,'Newest local title');assert.equal(p.store.data.tasks[0].description,'Other user note');
 assert.equal(await p.cloudsync.push(),true);assert.equal(documents.get('zms_tasks/task').description,'Other user note');
 }finally{await close();}
});
test('an in-flight reference edit cannot erase remote additions on its next upload',async()=>{
 const {p,documents,mirror,control,close}=await syncFixture();try{
 const base={id:'person',name:'Original',email:'old@example.com',updatedAt:'1'};
 mirror.setCollection('people',{person:mirror.recordTrack('people',base)});
 documents.set('zms_people/data',{items:[{...base,email:'remote@example.com',updatedAt:'3'},{id:'new-person',name:'Other user addition',updatedAt:'3'}]});
 p.store.data.people=[{...base,name:'First local name',updatedAt:'2'}];
 let release,entered;const blocked=new Promise(r=>release=r),started=new Promise(r=>entered=r);
 control.beforeRead=async key=>{if(key==='zms_people/data'){entered();await blocked;}};
 const upload=p.cloudsync.push();await started;p.store.data.people[0].name='Newest local name';p.store.data.people[0].updatedAt='4';release();
 assert.equal(await upload,true);control.beforeRead=null;
 assert.equal(p.store.data.people.length,2);assert.equal(p.store.data.people[0].name,'Newest local name');assert.equal(p.store.data.people[0].email,'remote@example.com');
 assert.equal(await p.cloudsync.push(),true);assert.equal(documents.get('zms_people/data').items.length,2);
 }finally{await close();}
});

test('conflicting in-flight reference edits retain other users additions until explicit resolution',async()=>{
 const {p,documents,mirror,control,close}=await syncFixture();try{
 const base={id:'person',name:'Original',email:'old@example.com',updatedAt:'1'};
 mirror.setCollection('people',{person:mirror.recordTrack('people',base)});
 documents.set('zms_people/data',{items:[{...base,email:'remote@example.com',updatedAt:'3'},{id:'new-person',name:'Keep this addition',updatedAt:'3'}]});
 p.store.data.people=[{...base,name:'Local name',updatedAt:'2'}];
 let release,entered;const blocked=new Promise(r=>release=r),started=new Promise(r=>entered=r);
 control.beforeRead=async key=>{if(key==='zms_people/data'){entered();await blocked;}};
 const upload=p.cloudsync.push();await started;p.store.data.people[0].email='new-local@example.com';p.store.data.people[0].updatedAt='4';release();
 assert.equal(await upload,false);control.beforeRead=null;
 assert.equal(p.store.data.people.length,2);assert.equal(p.store.data.people[0].email,'new-local@example.com');
 assert.equal(p.cloudsync.conflicts().length,1);assert.equal(await p.cloudsync.push(),false);
 assert.equal(documents.get('zms_people/data').items[0].email,'remote@example.com');
 assert.equal(p.cloudsync.resolveConflict('people/person',true),true);
 assert.equal(await p.cloudsync.push(),true);assert.equal(documents.get('zms_people/data').items.length,2);
 assert.equal(documents.get('zms_people/data').items.find(r=>r.id==='person').email,'new-local@example.com');
 }finally{await close();}
});
