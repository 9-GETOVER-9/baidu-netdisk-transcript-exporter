const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const core=require('../queue-core.js');
function harness({stored={},openReply=false,batchBusy=false,onSend=()=>undefined}={}) {
  const opens=[],messages=[],timers=[];
  const source=fs.readFileSync(path.join(__dirname,'../content_dir.js'),'utf8');
  const window={location:{hash:'#/index?path=%2Fcourse'},addEventListener(){}};
  const chrome={runtime:{lastError:null,onMessage:{addListener(){}},sendMessage(message,callback){
    messages.push(message);
    const custom=onSend(message);if(custom!==undefined){queueMicrotask(()=>callback(custom));return;}
    if(message.action==='openVideoTab'){opens.push(message);if(openReply)queueMicrotask(()=>callback({ok:true,tabId:opens.length}));}
    else if(message.action==='checkTabs')queueMicrotask(()=>callback({ok:true,batchBusy,aliveTabIds:[],results:[],jobs:[]}));
    else queueMicrotask(()=>callback({ok:true}));
  }},storage:{local:{get(key,callback){queueMicrotask(()=>callback(typeof key==='string'?{[key]:stored[key]}:stored));},set(value,callback){Object.assign(stored,value);queueMicrotask(()=>callback?.());}},onChanged:{addListener(){}}}};
  const context={window,chrome,PanDownloadQueue:core,PDFormatStats:require('../format-stats.js'),PDResultStats:require('../result-stats.js'),console:{log(){},error(){}},URL,URLSearchParams,AbortController,Date,Set,Map,
    setTimeout(fn){timers.push(fn);return timers.length;},clearTimeout(){},setInterval(fn){timers.push(fn);return timers.length;},clearInterval(){},
    fetch:async()=>({ok:true,json:async()=>({errno:0,list:[1,2,3].map(n=>({server_filename:`${n}.mp4`,path:`/course/${n}.mp4`,fs_id:n,size:10}))})})};
  vm.runInNewContext(source.replace(/\}\)\(\);\s*$/,`globalThis.controller={STATE,doScan,beginRun,scheduleNext,reCollectDocs,receiveResult,retryFailedVideos,startDocDownload,renderFailedHtml,renderFormatStatsHtml,renderCachedHtml:typeof renderCachedHtml==='function'?renderCachedHtml:null,renderResultSummaryHtml:typeof renderResultSummaryHtml==='function'?renderResultSummaryHtml:null,packCurrentArchive:typeof packCurrentArchive==='function'?packCurrentArchive:null,restoreCheckpoint:typeof restoreCheckpoint==='function'?restoreCheckpoint:null,pollOnce:typeof pollOnce==='function'?pollOnce:null};})();`),context);
  return {controller:context.controller,window,opens,messages,stored};
}
const drain=()=>new Promise(r=>setImmediate(r));
test('finishing a batch persists final state before requesting its automatic ZIP report',async()=>{
  let h;
  h=harness({openReply:true,onSend(message){if(message.action==='prepareArchive'){
    const checkpoint=Object.values(h.stored).find(v=>v?.queue);
    assert.ok(checkpoint.queue.videos.every(v=>!['pending','opening','opened'].includes(v.status)));
    return {ok:true,tabId:99};
  }}});
  await h.controller.doScan();h.window.__toggleVideoExport();await drain();
  for(const job of h.opens.slice())h.controller.receiveResult({...job,status:'skipped'});
  await drain();h.controller.receiveResult({...h.opens[2],status:'skipped'});await drain();
  const requests=h.messages.filter(m=>m.action==='prepareArchive');
  assert.equal(requests.length,1);assert.equal(requests[0].auto,true);
});
test('a paused partial batch can export a snapshot without launching pending videos',async()=>{
  const h=harness({openReply:true});await h.controller.doScan();h.window.__toggleVideoExport();await drain();
  h.window.__toggleVideoExport();
  for(const job of h.opens.slice())h.controller.receiveResult({...job,status:'skipped'});await drain();
  assert.equal(typeof h.controller.packCurrentArchive,'function');
  await h.controller.packCurrentArchive();
  const request=h.messages.find(m=>m.action==='prepareArchive');
  assert.equal(request.auto,false);assert.equal(h.opens.length,2);
  assert.equal(h.controller.STATE.videos.filter(v=>v.status==='pending').length,1);
});
test('a skipped report advances the controller and is not included in failed retry',async()=>{
  const h=harness({openReply:true});await h.controller.doScan();h.window.__toggleVideoExport();await drain();
  const first=h.opens[0];
  h.controller.receiveResult({...first,status:'skipped',reason:'未检测到文稿入口'});await drain();
  assert.equal(h.controller.STATE.totalSkip,1);
  assert.equal(h.controller.STATE.totalFailed,0);
  assert.equal(h.opens.length,3);
  assert.match(h.controller.renderFailedHtml(),/跳过/);
  await h.controller.retryFailedVideos();await drain();
  assert.equal(h.opens.filter(job=>job.taskId===first.taskId).length,1);
});
test('controller reserves before async open replies and advances each queued video once',async()=>{
  const h=harness();await h.controller.doScan();h.window.__toggleVideoExport();await drain();
  h.controller.scheduleNext();h.controller.scheduleNext();await drain();
  assert.equal(h.opens.length,2);
  assert.equal(new Set(h.opens.map(j=>j.taskId)).size,2);
  assert.ok(h.opens.every(j=>j.batchId&&j.attempt===1));
});
test('rescan during a running reservation leaves the existing queue intact',async()=>{
  const h=harness();await h.controller.doScan();h.window.__toggleVideoExport();await drain();
  const before=h.controller.STATE.videos;
  await h.controller.doScan();
  assert.equal(h.controller.STATE.videos,before);
});
test('checkpoint is saved and restored paused without discarding completed work',async()=>{
  const h=harness();await h.controller.doScan();
  const checkpoints=Object.values(h.stored).filter(v=>v&&v.version===1&&v.queue);
  assert.equal(checkpoints.length,1);
  checkpoints[0].queue.videos[0].status='saved';
  const next=harness({stored:h.stored});
  assert.equal(typeof next.controller.restoreCheckpoint,'function');
  await next.controller.restoreCheckpoint('/course');
  assert.equal(next.controller.STATE.paused,true);
  assert.equal(next.controller.STATE.videos[0].status,'saved');
});
test('scanning cannot overwrite another live directory tab checkpoint',async()=>{
  const h=harness({batchBusy:true});await h.controller.doScan();
  assert.equal(Object.keys(h.stored).length,0);
  assert.equal(h.controller.STATE.scanStats.totalDirs,0);
});
test('changing document filters preserves matching completed downloads',()=>{
  const h=harness();const state=h.controller.STATE;
  state.scanStats.nonVideoFiles=[{name:'notes.pdf',path:'/course/notes.pdf',dir:'(根目录)',fs_id:9,size:10,ext:'pdf'}];
  state.docs=[{name:'notes.pdf',path:'/course/notes.pdf',fs_id:9,size:10,status:'done'}];
  h.controller.reCollectDocs();
  assert.equal(state.docs[0].status,'done');assert.equal(state.docsDone,1);
});
test('out-of-order completed reports schedule remaining work once and retry excludes saved/review',async()=>{
  const h=harness({openReply:true});await h.controller.doScan();h.window.__toggleVideoExport();await drain();
  const [one,two]=h.opens;
  h.controller.receiveResult({...two,status:'review'});await drain();
  h.controller.receiveResult({...two,status:'review'});await drain();
  assert.equal(h.opens.length,3);
  h.controller.receiveResult({...one,status:'saved'});
  h.controller.receiveResult({...h.opens[2],status:'failed'});await drain();
  await h.controller.retryFailedVideos();await drain();
  assert.equal(h.opens.length,4);assert.equal(h.opens[3].taskId,h.opens[2].taskId);assert.equal(h.opens[3].attempt,2);
  assert.equal(h.controller.STATE.totalDone,1);assert.equal(h.controller.STATE.totalReview,1);
});
test('polling a missing tab records failure rather than a successful export',async()=>{
  const h=harness({openReply:true});await h.controller.doScan();h.window.__toggleVideoExport();await drain();
  await h.controller.pollOnce();await drain();
  assert.equal(h.controller.STATE.totalFailed,2);assert.equal(h.controller.STATE.totalDone,0);
});
test('a stale restored tab refreshes completed checkpoint before starting',async()=>{
  const h=harness({openReply:true});await h.controller.doScan();
  const later=harness({stored:h.stored});await later.controller.restoreCheckpoint('/course');
  h.window.__toggleVideoExport();await drain();
  for(const job of h.opens.slice())h.controller.receiveResult({...job,status:'review'});
  await drain();h.controller.receiveResult({...h.opens[2],status:'review'});await drain();
  later.window.__toggleVideoExport();await drain();
  assert.equal(later.opens.length,0);assert.equal(later.controller.STATE.totalReview,3);
});
test('disabled document downloads never dispatch downloadPDF',async()=>{
  const h=harness();h.controller.STATE.pdfEnabled=false;
  h.controller.STATE.scanStats.totalDirs=1;
  h.controller.STATE.docs=[{fs_id:1,name:'a.pdf',status:'pending'}];
  await h.controller.startDocDownload();
  assert.equal(h.messages.filter(m=>m.action==='downloadPDF').length,0);
});
test('navigating away cannot accidentally start the previous directory queue',async()=>{
  const h=harness();await h.controller.doScan();h.window.location.hash='#/index?path=%2Fother';
  h.window.__toggleVideoExport();await drain();
  assert.equal(h.opens.length,0);assert.match(h.controller.STATE.notice,/目录/);
});
test('pause/resume does not fail an in-flight open request without its tab reply yet',async()=>{
  const h=harness();await h.controller.doScan();h.window.__toggleVideoExport();await drain();
  h.window.__toggleVideoExport();h.window.__toggleVideoExport();await drain();
  assert.equal(h.controller.STATE.totalFailed,0);assert.equal(h.opens.length,2);
});
test('disabling documents while downloading finishes that file and leaves following files pending',async()=>{
  const h=harness({onSend(message){
    if(message.action==='downloadPDF')return {ok:true,downloadId:80};
    if(message.action==='getDownloadStatus'){h.controller.STATE.pdfEnabled=false;return {ok:true,state:'complete'};}
  }});
  h.controller.STATE.scanStats.totalDirs=1;
  h.controller.STATE.docs=[1,2].map(fs_id=>({fs_id,name:fs_id+'.pdf',status:'pending'}));
  await h.controller.startDocDownload();
  assert.equal(h.messages.filter(m=>m.action==='downloadPDF').length,1);
  assert.equal(h.controller.STATE.docs[0].status,'done');assert.equal(h.controller.STATE.docs[1].status,'pending');
  assert.equal(h.controller.STATE.docMode,'idle');
});
test('rendering after a poll retains an expanded problem list',()=>{
  const h=harness();h.controller.STATE.videos=[{name:'a.mp4',status:'failed',reason:'播放页未加载'}];
  h.controller.STATE.showFailed=true;
  assert.match(h.controller.renderFailedHtml(),/<details\b[^>]*\bopen(?:\s|>)/);
  h.controller.STATE.showFailed=false;
  assert.doesNotMatch(h.controller.renderFailedHtml(),/<details\b[^>]*\bopen(?:\s|>)/);
});

