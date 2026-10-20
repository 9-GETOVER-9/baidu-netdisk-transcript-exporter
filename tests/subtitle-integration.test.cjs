const test=require('node:test');const assert=require('node:assert/strict');const vm=require('node:vm');
const {Queue}=require('../queue-core.js');const {createController}=require('../background-controller.js');const {runExport}=require('../transcript-core.js');const {collect}=require('../subtitle-core.js');const {install}=require('../subtitle-capture.js');const {buildBundle,encodeZip}=require('../archive-core.js');
test('owned early subtitle capture reaches the correct Markdown archive without per-file downloads',async()=>{
 const root='/课',path='/课/章节/无文稿.MOV',directory={tab:{id:1,url:'https://pan.baidu.com/disk/main',windowId:40}};
 const queue=new Queue({batchId:'sub-integration',rootDir:root,videos:[{fs_id:11,path,name:'无文稿.MOV',relPath:'章节'}]});const [reservation]=queue.reserve(1);
 const state={},tabs=new Map([[1,directory.tab]]),retained=new Map();let page,downloadCalls=0;
 const chrome={storage:{session:{async get(k){return {[k]:structuredClone(state[k])};},async set(v){Object.assign(state,structuredClone(v));}}},
 tabs:{async get(id){return tabs.get(id);},async create(options){const tab={...options,id:2};tabs.set(2,tab);return tab;},async sendMessage(id,m){queue.applyResult(m);},async remove(id){tabs.delete(id);}},
 downloads:{async download(){downloadCalls++;throw Error('no individual downloads');}},
 scripting:{async executeScript(request){return [{result:vm.runInNewContext('('+request.func.toString()+')(...args)',{__PDSubtitleCapture42:page.__PDSubtitleCapture42,args:request.args})}];}}};
 const background=createController(chrome,{archiveStore:{async put(record){retained.set(record.taskId,record);},async get(root,id){return retained.get(id);}},fetchImpl:async url=>{assert.equal(url,'https://pan.baidu.com/lesson.srt');return new Response('1\n00:00:01,000 --> 00:00:03,000\n字幕提取正文');}});
 const url='https://pan.baidu.com/pfile/video?'+new URLSearchParams({path,fid:'11'});const opened=await background.handle({...reservation,action:'openVideoTab',rootDir:root,url},directory);assert.equal(opened.ok,true,opened.error);queue.markOpened(reservation,opened.tabId);
 const sender={tab:tabs.get(2)};assert.equal(new URL(sender.tab.url).searchParams.get('__pd_subtitle'),'1');
 class XHR{open(){}send(){}addEventListener(type,fn){this.loaded=fn;}}
 page={location:{href:sender.tab.url},XMLHttpRequest:XHR,document:{querySelectorAll:()=>[]}};install(page);
 const xhr=new page.XMLHttpRequest();xhr.open('GET','/api/streaming?'+new URLSearchParams({path,type:'M3U8_SUBTITLE_SRT'}));xhr.send();xhr.responseText='#EXTM3U\n#EXT-X-MEDIA:TYPE=SUBTITLES,LANGUAGE="zh",URI="/lesson.srt"';xhr.loaded();
 const {job}=await background.handle({action:'getTask'},sender);let now=0;const send=message=>background.handle(message,sender);const credentials={taskId:job.taskId,batchId:job.batchId,attempt:job.attempt};
 const result=await runExport(job,{now:()=>now,sleep:async ms=>{now+=ms;},openDraft:()=>false,send,readSubtitles:async({deadline})=>collect(path,{now:()=>now,sleep:async ms=>{now+=ms;},snapshot:async()=>{const r=await send({action:'subtitleSnapshot',...credentials});assert.equal(r.ok,true,r.error);return r.snapshot;},fetchText:async(url,timeoutMs)=>{const r=await send({action:'subtitleText',...credentials,url,timeoutMs});assert.equal(r.ok,true,r.error);return r.text;}},{deadline})},{openTimeoutMs:10,pollMs:5,totalTimeoutMs:200});
 assert.equal(result.status,'review');assert.equal((await send({action:'taskResult',...credentials,...result})).ok,true);
 const bundle=buildBundle({queue:queue.snapshot(),scanStats:{failedDirs:[]}},[...retained.values()]);assert.equal(bundle.summary.extracted,1);assert.equal(bundle.summary.missing,0);
 const entry=bundle.entries.find(e=>e.name==='课/章节/无文稿.md');assert.ok(entry);assert.match(entry.text,/文字来源.*播放器字幕/);assert.match(entry.text,/00:00:01.000/);assert.match(entry.text,/字幕提取正文/);
 assert.equal(retained.get(job.taskId).source,'subtitle');assert.equal(downloadCalls,0);assert.ok((await encodeZip(bundle.entries)).length>100);
 assert.equal(bundle.rows[0].source,'subtitle');
 assert.equal(bundle.formatStats.find(row=>row.format==='mov').present,0);
 assert.equal(bundle.formatStats.find(row=>row.format==='mov').unknown,1);
 assert.equal(bundle.rows[0].manuscriptObservation.state,'unknown');
});
