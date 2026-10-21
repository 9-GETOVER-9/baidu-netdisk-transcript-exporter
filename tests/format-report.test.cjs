const test=require('node:test');
const assert=require('node:assert/strict');
const {buildBundle}=require('../archive-core.js');
const root='/课';
const observed=(state,attempt=1)=>({version:1,state,reason:'有效检查',checkedAt:'2026-10-17T05:00:00.000Z',attempt});
const video=(id,name,state)=>({taskId:id,name,path:root+'/'+name,size:10,mtime:2,attempt:1,status:'failed',manuscriptObservation:state?observed(state):undefined});
const record=(v,source,extra={})=>({taskId:v.taskId,rootDir:root,sourcePath:v.path,sourceSize:v.size,sourceMtime:v.mtime,attempt:v.attempt,source,markdown:'# 正文',capturedAt:'2026-10-17T05:00:00.000Z',...extra});
const build=(videos,records=[])=>buildBundle({queue:{rootDir:root,videos},scanStats:{failedDirs:[]}},records,{generatedAt:'2026-10-17T06:00:00.000Z'});
const entry=(b,name)=>b.entries.find(e=>e.name==='_提取报告/'+name)?.text;

test('archive report keeps format counts consistent across Markdown, HTML and JSON',()=>{
  const a=video('1','一.mp4','present'),b=video('2','二.mp4','not_detected'),c=video('3','三.mp4');
  const bundle=build([a,b,c]);
  assert.ok(Array.isArray(bundle.formatStats));
  const expected={format:'mp4',total:3,present:1,notDetected:1,unknown:1,checked:2,rate:0.5};
  assert.deepEqual(bundle.formatStats.find(r=>r.format==='mp4'),expected);
  const json=JSON.parse(entry(bundle,'全部文件清单.json'));
  assert.deepEqual(json.formatStats,bundle.formatStats);
  assert.deepEqual(json.rows[0].manuscriptObservation,a.manuscriptObservation);
  const md=entry(bundle,'格式文稿统计.md'),html=entry(bundle,'总览.html');
  assert.match(md,/\| MP4 \| 3 \| 1 \| 1 \| 1 \| 50\.0% \|/);
  assert.match(md,/\| MOV \| 0 \| 0 \| 0 \| 0 \| 暂无有效检查 \|/);
  assert.match(html,/<td>MP4<\/td><td>3<\/td><td>1<\/td><td>1<\/td><td>1<\/td><td>50\.0%<\/td>/);
  for(const text of [md,html]){assert.match(text,/未知.*不.*分母/);assert.match(text,/全平台/);assert.match(text,/字幕.*不.*文稿/);assert.match(text,/2026-10-17T06:00:00.000Z/);}
});
test('subtitle cache never implies manuscript presence; verified manuscript cache can supply history',()=>{
  const a=video('1','旧字幕.MOV'),b=video('2','旧文稿.MP4');
  const bundle=build([a,b],[record(a,'subtitle'),record(b,'manuscript')]);
  assert.ok(Array.isArray(bundle.formatStats));
  assert.equal(bundle.formatStats.find(r=>r.format==='mov').unknown,1);
  assert.equal(bundle.formatStats.find(r=>r.format==='mp4').present,1);
  assert.equal(bundle.rows[0].source,'subtitle');
  assert.equal(bundle.rows[1].observationOrigin,'cache');
  assert.match(bundle.rows[1].manuscriptObservation.reason,/缓存/);
  const changed=build([b],[record(b,'manuscript',{sourceMtime:99})]);
  assert.equal(changed.formatStats.find(r=>r.format==='mp4').unknown,1);
});
test('newer unknown observation overrides old cache and untrusted suffixes are escaped',()=>{
  const a=video('1','重试.mp4','unknown');a.attempt=2;a.manuscriptObservation=observed('unknown',2);
  const b=video('2','课程.<img onerror=alert(1)>','present');
  const bundle=build([a,b],[record(a,'manuscript',{attempt:1})]);
  assert.ok(Array.isArray(bundle.formatStats));
  assert.equal(bundle.formatStats.find(r=>r.format==='mp4').unknown,1);
  const html=entry(bundle,'总览.html');
  assert.equal(html.includes('<img onerror='),false);
  assert.equal((html.match(/<\/script>/g)||[]).length,1);
});
test('export page shows the same format sample before saving its single ZIP',{timeout:15000},async()=>{
  const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
  const markup=fs.readFileSync(path.join(__dirname,'../export.html'),'utf8');
  assert.ok(markup.includes('id="formatRows"'));
  assert.ok(markup.indexOf('src="format-stats.js"')>=0&&markup.indexOf('src="format-stats.js"')<markup.indexOf('src="archive-core.js"'));
  assert.ok(markup.indexOf('src="result-stats.js"')>=0&&markup.indexOf('src="result-stats.js"')<markup.indexOf('src="archive-core.js"'));
  assert.match(markup,/<details class="card observation">/,'observation table is collapsed by default');
  function element(){return {textContent:'',children:[],append(...items){this.children.push(...items);},replaceChildren(...items){this.children=items;},classList:{toggle(){}},addEventListener(){}};}
  const nodes=new Map([...markup.matchAll(/id="([^"]+)"/g)].map(m=>[m[1],element()]));
  const a=video('1','一.MOV','not_detected'),b=video('2','二.mp4','present');
  const snapshot={queue:{rootDir:root,batchId:'batch',videos:[a,b]},scanStats:{failedDirs:[]}};
  let downloadCount=0;
  const context=vm.createContext({URL,document:{getElementById:id=>nodes.get(id),createElement:element},location:{href:'chrome-extension://id/export.html?'+new URLSearchParams({root,batch:'batch'})},chrome:{storage:{local:{async get(key){return key==='outputSubfolder'?{}:{[key]:snapshot};}}}},PDFormatStats:require('../format-stats.js'),PDArchive:require('../archive-core.js'),PDArchiveStore:{async list(){return [record(a,'subtitle'),record(b,'manuscript')];}},PDArchiveDownload:{async save(_chrome,_bytes,filename){downloadCount++;return {filename};}}});
  // export.js ends in generate(): await the real operation instead of a 1-second CPU race.
  await vm.runInContext(fs.readFileSync(path.join(__dirname,'../export.js'),'utf8'),context);
  const displayed=nodes.get('formatRows').children.map(tr=>tr.children.map(td=>td.textContent));
  assert.deepEqual(displayed,[['MP4','1','1','0','0','100.0%'],['MOV','1','0','1','0','0.0%']]);
  const results=nodes.get('resultRows').children.map(tr=>tr.children.map(td=>td.textContent));
  assert.deepEqual(results,[['MP4','1','1','0','1','0'],['MOV','1','0','1','1','0']]);
  assert.equal(nodes.get('resultEquation').textContent,'网页文稿 1 + 字幕补提 1 = 已取得文字 2');
  assert.equal(nodes.get('resultTotal').textContent,'已取得文字 2 + 尚未取得 0 = 已扫描视频 2');
  assert.equal(nodes.get('resultUnknownHeader').hidden,true);
  assert.match(nodes.get('status').textContent,/网页文稿 1、字幕补提 1/);
  assert.match(nodes.get('formatNote').textContent,/未知.*不.*分母/);
  assert.match(nodes.get('formatUpdated').textContent,/快照/);
  assert.equal(downloadCount,1);
});
