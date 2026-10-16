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
 const row=control.el.querySelector('.dep-row');assert.equal(row.querySelectorAll('label').length,2);
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
 const clock={now:Date.now()},polls=[];
 class Clock extends Date{constructor(...args){super(...(args.length?args:[clock.now]));}static now(){return clock.now;}}
 const c=context({Date:Clock,console:{error(){},warn(){},info(){}},setInterval:fn=>{polls.push(fn);return 1;},clearInterval(){},addEventListener(){},removeEventListener(){},document:{addEventListener(){},removeEventListener(){}}});
 c.firebase={apps:[],initializeApp:()=>({}),app:()=>({}),firestore:()=>firestore,auth:()=>({currentUser:{uid:user.cloudUid}})};
 Object.assign(c.PMS,{ids:{uuid:()=> 'page-id'},cloudConfig:{projectId:'demo'},auth:{currentUser:()=>user},bus:{on:()=>()=>{},emit(){}},i18n:{t:key=>key},toast:{show(){}},schema:{VERSION:1,defaultData:()=>({settings:{}})},store:{initialized:true,data:{meta:{},settings:{},users:[],tasks:[],projects:[],people:[],departments:[],subtasks:[]},commit:fn=>fn(c.PMS.store.data),flush:()=>Promise.resolve(),setData:data=>{c.PMS.store.data=structuredClone(data);}}});
 c.load('js/services/sync-mirror.js');c.load('js/services/sync-firestore.js');
 await c.PMS.cloudsync.enable();
 return {c,p:c.PMS,documents,queries,writes,control,clock,mirror:c.PMS.syncMirror.create('pms-cloud-mirror'),poll:()=>{clock.now+=4000;return polls[polls.length-1]();},close:()=>c.PMS.cloudsync.disable()};
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

test('unconnected dated tasks never display a confirmed critical path or invented slack',()=>{
 const {dom,p}=appFixture();try{
 p.store.data.tasks=[{id:'long',title:'Independent long work',startDate:'2026-10-05',dueDate:'2027-01-03',status:'todo',dependencies:[]},{id:'short',title:'Independent short work',startDate:'2026-10-05',dueDate:'2026-10-06',status:'todo',dependencies:[]}];
 const result=p.dependencies.analyzeCached(p.store.data);assert.equal(result.hasNetwork,false);
 for(const row of p.store.data.tasks){assert.equal(p.dependencies.isCritical(result,row.id),false);assert.equal(p.dependencies.slackOf(result,row.id),null);assert.equal(p.vformat.depMarkers(p.store.data,row,result).length,0);}
 const notice=p.vformat.networkNotice(result);assert.equal(notice.textContent,p.i18n.t('deps.noNetwork'));
 }finally{dom.window.close();}
});
test('critical path with missing dates is visibly estimated and cycles have a distinct notice',()=>{
 const {dom,p}=appFixture();try{
 const data={tasks:[{id:'a',title:'A'},{id:'b',title:'B',dependencies:[{id:'a',type:'FS',lag:0}]}]};
 const result=p.dependencies.analyze(data);assert.equal(result.estimated,true);assert.equal(result.hasNetwork,true);
 for(const lang of ['en','ar']){
  p.i18n.setLang(lang);assert.ok(p.vformat.depMarkers(data,data.tasks[1],result).some(n=>n.textContent.includes(p.i18n.t('deps.criticalEstimate'))));
  assert.equal(p.vformat.networkNotice(result).textContent,p.i18n.t('deps.estimateHint'));
 }
 data.tasks[0].dependencies=['b'];const cycle=p.dependencies.analyze(data);
 assert.equal(p.vformat.networkNotice(cycle).textContent,p.i18n.t('deps.cyclicAnalysis'));assert.equal(p.dependencies.isCritical(cycle,'a'),false);
 }finally{dom.window.close();}
});
test('critical arrows mark binding constraints rather than just two critical endpoints',()=>{
 const c=context();c.PMS.utils.parseDate=s=>s?new Date(s):null;c.load('js/services/dependencies.js');
 const data={tasks:[{id:'a',startDate:'2026-01-01',dueDate:'2026-01-02'},{id:'b',startDate:'2026-01-01',dueDate:'2026-01-02',dependencies:[{id:'a',type:'SS',lag:-1}]}]};
 const analysis=c.PMS.dependencies.analyze(data),edge=c.PMS.dependencies.edges(data)[0];
 assert.equal(c.PMS.dependencies.isCritical(analysis,'a'),true);assert.equal(c.PMS.dependencies.isCritical(analysis,'b'),true);
 assert.equal(c.PMS.dependencies.isCriticalEdge(analysis,edge),false);
 data.tasks[1].dependencies[0].lag=0;assert.equal(c.PMS.dependencies.isCriticalEdge(c.PMS.dependencies.analyze(data),c.PMS.dependencies.edges(data)[0]),true);
});
test('dependency date checks match the inclusive-day durations used by critical path analysis',()=>{
 const c=context();c.PMS.utils.parseDate=s=>s?new Date(s):null;c.load('js/services/dependencies.js');const d=c.PMS.dependencies;
 assert.equal(d.isSatisfied({type:'FS',lag:0},{dueDate:'2026-01-02'},{startDate:'2026-01-02'}),false);
 assert.equal(d.isSatisfied({type:'FS',lag:0},{dueDate:'2026-01-02'},{startDate:'2026-01-03'}),true);
 assert.equal(d.isSatisfied({type:'FS',lag:-1},{dueDate:'2026-01-02'},{startDate:'2026-01-02'}),true);
 assert.equal(d.isSatisfied({type:'SF',lag:0},{startDate:'2026-01-03'},{dueDate:'2026-01-02'}),true);
 assert.equal(d.isSatisfied({type:'SF',lag:1},{startDate:'2026-01-03'},{dueDate:'2026-01-02'}),false);
});
test('successful pulls do not hide a failed upload and polling retries pending records automatically',async()=>{
 const {p,documents,control,poll,close}=await syncFixture();try{
 documents.set('zms_meta/state',{updatedAt:'2026-01-01'});
 p.store.data.tasks=[{id:'local',title:'Must reach the other user',updatedAt:'1'}];
 control.beforeWrite=async key=>{if(key==='zms_tasks/local')throw Object.assign(new Error('Temporary network failure'),{code:'unavailable'});};
 assert.equal(await p.cloudsync.push(),false);assert.equal(p.cloudsync.status().error,'unavailable');assert.equal(p.cloudsync.status().pending,true);
 assert.equal(await p.cloudsync.pull('merge'),true);assert.equal(p.cloudsync.status().error,'unavailable');assert.equal(p.cloudsync.status().pending,true);
 control.beforeWrite=null;await poll();
 assert.equal(documents.get('zms_tasks/local').title,'Must reach the other user');assert.equal(p.cloudsync.status().pending,false);assert.equal(p.cloudsync.status().error,null);
 }finally{await close();}
});
test('the save indicator differentiates pending cloud uploads from confirmed reconciliation',()=>{
 const {dom,w,p}=appFixture();try{
 p.app.applyLocale();p.cloudsync.status=()=>({pending:true,error:null,unavailableCollections:[]});p.bus.emit('cloud:state',{});
 assert.ok(w.document.getElementById('save-indicator').textContent.includes(p.i18n.t('save.cloudPending')));
 assert.equal(w.document.getElementById('save-indicator').classList.contains('ok'),false);
 }finally{dom.window.close();}
});

