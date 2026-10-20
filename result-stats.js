/* Text-export outcomes are independent of the manuscript-detection observations. */
(function(root,factory){const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;else root.PDResultStats=api;})(globalThis,function(){
  'use strict';
  function latest(items){
    const files=new Map();
    for(const [index,item] of (Array.isArray(items)?items:[]).entries()){
      if(!item||typeof item!=='object')continue;
      const key=item.path||item.sourcePath||item.taskId||index;
      const previous=files.get(key);
      if(!previous||(Number(item.attempt)||0)>=(Number(previous.attempt)||0))files.set(key,item);
    }
    return [...files.values()];
  }
  function empty(){return {total:0,obtained:0,manuscript:0,subtitle:0,sourceUnknown:0,missing:0,failed:0,skipped:0,pending:0,active:0,cacheMissing:0,review:0};}
  function add(result,item,archive){
    result.total++;
    // The archive checks actual cache bodies. The directory has only queue records.
    const obtained=archive?item.included===true:['saved','review'].includes(item.status);
    if(obtained){
      result.obtained++;
      if(item.source==='manuscript')result.manuscript++;
      else if(item.source==='subtitle')result.subtitle++;
      else result.sourceUnknown++;
      if(item.status==='review')result.review++;
    }else{
      result.missing++;
      if(item.status==='failed')result.failed++;
      else if(item.status==='skipped')result.skipped++;
      else if(['opening','opened'].includes(item.status))result.active++;
      else if(['cache_missing','saved','review'].includes(item.status))result.cacheMissing++;
      else result.pending++;
    }
  }
  function summarize(items,{archive=false}={}){
    const result=empty();
    for(const item of latest(items))add(result,item,archive);
    return result;
  }
  function byFormat(items,{archive=false}={}){
    const groups=new Map();
    const get=format=>{if(!groups.has(format))groups.set(format,{format,...empty()});return groups.get(format);};
    get('mp4');get('mov');
    for(const item of latest(items)){
      const name=String(item.path||item.sourcePath||item.name||'').split('/').pop();
      const suffix=name.includes('.')?name.split('.').pop().toLowerCase():'';
      add(get(/^[a-z0-9]{1,20}$/.test(suffix)?suffix:'其他'),item,archive);
    }
    return [...groups.values()];
  }
  return {summarize,byFormat};
});
