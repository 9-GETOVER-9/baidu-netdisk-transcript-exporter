const test=require('node:test');
const assert=require('node:assert/strict');
const {Queue}=require('../queue-core.js');
const {createController}=require('../background-controller.js');
const {runExport}=require('../transcript-core.js');
const {buildBundle}=require('../archive-core.js');

test('real queue, background and transcript engine cache without downloads and build the archive',async()=>{
  const queue=new Queue({batchId:'integration',rootDir:'/课',videos:[
    {fs_id:11,path:'/课/100%课程.mp4',name:'100%课程.mp4',relPath:'子目录'},
    {fs_id:12,path:'/课/无文稿.mp4',name:'无文稿.mp4',relPath:''}
  ]});
  const session={},tabs=new Map(),downloads=new Map(),opened=[];
  const directory={tab:{id:1,url:'https://pan.baidu.com/disk/main'}};
  tabs.set(1,directory.tab);
  const chrome={storage:{session:{async get(k){return {[k]:structuredClone(session[k])};},async set(v){Object.assign(session,structuredClone(v));}},local:{async get(){return {outputSubfolder:'文稿导出'};}}},
    tabs:{async create(options){const tab={...options,id:opened.length+2};opened.push(tab);tabs.set(tab.id,tab);return tab;},async get(id){if(!tabs.has(id))throw Error('missing');return tabs.get(id);},async remove(id){tabs.delete(id);},async sendMessage(id,message){assert.equal(id,1);queue.applyResult(message);}},
    downloads:{async download(options){const id=100+downloads.size;downloads.set(id,{id,...options,state:'in_progress'});return id;},async search({id}){return downloads.has(id)?[downloads.get(id)]:[];}}
  };
  const retained=[];
  const background=createController(chrome,{archiveStore:{async put(record){retained.push(record);}}});
  for(const expectedId of [11,12]) {
    const [reservation]=queue.reserve(1);
    assert.equal(reservation.fs_id,expectedId);
    const url=new URL('https://pan.baidu.com/pfile/video');
    url.search=new URLSearchParams({path:reservation.path,fid:String(reservation.fs_id),relPath:reservation.relPath});
    const openedTab=await background.handle({...reservation,rootDir:queue.rootDir,action:'openVideoTab',url:url.href},directory);
    assert.equal(openedTab.ok,true);
    queue.markOpened(reservation,openedTab.tabId);
    const sender={tab:tabs.get(openedTab.tabId)};
    const {job}=await background.handle({action:'getTask'},sender);
    let now=0;
    const result=await runExport(job,{
      now:()=>now,sleep:async ms=>{now+=ms;},openDraft:async()=>true,
      readSnapshot:()=>({text:expectedId===11?'这是一段课程文字。':'',context:''}),
      send:async message=>{
        const response=await background.handle(message,sender);

        return response;
      }
    },{totalTimeoutMs:100,openTimeoutMs:10,captureTimeoutMs:30,downloadTimeoutMs:30,pollMs:5,stableMs:10});
    const ack=await background.handle({...reservation,action:'taskResult',...result},sender);
    assert.equal(ack.ok,true,ack.error);
    assert.equal((await background.handle({action:'closeTab'},sender)).ok,true);
  }
  assert.equal(queue.counts().review,1);
  assert.equal(queue.counts().skipped,1);
  assert.equal(queue.counts().failed,0);
  assert.equal(queue.counts().pending,0);
  assert.equal(opened.length,2);
  assert.equal(downloads.size,0);

  const replay=await background.handle({action:'checkTabs',batchId:queue.batchId,rootDir:queue.rootDir},directory);
  replay.results.forEach(result=>queue.applyResult(result));
  assert.equal(queue.counts().review,1);
  assert.equal(queue.counts().skipped,1);
  assert.equal(queue.counts().failed,0);
  const bundle=buildBundle({queue:queue.snapshot(),scanStats:{failedDirs:[]}},retained);
  assert.equal(bundle.summary.extracted,1);
  assert.equal(bundle.summary.missing,1);
  assert.equal(bundle.formatStats.find(row=>row.format==='mp4').present,1);
  assert.equal(bundle.formatStats.find(row=>row.format==='mp4').unknown,1);
  assert.equal(bundle.rows[0].source,'manuscript');
  assert.ok(bundle.entries.some(entry=>entry.name==='课/100%课程.md'&&entry.text.includes('课程文字')));
});
