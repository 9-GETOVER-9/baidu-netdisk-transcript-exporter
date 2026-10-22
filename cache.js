'use strict';
const $=id=>document.getElementById(id),size=PDCacheManagement.formatBytes;
let summary={roots:[]},preview=null,working=false;
function status(text,error=false){$('status').textContent=text;$('status').dataset.error=String(error);}
async function send(message){const result=await chrome.runtime.sendMessage(message);if(!result?.ok)throw Error(result?.error||'扩展未响应，请重新加载');return result;}
function options(node,values){node.replaceChildren();for(const [value,label] of values){const opt=document.createElement('option');opt.value=value;opt.textContent=label;node.append(opt);}}
function selectedRoot(){return summary.roots.find(r=>r.rootDir===$('root').value);}
function controls(){const ready=!!selectedRoot();$('refresh').disabled=working;$('root').disabled=working||!ready;$('folder').disabled=working||!ready;$('preview').disabled=working||!ready;}
function selection(){const folder=selectedRoot()?.folders.find(f=>f.path===$('folder').value);$('selection').textContent=folder?folder.path+'\n'+folder.count+' 份文字 · 约 '+size(folder.bytes):'没有可清理的文字缓存。';}
function folders(){options($('folder'),(selectedRoot()?.folders||[]).map(f=>[f.path,f.path+' · '+f.count+' 份 · '+size(f.bytes)]));selection();controls();}
async function refresh(announce=true){
  const oldRoot=$('root').value,oldFolder=$('folder').value;
  summary=await send({action:'cacheSummary'});
  $('count').textContent=summary.count;$('bytes').textContent=size(summary.bytes);
  options($('root'),summary.roots.map(r=>[r.rootDir,r.rootDir+' · '+r.count+' 份 · '+size(r.bytes)]));
  if(summary.roots.some(r=>r.rootDir===oldRoot))$('root').value=oldRoot;
  folders();if(selectedRoot()?.folders.some(f=>f.path===oldFolder))$('folder').value=oldFolder;selection();
  if(announce)status(summary.count?'统计已更新。选择课程目录后查看清理范围。':'本浏览器尚无文字缓存。已下载的文件仍保留在原位置。');
}
async function run(fn){if(working)return;working=true;controls();try{await fn();}catch(error){status(error.message,true);}finally{working=false;controls();}}
$('version').textContent='文稿整理 v'+chrome.runtime.getManifest().version+' · 缓存仅保存在当前浏览器';
$('root').addEventListener('change',folders);$('folder').addEventListener('change',selection);
$('refresh').addEventListener('click',()=>run(()=>refresh()));
$('preview').addEventListener('click',()=>run(async()=>{
  preview=await send({action:'cachePreview',rootDir:$('root').value,path:$('folder').value});
  if(!preview.count){await refresh();return;}
  $('confirmScope').textContent='任务根目录：'+preview.rootDir+'\n清理目录：'+preview.path;
  $('confirmSize').textContent=preview.count+' 份文字 · 缓存内容约 '+size(preview.bytes);
  $('confirmDialog').showModal();$('cancel').focus();
}));
$('cancel').addEventListener('click',()=>{$('confirmDialog').close();preview=null;status('已取消清理，缓存保持不变。');});
$('confirmDialog').addEventListener('cancel',()=>{preview=null;status('已取消清理，缓存保持不变。');});
$('confirm').addEventListener('click',()=>run(async()=>{
  const chosen=preview;if(!chosen)return;preview=null;$('confirmDialog').close();
  status('正在清理本地缓存，请保持此页打开…');
  const result=await send({action:'cacheClear',rootDir:chosen.rootDir,path:chosen.path,token:chosen.token,confirmed:true});
  await refresh(false);status('已清理 '+result.count+' 份文字缓存（约 '+size(result.bytes)+'）。已下载的 ZIP、MD 不受影响；需要重新提取时请在原目录点击“重试失败”。');
}));
run(()=>refresh());
