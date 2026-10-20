const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const file = path.join(__dirname, '..', 'background-controller.js');
const api = fs.existsSync(file) ? require(file) : {};
const dirSender = { tab: { id: 1, url: 'https://pan.baidu.com/disk/main' } };
const request = { action: 'openVideoTab', url: 'https://pan.baidu.com/pfile/video?path=%2Fcourse%2Fa.mp4&fid=10', taskId: '10', batchId: 'batch-1', attempt: 1 };

function fakeChrome() {
  const state = { session: {}, local: {}, tabs: new Map([[1, dirSender.tab]]), downloads: new Map(), created: [], sent: [] };
  const area = name => ({
    async get(key) { return { [key]: structuredClone(state[name][key]) }; },
    async set(value) { Object.assign(state[name], structuredClone(value)); }
  });
  let nextTab = 2, nextDownload = 100;
  return { state, storage: { session: area('session'), local: area('local') },
    tabs: {
      async create(options) { const tab = { ...options, id: nextTab++ }; state.tabs.set(tab.id, tab); state.created.push(tab); return tab; },
      async get(id) { if (!state.tabs.has(id)) throw Error('No tab'); return state.tabs.get(id); },
      async remove(id) { state.tabs.delete(id); },
      async sendMessage(id, message) { state.sent.push({ id, message }); }
    },
    downloads: {
      async download(options) { const id = nextDownload++; state.downloads.set(id, { id, state: 'in_progress', ...options }); return id; },
      async search({ id }) { return state.downloads.has(id) ? [state.downloads.get(id)] : []; }
    }
  };
}
function make(chrome = fakeChrome(), options = {archiveStore:{async put(){}}}) {
  assert.equal(typeof api.createController, 'function', 'Background must expose the production controller for isolated Chrome API tests');
  return { chrome, controller: api.createController(chrome, options) };
}
test('manuscript observation survives cache recovery and terminal relay without turning subtitles into manuscripts',async()=>{
  let record;const store={async put(value){record=value;},async get(){return record;}};
  const {controller,chrome}=make(fakeChrome(),{archiveStore:store});const {sender}=await open(controller,chrome);
  const manuscriptObservation={version:1,state:'not_detected',reason:'未检出入口',checkedAt:'2026-10-17T00:00:00.000Z',attempt:1};
  await controller.handle({...request,action:'archiveTranscript',text:'# 字幕',source:'subtitle',manuscriptObservation},sender);
  assert.deepEqual(record.manuscriptObservation,manuscriptObservation);
  const recovered=api.createController(chrome,{archiveStore:store});const {job}=await recovered.handle({action:'getTask'},sender);
  assert.deepEqual(job.manuscriptObservation,manuscriptObservation);assert.equal(job.source,'subtitle');
  const result=await recovered.handle({...request,action:'taskResult',status:'review'},sender);
  assert.deepEqual(result.result.manuscriptObservation,manuscriptObservation);assert.equal(result.result.source,'subtitle');
  assert.deepEqual(chrome.state.sent[0].message.manuscriptObservation,manuscriptObservation);
});
test('failed cache jobs relay observed text while rejecting another attempt observation',async()=>{
  const {controller,chrome}=make();const {sender}=await open(controller,chrome);
  const observation={version:1,state:'present',reason:'已看到正文，保存失败',checkedAt:'2026-10-17T00:00:00.000Z',attempt:1};
  const result=await controller.handle({...request,action:'taskResult',status:'failed',manuscriptObservation:observation},sender);
  assert.deepEqual(result.result.manuscriptObservation,observation);
  const second=await open(controller,chrome,{taskId:'second'});
  const invalid=await controller.handle({...request,taskId:'second',action:'taskResult',status:'failed',manuscriptObservation:{...observation,attempt:2}},second.sender);
  assert.equal(invalid.result.manuscriptObservation,null);
});
async function open(controller, chrome, overrides = {}) {
  const response = await controller.handle({ ...request, ...overrides }, dirSender);
  assert.equal(response.ok, true, response.error);
  return { response, sender: { tab: chrome.state.tabs.get(response.tabId) } };
}

