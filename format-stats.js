/* Per-file manuscript observations. This is a directory sample, not a format support rule. */
(function(root,factory){const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;else root.PDFormatStats=api;})(globalThis,function(){
  'use strict';
  const methodNote='检出率 = 检出可读取文稿正文 ÷（检出 + 检查后未检出）。未知不进入分母；未取得有效观察的失败、未处理和旧版记录保留为未知，不从旧失败原因回推。检查后未检出仅表示在本次有限等待内未检出，不证明永久没有文稿。字幕提取成功不等于检出文稿。每个文件只取最新轮次，重试不重复计数。此处是本目录当前样本，不是百度网盘全平台的文稿存在概率。';
  function validISO(value){
    if(typeof value!=='string')return false;
    const match=value.match(/^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$/);
    if(!match||Number(match[2])>23||Number(match[3])>59||Number(match[4])>59||!Number.isFinite(Date.parse(value)))return false;
    const day=new Date(match[1]+'T00:00:00.000Z');
    return Number.isFinite(day.getTime())&&day.toISOString().slice(0,10)===match[1];
  }
  function normalizeObservation(value,attempt){
    if(!value||value.version!==1||!['present','not_detected','unknown'].includes(value.state)||!Number.isInteger(attempt)||attempt<1||value.attempt!==attempt||!validISO(value.checkedAt)||(value.reason!==undefined&&typeof value.reason!=='string'))return null;
    return {version:1,state:value.state,reason:(value.reason||'').slice(0,1000),checkedAt:value.checkedAt,attempt};
  }
  function summarize(videos){
    const latest=new Map();
    for(const [index,video] of (Array.isArray(videos)?videos:[]).entries()){
      if(!video||typeof video!=='object')continue;
      const identity=video.path||video.sourcePath||video.taskId||index;
      const previous=latest.get(identity);
      if(!previous||(Number(video.attempt)||0)>=(Number(previous.attempt)||0))latest.set(identity,video);
    }
    const rows=new Map();
    function row(format){if(!rows.has(format))rows.set(format,{format,total:0,present:0,notDetected:0,unknown:0,checked:0,rate:null});return rows.get(format);}
    row('mp4');row('mov');
    for(const video of latest.values()){
      const name=String(video.path||video.sourcePath||video.name||'').split('/').pop();
      const suffix=name.includes('.')?name.split('.').pop().toLowerCase():'';
      const result=row(/^[a-z0-9]{1,20}$/.test(suffix)?suffix:'其他');
      const observation=normalizeObservation(video.manuscriptObservation,video.attempt);
      result.total++;
      if(observation?.state==='present')result.present++;
      else if(observation?.state==='not_detected')result.notDetected++;
      else result.unknown++;
    }
    for(const result of rows.values()){result.checked=result.present+result.notDetected;result.rate=result.checked?result.present/result.checked:null;}
    return [...rows.values()];
  }
  function formatRate(rate){return rate===null?'暂无有效检查':(rate*100).toFixed(1)+'%';}
  return {normalizeObservation,summarize,formatRate,methodNote};
});