test('problem list excludes successfully cached review files and exposes full escaped paths',()=>{
  const h=harness();const state=h.controller.STATE;
  state.rootDir='/course';state.showFailed=true;
  state.videos=[
    {name:'cached.mp4',path:'/course/cached.mp4',status:'review',reason:'review-exclusive'},
    {name:'fail.mp4',path:'/course/deep/<folder>/fail.mp4',status:'failed',reason:'关闭 & 超时'},
    {name:'skip.mov',path:'/course/deep/skip.mov',status:'skipped',reason:'没有可用文字'}
  ];
  const html=h.controller.renderFailedHtml();
  assert.match(html,/待处理的问题[\s\S]*\(2\)/);
  assert.doesNotMatch(html,/cached\.mp4|review-exclusive|需要关注/);
  assert.match(html,/\/course\/deep\/&lt;folder&gt;\/fail\.mp4/);
  assert.match(html,/关闭 &amp; 超时/);
  assert.match(html,/查看失败 \(1\)/);assert.match(html,/查看跳过 \(1\)/);
});

test('problem filters select files by task status without confusing manuscript unknown',()=>{
  const h=harness();const state=h.controller.STATE;
  state.showFailed=true;state.problemFilter='failed';
  state.videos=[
    {name:'failed.mp4',path:'/course/failed.mp4',status:'failed'},
    {name:'skipped.mov',path:'/course/skipped.mov',status:'skipped'},
    {name:'subtitle.mov',path:'/course/subtitle.mov',status:'review',source:'subtitle'}
  ];
  const failed=h.controller.renderFailedHtml();
  assert.match(failed,/\/course\/failed\.mp4/);assert.doesNotMatch(failed,/\/course\/skipped\.mov|\/course\/subtitle\.mov/);
  state.problemFilter='skipped';const skipped=h.controller.renderFailedHtml();
  assert.match(skipped,/\/course\/skipped\.mov/);assert.doesNotMatch(skipped,/\/course\/failed\.mp4/);
});

