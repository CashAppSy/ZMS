"use strict";
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { chromium } = require('playwright-core');
const root = path.resolve(__dirname, '..');
const types = {'.html':'text/html','.js':'text/javascript','.css':'text/css','.png':'image/png','.woff2':'font/woff2'};
const server = http.createServer((req,res)=>{
 const requested=decodeURIComponent(new URL(req.url,'http://localhost').pathname);
 const file=path.resolve(root,'.'+(requested==='/'?'/index.html':requested));
 if(!file.startsWith(root+path.sep)){res.writeHead(403);return res.end();}
 fs.readFile(file,(error,data)=>{res.writeHead(error?404:200,{'content-type':types[path.extname(file)]||'application/octet-stream'});res.end(error?'Not found':data);});
});
(async()=>{
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const base='http://127.0.0.1:'+server.address().port;
 const browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH||'/usr/bin/chromium',headless:true,args:['--no-sandbox']});
 try {
  const page=await browser.newPage();const errors=[],missing=[];
  page.on('pageerror',e=>errors.push(e.message));
  page.on('response',r=>{if(r.url().startsWith(base)&&r.status()>=400)missing.push(r.url());});
  // Exercise local workflows only. Never send test authentication or data to
  // the embedded real Firebase project; configuration is disabled in memory.
  await page.route('**/js/cloud-config.js',route=>route.fulfill({contentType:'text/javascript',body:'window.PMS.cloudConfig = {};'}));
  await page.goto(base);await page.waitForFunction(()=>window.PMS&&PMS.store.initialized);
  await page.evaluate(()=>{
    const res=PMS.auth.createUser({username:'browser-admin',password:'test-password',name:'Browser Admin'});
    if(res.error)throw new Error(res.error);
    const login=PMS.auth.login('browser-admin','test-password');if(login.error)throw new Error(login.error);
    const users=PMS.utils.deepClone(PMS.store.data.users),data=PMS.seed.build();data.users=users;
    PMS.store.setData(data);PMS.authUI.hide();PMS.app.init();
  });
  let routes=0;
  for(const lang of ['en','ar']){
    await page.evaluate(lang=>{PMS.i18n.setLang(lang);PMS.repos.settings.update({lang});},lang);
    for(const route of ['/','/projects','/tasks','/tasks/kanban','/tasks/gantt','/tasks/calendar','/people','/meetings','/reports','/settings','/activity']){
      await page.evaluate(route=>PMS.router.navigate(route),route);
      await page.waitForFunction(()=>document.getElementById('view-root').children.length>0);
      assert.equal(await page.locator('#view-root .error-state').count(),0,route);
      routes++;
    }
  }
  await page.evaluate(()=>PMS.router.navigate('/settings'));
  const sections=await page.locator('.settings-nav button').allTextContents();assert.equal(sections.length,8);
  for(const text of sections){
    await page.locator('.settings-nav button').filter({hasText:text}).click();
    assert.ok(await page.locator('.settings-body').textContent());
  }
  // A cloud refresh must repaint the list once, not recursively refresh it.
  await page.evaluate(()=>{
    window.backupRefreshCalls=0;
    window.originalBackupRefresh=PMS.backup.refresh;
    window.originalCloudEnabled=PMS.cloudsync.isEnabled;
    PMS.backup.refresh=()=>{window.backupRefreshCalls++;return Promise.resolve();};
    PMS.cloudsync.isEnabled=()=>true;
  });
  await page.locator('.settings-nav button').nth(5).click();
  await page.waitForTimeout(100);
  assert.equal(await page.evaluate(()=>window.backupRefreshCalls),1);
  await page.evaluate(()=>{PMS.backup.refresh=window.originalBackupRefresh;PMS.cloudsync.isEnabled=window.originalCloudEnabled;});
  const task=await page.evaluate(()=>{
    const task=PMS.repos.tasks.add({title:'Browser test task',status:'todo',priority:'low'});
    PMS.repos.tasks.update(task.id,{title:'Edited browser task'});
    PMS.store.undo();if(PMS.repos.tasks.get(task.id).title!=='Browser test task')throw new Error('undo');
    PMS.store.redo();if(PMS.repos.tasks.get(task.id).title!=='Edited browser task')throw new Error('redo');
    const temporary=PMS.repos.tasks.add({title:'Delete me',status:'todo',priority:'low'});
    PMS.repos.tasks.remove(temporary.id);if(PMS.repos.tasks.get(temporary.id)!==null)throw new Error('delete');
    return task.id;
  });
  await page.evaluate(id=>PMS.editors.openTaskEditor(PMS.repos.tasks.get(id),{}),task);
  await page.waitForSelector('.modal');
  assert.ok(await page.locator('.modal').getAttribute('aria-labelledby'));
  await page.locator('.modal button').last().focus();await page.keyboard.press('Tab');
  assert.equal(await page.evaluate(()=>document.activeElement===document.querySelector('.modal button')),true);
  await page.keyboard.press('Shift+Tab');
  assert.equal(await page.evaluate(()=>document.activeElement===Array.from(document.querySelectorAll('.modal button,input,select,textarea,a[href],[tabindex]')).filter(el=>!el.disabled&&el.tabIndex>=0&&!el.hidden&&!el.closest('[hidden],[inert]')&&getComputedStyle(el).display!=='none').at(-1)),true);
  await page.keyboard.press('Escape');assert.equal(await page.locator('.modal').count(),0);
  await page.setViewportSize({width:390,height:844});
  for(const lang of ['en','ar']){
    await page.evaluate(lang=>{PMS.i18n.setLang(lang);document.getElementById('sidebar').classList.add('collapsed');},lang);
    await page.waitForTimeout(250);
    const rect=await page.locator('#sidebar').boundingBox();
    assert.ok(lang==='ar'?rect.x>=389:rect.x+rect.width<=1,lang+' collapsed sidebar offscreen');
  }
  await page.evaluate(()=>PMS.store.flush());
  await page.reload();await page.waitForFunction(()=>window.PMS&&PMS.store.initialized);
  assert.equal(await page.evaluate(id=>PMS.repos.tasks.get(id).title,task),'Edited browser task');
  assert.equal(await page.evaluate(()=>PMS.auth.currentUser().username),'browser-admin');
  assert.deepEqual(errors,[]);assert.deepEqual(missing,[]);
  console.log('Browser checks passed: '+routes+' routes, 8 settings sections, task CRUD/undo/redo, modal keyboard access, mobile EN/AR, IndexedDB reload and session persistence.');
 } finally {await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;}).finally(()=>server.close());