test('manager tasks missing from an admin export propagate after automatic retry without losing the existing 52 tasks',async()=>{
 const shared=new Map([['zms_meta/state',{updatedAt:'2026-01-01'}],['zms_projects/foreign',{id:'foreign',name:'Foreign pillar',managerId:'admin-person',updatedAt:'2026-01-01'}]]);
 for(let i=0;i<52;i++)shared.set('zms_tasks/existing-'+i,{id:'existing-'+i,title:'Existing '+i,projectId:'foreign',assignees:[],updatedAt:'2026-01-01'});
 const manager=await syncFixture({id:'manager-local',cloudUid:'manager',role:'manager',personId:'manager-person'},shared);
 const admin=await syncFixture(undefined,shared);
 try{
  assert.equal(manager.p.store.data.tasks.length,52);assert.equal(admin.p.store.data.tasks.length,52);
  for(const [id,title]of [['task-test','Task Test'],['test-4','Test 4']])manager.p.store.data.tasks.push({id,title,projectId:'foreign',assignees:['admin-person'],createdByPersonId:'manager-person',createdByCloudUid:'manager',updatedAt:'2026-01-02'});
  manager.control.beforeWrite=async key=>{if(key==='zms_tasks/task-test'||key==='zms_tasks/test-4')throw Object.assign(new Error('Upload interrupted'),{code:'unavailable'});};
  assert.equal(await manager.p.cloudsync.push(),false);
  await admin.p.cloudsync.pull('merge');assert.equal(admin.p.store.data.tasks.length,52);
  await manager.p.cloudsync.pull('merge');assert.equal(manager.p.store.data.tasks.length,54);assert.equal(manager.p.cloudsync.status().error,'unavailable');
  manager.control.beforeWrite=null;await manager.poll();await admin.poll();
  assert.equal(admin.p.store.data.tasks.length,54);assert.equal(manager.p.cloudsync.status().pending,false);
  for(const title of ['Task Test','Test 4'])assert.ok(admin.p.store.data.tasks.some(task=>task.title===title));
  assert.equal(new Set(admin.p.store.data.tasks.map(task=>task.id)).size,54);
 }finally{await manager.close();await admin.close();}
});