test('opening the same reservation concurrently creates one tab, distinct tasks stay distinct', async () => {
  const { controller, chrome } = make();
  const results = await Promise.all([controller.handle(request, dirSender), controller.handle(request, dirSender), controller.handle({ ...request, taskId: '20', url: request.url.replace('fid=10', 'fid=20') }, dirSender)]);
  assert.equal(results[0].tabId, results[1].tabId);
  assert.notEqual(results[0].tabId, results[2].tabId);
  assert.equal(chrome.state.created.length, 2);
});
test('foreign URLs and non-directory open requests are rejected', async () => {
  const { controller, chrome } = make();
  assert.equal((await controller.handle({ ...request, url: 'https://example.org/' }, dirSender)).ok, false);
  assert.equal((await controller.handle(request, { tab: { id: 8, url: 'https://example.org/' } })).ok, false);
  assert.equal(chrome.state.created.length, 0);
});
test('manual video tabs do not receive a job or permission to close themselves', async () => {
  const { controller, chrome } = make();
  const sender = { tab: { id: 9, url: request.url } };
  assert.equal((await controller.handle({ action: 'getTask' }, sender)).job, null);
  assert.equal((await controller.handle({ action: 'closeTab' }, sender)).ok, false);
  assert.equal(chrome.state.created.length, 0);
});
test('Markdown is durably cached without starting any individual download',async()=>{
  const retained=[];const {controller,chrome}=make(fakeChrome(),{archiveStore:{async put(record){retained.push(record);}}});
  const {sender}=await open(controller,chrome,{rootDir:'/course',size:123,mtime:456});
  const original=chrome.downloads.download;
  chrome.downloads.download=async options=>{assert.equal(retained.length,1);return original(options);};
  const result=await controller.handle({...request,action:'archiveTranscript',filename:'a.md',text:'# 文稿\n正文'},sender);
  assert.equal(result.ok,true,result.error);
  assert.equal(result.archived,true);
  assert.equal(chrome.state.downloads.size,0);
  assert.equal(retained[0].rootDir,'/course');
  assert.equal(retained[0].sourcePath,'/course/a.mp4');
  assert.equal(retained[0].sourceSize,123);
  assert.equal(retained[0].sourceMtime,456);
  assert.equal(retained[0].markdown,'# 文稿\n正文');
});
test('archive write failure is surfaced before downloading instead of silently losing ZIP content',async()=>{
  const {controller,chrome}=make(fakeChrome(),{archiveStore:{async put(){throw Error('归档磁盘空间不足');}}});
  const {sender}=await open(controller,chrome);
  const result=await controller.handle({...request,action:'downloadText',filename:'a.md',text:'# 文稿'},sender);
  assert.equal(result.ok,false);assert.match(result.error,/空间不足/);
  assert.equal(chrome.state.downloads.size,0);
});
test('prepareArchive opens an extension export page from an existing checkpoint without visiting the cloud',async()=>{
  const {controller,chrome}=make();
  chrome.runtime={getURL:file=>'chrome-extension://test/'+file};
  chrome.state.local['pandownload.queue.v1.'+encodeURIComponent('/course')]={queue:{batchId:request.batchId,rootDir:'/course',videos:[{taskId:'10',attempt:1,status:'skipped'}]}};
  const result=await controller.handle({action:'prepareArchive',rootDir:'/course',batchId:request.batchId,auto:true},dirSender);
  assert.equal(result.ok,true,result.error);
  assert.ok(chrome.state.created[0].url.startsWith('chrome-extension://test/export.html?'));
  const repeated=await controller.handle({action:'prepareArchive',rootDir:'/course',batchId:request.batchId,auto:true},dirSender);
  assert.equal(repeated.ok,true);assert.equal(chrome.state.created.length,1);
  const rejected=await controller.handle({action:'prepareArchive',rootDir:'/course',batchId:'wrong'},dirSender);
  assert.equal(rejected.ok,false);
});
test('a no-draft task can be skipped, persisted and closed without a download', async () => {
  const {controller,chrome}=make();
  const {sender}=await open(controller,chrome);
  const ack=await controller.handle({...request,action:'taskResult',status:'skipped',reason:'未发现文稿入口'},sender);
  assert.equal(ack.ok,true,ack.error);
  assert.equal(chrome.state.downloads.size,0);
  assert.equal(chrome.state.sent[0].message.status,'skipped');
  assert.equal((await controller.handle({action:'closeTab'},sender)).ok,true);
  const polled=await controller.handle({action:'checkTabs',batchId:request.batchId,tabIds:[]},dirSender);
  assert.equal(polled.results[0].status,'skipped');
});
test('an uncommitted cache write cannot authorize success or trigger a download', async () => {
  let commit;
  const {controller,chrome}=make(fakeChrome(),{archiveStore:{put:()=>new Promise(resolve=>{commit=resolve;})}});
  const {sender}=await open(controller,chrome);
  const premature=await controller.handle({...request,action:'taskResult',status:'review'},sender);
  assert.equal(premature.ok,false);
  let acknowledged=false;
  const caching=controller.handle({...request,action:'archiveTranscript',text:'正文'},sender).then(result=>{acknowledged=true;return result;});
  await new Promise(setImmediate);
  assert.equal(acknowledged,false);
  assert.equal(chrome.state.downloads.size,0);
  commit();
  assert.equal((await caching).archived,true);
  assert.equal((await controller.handle({...request,action:'taskResult',status:'review'},sender)).ok,true);
});

