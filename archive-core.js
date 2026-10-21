/* Offline Markdown bundle, report and ZIP creation. No network access. */
(function(root,factory){const node=typeof module==='object'&&module.exports;const api=factory(node?require('./format-stats.js'):root.PDFormatStats,node?require('./result-stats.js'):root.PDResultStats);if(node)module.exports=api;else root.PDArchive=api;})(globalThis,function(formatStatsAPI,resultStatsAPI){
  'use strict';
  const encoder=new TextEncoder();
  const labels={review:'已提取 · 待核对',saved:'已提取',skipped:'跳过',failed:'失败',pending:'未处理',opening:'处理中',opened:'处理中',cache_missing:'缺少归档内容'};
  const html=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const md=value=>String(value??'').replace(/[\r\n]+/g,' ').replace(/`/g,'ˋ').replace(/\|/g,'\\|');
  function safeSegment(value){
    let out=String(value).replace(/[<>:"/\\|?*\x00-\x1f]/g,'_').replace(/[. ]+$/g,'').trim();
    if(!out||out==='.'||out==='..')out='_';
    if(/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(out))out='_'+out;
    return out.slice(0,120).replace(/[\uD800-\uDBFF]$/,'').replace(/[. ]+$/g,'')||'_';
  }
  function hash(value){let n=2166136261;for(const c of String(value)){n^=c.codePointAt(0);n=Math.imul(n,16777619);}return (n>>>0).toString(16);}
  function formatTable(stats){return '<div class="table-wrap"><table class="format-table"><thead><tr><th>格式</th><th>视频总数</th><th>读到文稿正文</th><th>本次未检出文稿</th><th>文稿情况未知</th><th>文稿检出率</th></tr></thead><tbody>'+stats.map(r=>'<tr><td>'+html(r.format.toUpperCase())+'</td><td>'+r.total+'</td><td>'+r.present+'</td><td>'+r.notDetected+'</td><td>'+r.unknown+'</td><td>'+html(formatStatsAPI.formatRate(r.rate))+'</td></tr>').join('')+'</tbody></table></div>';}
  function resultTable(stats,unknown){return '<div class="table-wrap"><table class="format-table result-table"><thead><tr><th>格式</th><th>视频总数</th><th>网页文稿</th><th>字幕补提</th>'+(unknown?'<th>来源未标明</th>':'')+'<th>已取得文字</th><th>尚未取得</th></tr></thead><tbody>'+stats.map(r=>'<tr><td>'+html(r.format.toUpperCase())+'</td><td>'+r.total+'</td><td>'+r.manuscript+'</td><td>'+r.subtitle+'</td>'+(unknown?'<td>'+r.sourceUnknown+'</td>':'')+'<td class="obtained">'+r.obtained+'</td><td>'+r.missing+'</td></tr>').join('')+'</tbody></table></div>';}
  function resultEquation(s){return '网页文稿 '+s.manuscript+' + 字幕补提 '+s.subtitle+(s.sourceUnknown?' + 来源未标明 '+s.sourceUnknown:'')+' = 已取得文字 '+s.obtained;}
  function missingBreakdown(s){return ['失败 '+s.failed,'跳过 '+s.skipped,'未处理 '+s.pending,'处理中 '+s.active,'缺少缓存 '+s.cacheMissing].join(' · ');}
  function reportUI(data){
    const body=document.getElementById('rows'), search=document.getElementById('search'), shown=document.getElementById('shown');
    let filter='all',sourceFilter='all';
    const sourceLabels={manuscript:'网页文稿',subtitle:'字幕补提',unknown:'来源未标明'};
    function cell(text,className){const e=document.createElement('td');e.textContent=text;e.className=className||'';return e;}
    function render(){
      const term=search.value.toLocaleLowerCase();
      const rows=data.rows.filter(r=>(filter==='all'||(filter==='missing'?!r.included:filter==='obtained'?r.included:r.status===filter))&&(sourceFilter==='all'||r.included&&(r.source||'unknown')===sourceFilter)&&[r.sourcePath,r.reason,r.name,sourceLabels[r.source||'unknown']].join(' ').toLocaleLowerCase().includes(term));
      const fragment=document.createDocumentFragment();
      for(const row of rows){
        const tr=document.createElement('tr');
        const status=cell('');const badge=document.createElement('span');badge.className='badge '+(row.included?'ok':'missing');badge.textContent=data.labels[row.status]||row.status;status.append(badge);
        if(row.included){const source=document.createElement('span');source.className='badge source';source.textContent=sourceLabels[row.source||'unknown'];status.append(document.createElement('br'),source);}
        const location=cell('');const title=document.createElement('strong');title.textContent=row.name;const path=document.createElement('p');path.className='path';path.textContent=row.sourcePath;location.append(title,path);
        const detail=cell(row.reason||'完整性仍需核对');
        if(row.outputPath){const a=document.createElement('a');a.href='../'+row.outputPath.split('/').map(encodeURIComponent).join('/');a.textContent='打开 Markdown ↗';detail.append(document.createElement('br'),a);}
        tr.append(status,location,detail);fragment.append(tr);
      }
      body.replaceChildren(fragment);shown.textContent='显示 '+rows.length+' / '+data.rows.length+' 个视频';
    }
    search.addEventListener('input',render);
    document.querySelectorAll('[data-filter]').forEach(button=>button.addEventListener('click',()=>{filter=button.dataset.filter;document.querySelectorAll('[data-filter]').forEach(peer=>peer.setAttribute('aria-pressed',String(peer===button)));render();}));
    document.querySelectorAll('[data-source-filter]').forEach(button=>button.addEventListener('click',()=>{sourceFilter=button.dataset.sourceFilter;document.querySelectorAll('[data-source-filter]').forEach(peer=>peer.setAttribute('aria-pressed',String(peer===button)));render();}));
    render();
  }
  function reportHTML(data){
    const json=JSON.stringify(data).replace(/</g,'\\u003c').replace(/\u2028/g,'\\u2028').replace(/\u2029/g,'\\u2029');
    const s=data.summary,r=data.resultSummary;
    return `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>文字稿导出结果</title><style>
    *{box-sizing:border-box}body{margin:0;background:#f4f3ee;color:#303d37;font:14px/1.7 'Segoe UI','Microsoft YaHei',sans-serif}main{max-width:1200px;margin:auto;padding:42px 28px}h1{font-size:30px;margin:6px 0}h2{font-size:18px}p{margin:7px 0}.eyebrow,.muted{color:#657169}.eyebrow{font-size:12px;letter-spacing:2px}.path{overflow-wrap:anywhere;color:#657169;font-size:12px}.stats{display:grid;grid-template-columns:repeat(4,1fr);gap:14px;margin:25px 0}.stat,.surface{background:#fffefb;border:1px solid #e1e7db;border-radius:16px;padding:20px}.stat strong{display:block;font-size:30px;font-weight:500}.stat span{color:#657169}.stat.good strong{color:#526f5e}.stat.warn strong{color:#856734}.filters{display:flex;flex-wrap:wrap;gap:8px;margin:12px 0}button,input{font:inherit}button{border:1px solid #dce3d7;background:#fffefb;border-radius:8px;padding:7px 13px;color:#526f5e;cursor:pointer}button[aria-pressed=true]{background:#526f5e;color:white}input{width:100%;border:1px solid #c4cebd;border-radius:10px;padding:12px;background:#fffefb;color:#303d37}input:focus-visible,button:focus-visible,a:focus-visible{outline:3px solid #526f5e;outline-offset:2px}.table-wrap{overflow:auto}table{width:100%;border-collapse:collapse;table-layout:fixed}th{text-align:left;font-size:12px;color:#657169;background:#f2f5ee}td,th{padding:15px 12px;border-bottom:1px solid #e6e9e1;vertical-align:top;overflow-wrap:anywhere}th:first-child{width:155px}th:nth-child(2){width:48%}td strong{font-weight:600}a{color:#526f5e;text-underline-offset:3px}.badge{display:inline-block;padding:4px 8px;border-radius:6px;font-size:12px}.badge.ok{color:#526f5e;background:#edf2eb}.badge.missing{color:#856734;background:#f6f0e4}.warning{padding:15px 18px;background:#f6f0e4;border:1px solid #e5d8bc;border-radius:12px;margin:20px 0}.scan{margin-top:25px}.foot{margin-top:24px;font-size:12px;color:#657169}@media(max-width:650px){main{padding:24px 14px}.stats{grid-template-columns:repeat(2,1fr)}.surface{padding:12px}table,thead,tbody,tr,td{display:block;width:100%}thead{display:none}tr{padding:12px 0;border-bottom:1px solid #e6e9e1}td{border:0;padding:6px 0}td:nth-child(2) .path{font-size:12px}td:last-child{font-size:13px}}
    .format-summary{margin:20px 0}.format-table{table-layout:auto;min-width:620px}.format-table th:first-child,.format-table th:nth-child(2){width:auto}.format-table td,.format-table th{white-space:nowrap}.method{font-size:12px;color:#657169;margin-top:14px}@media(max-width:650px){.format-table{display:table}.format-table thead{display:table-header-group}.format-table tbody{display:table-row-group}.format-table tr{display:table-row}.format-table td,.format-table th{display:table-cell;width:auto;padding:12px;border-bottom:1px solid #e6e9e1}}
    .stats{grid-template-columns:repeat(3,1fr)}.equation{background:#edf3eb;border-radius:12px;padding:15px 18px;margin:16px 0;color:#3f6050;font-weight:600}.equation small{display:block;font-weight:400;color:#657169;margin-top:5px}.source{margin-top:6px;color:#657169;background:#f2f3ee}.obtained{color:#3f6050;font-weight:600}.observation{margin:20px 0;padding:16px 20px;background:#f8f8f3;border:1px solid #e1e7db;border-radius:14px}.observation summary{cursor:pointer;color:#526f5e;font-weight:600;min-height:24px}.observation summary:focus-visible{outline:3px solid #526f5e;outline-offset:4px}.observation[open] summary{margin-bottom:14px}.filter-label{font-size:12px;color:#657169;margin:12px 0 0}.filter-group{border-bottom:1px solid #e6e9e1;padding-bottom:10px}@media(max-width:650px){.stats{gap:8px}.stat{padding:14px 10px}.stat strong{font-size:26px}.stat span{font-size:12px}.equation{font-size:13px}.format-table{min-width:620px}.observation{padding:14px}}
    </style><main><p class="eyebrow">MARKDOWN ARCHIVE / LOCAL REPORT</p><h1>文字稿导出结果</h1><p class="path">网盘根目录：${html(data.rootDir)}</p><p class="muted">生成时间：${html(data.generatedAt)} · 此报告为打包时快照</p>
    <section class="stats"><div class="stat"><strong>${r.total}</strong><span>已扫描视频</span></div><div class="stat good"><strong>${r.obtained}</strong><span>已取得文字 · 本包 MD</span></div><div class="stat warn"><strong>${r.missing}</strong><span>尚未取得文字</span></div></section>
    <div class="equation">${html(resultEquation(r))}<small>已取得文字 ${r.obtained} + 尚未取得 ${r.missing} = 已扫描视频 ${r.total}</small></div>
    <p class="muted">尚未取得 ${r.missing}：${html(missingBreakdown(r))}</p><p class="muted">“待核对”表示文字已取得、完整性尚待核对，计入已取得，不属于失败。</p>
    <div class="warning">网页文稿和字幕补提都会生成 Markdown 文字稿，正文完整性仍需核对。${s.scanFailed?'有 '+s.scanFailed+' 个目录扫描失败，未扫描到的视频数量未知。':'当前扫描没有记录失败目录。'}</div>
    <section class="surface format-summary"><h2>按格式看导出结果</h2><p class="muted">网页文稿、字幕补提${r.sourceUnknown?'、来源未标明的旧缓存':''}相加，就是已取得文字；每个视频只计一次。</p>${resultTable(data.formatResults,r.sourceUnknown>0)}${r.sourceUnknown?'<p class="method">来源未标明：已取得文字，但旧缓存没有记录来自文稿还是字幕；不推测来源。</p>':''}</section>
    <details class="observation"><summary>查看网页文稿检测记录（辅助统计）</summary><p><strong>仅网页文稿检测，不等于文字导出结果。</strong>本次未检出文稿或文稿情况未知的视频，仍可能通过字幕补提成功。</p>${formatTable(data.formatStats)}<p class="method">${html(formatStatsAPI.methodNote)}</p><p class="method">同轮次匹配的已有文稿缓存可作历史检出依据，记录标记为“来自缓存”。此表为打包时快照。</p></details>
    <section class="surface"><h2>按文件定位</h2><input id="search" type="search" aria-label="搜索完整网盘路径、文件名或原因" placeholder="搜索课程名称、目录路径、失败原因…"><div class="filter-group"><p class="filter-label">任务结果</p><div class="filters"><button data-filter="all" aria-pressed="true">全部 ${r.total}</button><button data-filter="missing" aria-pressed="false">尚未取得 ${r.missing}</button><button data-filter="failed" aria-pressed="false">失败 ${r.failed}</button><button data-filter="skipped" aria-pressed="false">跳过 ${r.skipped}</button><button data-filter="pending" aria-pressed="false">未处理 ${r.pending}</button><button data-filter="obtained" aria-pressed="false">已取得 ${r.obtained}</button><button data-filter="cache_missing" aria-pressed="false">缺少缓存 ${r.cacheMissing}</button></div></div><p class="filter-label">文字来源（可与任务结果组合筛选）</p><div class="filters"><button data-source-filter="all" aria-pressed="true">所有来源</button><button data-source-filter="manuscript" aria-pressed="false">网页文稿 ${r.manuscript}</button><button data-source-filter="subtitle" aria-pressed="false">字幕补提 ${r.subtitle}</button>${r.sourceUnknown?'<button data-source-filter="unknown" aria-pressed="false">来源未标明 '+r.sourceUnknown+'</button>':''}</div><p id="shown" class="muted" role="status" aria-live="polite"></p><div class="table-wrap"><table><thead><tr><th>状态 / 来源</th><th>文件与完整网盘路径</th><th>原因 / 本地文字稿</th></tr></thead><tbody id="rows"></tbody></table></div></section>
    <section class="surface scan"><h2>扫描失败的目录</h2>${data.scanFailures.length?data.scanFailures.map(f=>'<p class="path">'+html(f.path)+'</p><p>'+html(f.error)+'</p>').join(''):'<p class="muted">没有记录。</p>'}</section><p class="foot">全文路径保留原始网盘名称；ZIP 内只对 Windows 不允许的字符作兼容处理，重名会自动加后缀。此页离线运行，不连接网盘。</p></main><script>(${reportUI.toString()})(${json});</script></html>`;
  }
  function buildBundle(snapshot,records,options={}){
    const queue=snapshot?.queue;
    if(!queue||!Array.isArray(queue.videos)||typeof queue.rootDir!=='string')throw Error('没有有效的目录任务记录');
    const rootDir=queue.rootDir.replace(/\/$/,'')||'/';
    const generatedAt=options.generatedAt||new Date().toISOString();
    let rootName=safeSegment(rootDir.split('/').filter(Boolean).pop()||'网盘根目录');
    if(rootName==='_提取报告')rootName+='_课程';
    const byTask=new Map(records.filter(r=>r.rootDir===queue.rootDir).map(r=>[r.taskId,r]));
    const entries=[],rows=[],directories=new Set([rootName+'/']),used=new Set();
    function addDirectories(relative){let prefix='';for(const part of relative.split('/').slice(0,-1)){prefix+=part+'/';directories.add(prefix);}}
    for(const dir of [...(snapshot.scanStats?.dirDetails||[]),...(snapshot.scanStats?.failedDirs||[])]){
      const path=String(dir.path||'');
      const relative=rootDir==='/'?path.slice(1):path.startsWith(rootDir+'/')?path.slice(rootDir.length+1):'';
      if(relative&&!relative.split('/').some(part=>!part||part==='.'||part==='..'))addDirectories(rootName+'/'+relative.split('/').map(safeSegment).join('/')+'/');
    }
    for(const video of queue.videos){
      const sourcePath=String(video.path||'');
      const relative=rootDir==='/'?sourcePath.slice(1):sourcePath.startsWith(rootDir+'/')?sourcePath.slice(rootDir.length+1):'';
      const valid=!!relative&&!relative.split('/').some(part=>!part||part==='.'||part==='..');
      const record=byTask.get(video.taskId);
      const matched=valid&&record&&record.sourcePath===sourcePath&&record.sourceSize===video.size&&record.sourceMtime===video.mtime&&typeof record.markdown==='string'&&record.markdown.trim();
      let outputPath='';
      if(valid){const parts=relative.split('/').map(safeSegment);const basename=parts.pop().replace(/\.[^.]+$/,'');let candidate=[rootName,...parts,basename+'.md'].join('/');addDirectories(candidate);
        if(matched){let attempt=0;while(used.has(candidate.toLocaleLowerCase()))candidate=[rootName,...parts,basename+'~'+hash(video.taskId)+(attempt++?'-'+attempt:'')+'.md'].join('/');used.add(candidate.toLocaleLowerCase());outputPath=candidate;entries.push({name:outputPath,text:record.markdown});}
      }
      let status=video.status||'pending',reason=String(video.reason||'');
      if(matched){status='review';reason=reason?(video.status==='failed'?'单篇下载曾失败，文字稿缓存已收进本压缩包；':'')+reason:'文字稿已收进压缩包；完整性待核对';}
      else if(!valid){status='failed';reason='原始路径不属于本次根目录或含不安全层级，未归档';}
      else if(['saved','review'].includes(status)){status='cache_missing';reason='旧版或当前浏览器未保留可打包的文字稿缓存；已有单篇文件需另行收集';}
      else if(!reason)reason=['opening','opened'].includes(status)?'打包时此视频仍在处理中':'尚未处理，未取得文字';
      let manuscriptObservation=formatStatsAPI.normalizeObservation(video.manuscriptObservation,video.attempt),observationOrigin=manuscriptObservation?'task':null;
      if(!manuscriptObservation&&matched&&record.attempt===video.attempt){
        manuscriptObservation=formatStatsAPI.normalizeObservation(record.manuscriptObservation,video.attempt);
        if(!manuscriptObservation&&record.source==='manuscript')manuscriptObservation=formatStatsAPI.normalizeObservation({version:1,state:'present',reason:'来自同轮次已保存的文稿缓存；归档时核验缓存，不代表重新检查页面',checkedAt:record.capturedAt||generatedAt,attempt:video.attempt},video.attempt);
        if(manuscriptObservation)observationOrigin='cache';
      }
      const source=matched&&['manuscript','subtitle'].includes(record.source)?record.source:null;
      rows.push({taskId:video.taskId,name:video.name||sourcePath.split('/').pop(),sourcePath,status,originalStatus:video.status,reason,outputPath,included:!!matched,attempt:video.attempt,source,manuscriptObservation,observationOrigin});
    }
    const scanFailures=(snapshot.scanStats?.failedDirs||[]).map(item=>({path:String(item.path),error:String(item.error||'扫描失败')}));
    const summary={total:rows.length,extracted:rows.filter(r=>r.included).length,missing:rows.filter(r=>!r.included).length,pending:rows.filter(r=>r.status==='pending').length,active:rows.filter(r=>['opening','opened'].includes(r.status)).length,skipped:rows.filter(r=>r.status==='skipped').length,failed:rows.filter(r=>r.status==='failed').length,scanFailed:scanFailures.length};
    const formatStats=formatStatsAPI.summarize(rows);
    const resultSummary=resultStatsAPI.summarize(rows,{archive:true}),formatResults=resultStatsAPI.byFormat(rows,{archive:true});
    const missing=['# 尚未取得文字的文件清单','',`- 网盘根目录：\`${md(rootDir)}\``,`- 已扫描视频：${summary.total}；本包已取得文字：${summary.extracted}；尚未取得文字：${summary.missing}`,'- 此清单是打包时快照。未处理、跳过、失败与缺少缓存分别列出；已保存的网页文稿和字幕均不在此列。','','| 状态 | 完整网盘路径 | 原因 |','| --- | --- | --- |',...rows.filter(r=>!r.included).map(r=>`| ${labels[r.status]||r.status} | \`${md(r.sourcePath)}\` | ${md(r.reason)} |`),'','## 扫描失败的目录','',...(scanFailures.length?scanFailures.map(f=>`- \`${md(f.path)}\`：${md(f.error)}`):['无。']),'','扫描失败目录中没有被枚举的视频数量未知，不能保证扫描清单完整。'].join('\n');
    const hasUnknown=resultSummary.sourceUnknown>0;
    const resultReport=['# 文字稿导出结果统计','',`- 网盘根目录：\`${md(rootDir)}\``,`- 生成时间：${md(generatedAt)}（打包时快照）`,'',resultEquation(resultSummary),'',`已取得文字 ${resultSummary.obtained} + 尚未取得 ${resultSummary.missing} = 已扫描视频 ${resultSummary.total}`,'',`尚未取得 ${resultSummary.missing}：${missingBreakdown(resultSummary)}`,'','网页文稿和字幕补提均已转换为 Markdown 文字稿；“待核对”表示已取得文字、完整性待核对，不属于失败。','',`| 格式 | 视频总数 | 网页文稿 | 字幕补提 |${hasUnknown?' 来源未标明 |':''} 已取得文字 | 尚未取得 |`,`| --- | ---: | ---: | ---: |${hasUnknown?' ---: |':''} ---: | ---: |`,...formatResults.map(r=>`| ${md(r.format.toUpperCase())} | ${r.total} | ${r.manuscript} | ${r.subtitle} |${hasUnknown?' '+r.sourceUnknown+' |':''} ${r.obtained} | ${r.missing} |`),'',hasUnknown?'来源未标明：旧缓存已保留文字，但没有记录来源，不推测为网页文稿或字幕。':'','每个视频只计一次。网页文稿 + 字幕补提 + 来源未标明 = 已取得文字；已取得文字 + 尚未取得 = 视频总数。','','网页文稿检出情况另见《格式文稿统计.md》；本次未检出文稿或文稿情况未知，不等于没有取得文字。'].join('\n');
    const formatReport=['# 网页文稿检测记录（辅助统计）','',`- 网盘根目录：\`${md(rootDir)}\``,`- 生成时间：${md(generatedAt)}（打包时快照）`,'','**仅网页文稿检测，不等于文字导出结果。** 本次未检出文稿或文稿情况未知，仍可能通过字幕补提成功。实际文字取得数量见《导出结果统计.md》。','','| 格式 | 视频总数 | 读到文稿正文 | 本次未检出文稿 | 文稿情况未知 | 文稿检出率 |','| --- | ---: | ---: | ---: | ---: | ---: |',...formatStats.map(r=>`| ${md(r.format.toUpperCase())} | ${r.total} | ${r.present} | ${r.notDetected} | ${r.unknown} | ${formatStatsAPI.formatRate(r.rate)} |`),'',formatStatsAPI.methodNote,'','同轮次匹配的已有文稿缓存可作历史检出依据，完整清单中的 observationOrigin=cache 表示来自缓存；不会凭字幕或旧版失败原因推断是否存在文稿。正文完整性仍需核对。'].join('\n');
    const data={rootDir,generatedAt,summary,rows,scanFailures,labels,formatStats,resultSummary,formatResults};
    entries.push({name:'_提取报告/未提取清单.md',text:missing},{name:'_提取报告/导出结果统计.md',text:resultReport},{name:'_提取报告/格式文稿统计.md',text:formatReport},{name:'_提取报告/总览.html',text:reportHTML(data)},{name:'_提取报告/全部文件清单.json',text:JSON.stringify({rootDir,generatedAt,summary,rows,scanFailures,formatStats,resultSummary,formatResults},null,2)});
    directories.add('_提取报告/');
    return {entries:[...directories].sort().map(name=>({name,text:''})).concat(entries),rows,summary,rootName,generatedAt,formatStats,resultSummary,formatResults};
  }
  const crcTable=Uint32Array.from({length:256},(_,n)=>{for(let i=0;i<8;i++)n=n&1?0xedb88320^(n>>>1):n>>>1;return n>>>0;});
  function crc32(bytes){let crc=0xffffffff;for(const byte of bytes)crc=crcTable[(crc^byte)&255]^(crc>>>8);return (crc^0xffffffff)>>>0;}
  async function deflate(bytes){
    if(typeof CompressionStream==='undefined')return null;
    try{return new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(new CompressionStream('deflate-raw'))).arrayBuffer());}catch{return null;}
  }
  async function encodeZip(entries,{compress=true,onProgress=()=>{}}={}){
    if(entries.length>65535)throw Error('文件数量超出本版 ZIP 支持范围，请按子目录分批打包');
    const chunks=[],central=[],seen=new Set();let offset=0;
    for(let i=0;i<entries.length;i++){
      const entry=entries[i],name=entry.name;
      if(!name||name.startsWith('/')||name.includes('\\')||name.split('/').some(part=>part==='..'||part==='.'))throw Error('不安全的 ZIP 路径');
      if(seen.has(name))throw Error('ZIP 文件名重复：'+name);seen.add(name);
      const filename=encoder.encode(name),raw=encoder.encode(entry.text||'');
      if(filename.length>65535)throw Error('文件路径过长');
      const zipped=compress&&!name.endsWith('/')?await deflate(raw):null;
      const useCompression=zipped&&zipped.length<raw.length,body=useCompression?zipped:raw,method=useCompression?8:0,crc=crc32(raw);
      if(offset+30+filename.length+body.length>=0xffffffff)throw Error('压缩包超出 4GB，请按子目录分批打包');
      const local=new Uint8Array(30+filename.length),view=new DataView(local.buffer);
      view.setUint32(0,0x04034b50,true);view.setUint16(4,20,true);view.setUint16(6,0x800,true);view.setUint16(8,method,true);view.setUint16(12,0x21,true);view.setUint32(14,crc,true);view.setUint32(18,body.length,true);view.setUint32(22,raw.length,true);view.setUint16(26,filename.length,true);local.set(filename,30);
      const header=new Uint8Array(46+filename.length),cv=new DataView(header.buffer);
      cv.setUint32(0,0x02014b50,true);cv.setUint16(4,20,true);cv.setUint16(6,20,true);cv.setUint16(8,0x800,true);cv.setUint16(10,method,true);cv.setUint16(14,0x21,true);cv.setUint32(16,crc,true);cv.setUint32(20,body.length,true);cv.setUint32(24,raw.length,true);cv.setUint16(28,filename.length,true);cv.setUint32(38,name.endsWith('/')?16:0,true);cv.setUint32(42,offset,true);header.set(filename,46);
      chunks.push(local,body);central.push(header);offset+=local.length+body.length;onProgress(i+1,entries.length);
    }
    const centralSize=central.reduce((sum,header)=>sum+header.length,0),end=new Uint8Array(22),ev=new DataView(end.buffer);
    if(offset+centralSize>=0xffffffff)throw Error('压缩包目录超出 4GB 限制');
    ev.setUint32(0,0x06054b50,true);ev.setUint16(8,entries.length,true);ev.setUint16(10,entries.length,true);ev.setUint32(12,centralSize,true);ev.setUint32(16,offset,true);
    const output=new Uint8Array(offset+centralSize+22);let cursor=0;for(const part of [...chunks,...central,end]){output.set(part,cursor);cursor+=part.length;}return output;
  }
  return {buildBundle,encodeZip,safeSegment,hash};
});