test('an old timestamp-only mirror cannot silently delete a manager task absent from the cloud',async()=>{
 const {p,documents,mirror,close}=await syncFixture({id:'manager-local',cloudUid:'manager',role:'manager',personId:'manager-person'});try{
 documents.set('zms_meta/state',{updatedAt:'2026-01-03'});
 const task={id:'manager-only',title:'Task Test',createdByCloudUid:'manager',createdByPersonId:'manager-person',updatedAt:'2026-01-02'};
 p.store.data.tasks=[task];mirror.setCollection('tasks',{'manager-only':{updatedAt:task.updatedAt,status:'todo'}});
 assert.equal(await p.cloudsync.pull('merge'),false);assert.equal(p.store.data.tasks.length,1);assert.equal(p.store.data.tasks[0].title,'Task Test');
 assert.equal(p.cloudsync.conflicts().length,1);assert.equal(p.cloudsync.resolveConflict('tasks/manager-only',true),true);
 assert.equal(await p.cloudsync.push(),true);assert.equal(documents.get('zms_tasks/manager-only').title,'Task Test');
 }finally{await close();}
});

test('read-only normalization differences do not keep manager synchronization pending forever',async()=>{
 const {p,documents,mirror,close}=await syncFixture({id:'manager-local',cloudUid:'manager',role:'manager',personId:'manager-person'});try{
 const base={id:'foreign',title:'Read-only work',projectId:'foreign-pillar',assignees:['other-person'],status:'todo',updatedAt:'1'};
 documents.set('zms_tasks/foreign',base);p.store.data.tasks=[{...base,plannedSubtasks:10,calculatedProgress:0}];
 mirror.setCollection('tasks',{foreign:mirror.recordTrack('tasks',base)});
 assert.equal(p.cloudsync.status().pending,false);
 p.store.data.tasks[0].assignees=['manager-person'];mirror.setCollection('tasks',{foreign:mirror.recordTrack('tasks',{...base,assignees:['manager-person']})});
 assert.equal(p.cloudsync.status().pending,false);
 p.store.data.tasks[0].status='inprogress';assert.equal(p.cloudsync.status().pending,true);
 }finally{await close();}
});
test('a manager without a person link can synchronize deletion of its own UID-attributed record',async()=>{
 const {p,documents,mirror,close}=await syncFixture({id:'manager-local',cloudUid:'manager',role:'manager',personId:null});try{
 const base={id:'own',title:'Own record',createdByCloudUid:'manager',updatedAt:'1'};
 documents.set('zms_tasks/own',base);mirror.setCollection('tasks',{own:mirror.recordTrack('tasks',base)});
 assert.equal(p.cloudsync.status().pending,true);assert.equal(await p.cloudsync.push(),true);assert.equal(documents.has('zms_tasks/own'),false);
 }finally{await close();}
});

test('periodic reconciliation discovers manager tasks even when an interrupted upload left the shared clock unchanged',async()=>{
 const shared=new Map([['zms_meta/state',{updatedAt:'2026-01-01'}]]);
 for(let i=0;i<52;i++)shared.set('zms_tasks/original-'+i,{id:'original-'+i,title:'Original '+i,updatedAt:'2026-01-01'});
 const admin=await syncFixture(undefined,shared);try{
  assert.equal(admin.p.store.data.tasks.length,52);
  shared.set('zms_tasks/task-test',{id:'task-test',title:'Task Test',createdByCloudUid:'manager',updatedAt:'2026-01-02'});
  shared.set('zms_tasks/test-4',{id:'test-4',title:'Test 4',createdByCloudUid:'manager',updatedAt:'2026-01-02'});
  admin.clock.now+=6*60*60000;await admin.poll();
  assert.equal(shared.get('zms_meta/state').updatedAt,'2026-01-01');
  assert.equal(admin.p.store.data.tasks.length,54);assert.ok(admin.p.store.data.tasks.some(t=>t.title==='Task Test'));assert.ok(admin.p.store.data.tasks.some(t=>t.title==='Test 4'));
 }finally{await admin.close();}
});

