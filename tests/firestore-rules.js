"use strict";
const { test, before, after } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const { initializeTestEnvironment, assertSucceeds, assertFails } = require('@firebase/rules-unit-testing');
const { doc, setDoc, updateDoc, writeBatch, getDoc } = require('firebase/firestore');
let env;
before(async()=>{
  env=await initializeTestEnvironment({projectId:'demo-zms',firestore:{host:'127.0.0.1',port:8085,rules:fs.readFileSync(path.join(__dirname,'../firestore.rules'),'utf8')}});
  await env.withSecurityRulesDisabled(async c=>{
    const db=c.firestore();
    for(const [uid,profile] of Object.entries({admin:{role:'admin',active:true,personId:'admin-person'},member:{role:'member',active:true,personId:'member-person'},disabled:{role:'member',active:false,personId:null}}))await setDoc(doc(db,'zms_auth_users',uid),profile);
    await setDoc(doc(db,'zms_auth/bootstrap'),{firstUid:'admin'});
    await setDoc(doc(db,'zms_projects/project'),{managerId:'manager-person'});
  });
});
after(async()=>{if(env)await env.cleanup();});
test('member may edit display name but not authorization fields',async()=>{
 const db=env.authenticatedContext('member').firestore(),ref=doc(db,'zms_auth_users/member');
 await assertSucceeds(updateDoc(ref,{displayName:'Member'}));
 for(const patch of [{personId:'manager-person'},{role:'admin'},{active:false},{email:'other@example.com'}])await assertFails(updateDoc(ref,patch));
 await assertFails(updateDoc(doc(db,'zms_projects/project'),{title:'Unauthorized'}));
});
test('disabled member cannot reactivate itself or edit its profile',async()=>{
 const ref=doc(env.authenticatedContext('disabled').firestore(),'zms_auth_users/disabled');
 await assertFails(updateDoc(ref,{active:true}));await assertFails(updateDoc(ref,{displayName:'Disabled'}));
});
test('admin may assign a person and reactivate an account',async()=>{
 const db=env.authenticatedContext('admin').firestore();
 await assertSucceeds(updateDoc(doc(db,'zms_auth_users/member'),{personId:'manager-person'}));
 await assertSucceeds(updateDoc(doc(db,'zms_auth_users/disabled'),{active:true}));
});
test('later signup cannot claim admin or attach an arbitrary person',async()=>{
 const db=env.authenticatedContext('new-member').firestore(),ref=doc(db,'zms_auth_users/new-member');
 await assertFails(setDoc(ref,{role:'admin',personId:null}));
 await assertFails(setDoc(ref,{role:'member',personId:'manager-person'}));
 await assertSucceeds(setDoc(ref,{role:'member',personId:null,active:true,displayName:'New',email:'new@example.com',createdAt:'2026-01-01'}));
});
test('bootstrap is atomic and binds the first admin to its authenticated uid',async()=>{
 await env.clearFirestore();
 const db=env.authenticatedContext('first').firestore();
 await assertFails(setDoc(doc(db,'zms_auth_users/first'),{role:'admin',personId:null}));
 await assertFails(setDoc(doc(db,'zms_auth/bootstrap'),{firstUid:'other'}));
 const batch=writeBatch(db);batch.set(doc(db,'zms_auth_users/first'),{role:'admin',personId:null,active:true});batch.set(doc(db,'zms_auth/bootstrap'),{firstUid:'first'});
 await assertSucceeds(batch.commit());
 const other=env.authenticatedContext('second').firestore();
 await assertFails(setDoc(doc(other,'zms_auth_users/second'),{role:'admin',personId:null}));
 await assertFails(setDoc(doc(other,'zms_auth/bootstrap'),{firstUid:'second'}));
 await assertSucceeds(getDoc(doc(db,'zms_auth_users/first')));
});
