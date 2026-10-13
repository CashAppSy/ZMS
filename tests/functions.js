'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {createRequire}=require('node:module');
const functionsRequire=createRequire(path.join(__dirname,'../functions/package.json'));
function fixture(){
 const profiles=new Map([['admin',{role:'admin',active:true}],['member',{role:'member',active:true}],['disabled',{role:'admin',active:false}]]);
 const created=[],deleted=[],authUpdates=[];let failProfile=false;
 const ref=key=>({get:async()=>({exists:profiles.has(key),data:()=>profiles.get(key)}),set:async(data,opts)=>{if(failProfile&&key==='new-member')throw new Error('write failed');profiles.set(key,opts&&opts.merge?{...profiles.get(key),...data}:data);},delete:async()=>profiles.delete(key)});
 const db={
  doc:key=>ref(key.split('/')[1]),
  collection:()=>({where:()=>({get:async()=>({
   docs:[...profiles.entries()].filter(([,d])=>d.role==='admin').map(([id,d])=>({id,data:()=>d}))
  })})})
 };
 const admin={initializeApp(){},firestore:Object.assign(()=>db,{FieldValue:{serverTimestamp:()=> 'server-time'}}),auth:()=>({createUser:async options=>{created.push(options);return {uid:'new-member'};},deleteUser:async uid=>deleted.push(uid),updateUser:async(uid,patch)=>authUpdates.push({uid,patch})})};
 const c={exports:{},console,require:name=>name==='firebase-admin'?admin:name==='crypto'?require('node:crypto'):functionsRequire(name)};
 vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../functions/index.js'),'utf8'),c);
 return {f:c.exports,profiles,created,deleted,authUpdates,failProfile:()=>failProfile=true};
}
test('trusted account creation checks active admin, keeps person link and never signs in the caller',async()=>{
 const {f,profiles,created}=fixture();
 for(const uid of ['member','disabled',null])await assert.rejects(f.adminCreateUser.run({email:'person@example.com'},{auth:uid?{uid}:null}),e=>e.code==='permission-denied');
 assert.equal(created.length,0);
 const result=await f.adminCreateUser.run({email:' Person@Example.com ',name:'Person',personId:'person-id'},{auth:{uid:'admin'}});
 assert.equal(result.uid,'new-member');assert.equal(profiles.get('new-member').personId,'person-id');
 assert.equal(profiles.get('new-member').role,'member');assert.equal(created[0].email,'person@example.com');
 assert.ok(created[0].password.length>=12);assert.equal(profiles.get('admin').role,'admin');
});
test('failed profile creation removes the new authentication identity',async()=>{
 const {f,deleted,failProfile}=fixture();failProfile();
 await assert.rejects(f.adminCreateUser.run({email:'person@example.com'},{auth:{uid:'admin'}}),e=>e.code==='internal');
 assert.deepEqual(deleted,['new-member']);
});
test('the last active administrator cannot be disabled and legacy active admins count',async()=>{
 const {f,profiles,authUpdates}=fixture();
 await assert.rejects(f.adminSetActive.run({uid:'admin',active:false},{auth:{uid:'admin'}}),e=>e.code==='failed-precondition');
 assert.equal(authUpdates.length,0);assert.equal(profiles.get('admin').active,true);
 profiles.set('legacy-admin',{role:'admin'});
 await f.adminSetActive.run({uid:'admin',active:false},{auth:{uid:'admin'}});
 assert.equal(profiles.get('admin').active,false);assert.equal(authUpdates[0].patch.disabled,true);
});
