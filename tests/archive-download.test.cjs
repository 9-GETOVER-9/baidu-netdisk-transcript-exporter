const test=require('node:test');const assert=require('node:assert/strict');
const {save}=require('../archive-download.js');
const {createStore}=require('../archive-store.js');
function harness(states){let now=0,revoked=0;const requests=[];return {requests,getRevoked:()=>revoked,
  chrome:{downloads:{async download(options){requests.push(options);return 1;},async search(){return [{id:1,filename:'D:/文稿/成果.zip',...states.shift()}];}}},
  options:{urlAPI:{createObjectURL:()=> 'blob:offline-test',revokeObjectURL:()=>revoked++},sleep:async ms=>{now+=ms;},now:()=>now,timeoutMs:5000}};}
test('ZIP reports success and revokes its Blob only after download completion',async()=>{
  const h=harness([{state:'in_progress'},{state:'complete'}]);
  const result=await save(h.chrome,new Uint8Array([1]),'文稿/成果.zip',h.options);
  assert.equal(result.filename,'D:/文稿/成果.zip');assert.equal(h.getRevoked(),1);assert.equal(h.requests.length,1);
});
test('interrupted ZIP is an error instead of a success',async()=>{
  const h=harness([{state:'interrupted',error:'USER_CANCELED'}]);
  await assert.rejects(save(h.chrome,new Uint8Array([1]),'成果.zip',h.options),/USER_CANCELED/);assert.equal(h.getRevoked(),1);
});
test('a ZIP still downloading at timeout keeps its Blob available and is not marked complete',async()=>{
  const h=harness(Array.from({length:8},()=>({state:'in_progress'})));
  await assert.rejects(save(h.chrome,new Uint8Array([1]),'成果.zip',h.options),/未确认完成/);assert.equal(h.getRevoked(),0);
});
test('archive storage rejects invalid records and unavailable storage with readable errors',async()=>{
  const store=createStore({factory:null});
  await assert.rejects(store.put({rootDir:'/root',taskId:'1',markdown:''}),/缺少/);
  await assert.rejects(store.list('/root'),/不支持/);
});