test('completed transcript records a durable result and relays exactly one terminal event', async () => {
  const { controller, chrome } = make();
  const { sender } = await open(controller, chrome);
  const download = await controller.handle({ ...request, action: 'downloadText', text: '正文', filename: 'a.txt' }, sender);
  assert.equal(download.archived,true);
  const result = { ...request, action: 'taskResult', status: 'review', reason: '需核验全文', downloadId: download.downloadId };
  assert.equal((await controller.handle(result, sender)).ok, true);
  assert.equal((await controller.handle(result, sender)).ok, true);
  assert.equal(chrome.state.sent.length, 1);
  const restarted = api.createController(chrome);
  const polled = await restarted.handle({ action: 'checkTabs', batchId: request.batchId, tabIds: [] }, dirSender);
  assert.equal(polled.results[0].status, 'review');
  assert.equal(polled.jobs.length, 1);
});
test('closing an unfinished task fails it instead of counting it as saved', async () => {
  const { controller, chrome } = make();
  const { response } = await open(controller, chrome);
  chrome.state.tabs.delete(response.tabId);
  const polled = await controller.handle({ action: 'checkTabs', batchId: request.batchId, tabIds: [response.tabId] }, dirSender);
  assert.deepEqual(polled.aliveTabIds, []);
  assert.equal(polled.results[0].status, 'failed');
  assert.match(polled.results[0].reason, /关闭|离开/);
});
test('result identity and download ownership are checked', async () => {
  const { controller, chrome } = make();
  const { sender } = await open(controller, chrome);
  assert.equal((await controller.handle({ ...request, action: 'taskResult', taskId: 'forged', status: 'failed' }, sender)).ok, false);
  assert.equal((await controller.handle({ action: 'getDownloadStatus', downloadId: 555 }, sender)).ok, false);
});
test('legacy downloadText requests cache only and survive worker restart without downloads', async () => {
  const { controller, chrome } = make();
  const { sender } = await open(controller, chrome);
  const message = { ...request, action: 'downloadText', text: '文字', filename: 'a.txt' };
  const first = await controller.handle(message, sender);
  const restarted = api.createController(chrome);
  const second = await restarted.handle(message, sender);
  assert.equal(first.downloadId, second.downloadId);
  assert.equal(first.archived,true);
  assert.equal(second.archived,true);
  assert.equal(chrome.state.downloads.size, 0);
});
test('relative paths remain sanitized for optional document downloads', () => {
  assert.equal(api.sanitizeRelativePath('CON/100%真实?.txt'),'_CON/100%真实_.txt');
  assert.throws(()=>api.sanitizeRelativePath('../outside.txt'));
  assert.throws(()=>api.sanitizeRelativePath('D:\\outside.txt'));
});

