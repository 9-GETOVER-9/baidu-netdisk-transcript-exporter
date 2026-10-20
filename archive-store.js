/* Extension-local durable transcript storage. No account or network APIs. */
(function(root,factory){const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;else{root.PDArchiveStorage=api;root.PDArchiveStore=api.createStore();}})(globalThis,function(){
  'use strict';
  function createStore({name='pandownload-transcripts-v1',factory=globalThis.indexedDB}={}){
    let opened;
    function open(){
      if(!factory)return Promise.reject(Error('浏览器不支持本地文稿归档数据库'));
      if(!opened)opened=new Promise((resolve,reject)=>{
        const request=factory.open(name,1);
        request.onupgradeneeded=()=>{const store=request.result.createObjectStore('transcripts',{keyPath:'key'});store.createIndex('rootDir','rootDir',{unique:false});};
        request.onerror=()=>reject(Error('无法打开文稿归档缓存：'+(request.error?.message||'未知错误')));
        request.onblocked=()=>reject(Error('文稿缓存升级被旧页面占用，请关闭旧打包页后重试'));
        request.onsuccess=()=>{request.result.onversionchange=()=>{request.result.close();opened=null;};resolve(request.result);};
      }).catch(error=>{opened=null;throw error;});
      return opened;
    }
    async function put(record){
      if(typeof record?.rootDir!=='string'||!record.rootDir||typeof record.taskId!=='string'||!record.taskId||typeof record.markdown!=='string'||!record.markdown.trim())throw Error('文稿归档记录缺少内容或路径');
      const db=await open();
      return new Promise((resolve,reject)=>{
        const tx=db.transaction('transcripts','readwrite');
        tx.objectStore('transcripts').put({...record,key:JSON.stringify([record.rootDir,record.taskId])});
        tx.oncomplete=()=>resolve();tx.onerror=tx.onabort=()=>reject(Error('文稿缓存保存失败：'+(tx.error?.message||'请检查磁盘空间')));
      });
    }
    async function list(rootDir){
      const db=await open();
      return new Promise((resolve,reject)=>{
        const tx=db.transaction('transcripts','readonly');
        const request=tx.objectStore('transcripts').index('rootDir').getAll(rootDir);
        request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(Error('无法读取文稿归档缓存'));
      });
    }
    async function get(rootDir,taskId){
      const db=await open();
      return new Promise((resolve,reject)=>{
        const tx=db.transaction('transcripts','readonly');
        const request=tx.objectStore('transcripts').get(JSON.stringify([rootDir,taskId]));
        request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(Error('无法读取文稿缓存'));
      });
    }
    return {put,list,get};
  }
  return {createStore};
});
