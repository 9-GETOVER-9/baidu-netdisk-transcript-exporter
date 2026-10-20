const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const corePath = path.join(__dirname, '../queue-core.js');
const core = fs.existsSync(corePath) ? require(corePath) : {};
const files = n => Array.from({length:n}, (_,i)=>({fs_id:i+1,path:`/课程/${i}.mp4`,name:`${i}.mp4`}));
const make = n => new core.Queue({batchId:'b',rootDir:'/课程',videos:files(n)});

test('queue module exposes its production API',()=> assert.equal(typeof core.Queue,'function'));
test('skipped files free slots, survive restore and do not enter failed retries',()=>{
  const q=make(2);const [job]=q.reserve(1);
  assert.equal(q.applyResult({...job,status:'skipped',reason:'未发现文稿入口'}),true);
  assert.equal(q.counts().skipped,1);
  assert.equal(q.counts().failed,0);
  q.retryFailed();
  const next=q.reserve(1);
  assert.equal(next.length,1);
  assert.notEqual(next[0].taskId,job.taskId);
  const restored=new core.Queue(q.snapshot());
  assert.equal(restored.videos[0].status,'skipped');
});
test('reservation immediately consumes slots and never reopens the first video',()=>{
  const q=make(6); const a=q.reserve(2); const b=q.reserve(2);
  assert.equal(a.length,2); assert.equal(b.length,0);
  assert.notEqual(a[0].taskId,a[1].taskId);
  q.applyResult({...a[0],status:'saved'});
  assert.equal(q.reserve(2)[0].path,'/课程/2.mp4');
});
test('out of order and repeated results are idempotent, stale attempts cannot overwrite retries',()=>{
  const q=make(2); const [a,b]=q.reserve(2);
  assert.equal(q.applyResult({...b,status:'review',reason:'需要核对'}),true);
  assert.equal(q.applyResult({...b,status:'saved'}),false);
  q.applyResult({...a,status:'failed'}); q.retryFailed();
  const next=q.reserve(2)[0]; assert.equal(next.attempt,2);
  assert.equal(q.applyResult({...a,status:'saved'}),false);
  assert.equal(q.applyResult({...next,batchId:'wrong',status:'saved'}),false);
  assert.deepEqual(q.counts(),{pending:0,active:1,saved:0,review:1,failed:0,skipped:0});
});
test('a closed tab without a result fails, never becomes saved',()=>{
  const q=make(2); const jobs=q.reserve(2); q.markOpened(jobs[0],11);q.markOpened(jobs[1],12);
  q.markMissing([11],[]);
  assert.equal(q.videos[0].status,'failed');assert.equal(q.videos[1].status,'opened');
});
test('completion received before open callback is not overwritten',()=>{
  const q=make(1);const [job]=q.reserve(1);q.applyResult({...job,status:'saved'});
  assert.equal(q.markOpened(job,10),false);assert.equal(q.videos[0].status,'saved');
});
test('paused reservations can be returned to pending without touching opened tasks',()=>{
  const q=make(2);const [a,b]=q.reserve(2);q.markOpened(b,42);
  assert.equal(typeof q.cancelReservation,'function');
  assert.equal(q.cancelReservation(a),true);assert.equal(q.cancelReservation(b),false);
  assert.equal(q.counts().pending,1);assert.equal(q.counts().active,1);
});
test('checkpoint roundtrip keeps terminal results and active reservations',()=>{
  const q=make(3);const [a,b]=q.reserve(2);q.applyResult({...a,status:'saved'});q.markOpened(b,22);
  const restored=new core.Queue(q.snapshot());
  assert.equal(restored.videos[0].status,'saved');assert.equal(restored.active()[0].tabId,22);
  assert.equal(restored.reserve(1).length,0);
  restored.markMissing([22],[]);restored.retryFailed();
  assert.equal(restored.reserve(2).length,2);assert.equal(restored.videos[0].attempt,1);
});
test('merge scan preserves matching results, changed file identity becomes pending',()=>{
  const q=make(2);q.applyResult({...q.reserve(1)[0],status:'saved'});
  q.mergeScan([...files(2),{fs_id:3,path:'/new.mp4',name:'new.mp4'}]);
  assert.equal(q.videos[0].status,'saved');assert.equal(q.videos[2].status,'pending');
  q.reserve(1);
  assert.throws(()=>q.mergeScan(files(2)),/活动/);
});
test('changed metadata resets work but never reuses an old terminal attempt',()=>{
  const q=make(1);const first=q.reserve(1)[0];q.applyResult({...first,status:'saved'});
  q.mergeScan([{...files(1)[0],size:200,mtime:1234,status:'pending'}]);
  assert.equal(q.videos[0].status,'pending');assert.equal(q.videos[0].size,200);assert.equal(q.videos[0].mtime,1234);
  const retried=q.reserve(1)[0];assert.equal(retried.attempt,first.attempt+1);
  assert.equal(q.applyResult({...first,status:'saved'}),false);
});
test('all supported video formats are queued consistently, audio remains a document',()=>{
  for(const ext of ['mp4','m4v','mkv','avi','mov','flv','wmv','webm']) assert.equal(core.isVideoFile(`A.${ext.toUpperCase()}`),true);
  assert.equal(core.isVideoFile('audio.m4a'),false);
});
test('filename HTML and encoded directory paths are handled as literal data',()=>{
  assert.equal(core.escapeHtml('<img a="b">&\''),'&lt;img a=&quot;b&quot;&gt;&amp;&#39;');
  assert.equal(core.getDirPath('#/index?path=%2F100%25%2520%2Ba'),'/100%%20+a');
  assert.equal(core.getDirPath('#/index?category=all'),'/');
});
test('later-page API errors reject the directory instead of returning a partial success',async()=>{
  const seen=[];
  const result=await core.listDir('/x',async(url)=>{
    const p=Number(new URL(url).searchParams.get('page'));seen.push(p);
    return {ok:true,json:async()=>p===1?{errno:0,list:[{path:'/a',server_filename:'a.mp4'}]}:{errno:12}};
  },{num:1,maxRetries:2,sleep:async()=>{}});
  assert.match(result.error,/12/);assert.deepEqual(result.files,[]);assert.deepEqual(seen,[1,2,1,2]);
});
test('HTTP and malformed API responses cannot be mistaken for empty directories',async()=>{
  for(const response of [{ok:false,status:503},{ok:true,json:async()=>({errno:0})}]){
    const result=await core.listDir('/x',async()=>response,{maxRetries:1,sleep:async()=>{}});
    assert.equal(typeof result.error,'string');assert.ok(result.error.length);
  }
});
test('directory traversal uses one global concurrency limit and reports failed subtrees',async()=>{
  let active=0,max=0;const visits=[];
  const result=await core.scanTree('/',async p=>{
    visits.push(p);active++;max=Math.max(max,active);await new Promise(r=>setImmediate(r));active--;
    if(p==='/bad')return {files:[],dirs:[],error:'denied'};
    const dirs=p==='/'?['/a','/b','/bad']:p.length===2?[`${p}/1`,`${p}/2`]:[];
    return {files:[{name:'video.mkv',path:`${p}/v.mkv`,fs_id:p}],dirs:dirs.map(path=>({path})),error:null};
  },{concurrency:2});
  assert.ok(max<=2);assert.equal(visits.length,8);assert.equal(result.failedDirs.length,1);
});

test('explicit subtitle retry requeues only skipped items and advances their attempt',()=>{
 const q=make(3);const jobs=q.reserve(3);q.applyResult({...jobs[0],status:'skipped'});q.applyResult({...jobs[1],status:'review',archived:true});q.applyResult({...jobs[2],status:'failed'});
 q.retrySkipped();const next=q.reserve(1);assert.equal(next[0].taskId,jobs[0].taskId);assert.equal(next[0].attempt,jobs[0].attempt+1);assert.equal(q.counts().review,1);assert.equal(q.counts().failed,1);
});
