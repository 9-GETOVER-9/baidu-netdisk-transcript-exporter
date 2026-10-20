const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const stats=fs.existsSync(require('node:path').join(__dirname,'../format-stats.js'))?require('../format-stats.js'):{};
const observed=(state,attempt=1,extra={})=>({version:1,state,reason:'页面检查',checkedAt:'2026-10-17T05:00:00.000Z',attempt,...extra});
const video=(id,name,state,extra={})=>({taskId:id,name,path:'/课/'+name,attempt:1,manuscriptObservation:state?observed(state):undefined,...extra});

test('only valid current-attempt observations may enter format denominators',()=>{
  assert.equal(typeof stats.normalizeObservation,'function');
  assert.deepEqual(stats.normalizeObservation(observed('present'),1),observed('present'));
  for(const invalid of [observed('absent'),observed('present',0),observed('present',1,{version:2}),observed('present',1,{checkedAt:''}),observed('present',1,{checkedAt:'yesterday'}),observed('present',1,{checkedAt:'2026-02-30T05:00:00.000Z'}),observed('present',1,{reason:{bad:true}})])assert.equal(stats.normalizeObservation(invalid,1),null);
  assert.equal(stats.normalizeObservation(observed('present'),2),null);
  assert.equal(stats.normalizeObservation(observed('present',1,{reason:'x'.repeat(1500)}),1).reason.length,1000);
});
test('unknown and old failures stay outside MP4/MOV checked denominators',()=>{
  assert.equal(typeof stats.summarize,'function');
  const result=stats.summarize([video('1','一.MP4','present'),video('2','二.mp4','not_detected'),video('3','三.mp4','unknown'),video('4','四.mp4',null,{status:'skipped',reason:'未发现文稿入口'}),video('5','五.MOV',null,{source:'subtitle',status:'review'}),video('6','六.mov','present',{attempt:2})]);
  assert.deepEqual(result.find(r=>r.format==='mp4'),{format:'mp4',total:4,present:1,notDetected:1,unknown:2,checked:2,rate:0.5});
  assert.deepEqual(result.find(r=>r.format==='mov'),{format:'mov',total:2,present:0,notDetected:0,unknown:2,checked:0,rate:null});
});
test('retry attempts replace earlier samples instead of inflating the rate',()=>{
  assert.equal(typeof stats.summarize,'function');
  const first=video('1','一.mp4','present');
  const retry=video('1','一.mp4','unknown',{attempt:2,manuscriptObservation:observed('unknown',2)});
  const rows=stats.summarize([retry,first,retry]);
  assert.deepEqual(rows.find(r=>r.format==='mp4'),{format:'mp4',total:1,present:0,notDetected:0,unknown:1,checked:0,rate:null});
  assert.deepEqual(rows.find(r=>r.format==='mov'),{format:'mov',total:0,present:0,notDetected:0,unknown:0,checked:0,rate:null});
});
