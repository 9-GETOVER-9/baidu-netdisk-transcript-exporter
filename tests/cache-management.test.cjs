const test=require('node:test'),assert=require('node:assert/strict');
const api=require('../cache-management.js');
function record(root,task,path,bytes=60){return {key:JSON.stringify([root,task]),rootDir:root,taskId:task,sourcePath:path,bytes,capturedAt:'today',attempt:1};}
const a=record('/课程','a','/课程/第一章/a.mp4'),b=record('/课程','b','/课程/第一章加长/b.mov'),c=record('/其他','c','/其他/c.mp4');
function setup(){
  const records=new Map([a,b,c].map(r=>[r.key,structuredClone(r)])),local={},session={},state={jobs:{x:{rootDir:'/课程',taskId:'a'},y:{rootDir:'/其他',taskId:'c'}},owners:{'/课程':{},'/其他':{}},archives:{old:'done'}};
  const area=data=>({async get(key){return {[key]:structuredClone(data[key])};},async set(values){Object.assign(data,structuredClone(values));},async remove(key){delete data[key];}});
  const chrome={runtime:{id:'id',getURL:f=>'chrome-extension://id/'+f},tabs:{async query(){return chrome.openTabs||[];}},storage:{local:area(local),session:area(session)}};
  const store={async metadata(){return [...records.values()];},async removeKeys(keys){for(const key of keys)records.delete(key);}};
  const sender={id:'id',url:chrome.runtime.getURL('cache.html')};
  local['pandownload.queue.v1.'+encodeURIComponent('/课程')]={queue:{rootDir:'/课程',videos:[{taskId:'a',attempt:3,status:'review',archived:true},{taskId:'b',attempt:2,status:'review',archived:true}]},docs:[{path:'keep.pdf'}]};
  return {records,local,session,state,chrome,store,sender,manager:api.createManager(chrome,store)};
}
const choice={rootDir:'/课程',path:'/课程/第一章'};
test('directory scope uses path segments and task-root isolation; malformed selection rejected',()=>{
  assert.deepEqual(api.select([a,b,c],choice.rootDir,choice.path),[a]);
  assert.throws(()=>api.select([a],'/课程','/其他'));
  assert.throws(()=>api.select([a],'/课程','/课程/../其他'));
  assert.deepEqual(api.select([a,b,c],'/课程','/课程'),[a,b]);
});
test('summary counts parents once and sums estimated bytes without counting descendants twice',()=>{
  const r=record('/','r','/中文/子目录/a.mp4',123);
  const total=api.summarize([a,b,c,r]);
  assert.equal(total.count,4);assert.equal(total.bytes,303);
  const root=total.roots.find(x=>x.rootDir==='/');
  assert.deepEqual(root.folders.map(x=>x.path),['/','/中文','/中文/子目录']);
  assert.equal(api.formatBytes(1024),'1.0 KiB');
});
test('web content and other extension pages cannot read metadata or delete cache',async()=>{
  const f=setup();
  for(const sender of [{id:'id',url:'https://pan.baidu.com/disk/main'}, {id:'other',url:f.sender.url},{id:'id',url:'chrome-extension://id/popup.html'}]){
    await assert.rejects(f.manager.handle({action:'cacheSummary'},sender,f.state),/只允许/);
  }
  assert.equal(f.records.size,3);
});
test('open directory, pending video navigation and archive tabs block preview and confirmed deletion',async()=>{
  const f=setup();
  for(const tab of [{url:'https://pan.baidu.com/disk/main#/index'}, {url:'about:blank',pendingUrl:'https://pan.baidu.com/pfile/video?path=x'}, {url:'chrome-extension://id/export.html?root=x'}]){
    f.chrome.openTabs=[tab];
    await assert.rejects(f.manager.handle({action:'cachePreview',...choice},f.sender,f.state),/关闭/);
    await assert.rejects(f.manager.handle({action:'cacheClear',...choice,confirmed:true},f.sender,f.state),/关闭/);
  }
  assert.equal(f.records.size,3);
});
test('preview alone does not delete; explicit confirmation and fresh preview signature required',async()=>{
  const f=setup(),p=await f.manager.handle({action:'cachePreview',...choice},f.sender,f.state);
  assert.equal(f.records.size,3);assert.equal(p.count,1);
  await assert.rejects(f.manager.handle({action:'cacheClear',...choice,token:p.token},f.sender,f.state),/确认/);
  f.records.get(a.key).capturedAt='tomorrow';
  await assert.rejects(f.manager.handle({action:'cacheClear',...choice,confirmed:true,token:p.token},f.sender,f.state),/已变化/);
  assert.equal(f.records.size,3);
});
test('confirmed deletion preserves other directories and documents, resets only selected progress and receipts',async()=>{
  const f=setup(),p=await f.manager.handle({action:'cachePreview',...choice},f.sender,f.state);
  const result=await f.manager.handle({action:'cacheClear',...choice,confirmed:true,token:p.token},f.sender,f.state);
  assert.equal(result.count,1);assert.deepEqual([...f.records.keys()],[b.key,c.key]);
  const snap=f.local['pandownload.queue.v1.'+encodeURIComponent('/课程')];
  assert.equal(snap.queue.videos[0].status,'failed');assert.equal(snap.queue.videos[0].attempt,3);assert.equal(snap.queue.videos[0].archived,false);
  assert.equal(snap.queue.videos[1].status,'review');assert.equal(snap.docs[0].path,'keep.pdf');
  assert(!f.state.jobs.x);assert(f.state.jobs.y);assert(f.state.owners['/其他']);assert(!f.local[api.JOURNAL]);
});
test('failed journal save prevents deleting any records',async()=>{
  const f=setup(),p=await f.manager.handle({action:'cachePreview',...choice},f.sender,f.state);
  f.chrome.storage.local.set=async()=>{throw Error('quota');};
  await assert.rejects(f.manager.handle({action:'cacheClear',...choice,confirmed:true,token:p.token},f.sender,f.state),/quota/);
  assert.equal(f.records.size,3);
});
test('interruption after database deletion retains journal; a new manager repairs progress idempotently',async()=>{
  const f=setup(),p=await f.manager.handle({action:'cachePreview',...choice},f.sender,f.state);
  const original=f.chrome.storage.local.set;
  f.chrome.storage.local.set=async values=>{if(Object.keys(values)[0].startsWith('pandownload.queue'))throw Error('interrupted');await original(values);};
  await assert.rejects(f.manager.handle({action:'cacheClear',...choice,confirmed:true,token:p.token},f.sender,f.state),/interrupted/);
  assert(!f.records.has(a.key));assert(f.local[api.JOURNAL]);
  f.chrome.storage.local.set=original;
  const next=api.createManager(f.chrome,f.store);await next.recover(f.state);await next.recover(f.state);
  assert(!f.local[api.JOURNAL]);assert.equal(f.local['pandownload.queue.v1.'+encodeURIComponent('/课程')].queue.videos[0].status,'failed');
  assert.equal(f.records.size,2);
});