test('successfully cached review files have their own list and retain expanded state',()=>{
  const h=harness();const state=h.controller.STATE;
  state.showCached=true;state.videos=[{name:'a.mov',path:'/course/a.mov',status:'review',source:'subtitle',reason:'字幕完整性待核对'}];
  assert.equal(typeof h.controller.renderCachedHtml,'function');
  const html=h.controller.renderCachedHtml();
  assert.match(html,/已缓存文字清单 \(1\)/);assert.match(html,/<details\b[^>]*\bopen(?:\s|>)/);
  assert.match(html,/字幕补提/);assert.match(html,/\/course\/a\.mov/);assert.doesNotMatch(html,/待处理的问题/);
});

test('directory result summary separates successful sources from files without text',()=>{
  const h=harness();const state=h.controller.STATE;
  state.videos=[
    ...Array.from({length:562},(_,i)=>({name:i+'.mp4',status:'review',source:'manuscript'})),
    ...Array.from({length:115},(_,i)=>({name:i+'.mov',status:'review',source:'subtitle'})),
    ...Array.from({length:21},(_,i)=>({name:i+'.mp4',status:'failed'})),
    ...Array.from({length:3},(_,i)=>({name:i+'.mov',status:'skipped'}))
  ];
  assert.equal(typeof h.controller.renderResultSummaryHtml,'function');
  const html=h.controller.renderResultSummaryHtml();
  assert.match(html,/701 个视频 = 677 已缓存 \+ 24 尚未取得/);
  assert.match(html,/网页文稿[\s\S]*562/);assert.match(html,/字幕补提[\s\S]*115/);
  assert.match(html,/失败 21/);assert.match(html,/跳过 3/);assert.match(html,/处理中 0/);assert.match(html,/待处理 0/);
  assert.match(html,/ZIP.*核验/);assert.doesNotMatch(html,/来源未标明/);
});

