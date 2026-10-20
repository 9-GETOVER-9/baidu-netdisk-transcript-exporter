(function(root,factory){const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;else root.PDArchiveDownload=api;})(globalThis,function(){
  'use strict';
  async function save(chrome,bytes,filename,{urlAPI=URL,sleep=ms=>new Promise(r=>setTimeout(r,ms)),now=Date.now,timeoutMs=30*60*1000}={}){
    const url=urlAPI.createObjectURL(new Blob([bytes],{type:'application/zip'}));
    let id,terminal=false;
    try{
      id=await chrome.downloads.download({url,filename,saveAs:false,conflictAction:'uniquify'});
      if(!Number.isInteger(id))throw Error('浏览器未能创建 ZIP 下载');
      const start=now();
      while(now()-start<timeoutMs){
        const item=(await chrome.downloads.search({id}))[0];
        if(!item)throw Error('ZIP 下载记录丢失，请检查浏览器下载列表');
        if(item.state==='complete'){terminal=true;return {downloadId:id,filename:item.filename||filename};}
        if(item.state==='interrupted'){terminal=true;throw Error('ZIP 下载中断：'+(item.error||'未知原因'));}
        await sleep(1000);
      }
      throw Error('ZIP 下载仍未确认完成，请检查下载列表；此页暂时保留下载资源');
    }finally{
      // An unfinished download may still be reading its Blob. Keep that URL alive.
      if(terminal||id===undefined)urlAPI.revokeObjectURL(url);
    }
  }
  return {save};
});
