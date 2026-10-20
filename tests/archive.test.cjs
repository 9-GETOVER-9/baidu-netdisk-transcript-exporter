const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const os=require('node:os');
const {spawnSync}=require('node:child_process');
const archiveFile=path.join(__dirname,'../archive-core.js');
const core=fs.existsSync(archiveFile)?require(archiveFile):{};
const root='/我的资源/课程合集';
function snapshot() {
  return {queue:{rootDir:root,batchId:'batch',videos:[
    {taskId:'1',name:'第一课.mp4',path:root+'/第一章/第一课.mp4',size:10,mtime:1,status:'review',attempt:1},
    {taskId:'2',name:'第二课.mp4',path:root+'/第二章/第二课.mp4',size:20,mtime:2,status:'skipped',reason:'未发现文稿入口'},
    {taskId:'3',name:'第三课.mp4',path:root+'/第二章/第三课.mp4',status:'pending'}
  ]},scanStats:{failedDirs:[{path:root+'/未扫描子目录',error:'HTTP 503'}]},updatedAt:123};
}
function record(taskId='1',extra={}) {return {rootDir:root,taskId,sourcePath:root+'/第一章/第一课.mp4',sourceSize:10,sourceMtime:1,markdown:'# 第一课\n\n课程正文。',...extra};}
test('archive keeps the selected cloud hierarchy and reports exact missing paths',()=>{
  assert.equal(typeof core.buildBundle,'function');
  const bundle=core.buildBundle(snapshot(),[record()]);
  assert.ok(bundle.entries.some(e=>e.name==='课程合集/第一章/第一课.md'&&e.text.includes('课程正文')));
  assert.equal(bundle.summary.extracted,1);
  assert.equal(bundle.summary.missing,2);
  assert.equal(bundle.summary.pending,1);
  assert.equal(bundle.summary.scanFailed,1);
  const missing=bundle.entries.find(e=>e.name==='_提取报告/未提取清单.md').text;
  assert.ok(missing.includes(root+'/第二章/第二课.mp4'));
  assert.ok(missing.includes('未发现文稿入口'));
  assert.ok(missing.includes(root+'/未扫描子目录'));
  assert.ok(bundle.entries.some(e=>e.name==='课程合集/第二章/'));
});
test('old saved records without retained content are listed as missing instead of a fake markdown',()=>{
  const saved=snapshot();saved.queue.videos[0].status='saved';
  const bundle=core.buildBundle(saved,[]);
  assert.equal(bundle.summary.extracted,0);
  assert.match(bundle.rows[0].reason,/缓存|旧版/);
  assert.equal(bundle.entries.some(e=>e.name.endsWith('第一课.md')),false);
});
test('changed source metadata cannot silently reuse an old transcript',()=>{
  const bundle=core.buildBundle(snapshot(),[record('1',{sourceMtime:99})]);
  assert.equal(bundle.summary.extracted,0);
});
test('a retained transcript survives a single-file download failure and is included in the ZIP',()=>{
  const saved=snapshot();saved.queue.videos[0].status='failed';saved.queue.videos[0].reason='单篇下载失败';
  const bundle=core.buildBundle(saved,[record()]);
  assert.equal(bundle.summary.extracted,1);
  assert.equal(bundle.rows[0].status,'review');
  assert.match(bundle.rows[0].reason,/下载/);
});
test('same-stem and sanitized filename collisions get separate files',()=>{
  const saved=snapshot();saved.scanStats.failedDirs=[];
  saved.queue.videos=[
    {taskId:'a',path:root+'/A?.mp4',name:'A?.mp4',status:'review'},
    {taskId:'b',path:root+'/A*.mkv',name:'A*.mkv',status:'review'}
  ];
  const records=saved.queue.videos.map(v=>({rootDir:root,taskId:v.taskId,sourcePath:v.path,markdown:'# 文稿'}));
  const names=core.buildBundle(saved,records).rows.map(v=>v.outputPath);
  assert.equal(new Set(names).size,2);
  assert.ok(names.every(name=>!/[?*]/.test(name)));
});
test('HTML report escapes remote names, includes searchable filters and has no external assets',()=>{
  const saved=snapshot();saved.queue.videos[1].reason='</script><img src=x onerror=alert(1)>';
  const html=core.buildBundle(saved,[record()]).entries.find(e=>e.name==='_提取报告/总览.html').text;
  assert.equal((html.match(/<\/script>/g)||[]).length,1);
  assert.ok(html.includes('id="search"'));
  assert.ok(html.includes('data-filter="missing"'));
  assert.equal(/<script[^>]+src=|<link[^>]+href="https?:/.test(html),false);
  assert.equal(html.includes('<img src=x'),false);
});
test('out-of-root sources cannot escape the archive tree',()=>{
  const saved=snapshot();saved.queue.videos[0].path='/别的资源/第一课.mp4';
  const bundle=core.buildBundle(saved,[record('1',{sourcePath:'/别的资源/第一课.mp4'})]);
  assert.equal(bundle.summary.extracted,0);
  assert.ok(bundle.entries.every(e=>!e.name.startsWith('/')&&!e.name.split('/').includes('..')));
});
test('scanned empty and document-only directories retain their original hierarchy',()=>{
  const saved=snapshot();saved.scanStats.dirDetails=[{path:root+'/只有资料/空子目录'}];
  const bundle=core.buildBundle(saved,[]);
  assert.ok(bundle.entries.some(e=>e.name==='课程合集/只有资料/空子目录/'));
  assert.ok(bundle.entries.some(e=>e.name==='课程合集/未扫描子目录/'));
});
test('ZIP is readable by an independent reader, with Chinese paths and correct content',async()=>{
  assert.equal(typeof core.encodeZip,'function');
  const bytes=await core.encodeZip([{name:'课程/第一课.md',text:'# 课程\n你好。'},{name:'空目录/',text:''}]);
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'pd-zip-test-'));
  const zip=path.join(directory,'sample.zip');
  try {
    fs.writeFileSync(zip,bytes);
    const check=spawnSync((process.env.PYTHON || 'python'),['-c','import zipfile,sys,json; z=zipfile.ZipFile(sys.argv[1]); assert z.testzip() is None; print(json.dumps({"names":z.namelist(),"text":z.read("课程/第一课.md").decode("utf-8")},ensure_ascii=True))',zip],{encoding:'utf8'});
    assert.equal(check.status,0,check.stderr);
    const result=JSON.parse(check.stdout);
    assert.equal(result.text,'# 课程\n你好。');
    assert.deepEqual(result.names,['课程/第一课.md','空目录/']);
  } finally {fs.rmSync(directory,{recursive:true,force:true});}
});
test('compressible Markdown uses valid DEFLATE entries that pass independent CRC checking',async()=>{
  const text='# 长文稿\n'+('课程内容，按目录保留。\n'.repeat(2000));
  const bytes=await core.encodeZip([{name:'课程/长文稿.md',text}]);
  assert.equal(new DataView(bytes.buffer,bytes.byteOffset).getUint16(8,true),8);
  assert.ok(bytes.length<Buffer.byteLength(text)/2);
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'pd-deflate-test-'));
  const zip=path.join(directory,'sample.zip');
  try{fs.writeFileSync(zip,bytes);const check=spawnSync((process.env.PYTHON || 'python'),['-c','import zipfile,sys;z=zipfile.ZipFile(sys.argv[1]);assert z.testzip() is None;assert len(z.read("课程/长文稿.md").decode("utf-8"))==int(sys.argv[2])',zip,String(text.length)],{encoding:'utf8'});assert.equal(check.status,0,check.stderr);}
  finally{fs.rmSync(directory,{recursive:true,force:true});}
});