test('quota exhaustion pauses cloud reads and writes across reloads while retaining pending edits',async()=>{
 const f=await syncFixture();try{
  f.p.store.data.tasks=[{id:'offline-task',title:'Keep locally',updatedAt:'2026-01-02'}];
  let reads=0;f.control.beforeRead=async()=>{reads++;throw Object.assign(new Error('Quota exceeded'),{code:'resource-exhausted'});};
  assert.equal(await f.p.cloudsync.pull('merge'),false);assert.equal(reads,1);
  for(let i=0;i<10;i++){await f.poll();await f.p.cloudsync.push();await f.p.cloudsync.pull('merge');}
  assert.equal(reads,1);assert.equal(f.p.store.data.tasks[0].title,'Keep locally');assert.equal(f.p.cloudsync.status().pending,true);
  // A new sync module in the same browser must respect the saved deadline.
  await f.p.cloudsync.disable();f.c.load('js/services/sync-firestore.js');
  await f.p.cloudsync.enable();assert.equal(reads,1);
  f.control.beforeRead=null;f.clock.now+=30*60000;
  await f.p.cloudsync.push();assert.equal(f.documents.get('zms_tasks/offline-task').title,'Keep locally');
 }finally{await f.close();}
});

test('unchanged data does not reread the complete history each minute and hidden tabs do not poll',async()=>{
 const shared=new Map([['zms_meta/state',{updatedAt:'2026-01-01'}],['zms_tasks/task',{id:'task',title:'Task',updatedAt:'2026-01-01'}],['zms_activities/event',{id:'event'}]]);
 const f=await syncFixture(undefined,shared);try{
  const initial=f.queries.length;
  for(let i=0;i<100;i++)await f.poll();
  assert.equal(f.queries.length,initial);
  let reads=0;f.control.beforeRead=async()=>{reads++;};f.c.document.hidden=true;
  f.clock.now+=6*60*60000;await f.poll();assert.equal(reads,0);
  f.c.document.hidden=false;await f.poll();assert.ok(f.queries.length>initial);
 }finally{await f.close();}
});

test('editing a task does not transact unchanged reference datasets',async()=>{
 const person={id:'person',name:'Person'};
 const shared=new Map([['zms_meta/state',{updatedAt:'2026-01-01'}],['zms_people/data',{items:[person]}],['zms_tasks/task',{id:'task',title:'Task',updatedAt:'2026-01-01'}]]);
 const f=await syncFixture(undefined,shared);try{
  const reads=[];f.control.beforeRead=async key=>{reads.push(key);};
  f.p.store.data.tasks[0].title='Edited';f.p.store.data.tasks[0].updatedAt='2026-01-02';
  assert.equal(await f.p.cloudsync.push(),true);
  assert.equal(reads.includes('zms_people/data'),false);assert.equal(f.documents.get('zms_people/data').items[0].name,'Person');
  assert.equal(f.documents.get('zms_tasks/task').title,'Edited');
 }finally{await f.close();}
});

async function incrementalPair(){
 const shared=new Map([['zms_meta/state',{updatedAt:'2026-01-01'}]]);
 for(let i=0;i<52;i++)shared.set('zms_tasks/task-'+i,{id:'task-'+i,title:'Task '+i,description:'Original',updatedAt:'2026-01-01'});
 for(let i=0;i<502;i++)shared.set('zms_activities/event-'+i,{id:'event-'+i,entityName:'Task '+i,createdAt:'2026-01-01'});
 const writer=await syncFixture(undefined,shared);
 writer.p.store.data.tasks[0].title='Initial hint';writer.p.store.data.tasks[0].updatedAt='2026-01-02';await writer.p.cloudsync.push();
 const reader=await syncFixture(undefined,shared);
 return {writer,reader,shared,close:async()=>{await writer.close();await reader.close();}};
}

test('incremental pulls read only changed tasks and new activity without reloading 502 events',async()=>{
 const f=await incrementalPair();try{
  const queries=f.reader.queries.length,reads=[];
  f.reader.control.beforeRead=async key=>{reads.push(key);};
  const row=f.writer.p.store.data.tasks.find(t=>t.id==='task-0');row.title='Updated';row.updatedAt='2026-01-03';
  f.writer.p.store.data.activities.push({id:'new-event',entityName:'New action',createdAt:'2026-01-03'});
  assert.equal(await f.writer.p.cloudsync.push(),true);await f.reader.poll();
  assert.equal(f.reader.p.store.data.tasks.find(t=>t.id==='task-0').title,'Updated');
  assert.equal(f.reader.p.store.data.tasks.length,52);assert.equal(f.reader.p.store.data.activities.length,503);
  assert.equal(f.reader.queries.length,queries);assert.deepEqual(reads.sort(),['zms_activities/new-event','zms_meta/state','zms_tasks/task-0'].sort());
 }finally{await f.close();}
});