test('result table never presents old successful sources as failed and manuscript table is secondary',()=>{
  const h=harness();const state=h.controller.STATE;
  state.videos=[{name:'legacy.mp4',status:'review'},{name:'new.mov',status:'opening'},{name:'later.mov',status:'pending'}];
  assert.equal(typeof h.controller.renderResultSummaryHtml,'function');
  const summary=h.controller.renderResultSummaryHtml();
  assert.match(summary,/3 个视频 = 1 已缓存 \+ 2 尚未取得/);
  assert.match(summary,/来源未标明[\s\S]*1/);assert.match(summary,/处理中 1/);assert.match(summary,/待处理 1/);
  const html=h.controller.renderFormatStatsHtml();
  assert.match(html,/按格式看提取结果/);
  assert.match(html,/id="__batch_manuscript_stats__"/);
  assert.doesNotMatch(html,/<details\b[^>]*\bopen(?:\s|>)/);
  state.showManuscriptStats=true;
  assert.match(h.controller.renderFormatStatsHtml(),/<details\b[^>]*\bopen(?:\s|>)/);
  assert.match(html,/未知.*不等于.*失败/);assert.match(html,/未检出.*不.*永久/);
});

test('explicit skipped retry in the directory starts only missing items after reclaiming',async()=>{
 const h=harness({openReply:true});await h.controller.doScan();h.window.__toggleVideoExport();await drain();
 const first=h.opens[0].taskId,second=h.opens[1].taskId;
 for(const job of h.opens.slice())h.controller.receiveResult({...job,status:job.taskId===first?'review':'skipped'});await drain();
 h.controller.receiveResult({...h.opens[2],status:'skipped'});await drain();
 assert.match(h.controller.renderFailedHtml(),/重试已跳过/);
 await h.controller.beginRun('skipped');await drain();assert.equal(h.opens.filter(j=>j.taskId===first).length,1);assert.equal(h.opens.filter(j=>j.taskId===second).length,2);
});


test('directory statistics render actual observations and survive checkpoint restore',async()=>{
  const h=harness({openReply:true});await h.controller.doScan();h.window.__toggleVideoExport();await drain();
  const first=h.opens[0];
  h.controller.receiveResult({...first,status:'failed',reason:'缓存失败',manuscriptObservation:{version:1,state:'present',reason:'已有正文',checkedAt:'2026-10-17T00:00:00.000Z',attempt:first.attempt}});await drain();
  const rendered=h.controller.renderFormatStatsHtml();
  assert.match(rendered,/>MP4<.*>3<.*>1<.*>0<.*>2<.*>100.0%/);
  assert.match(rendered,/>MOV<.*暂无样本/);
  const saved=Object.values(h.stored).find(v=>v?.queue);
  assert.equal(saved.queue.videos[0].manuscriptObservation.state,'present');
  const next=harness({stored:h.stored});await next.controller.restoreCheckpoint('/course');
  assert.match(next.controller.renderFormatStatsHtml(),/>MP4<.*>100.0%/);
});
