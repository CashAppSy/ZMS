"use strict";
const { test, before, after } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const { initializeTestEnvironment, assertSucceeds, assertFails } = require('@firebase/rules-unit-testing');
const { doc, setDoc, updateDoc, writeBatch, getDoc, deleteDoc, getDocs, query, collection, where } = require('firebase/firestore');
let env;
before(async()=>{
  env=await initializeTestEnvironment({projectId:'demo-zms',firestore:{host:'127.0.0.1',port:8085,rules:fs.readFileSync(path.join(__dirname,'../firestore.rules'),'utf8')}});
  await env.withSecurityRulesDisabled(async c=>{
    const db=c.firestore();
    for(const [uid,profile] of Object.entries({admin:{role:'admin',active:true,personId:'admin-person'},member:{role:'member',active:true,personId:'member-person'},manager:{role:'manager',active:true,personId:'manager-person'},disabled:{role:'member',active:false,personId:null}}))await setDoc(doc(db,'zms_auth_users',uid),profile);
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
test('creator cannot be rewritten to bypass delete permissions',async()=>{
 await env.withSecurityRulesDisabled(async c=>{
  for(const [col,rec] of Object.entries({zms_meetings:{attendees:[]},zms_tasks:{projectId:'project',assignees:[]},zms_projects:{managerId:'manager-person'}}))
   await setDoc(doc(c.firestore(),col,'other-created'),{...rec,createdByPersonId:'other-person'});
 });
 const db=env.authenticatedContext('manager').firestore();
 for(const col of ['zms_meetings','zms_tasks','zms_projects']){
  const ref=doc(db,col,'other-created');
  await assertFails(deleteDoc(ref));
  await assertFails(updateDoc(ref,{createdByPersonId:'manager-person'}));
  await assertFails(updateDoc(ref,{createdBy:'fake'}));
  await assertFails(updateDoc(ref,{createdByCloudUid:'manager'}));
  await assertSucceeds(updateDoc(ref,{title:'Allowed edit'}));
 }
 await assertFails(setDoc(doc(db,'zms_tasks/spoofed'),{projectId:'project',createdByPersonId:'other-person'}));
 await assertSucceeds(setDoc(doc(db,'zms_tasks/own'),{projectId:'project',createdByPersonId:'manager-person'}));
 await assertSucceeds(deleteDoc(doc(db,'zms_tasks/own')));
});
test('member reads only assigned/attended or own records and scoped queries work',async()=>{
 await env.withSecurityRulesDisabled(async c=>{
  for(const [col,field] of [['zms_tasks','assignees'],['zms_meetings','attendees']]){
   await setDoc(doc(c.firestore(),col,'private'),{[field]:['other-person'],createdByPersonId:'other-person'});
   await setDoc(doc(c.firestore(),col,'assigned'),{[field]:['manager-person'],createdByPersonId:'other-person'});
   await setDoc(doc(c.firestore(),col,'created'),{[field]:[],createdByPersonId:'manager-person'});
  }
 });
 // Prior admin test relinked this member to manager-person.
 const db=env.authenticatedContext('member').firestore();
 for(const [col,field]of [['zms_tasks','assignees'],['zms_meetings','attendees']]){
  await assertFails(getDoc(doc(db,col,'private')));
  await assertSucceeds(getDoc(doc(db,col,'assigned')));
  await assertSucceeds(getDoc(doc(db,col,'created')));
  await assertFails(getDocs(collection(db,col)));
  await assertSucceeds(getDocs(query(collection(db,col),where(field,'array-contains','manager-person'))));
  await assertSucceeds(getDocs(query(collection(db,col),where('createdByPersonId','==','manager-person'))));
 }
 await assertFails(getDocs(collection(db,'zms_activities')));
});
test('subtasks follow parent visibility and member status permissions',async()=>{
 await env.withSecurityRulesDisabled(async c=>{
  const db=c.firestore();
  await setDoc(doc(db,'zms_tasks/subtask-parent'),{id:'subtask-parent',projectId:'project',assignees:['manager-person'],createdByPersonId:'other-person'});
  await setDoc(doc(db,'zms_tasks/private-parent'),{id:'private-parent',projectId:'project',assignees:['other-person'],createdByPersonId:'other-person'});
  await setDoc(doc(db,'zms_subtasks/visible'),{id:'visible',taskId:'subtask-parent',title:'Subtask',status:'todo',createdByPersonId:'other-person'});
  await setDoc(doc(db,'zms_subtasks/private'),{id:'private',taskId:'private-parent',status:'todo'});
 });
 const db=env.authenticatedContext('member').firestore();
 await assertSucceeds(getDoc(doc(db,'zms_subtasks/visible')));
 await assertFails(getDoc(doc(db,'zms_subtasks/private')));
 await assertSucceeds(getDocs(query(collection(db,'zms_subtasks'),where('taskId','==','subtask-parent'))));
 await assertFails(getDocs(collection(db,'zms_subtasks')));
 await assertSucceeds(updateDoc(doc(db,'zms_subtasks/visible'),{status:'done',progress:100,updatedAt:'2026-01-01'}));
 await assertFails(updateDoc(doc(db,'zms_subtasks/visible'),{title:'Not allowed'}));
 await assertFails(updateDoc(doc(db,'zms_tasks/subtask-parent'),{title:'Not allowed'}));
 await assertFails(updateDoc(doc(db,'zms_projects/project'),{title:'Not allowed'}));
 await assertFails(updateDoc(doc(db,'zms_subtasks/visible'),{taskId:'private-parent'}));
 const manager=env.authenticatedContext('manager').firestore();
 await assertSucceeds(setDoc(doc(manager,'zms_subtasks/new'),{id:'new',taskId:'subtask-parent',createdByPersonId:'manager-person',status:'todo'}));
 await assertSucceeds(deleteDoc(doc(manager,'zms_subtasks/new')));
});
test('stable creator UID grants own-record access without letting a manager spoof attribution',async()=>{
 await env.withSecurityRulesDisabled(async c=>{
  const db=c.firestore();
  await setDoc(doc(db,'zms_auth_users/unlinked-manager'),{role:'manager',active:true,personId:null});
  await setDoc(doc(db,'zms_auth_users/unlinked-member'),{role:'member',active:true,personId:null});
  await setDoc(doc(db,'zms_tasks/uid-created'),{id:'uid-created',createdByCloudUid:'unlinked-member',assignees:[]});
 });
 const member=env.authenticatedContext('unlinked-member').firestore();
 await assertSucceeds(getDoc(doc(member,'zms_tasks/uid-created')));
 await assertSucceeds(getDocs(query(collection(member,'zms_tasks'),where('createdByCloudUid','==','unlinked-member'))));
 await assertFails(getDoc(doc(member,'zms_tasks/private')));
 const manager=env.authenticatedContext('unlinked-manager').firestore();
 await assertSucceeds(setDoc(doc(manager,'zms_tasks/uid-own'),{createdByCloudUid:'unlinked-manager',assignees:[]}));
 await assertSucceeds(deleteDoc(doc(manager,'zms_tasks/uid-own')));
 await assertFails(setDoc(doc(manager,'zms_tasks/uid-spoof'),{createdByCloudUid:'manager',assignees:[]}));
 await assertFails(setDoc(doc(manager,'zms_tasks/person-spoof'),{createdByCloudUid:'unlinked-manager',createdByPersonId:'other-person',assignees:[]}));
 await assertFails(updateDoc(doc(manager,'zms_projects/project'),{title:'Cannot manage without person link'}));
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

test('admin reads activity from every active role while entries remain immutable and private to members',async()=>{
 await env.withSecurityRulesDisabled(async c=>{
  for(const role of ['member','manager','admin'])await setDoc(doc(c.firestore(),'zms_auth_users',role),{role,active:true,personId:role+'-person'});
 });
 for(const uid of ['member','manager','admin']){
  const db=env.authenticatedContext(uid).firestore();
  const event={id:'audit-'+uid,actor:uid,actorUid:uid,entity:'task',action:'status',at:'2026-01-01'};
  await assertSucceeds(setDoc(doc(db,'zms_activities',event.id),event));
  await assertFails(updateDoc(doc(db,'zms_activities',event.id),{actor:'Someone else'}));
 }
 const snapshot=await assertSucceeds(getDocs(collection(env.authenticatedContext('admin').firestore(),'zms_activities')));
 for(const uid of ['member','manager','admin'])if(!snapshot.docs.some(row=>row.data().actorUid===uid))throw new Error('Missing activity for '+uid);
 await assertFails(getDocs(collection(env.authenticatedContext('member').firestore(),'zms_activities')));
 await assertFails(setDoc(doc(env.unauthenticatedContext().firestore(),'zms_activities/anonymous'),{id:'anonymous'}));
 await env.withSecurityRulesDisabled(c=>setDoc(doc(c.firestore(),'zms_auth_users/inactive-auditor'),{role:'member',active:false}));
 await assertFails(setDoc(doc(env.authenticatedContext('inactive-auditor').firestore(),'zms_activities/inactive'),{id:'inactive'}));
});