test('incremental deletion removes only acknowledged deleted records and preserves other history',async()=>{
 const f=await incrementalPair();try{
  f.writer.p.store.data.tasks=f.writer.p.store.data.tasks.filter(t=>t.id!=='task-1');
  f.writer.p.store.data.activities=f.writer.p.store.data.activities.filter(t=>t.id!=='event-1');
  f.writer.p.store.data.activityDeletedIds=['event-1'];
  const queries=f.reader.queries.length;
  assert.equal(await f.writer.p.cloudsync.push(),true);await f.reader.poll();
  assert.equal(f.reader.p.store.data.tasks.length,51);assert.equal(f.reader.p.store.data.activities.length,501);
  assert.equal(f.reader.p.store.data.tasks.some(t=>t.id==='task-1'),false);assert.equal(f.reader.p.store.data.activities.some(t=>t.id==='event-1'),false);
  assert.equal(f.reader.queries.length,queries);
 }finally{await f.close();}
});

test('incremental pulls merge pending local fields and detect overlapping conflicts',async()=>{
 const f=await incrementalPair();try{
  const local=f.reader.p.store.data.tasks.find(t=>t.id==='task-0');local.description='Local edit';local.updatedAt='2026-01-04';
  const remote=f.writer.p.store.data.tasks.find(t=>t.id==='task-0');remote.title='Remote title';remote.updatedAt='2026-01-03';
  await f.writer.p.cloudsync.push();await f.reader.poll();
  assert.equal(f.shared.get('zms_tasks/task-0').description,'Local edit');assert.equal(f.shared.get('zms_tasks/task-0').title,'Remote title');
  await f.writer.p.cloudsync.pull('merge');await f.reader.p.cloudsync.pull('merge');
  f.writer.p.store.data.tasks.find(t=>t.id==='task-0').title='Their next edit';
  f.reader.p.store.data.tasks.find(t=>t.id==='task-0').title='My next edit';
  await f.writer.p.cloudsync.push();await f.reader.poll();
  assert.equal(f.reader.p.cloudsync.conflicts().length,1);assert.equal(f.reader.p.store.data.tasks.find(t=>t.id==='task-0').title,'My next edit');
 }finally{await f.close();}
});

test('clock-only older clients invalidate incremental hints and trigger a complete safe merge',async()=>{
 const f=await incrementalPair();try{
  f.shared.set('zms_tasks/task-2',{...f.shared.get('zms_tasks/task-2'),title:'Older client edit',updatedAt:'2026-02-01'});
  f.shared.set('zms_meta/state',{...f.shared.get('zms_meta/state'),updatedAt:'2026-02-01'});
  const queries=f.reader.queries.length;await f.reader.poll();
  assert.ok(f.reader.queries.length>queries);assert.equal(f.reader.p.store.data.tasks.find(t=>t.id==='task-2').title,'Older client edit');
  assert.equal(f.reader.p.store.data.activities.length,502);
 }finally{await f.close();}
});

test('a client missing the bounded change window safely falls back to full reconciliation',async()=>{
 const f=await incrementalPair();try{
  for(let i=0;i<22;i++){
   const t=f.writer.p.store.data.tasks.find(t=>t.id==='task-0');t.title='Edit '+i;t.updatedAt='2026-02-'+String(i+1).padStart(2,'0');
   assert.equal(await f.writer.p.cloudsync.push(),true);
  }
  assert.equal(f.shared.get('zms_meta/state').syncJournal.batches.length,20);
  const queries=f.reader.queries.length;await f.reader.poll();
  assert.ok(f.reader.queries.length>queries);assert.equal(f.reader.p.store.data.tasks.find(t=>t.id==='task-0').title,'Edit 21');
  assert.equal(f.reader.p.store.data.activities.length,502);
 }finally{await f.close();}
});

test('an interrupted clock publish retains change hints for a later retry',async()=>{
 const f=await incrementalPair();try{
  f.writer.control.beforeWrite=async key=>{if(key==='zms_meta/state')throw Object.assign(new Error('Clock interrupted'),{code:'unavailable'});};
  const t=f.writer.p.store.data.tasks.find(t=>t.id==='task-0');t.title='Acknowledged before clock';t.updatedAt='2026-03-01';
  assert.equal(await f.writer.p.cloudsync.push(),false);assert.equal(f.shared.get('zms_tasks/task-0').title,t.title);
  f.writer.control.beforeWrite=null;assert.equal(await f.writer.p.cloudsync.push(),true);
  const queries=f.reader.queries.length;await f.reader.poll();
  assert.equal(f.reader.queries.length,queries);assert.equal(f.reader.p.store.data.tasks.find(t=>t.id==='task-0').title,'Acknowledged before clock');
 }finally{await f.close();}
});

