'use strict';
const $=id=>document.getElementById(id);
function status(text,error=false){$('status').textContent=text;$('status').classList.toggle('error',error);}
let busy=false;
let missingRows=[];
const resultLabels={failed:'失败',skipped:'跳过',pending:'未处理',opening:'处理中',opened:'处理中',cache_missing:'缺少缓存'};
function renderMissing(){
  const filter=$('missingFilter').value||'all',term=String($('missingSearch').value||'').trim().toLocaleLowerCase();
  const rows=missingRows.filter(row=>(filter==='all'||(filter==='active'?['opening','opened'].includes(row.status):row.status===filter))&&[row.sourcePath,row.reason].join(' ').toLocaleLowerCase().includes(term));
  $('missingList').replaceChildren();
  for(const row of rows.slice(0,20)){
    const item=document.createElement('li'),badge=document.createElement('span'),title=document.createElement('strong'),reason=document.createElement('p');
    badge.className='badge';badge.textContent=resultLabels[row.status]||row.status;title.textContent=row.sourcePath;reason.textContent=row.reason;item.append(badge,title,reason);$('missingList').append(item);
  }
  $('missingShown').textContent='匹配 '+rows.length+' 项 · 显示前 '+Math.min(rows.length,20)+' 项 · 尚未取得共 '+missingRows.length+' 项';
  if(!rows.length){const li=document.createElement('li');li.textContent=missingRows.length?'没有匹配的文件，可切换筛选条件。':'本次扫描的视频均有文字稿缓存；仍请核验全文完整性。';$('missingList').append(li);}
}
async function generate(){
  if(busy)return;busy=true;$('download').disabled=true;
  try{
    const params=new URL(location.href).searchParams,root=params.get('root'),batch=params.get('batch');
    if(!root||!batch)throw Error('缺少目录任务标识，请从插件任务面板点击“打包 ZIP”');
    const key='pandownload.queue.v1.'+encodeURIComponent(root);
    const snapshot=(await chrome.storage.local.get(key))[key];
    if(snapshot?.queue?.rootDir!==root||snapshot.queue.batchId!==batch)throw Error('批次记录已变化，请从原目录面板重新打包');
    $('root').textContent='网盘根目录：'+root;
    status('正在读取已保留的 Markdown 文字稿…');
    const records=await PDArchiveStore.list(root);
    const bundle=PDArchive.buildBundle(snapshot,records);
    $('total').textContent=bundle.summary.total;$('included').textContent=bundle.summary.extracted;$('missing').textContent=bundle.summary.missing;
    const result=bundle.resultSummary,hasUnknown=result.sourceUnknown>0;
    $('resultEquation').textContent='网页文稿 '+result.manuscript+' + 字幕补提 '+result.subtitle+(hasUnknown?' + 来源未标明 '+result.sourceUnknown:'')+' = 已取得文字 '+result.obtained;
    $('resultTotal').textContent='已取得文字 '+result.obtained+' + 尚未取得 '+result.missing+' = 已扫描视频 '+result.total;
    $('missingBreakdown').textContent='尚未取得 '+result.missing+'：失败 '+result.failed+' · 跳过 '+result.skipped+' · 未处理 '+result.pending+' · 处理中 '+result.active+' · 缺少缓存 '+result.cacheMissing;
    $('resultUnknownHeader').hidden=!hasUnknown;$('resultUnknownNote').hidden=!hasUnknown;
    $('resultUnknownNote').textContent=hasUnknown?'来源未标明：'+result.sourceUnknown+' 份旧缓存已保留文字，但未记录来自网页文稿还是字幕；这些内容仍计入已取得。':'';
    $('resultRows').replaceChildren();
    for(const row of bundle.formatResults){
      const tr=document.createElement('tr'),values=[row.format.toUpperCase(),row.total,row.manuscript,row.subtitle,...(hasUnknown?[row.sourceUnknown]:[]),row.obtained,row.missing];
      for(let i=0;i<values.length;i++){const td=document.createElement('td');td.textContent=String(values[i]);if(i===values.length-2)td.className='obtained';tr.append(td);}
      $('resultRows').append(tr);
    }
    $('formatRows').replaceChildren();
    for(const row of bundle.formatStats){
      const tr=document.createElement('tr');
      for(const value of [row.format.toUpperCase(),row.total,row.present,row.notDetected,row.unknown,PDFormatStats.formatRate(row.rate)]){const td=document.createElement('td');td.textContent=String(value);tr.append(td);}
      $('formatRows').append(tr);
    }
    $('formatUpdated').textContent='本目录快照：'+new Date(bundle.generatedAt).toLocaleString('zh-CN');
    $('formatNote').textContent=PDFormatStats.methodNote;
    missingRows=bundle.rows.filter(row=>!row.included);renderMissing();
    status('正在生成 ZIP：已取得文字 '+result.obtained+' 份，尚未取得 '+result.missing+' 项…');
    const bytes=await PDArchive.encodeZip(bundle.entries,{onProgress:(done,total)=>{$('progress').value=Math.round(done/Math.max(1,total)*100);}});
    const settings=await chrome.storage.local.get('outputSubfolder');
    const prefix=settings.outputSubfolder===undefined?'文稿导出':settings.outputSubfolder;
    if(typeof prefix!=='string'||/^[\\/]|^[a-z]:/i.test(prefix)||prefix.replace(/\\/g,'/').split('/').some(p=>p==='.'||p==='..'))throw Error('保存子文件夹不是有效相对路径');
    const folder=prefix?prefix.replace(/\\/g,'/').split('/').map(PDArchive.safeSegment).join('/')+'/':'';
    const stamp=new Date().toISOString().replace(/[:.]/g,'-');
    const filename=folder+bundle.rootName+'-文稿与提取报告-'+stamp+'.zip';
    status('ZIP 已生成，等待浏览器确认保存完成…');
    const downloaded=await PDArchiveDownload.save(chrome,bytes,filename);
    $('filename').textContent='保存位置：'+downloaded.filename;
    status('ZIP 已保存：'+result.obtained+' 份 Markdown（网页文稿 '+result.manuscript+'、字幕补提 '+result.subtitle+(hasUnknown?'、来源未标明 '+result.sourceUnknown:'')+'）；尚未取得 '+result.missing+' 项。'+(result.pending+result.active?'本包是阶段成果，仍有任务未结束。':''));
  }catch(error){status(error.message,true);}
  finally{busy=false;$('download').disabled=false;}
}
$('download').addEventListener('click',generate);
$('missingFilter').addEventListener('change',renderMissing);
$('missingSearch').addEventListener('input',renderMissing);
generate();
