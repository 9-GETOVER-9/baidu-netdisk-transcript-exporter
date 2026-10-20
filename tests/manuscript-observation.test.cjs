const test = require('node:test');
const assert = require('node:assert/strict');
const {runExport} = require('../transcript-core.js');
const {Queue,isVideoFile} = require('../queue-core.js');
const opts={openTimeoutMs:10,emptyTimeoutMs:10,captureTimeoutMs:40,totalTimeoutMs:100,pollMs:5,stableMs:5};
async function capture(extension, overrides={}) {
  let now=0, fallbackCalls=0;const writes=[];
  const job={taskId:'t',batchId:'b',attempt:1,url:'https://pan.baidu.com/pfile/video?'+new URLSearchParams({path:'/课/样本.'+extension})};
  const deps={now:()=>now,sleep:async ms=>{now+=ms;},openDraft:()=>false,isPageReady:()=>true,
    readSnapshot:()=>({text:'',context:'',panelFound:true}),send:async m=>{writes.push(m);return {ok:true,archived:true};},
    readSubtitles:async()=>{fallbackCalls++;return {status:'review',text:'00:00:01.000 字幕',reason:'字幕需核对'};},...overrides};
  return {result:await runExport(job,deps,opts),writes,fallbackCalls};
}
for(const extension of ['mp4','MOV']) {
  test(extension+' with a manuscript stays on manuscript and records positive evidence',async()=>{
    assert.equal(isVideoFile('样本.'+extension),true);
    const r=await capture(extension,{openDraft:()=>true,readSnapshot:()=>({text:'正文内容',context:'',panelFound:true})});
    assert.equal(r.fallbackCalls,0);assert.equal(r.result.source,'manuscript');
    assert.equal(r.result.manuscriptObservation?.state,'present');
    assert.deepEqual(r.writes[0].manuscriptObservation,r.result.manuscriptObservation);
  });
  test(extension+' without entry tries subtitles and preserves negative detection separately',async()=>{
    const r=await capture(extension);
    assert.equal(r.fallbackCalls,1);assert.equal(r.result.source,'subtitle');
    assert.equal(r.result.manuscriptObservation?.state,'not_detected');
    assert.equal(r.writes[0].manuscriptObservation?.attempt,1);
  });
}
test('unready page remains unknown even when subtitles succeed',async()=>{
  const r=await capture('mov',{isPageReady:()=>false});
  assert.equal(r.result.source,'subtitle');assert.equal(r.result.manuscriptObservation?.state,'unknown');
});
test('generation, permission and missing panel are not negative manuscript evidence',async()=>{
  for(const snapshot of [{text:'生成中',context:'',panelFound:true},{text:'',context:'开通会员查看全文',panelFound:true},{text:'',context:'',panelFound:false}]) {
    const r=await capture('mov',{openDraft:()=>true,readSnapshot:()=>snapshot});
    assert.equal(r.fallbackCalls,1);assert.equal(r.result.manuscriptObservation?.state,'unknown');
  }
});
test('empty loaded panel is not detected, while a failed cache write retains positive evidence',async()=>{
  const empty=await capture('mov',{openDraft:()=>true});assert.equal(empty.result.manuscriptObservation?.state,'not_detected');
  const failure=await capture('mp4',{openDraft:()=>true,readSnapshot:()=>({text:'实际文稿',context:'',panelFound:true}),send:async()=>({ok:false,error:'写入失败'})});
  assert.equal(failure.result.status,'failed');assert.equal(failure.result.manuscriptObservation?.state,'present');
});
test('subtitle errors retain the preceding manuscript observation',async()=>{
  const r=await capture('mov',{readSubtitles:async()=>{throw Error('字幕网络失败');}});
  assert.equal(r.result.status,'failed');assert.equal(r.result.manuscriptObservation?.state,'not_detected');
});
test('server generation or loading failure is unknown, never evidence of absence or readable text',async()=>{
  for (const text of ['文稿生成失败','加载失败','网络异常','文稿生成失败，请重试','加载失败\n重新加载']) {
    const r=await capture('mov',{openDraft:()=>true,readSnapshot:()=>({text,context:text,panelFound:true})});
    assert.equal(r.fallbackCalls,1,text);assert.equal(r.result.manuscriptObservation?.state,'unknown',text);
  }
  const normal=await capture('mov',{openDraft:()=>true,readSnapshot:()=>({text:'遇到加载失败的时候，我们先检查网络。',context:'',panelFound:true})});
  assert.equal(normal.fallbackCalls,0);assert.equal(normal.result.manuscriptObservation.state,'present');
});
test('queue checkpoint preserves evidence, retry replaces it and stale result cannot alter it',()=>{
  const queue=new Queue({batchId:'b',rootDir:'/课',videos:[{fs_id:1,path:'/课/a.MOV',name:'a.MOV'}]});
  const [job]=queue.reserve(1),observation={version:1,state:'not_detected',reason:'没有入口',checkedAt:'2026-10-17T00:00:00.000Z',attempt:1};
  queue.applyResult({...job,status:'failed',manuscriptObservation:observation,source:'subtitle'});
  const restored=new Queue(queue.snapshot());assert.deepEqual(restored.videos[0].manuscriptObservation,observation);
  assert.equal(restored.videos[0].source,'subtitle');
  restored.retryFailed();const [next]=restored.reserve(1);
  assert.equal(restored.videos[0].manuscriptObservation,null);
  assert.equal(restored.applyResult({...job,status:'skipped',manuscriptObservation:observation}),false);
  restored.applyResult({...next,status:'failed',reason:'打不开页面'});
  assert.equal(restored.videos[0].manuscriptObservation,null);
});