test('legacy wrappers are retained until their records actually exist in Firestore',async()=>{
 const shared=new Map([['zms_meta/state',{updatedAt:'2026-01-01'}],['zms_tasks/data',{items:[{id:'legacy',title:'Only backup',updatedAt:'2026-01-01'}]}]]);
 const f=await syncFixture(undefined,shared);try{
  assert.ok(shared.has('zms_tasks/data'));assert.equal(shared.has('zms_tasks/legacy'),false);
  assert.equal(f.p.store.data.tasks[0].title,'Only backup');
  await f.p.cloudsync.push();assert.ok(shared.has('zms_tasks/data'));
 }finally{await f.close();}
});

test('activity renders in automatic scroll batches while preserving the complete history',async()=>{
 const {dom,w,p}=appFixture();let callback,disconnects=0;
 try{
  w.IntersectionObserver=class{constructor(fn){callback=fn;}observe(){}disconnect(){disconnects++;}};
  p.activity.refreshAccountEvents=()=>Promise.resolve([]);
  p.store.data.activities=Array.from({length:250},(_,i)=>({id:'history-'+i,entity:'task',actor:'User',at:'2026-01-01'}));
  const root=w.document.getElementById('view-root'),cleanup=p.registry.getView('activity').render(root);
  assert.equal(root.querySelectorAll('.act-row').length,100);
  callback([{isIntersecting:true}]);assert.equal(root.querySelectorAll('.act-row').length,200);
  callback([{isIntersecting:true}]);assert.equal(root.querySelectorAll('.act-row').length,250);
  assert.equal(p.activity.entries().length,250);cleanup();assert.ok(disconnects>0);
 }finally{dom.window.close();}
});

test('account audit reads coalesce simultaneous requests and cache repeated refreshes',async()=>{
 const f=await syncFixture();try{
  f.documents.set('zms_account_events/event',{id:'event',actor:'Member',at:'2026-01-01'});
  await Promise.all([f.p.cloudsync.accountEvents(),f.p.cloudsync.accountEvents(),f.p.cloudsync.accountEvents()]);
  for(let i=0;i<5;i++)await f.p.cloudsync.accountEvents();
  assert.equal(f.queries.filter(q=>q[0]==='zms_account_events').length,1);
  f.clock.now+=60000;await f.p.cloudsync.accountEvents();assert.equal(f.queries.filter(q=>q[0]==='zms_account_events').length,2);
  assert.equal(f.p.store.data.accountEvents[0].actor,'Member');
 }finally{await f.close();}
});

test('quota recovery verifies collection reads even when the shared clock did not change',async()=>{
 const shared=new Map([['zms_meta/state',{updatedAt:'2026-01-01'}],['zms_tasks/task',{id:'task',title:'Preserved',updatedAt:'2026-01-01'}]]);
 const f=await syncFixture(undefined,shared);try{
  f.control.beforeRead=async()=>{throw Object.assign(new Error('Quota'),{code:'resource-exhausted'});};
  assert.equal(await f.p.cloudsync.pull(),false);assert.equal(f.p.cloudsync.status().error,'resource-exhausted');
  f.control.beforeRead=null;f.clock.now+=30*60000;const queries=f.queries.length;await f.poll();
  assert.ok(f.queries.length>queries);assert.equal(f.p.cloudsync.status().error,null);assert.equal(f.p.store.data.tasks[0].title,'Preserved');
 }finally{await f.close();}
});

test('malformed incremental hints fall back to complete reads without discarding cached history',async()=>{
 const f=await incrementalPair();try{
  const state=f.shared.get('zms_meta/state');state.syncJournal.revision='broken';state.syncJournal.batches=[{revision:'broken',changes:{tasks:'not-an-array'}}];
  f.shared.set('zms_tasks/task-2',{...f.shared.get('zms_tasks/task-2'),title:'Recovered by full read'});
  const queries=f.reader.queries.length;await f.reader.poll();
  assert.ok(f.reader.queries.length>queries);assert.equal(f.reader.p.store.data.tasks.find(t=>t.id==='task-2').title,'Recovered by full read');
  assert.equal(f.reader.p.store.data.activities.length,502);
 }finally{await f.close();}
});

test('a stale legacy wrapper never overrides a modern task status regardless of document order',async()=>{
 for(const wrapperFirst of [true,false]){
  const shared=new Map([['zms_meta/state',{updatedAt:'2026-01-02'}]]);
  const legacy=['zms_tasks/data',{items:[{id:'task',title:'Old',status:'todo',updatedAt:'2026-01-01'},{id:'legacy-only',title:'Preserve fallback',updatedAt:'2026-01-01'}]}];
  const modern=['zms_tasks/task',{id:'task',title:'Current',status:'inprogress',updatedAt:'2026-01-02'}];
  for(const [key,value] of wrapperFirst?[legacy,modern]:[modern,legacy])shared.set(key,value);
  const f=await syncFixture(undefined,shared);try{
   const task=f.p.store.data.tasks.find(t=>t.id==='task');assert.equal(task.status,'inprogress');assert.equal(task.title,'Current');
   assert.equal(f.p.store.data.tasks.filter(t=>t.id==='task').length,1);assert.ok(f.p.store.data.tasks.some(t=>t.id==='legacy-only'));
  }finally{await f.close();}
 }
});