test('jobs are isolated between directory tabs', async () => {
  const { controller, chrome } = make();
  await open(controller, chrome);
  const foreign = await controller.handle({ action: 'checkTabs', batchId: request.batchId, tabIds: [2] }, { tab: { id: 90, url: dirSender.tab.url } });
  assert.deepEqual(foreign.jobs, []);
  assert.deepEqual(foreign.results, []);
});
test('a completed batch may be claimed from another live directory after release', async () => {
  const { controller, chrome } = make();
  await controller.handle({action:'checkTabs',batchId:request.batchId,rootDir:'/course',claim:true},dirSender);
  const {sender} = await open(controller,chrome);
  await controller.handle({...request,action:'taskResult',status:'failed',reason:'sample'},sender);
  await controller.handle({action:'releaseBatch',batchId:request.batchId,rootDir:'/course'},dirSender);
  const claimed = await controller.handle({action:'checkTabs',batchId:request.batchId,rootDir:'/course',claim:true},{tab:{id:90,url:dirSender.tab.url}});
  assert.equal(claimed.batchBusy,false);
  assert.equal(claimed.results[0].status,'failed');
});
test('a failed claim does not steal the root lock from a live task owner', async () => {
  const { controller, chrome } = make();
  await open(controller,chrome);
  const other={tab:{id:90,url:dirSender.tab.url}};
  chrome.state.tabs.set(90,other.tab);
  assert.equal((await controller.handle({action:'checkTabs',batchId:request.batchId,rootDir:'/course',claim:true},other)).batchBusy,true);
  assert.equal((await controller.handle({action:'checkTabs',batchId:request.batchId,rootDir:'/course',claim:true},dirSender)).batchBusy,false);
});
test('slow document URL lookup cannot block video task routing', async () => {
  const { controller, chrome } = make();
  let finishLookup;
  chrome.scripting={executeScript:()=>new Promise(resolve=>{finishLookup=resolve;})};
  const doc=controller.handle({action:'downloadPDF',fs_id:'25',filename:'doc.pdf'},dirSender);
  await new Promise(setImmediate);
  let routed=false;
  const get=controller.handle({action:'getTask'},{tab:{id:20,url:request.url}}).then(()=>{routed=true;});
  await new Promise(setImmediate);
  const wasRouted=routed;
  finishLookup([{result:{ok:true,dlink:'https://example.com/document.pdf'}}]);
  await Promise.all([doc,get]);
  assert.equal(wasRouted,true,'Independent video messages must finish while document lookup is pending');
});
test('an alive tab that never reports is failed and closed after the bounded task lifetime', async () => {
  const { controller, chrome } = make();
  const {response}=await open(controller,chrome);
  chrome.state.session.pd_runtime_v4.jobs[response.tabId].openedAt=Date.now()-13*60*1000;
  const result=await controller.handle({action:'checkTabs',batchId:request.batchId,tabIds:[response.tabId]},dirSender);
  assert.equal(result.results[0]?.status,'failed');
  assert.equal(chrome.state.tabs.has(response.tabId),false);
});

test('cache recovery checks persisted body and rejects an evicted record before success',async()=>{
  let record;
  const store={async put(value){record=value;},async get(){return record;}};
  const {controller,chrome}=make(fakeChrome(),{archiveStore:store});
  const {sender,response}=await open(controller,chrome);
  await controller.handle({...request,action:'archiveTranscript',text:'正文'},sender);
  // A worker may stop after the IndexedDB commit but before its session marker.
  delete chrome.state.session.pd_runtime_v4.jobs[response.tabId].archived;
  const restarted=api.createController(chrome,{archiveStore:store});
  assert.equal((await restarted.handle({action:'getTask'},sender)).job.archived,true);
  record=undefined;
  assert.equal((await restarted.handle({...request,action:'taskResult',status:'review'},sender)).ok,false);
  assert.equal(chrome.state.downloads.size,0);
});

