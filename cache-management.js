/* Cache metadata, deletion journal and extension-page authorization. No downloads API. */
(function(root,factory){const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;else root.PDCacheManagement=api;})(globalThis,function(){
  'use strict';
  const JOURNAL='pd_cache_clear_v1';
  const reason='本地文字缓存已由用户清理；已下载 ZIP/MD 不受影响。需要再次打包时请重试提取。';
  function validPath(value){return typeof value==='string'&&value.startsWith('/')&&(value==='/'||!value.slice(1).split('/').some(p=>!p||p==='.'||p==='..'));}
  function within(path,dir){return path===dir||path.startsWith(dir==='/'?'/':dir+'/');}
  function select(records,rootDir,path){
    if(!validPath(rootDir)||!validPath(path)||!within(path,rootDir))throw Error('请选择有效的任务目录及子目录');
    return records.filter(r=>r.rootDir===rootDir&&(path===rootDir||within(r.sourcePath||'',path)));
  }
  function summarize(records){
    const roots=new Map();
    for(const r of records){
      if(!roots.has(r.rootDir))roots.set(r.rootDir,{rootDir:r.rootDir,count:0,bytes:0,folders:new Map()});
      const root=roots.get(r.rootDir);root.count++;root.bytes+=r.bytes;
      const folders=[r.rootDir];
      if(validPath(r.sourcePath)&&within(r.sourcePath,r.rootDir)){
        let folder=r.sourcePath.slice(0,r.sourcePath.lastIndexOf('/'))||'/';
        while(folder!==r.rootDir&&within(folder,r.rootDir)){folders.push(folder);folder=folder.slice(0,folder.lastIndexOf('/'))||'/';}
      }
      for(const path of folders){const f=root.folders.get(path)||{path,count:0,bytes:0};f.count++;f.bytes+=r.bytes;root.folders.set(path,f);}
    }
    return {count:records.length,bytes:records.reduce((n,r)=>n+r.bytes,0),roots:[...roots.values()].sort((a,b)=>a.rootDir.localeCompare(b.rootDir)).map(r=>({...r,folders:[...r.folders.values()].sort((a,b)=>a.path.localeCompare(b.path))}))};
  }
  function formatBytes(bytes){if(bytes<1024)return bytes+' B';if(bytes<1024**2)return (bytes/1024).toFixed(1)+' KiB';return (bytes/1024**2).toFixed(2)+' MiB';}
  async function signature(records){
    const data=records.map(r=>[r.key,r.bytes,r.capturedAt,r.batchId,r.attempt,r.sourcePath]).sort((a,b)=>a[0].localeCompare(b[0]));
    const hash=await globalThis.crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(data)));
    return Array.from(new Uint8Array(hash),b=>b.toString(16).padStart(2,'0')).join('');
  }
  function createManager(chrome,store){
    function authorize(sender){if(sender.id!==chrome.runtime.id||sender.url!==chrome.runtime.getURL('cache.html'))throw Error('只允许本扩展的缓存管理页操作');}
    async function guard(state){
      const tabs=await chrome.tabs.query({});
      const busy=tabs.some(t=>{
        try{const u=new URL(t.pendingUrl||t.url);return (u.origin==='https://pan.baidu.com'&&['/disk/main','/pfile/video'].includes(u.pathname))||u.href.startsWith(chrome.runtime.getURL('export.html'));}catch{return false;}
      });
      if(busy)throw Error('请先暂停提取、等待任务收尾，并关闭网盘目录/视频页及 ZIP 打包页，再清理缓存；本页可以保留。');
      // A reserved task without a tab may still be queued. The caller serializes all writers.
      for(const job of Object.values(state.jobs||{}))if(!job.result&&tabs.some(t=>t.id===job.tabId))throw Error('仍有提取任务在运行，请等待收尾');
    }
    async function recover(state){
      const journal=(await chrome.storage.local.get(JOURNAL))[JOURNAL];
      if(!journal)return;
      const ids=new Set(journal.records.map(r=>r.taskId));
      await store.removeKeys(journal.records.map(r=>r.key));
      const key='pandownload.queue.v1.'+encodeURIComponent(journal.rootDir);
      const snapshot=(await chrome.storage.local.get(key))[key];
      if(snapshot?.queue?.rootDir===journal.rootDir&&Array.isArray(snapshot.queue.videos)){
        for(const v of snapshot.queue.videos)if(ids.has(v.taskId))Object.assign(v,{status:'failed',archived:false,source:null,manuscriptObservation:null,tabId:null,downloadId:null,reason});
        snapshot.updatedAt=Date.now();await chrome.storage.local.set({[key]:snapshot});
      }
      for(const [key,job] of Object.entries(state.jobs||{}))if(job.rootDir===journal.rootDir&&ids.has(job.taskId))delete state.jobs[key];
      delete state.owners?.[journal.rootDir];
      // Persist invalidated receipts before removing the durable journal.
      if(snapshot?.queue?.batchId&&state.archives)delete state.archives[snapshot.queue.batchId];
      await chrome.storage.session.set({pd_runtime_v4:state});
      await chrome.storage.local.remove(JOURNAL);
    }
    async function handle(message,sender,state){
      authorize(sender);
      if(message.action==='cacheSummary')return {ok:true,...summarize(await store.metadata())};
      await guard(state);
      const records=select(await store.metadata(),message.rootDir,message.path);
      const token=await signature(records),count=records.length,bytes=records.reduce((n,r)=>n+r.bytes,0);
      if(message.action==='cachePreview')return {ok:true,token,count,bytes,rootDir:message.rootDir,path:message.path};
      if(message.action!=='cacheClear'||message.confirmed!==true)throw Error('清理前必须确认目录和数量');
      if(token!==message.token)throw Error('缓存已变化，请刷新并重新确认清理范围');
      if(!count)throw Error('该目录已经没有文字缓存');
      await chrome.storage.local.set({[JOURNAL]:{rootDir:message.rootDir,records:records.map(r=>({key:r.key,taskId:r.taskId}))}});
      await recover(state);
      return {ok:true,count,bytes};
    }
    return {handle,recover};
  }
  return {select,summarize,formatBytes,createManager,JOURNAL};
});
