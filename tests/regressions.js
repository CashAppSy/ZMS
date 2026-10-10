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
 for(const m of html.matchAll(/<script src="([^"]+)"><\/script>/g))if(m[1]!=='js/main.js')w.eval(read(m[1]));
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
