const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path');
const api=fs.existsSync(path.join(__dirname,'../result-stats.js'))?require('../result-stats.js'):{};
function fixture(){
 const rows=[];
 for(const [format,manuscript,subtitle,failed,skipped] of [['mp4',524,98,19,2],['mov',36,17,2,1],['mkv',2,0,0,0]]){
  for(const [count,source,status,included] of [[manuscript,'manuscript','review',true],[subtitle,'subtitle','review',true],[failed,null,'failed',false],[skipped,null,'skipped',false]])
   for(let i=0;i<count;i++)rows.push({sourcePath:'/课程/'+rows.length+'.'+format,attempt:1,source,status,included});
 }
 return rows;
}
test('701 export outcomes reconcile to 562 manuscripts + 115 subtitles + 24 missing',()=>{
 assert.equal(typeof api.summarize,'function');
 const result=api.summarize(fixture(),{archive:true});
 assert.deepEqual(result,{total:701,obtained:677,manuscript:562,subtitle:115,sourceUnknown:0,missing:24,failed:21,skipped:3,pending:0,active:0,cacheMissing:0,review:677});
 const rows=api.byFormat(fixture(),{archive:true});
 assert.deepEqual(rows.map(r=>[r.format,r.total,r.manuscript,r.subtitle,r.missing]),[['mp4',643,524,98,21],['mov',56,36,17,3],['mkv',2,2,0,0]]);
 for(const row of rows)assert.equal(row.total,row.manuscript+row.subtitle+row.sourceUnknown+row.missing);
});
test('old unlabelled successes remain sourceUnknown and manuscript observations never invent sources',()=>{
 assert.equal(typeof api.summarize,'function');
 const r=api.summarize([{status:'review',sourcePath:'/a.mp4',source:null,manuscriptObservation:{state:'present'}},{status:'review',sourcePath:'/b.mov',source:'subtitle',manuscriptObservation:{state:'unknown'}},{status:'failed',sourcePath:'/c.mp4',source:'manuscript',manuscriptObservation:{state:'present'}}]);
 assert.equal(r.obtained,2);assert.equal(r.manuscript,0);assert.equal(r.subtitle,1);assert.equal(r.sourceUnknown,1);assert.equal(r.failed,1);
});
test('ZIP truth uses included, distinguishes missing cache and unfinished tasks',()=>{
 assert.equal(typeof api.summarize,'function');
 const r=api.summarize([{included:true,status:'failed',source:'subtitle'}, {included:false,status:'cache_missing',source:'manuscript'}, {included:false,status:'pending'}, {included:false,status:'opening'}, {included:false,status:'opened'}],{archive:true});
 assert.equal(r.obtained,1);assert.equal(r.subtitle,1);assert.equal(r.failed,0);assert.equal(r.missing,4);assert.equal(r.cacheMissing,1);assert.equal(r.pending,1);assert.equal(r.active,2);
});
test('retries count one file and case-insensitive extensions share the correct format',()=>{
 assert.equal(typeof api.byFormat,'function');
 const rows=api.byFormat([{path:'/a.MOV',attempt:2,status:'failed'},{path:'/a.MOV',attempt:1,status:'review',source:'subtitle'},{path:'/b.mov',status:'review',source:'manuscript'}]);
 assert.equal(rows.find(r=>r.format==='mov').total,2);assert.equal(rows.find(r=>r.format==='mov').manuscript,1);assert.equal(rows.find(r=>r.format==='mov').subtitle,0);assert.equal(rows.find(r=>r.format==='mov').missing,1);
 assert.equal(rows.find(r=>r.format==='mp4').total,0);
});