test('reference merges never introduce undefined timestamps into Firestore payloads',()=>{
 const c=context();c.load('js/services/sync-mirror.js');const m=c.PMS.syncMirror.create('test');
 const base={id:'todo',name:{en:'To do'},color:'#888'};
 const merged=m.mergeRecord(base,{...base,name:{en:'Ready'}},{...base,color:'#999'});
 assert.equal(merged.name.en,'Ready');assert.equal(merged.color,'#999');
 assert.equal(Object.prototype.hasOwnProperty.call(merged,'updatedAt'),false);
 const untouched=m.mergeRecord(base,base,{...base,color:'#999'});
 assert.equal(Object.prototype.hasOwnProperty.call(untouched,'updatedAt'),false);
 assert.deepEqual(JSON.parse(JSON.stringify(merged)),JSON.parse(JSON.stringify({...base,name:{en:'Ready'},color:'#999'})));
});


test('simple dependency fields omit lag, preserve legacy offsets and reset offsets for a replacement task',()=>{
 const {dom,w,p}=appFixture();try{
 const a=p.repos.tasks.add({title:'Alpha'}),b=p.repos.tasks.add({title:'Beta'}),c=p.repos.tasks.add({title:'Gamma'});
 for(const lang of ['en','ar']){
  p.i18n.setLang(lang);
  const control=p.forms.buildControl({type:'dependencies',excludeId:b.id},[{id:a.id,type:'FF',lag:-2}]);
  assert.equal(control.el.querySelectorAll('input[type=number]').length,0);
  assert.equal(control.getValue()[0].lag,-2);assert.ok(control.el.querySelector('.dep-explanation').textContent.includes('-2'));
  control.el.querySelector(':scope > button').click();
  const rows=control.el.querySelectorAll('.dep-row'),added=rows[1].querySelector('select');added.value=c.id;added.dispatchEvent(new w.Event('change'));
  assert.equal(control.getValue()[1].lag,0);
  rows[1].querySelector('button').click();
  const who=rows[0].querySelector('select');who.value=c.id;who.dispatchEvent(new w.Event('change'));
  assert.equal(control.getValue()[0].lag,0);assert.ok(!rows[0].querySelector('.dep-explanation').textContent.includes('-2'));
 }
 }finally{dom.window.close();}
});

test('dependency summaries distinguish both directions and identify connected tasks',()=>{
 const {dom,p}=appFixture();try{
 const a=p.repos.tasks.add({title:'Predecessor task'}),b=p.repos.tasks.add({title:'Current task'}),c=p.repos.tasks.add({title:'Successor task'});
 p.repos.tasks.addDependency(b.id,a.id,'FS',0);p.repos.tasks.addDependency(c.id,b.id,'FS',0);
 for(const lang of ['en','ar']){
  p.i18n.setLang(lang);const summary=p.vformat.depSummary(p.store.data,p.repos.tasks.get(b.id),p.utils.taskNumbers(p.store.data));
  assert.ok(summary.textContent.includes(p.i18n.t('deps.predecessor')));
  assert.ok(summary.textContent.includes(p.i18n.t('deps.successor')));
  assert.ok(summary.textContent.includes('Predecessor task'));
  assert.ok([...summary.querySelectorAll('[title]')].some(el=>el.title.includes('Successor task')));
 }
 }finally{dom.window.close();}
});

