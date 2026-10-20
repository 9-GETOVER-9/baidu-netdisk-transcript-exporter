const test=require('node:test');
const assert=require('node:assert/strict');
const vm=require('node:vm');
const {buildBundle}=require('../archive-core.js');
const root='/我的资源/课程';
function fixture({manuscript=562,subtitle=115,sourceUnknown=0,failed=21,skipped=3}={}){
  const videos=[],records=[];
  for(const [kind,count] of Object.entries({manuscript,subtitle,sourceUnknown,failed,skipped}))for(let i=0;i<count;i++){
    const id=String(videos.length),v={taskId:id,name:id+'.'+(i%2?'mov':'mp4'),path:root+'/章节/'+id+'.'+(i%2?'mov':'mp4'),size:10,mtime:1,attempt:1,status:['failed','skipped'].includes(kind)?kind:'review',reason:['failed','skipped'].includes(kind)?'未能读取文字':'完整性待核对'};
    videos.push(v);
    if(v.status==='review')records.push({taskId:id,rootDir:root,sourcePath:v.path,sourceSize:10,sourceMtime:1,attempt:1,source:kind==='sourceUnknown'?null:kind,markdown:'# 正文'});
  }
  return buildBundle({queue:{rootDir:root,videos},scanStats:{failedDirs:[]}},records,{generatedAt:'2026-10-17T12:32:26.000Z'});
}
const entry=(b,name)=>b.entries.find(e=>e.name==='_提取报告/'+name)?.text;
test('701 videos reconcile as 562 manuscripts + 115 subtitles + 24 missing in HTML, Markdown and JSON',()=>{
  const bundle=fixture(),s=bundle.resultSummary;
  assert.ok(s,'resultSummary is separate from manuscript observations');
  assert.equal(s.total,701);assert.equal(s.obtained,677);assert.equal(s.manuscript,562);assert.equal(s.subtitle,115);assert.equal(s.sourceUnknown,0);assert.equal(s.missing,24);assert.equal(s.failed,21);assert.equal(s.skipped,3);
  assert.equal(bundle.summary.extracted,s.obtained,'legacy archive counts remain compatible');
  assert.equal(bundle.formatResults.reduce((n,r)=>n+r.obtained,0),677);
  const report=entry(bundle,'导出结果统计.md'),html=entry(bundle,'总览.html'),json=JSON.parse(entry(bundle,'全部文件清单.json'));
  assert.deepEqual(json.resultSummary,s);assert.deepEqual(json.formatResults,bundle.formatResults);
  for(const content of [report,html]){
    assert.match(content,/网页文稿 562/);assert.match(content,/字幕补提 115/);assert.match(content,/已取得文字 677/);assert.match(content,/尚未取得 24/);
    assert.match(content,/失败 21/);assert.match(content,/跳过 3/);
    assert.doesNotMatch(content,/本包已包含文稿|本包未包含文稿/);
  }
  assert.match(html,/<details[^>]*class="[^"]*observation/);
  assert.doesNotMatch(html,/<details[^>]*\bopen(?:\s|=|>)/);
  assert.match(html,/仅网页文稿检测，不等于文字导出结果/);
  assert.match(entry(bundle,'格式文稿统计.md'),/仅网页文稿检测，不等于文字导出结果/);
});
test('legacy successful content without source is not invented as a manuscript',()=>{
  const bundle=fixture({manuscript:1,subtitle:1,sourceUnknown:1,failed:0,skipped:0});
  assert.ok(bundle.resultSummary);assert.equal(bundle.resultSummary.sourceUnknown,1);
  assert.match(entry(bundle,'导出结果统计.md'),/来源未标明 1/);
  assert.match(entry(bundle,'总览.html'),/来源未标明 1/);
  assert.equal(bundle.resultSummary.obtained,3);
});
test('offline report filters source and status independently and preserves full paths',()=>{
  const bundle=fixture({manuscript:2,subtitle:1,sourceUnknown:1,failed:1,skipped:1}),html=entry(bundle,'总览.html');
  function el(dataset={}){return {dataset,textContent:'',value:'',children:[],handlers:{},append(...values){this.children.push(...values);},replaceChildren(...values){this.children=values.flatMap(v=>v.isFragment?v.children:[v]);},addEventListener(type,fn){this.handlers[type]=fn;},setAttribute(){}};}
  const ids=new Map(['rows','search','shown'].map(id=>[id,el()]));
  const statusButtons=[...html.matchAll(/data-filter="([^"]+)"/g)].map(m=>el({filter:m[1]}));
  const sourceButtons=[...html.matchAll(/data-source-filter="([^"]+)"/g)].map(m=>el({sourceFilter:m[1]}));
  assert.ok(sourceButtons.some(b=>b.dataset.sourceFilter==='subtitle'),'a subtitle source filter is available');
  const context=vm.createContext({document:{getElementById:id=>ids.get(id),createElement:()=>el(),createDocumentFragment:()=>Object.assign(el(),{isFragment:true}),querySelectorAll:selector=>selector==='[data-filter]'?statusButtons:sourceButtons}});
  vm.runInContext(html.match(/<script>([\s\S]*?)<\/script>/)[1],context);
  assert.equal(ids.get('rows').children.length,6);
  const click=(buttons,key,value)=>buttons.find(b=>b.dataset[key]===value).handlers.click();
  click(sourceButtons,'sourceFilter','subtitle');assert.equal(ids.get('rows').children.length,1);
  click(statusButtons,'filter','failed');assert.equal(ids.get('rows').children.length,0,'saved subtitle is never a failed result');
  click(sourceButtons,'sourceFilter','all');assert.equal(ids.get('rows').children.length,1);
  const failure=bundle.rows.find(r=>r.status==='failed');
  assert.equal(ids.get('rows').children[0].children[1].children[1].textContent,failure.sourcePath);
  click(statusButtons,'filter','all');click(sourceButtons,'sourceFilter','unknown');assert.equal(ids.get('rows').children.length,1,'source unknown selects successful legacy content only');
});