test('an older attempt cache cannot authorize or suppress a fresh capture',async()=>{
  let writes=0;
  const {controller,chrome}=make(fakeChrome(),{archiveStore:{async get(){return {markdown:'旧文稿',batchId:request.batchId,attempt:0,sourcePath:'/course/a.mp4'};},async put(){writes++;}}});
  const {sender}=await open(controller,chrome);
  assert.equal((await controller.handle({action:'getTask'},sender)).job.archived,false);
  assert.equal((await controller.handle({...request,action:'archiveTranscript',text:'新文稿'},sender)).archived,true);
  assert.equal(writes,1);assert.equal(chrome.state.downloads.size,0);
});

test('video creation stays with its live directory window when another window is focused',async()=>{
  const {controller,chrome}=make();
  chrome.state.tabs.set(1,{...dirSender.tab,windowId:41});
  const create=chrome.tabs.create;
  chrome.tabs.create=async options=>{
    const targetWindow=options.windowId ?? 99;
    const opener=chrome.state.tabs.get(options.openerTabId);
    if(opener && opener.windowId!==targetWindow)throw Error('Tab opener must be in the same window as the updated tab.');
    return create({...options,windowId:targetWindow});
  };
  const response=await controller.handle(request,{tab:{...dirSender.tab,windowId:12}});
  assert.equal(response.ok,true,response.error);
  assert.equal(chrome.state.created[0].windowId,41);
  assert.equal(chrome.state.created[0].active,false);
});

test('a disappeared directory does not create an orphan video in another window',async()=>{
  const {controller,chrome}=make();chrome.state.tabs.delete(1);
  const response=await controller.handle(request,dirSender);
  assert.equal(response.ok,false);assert.equal(chrome.state.created.length,0);
});

test('subtitle bridge reads require matching owned task identity',async()=>{
 const {controller,chrome}=make();let calls=0;
 chrome.scripting={executeScript:async()=>{calls++;return [{result:{sourcePath:'/course/a.mp4',manifests:[],native:[]}}];}};
 const {sender}=await open(controller,chrome);
 assert.equal((await controller.handle({...request,action:'subtitleSnapshot',attempt:99},sender)).ok,false);
 assert.equal(calls,0);
 assert.equal((await controller.handle({...request,action:'subtitleSnapshot'},sender)).ok,true);assert.equal(calls,1);
});
test('subtitle HTTP work is bounded, rejects unapproved hosts, and cannot block task routing',async()=>{
 let finish;const chrome=fakeChrome();const controller=api.createController(chrome,{fetchImpl:()=>new Promise(r=>{finish=r;})});
 const {sender}=await open(controller,chrome);
 assert.equal((await controller.handle({...request,action:'subtitleText',url:'https://evil.test/a'},sender)).ok,false);
 const reading=controller.handle({...request,action:'subtitleText',url:'https://pan.baidu.com/sub.srt'},sender);await new Promise(setImmediate);
 let routed=false;const get=controller.handle({action:'getTask'},sender).then(()=>{routed=true;});await new Promise(setImmediate);const didRoute=routed;
 assert.equal(typeof finish,'function');finish(new Response('1\n00:00:00,000 --> 00:00:01,000\n正文',{status:200}));const result=await reading;await get;assert.equal(result.ok,true,result.error);assert.equal(didRoute,true);
});

test('subtitle HTTP rejection and oversized replies remain errors, never successful empty text',async()=>{
 for(const response of [new Response('denied',{status:403}),new Response('huge',{headers:{'content-length':String(9*1024*1024)}})]){
  const chrome=fakeChrome(),controller=api.createController(chrome,{fetchImpl:async()=>response});const {sender}=await open(controller,chrome);
  const r=await controller.handle({...request,action:'subtitleText',url:'https://pan.baidu.com/a.srt'},sender);assert.equal(r.ok,false);assert.ok(r.error);
 }
});

test('navigation away from a task revokes subtitle page operations even with a stale sender',async()=>{
 const {controller,chrome}=make();const {sender}=await open(controller,chrome);let invoked=false;chrome.scripting={executeScript:async()=>{invoked=true;return [{result:{}}];}};
 chrome.state.tabs.set(sender.tab.id,{...sender.tab,url:'https://pan.baidu.com/disk/main'});
 const result=await controller.handle({...request,action:'subtitleSnapshot'},sender);assert.equal(result.ok,false);assert.equal(invoked,false);
});