test('Gantt combines task filters, preserves them on rerender and clears without changing data',()=>{
 const {dom,w,p}=appFixture();try{
  const project=p.repos.projects.add({name:'Filter pillar'}),person=p.repos.people.add({name:'Owner'});
  const alpha=p.repos.tasks.add({title:'Gantt Alpha',projectId:project.id,status:'todo',priority:'high',assignees:[person.id],startDate:'2026-10-01',dueDate:'2026-10-10'});
  p.repos.tasks.add({title:'Gantt Beta',status:'done',priority:'low',dueDate:'2026-10-12'});
  const root=w.document.getElementById('view-root'),view=p.registry.getView('tasks-gantt');let off=view.render(root);
  const before=JSON.stringify(p.store.data.tasks),bar=root.querySelector('.filter-bar'),selects=bar.querySelectorAll('select');
  bar.querySelector('input').value='Alpha';selects[0].value=project.id;selects[1].value='todo';selects[2].value='high';selects[3].value=person.id;
  [...bar.querySelectorAll('button')].find(b=>b.textContent===p.i18n.t('common.apply')).click();
  assert.equal(root.querySelectorAll('.gantt-bar').length,1);assert.equal(root.querySelector('.gantt-bar').dataset.id,alpha.id);
  assert.ok(root.querySelector('.gantt-summary').textContent.includes('1'));
  off();off=view.render(root);assert.equal(root.querySelector('.filter-bar input').value,'Alpha');
  assert.equal(root.querySelectorAll('.gantt-bar').length,1);
  [...root.querySelectorAll('.filter-bar button')].find(b=>b.textContent===p.i18n.t('common.clear')).click();
  assert.equal(root.querySelectorAll('.gantt-bar').length,2);assert.equal(JSON.stringify(p.store.data.tasks),before);off();
 }finally{dom.window.close();}
});

test('Gantt shows undated and reversed-date tasks without fictional schedule bars and retains due-only tasks',()=>{
 const {dom,w,p}=appFixture();try{
  p.repos.tasks.add({title:'Undated task'});
  const reversed=p.repos.tasks.add({title:'Reversed task',startDate:'2026-10-20',dueDate:'2026-10-10'});
  const due=p.repos.tasks.add({title:'Due only',dueDate:'2026-12-10'});
  // Import-shaped reversed ranges can still arrive even if editing validates them.
  if(reversed.error)p.store.data.tasks.push({id:'reversed',title:'Reversed task',startDate:'2026-10-20',dueDate:'2026-10-10'});
  const root=w.document.getElementById('view-root'),off=p.registry.getView('tasks-gantt').render(root);
  assert.equal(root.querySelectorAll('.gantt-bar').length,1);assert.equal(root.querySelector('.gantt-bar').dataset.id,due.id);
  assert.equal(root.querySelectorAll('.gantt-unscheduled').length,2);
  assert.ok(parseFloat(root.querySelector('.gantt-bar').style.left)>=0);
  assert.equal(root.querySelector('.gantt-root').getAttribute('tabindex'),'0');off();
 }finally{dom.window.close();}
});

test('Gantt draws links only between matching tasks and shows a useful filtered empty state',()=>{
 const {dom,w,p}=appFixture();try{
  const a=p.repos.tasks.add({title:'Keep predecessor',startDate:'2026-10-01',dueDate:'2026-10-03'});
  p.repos.tasks.add({title:'Other successor',startDate:'2026-10-04',dueDate:'2026-10-06',dependencies:[{id:a.id,type:'FS',lag:0}]});
  const root=w.document.getElementById('view-root'),off=p.registry.getView('tasks-gantt').render(root);
  assert.equal(root.querySelectorAll('.gantt-links path').length,1);
  function search(value){root.querySelector('.filter-bar input').value=value;[...root.querySelectorAll('.filter-bar button')].find(b=>b.textContent===p.i18n.t('common.apply')).click();}
  search('Keep');assert.equal(root.querySelectorAll('.gantt-links path').length,0);
  search('No matches');assert.ok(root.querySelector('.empty-state').textContent.includes(p.i18n.t('gantt.noMatches')));
  assert.equal(root.querySelector('.empty-state button'),null);off();
 }finally{dom.window.close();}
});


test('Gantt opens near today and preserves the calendar position when older tasks arrive',()=>{
 const {dom,w,p}=appFixture();try{
  const day=86400000,today=p.utils.parseDate(p.utils.todayISO());
  const date=n=>p.utils.toISODate(new Date(today.getTime()+n*day));
  p.repos.tasks.add({title:'Long schedule',startDate:date(-60),dueDate:date(60)});
  const root=w.document.getElementById('view-root'),view=p.registry.getView('tasks-gantt');let off=view.render(root);
  let chart=root.querySelector('.gantt-root'),scale=Number(chart.dataset.zoom);
  assert.equal(chart.scrollLeft,58*scale);
  chart.scrollLeft=10*scale;chart.scrollTop=40;
  p.store.data.tasks.push({id:'older',title:'Earlier history',startDate:date(-90),dueDate:date(-85)});
  off();off=view.render(root);chart=root.querySelector('.gantt-root');
  assert.equal(chart.scrollLeft,40*scale);assert.equal(chart.scrollTop,40);
  const zoom=root.querySelector('.page-header select');zoom.value='70';zoom.dispatchEvent(new w.Event('change'));
  assert.equal(root.querySelector('.gantt-root').scrollLeft,40*70);off();
 }finally{dom.window.close();}
});
