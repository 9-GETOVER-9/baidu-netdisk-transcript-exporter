/* Independent subtitle readers. No browser or storage side effects. */
(function(root,factory){const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;else root.PDSubtitles=api;})(globalThis,function(){
  'use strict';
  const MAX_TEXT=8*1024*1024, MAX_REQUESTS=128;
  function allowedURL(value){
    try{const u=new URL(value);return u.protocol==='https:'&&!u.username&&!u.password&&(!u.port||u.port==='443')&&(u.hostname==='pan.baidu.com'||u.hostname==='baidupcs.com'||u.hostname.endsWith('.baidupcs.com'));}catch{return false;}
  }
  function attributes(line){
    const result={};for(const m of line.matchAll(/([A-Z0-9-]+)=(?:"([^"]*)"|([^,]*))/g))result[m[1]]=m[2]??m[3];return result;
  }
  function parsePlaylist(text,base){
    const tracks=[],segments=[];let pending=null,duration=0,encrypted=false;
    const resolve=value=>{try{return new URL(value,base).href;}catch{return '';}};
    for(const line of String(text).replace(/^\uFEFF/,'').split(/\r?\n/).map(s=>s.trim())){
      if(line.startsWith('#EXT-X-MEDIA:')){
        pending=attributes(line.slice(13));
        if(pending.TYPE&&pending.TYPE!=='SUBTITLES'){pending=null;continue;}
        if(pending.URI){tracks.push({name:pending.NAME||'',language:pending.LANGUAGE||'',url:resolve(pending.URI)});pending=null;}
      }else if(line.startsWith('#EXT-X-KEY:')){if(attributes(line.slice(11)).METHOD!=='NONE')encrypted=true;}
      else if(line.startsWith('#EXTINF:'))duration=Number.parseFloat(line.slice(8))||0;
      else if(line&&!line.startsWith('#')){
        if(pending){tracks.push({name:pending.NAME||'',language:pending.LANGUAGE||'',url:resolve(line)});pending=null;}
        else if(duration>0){segments.push({url:resolve(line),duration});duration=0;}
      }
    }
    return {tracks,segments,encrypted,complete:String(text).includes('#EXT-X-ENDLIST')};
  }
  function plain(value){return String(value||'').replace(/<[^>]*>/g,'').replace(/&(?:amp|lt|gt|quot|apos|nbsp);|&#(?:x[0-9a-f]+|\d+);/gi,m=>{
    const table={'&amp;':'&','&lt;':'<','&gt;':'>','&quot;':'"','&apos;':"'",'&nbsp;':' '};if(table[m.toLowerCase()])return table[m.toLowerCase()];
    const num=m[2].toLowerCase()==='x'?parseInt(m.slice(3),16):parseInt(m.slice(2),10);return num>=0&&num<=0x10ffff?String.fromCodePoint(num):m;
  }).trim();}
  function seconds(value){const p=value.replace(',','.').split(':').map(Number);return p.reduce((a,v)=>a*60+v,0);}
  function normalizeCues(cues){
    const seen=new Set();return cues.filter(c=>Number.isFinite(c.start)&&Number.isFinite(c.end)&&c.start>=0&&c.end>=c.start&&c.text.trim()).sort((a,b)=>a.start-b.start||a.end-b.end).filter(c=>{const k=JSON.stringify([c.start,c.end,c.text]);if(seen.has(k))return false;seen.add(k);return true;});
  }
  function parseCues(text){
    if(typeof text!=='string'||text.length>MAX_TEXT)throw Error('字幕响应超出大小限制');
    const cues=[];const stamp='(?:\\d{2,}:)?\\d{2}:\\d{2}[.,]\\d{3}';const timing=new RegExp('^('+stamp+')\\s+-->\\s+('+stamp+')(?:\\s.*)?$');
    for(const block of text.replace(/^\uFEFF/,'').replace(/\r\n?/g,'\n').split(/\n[ \t]*\n/)){
      const lines=block.trim().split('\n');if(/^(NOTE(?:\s|$)|STYLE$|REGION$)/.test(lines[0]))continue;
      const index=lines.findIndex(l=>timing.test(l.trim()));if(index<0)continue;
      const m=lines[index].trim().match(timing);cues.push({start:seconds(m[1]),end:seconds(m[2]),text:plain(lines.slice(index+1).join('\n'))});
    }
    const normalized=normalizeCues(cues);if(!normalized.length)throw Error('未解析出有效 SRT/WebVTT 字幕，响应可能不是字幕');return normalized;
  }
  function rank(track){const value=(track.language+' '+track.name).toLowerCase();return /zh|中文|汉语|普通话|chinese/.test(value)?0:/bilingual|双语/.test(value)?1:2;}
  function timestamp(value){const ms=Math.round(value*1000),h=Math.floor(ms/3600000),m=Math.floor(ms/60000)%60,s=Math.floor(ms/1000)%60;return [h,m,s].map(n=>String(n).padStart(2,'0')).join(':')+'.'+String(ms%1000).padStart(3,'0');}
  function cueText(cues){return normalizeCues(cues).map(c=>'['+timestamp(c.start)+' → '+timestamp(c.end)+'] '+c.text).join('\n\n');}
  async function collect(sourcePath,deps,options={}){
    const deadline=Math.min(options.deadline??Infinity,deps.now()+(options.timeoutMs??90000));
    const pollMs=options.pollMs??2000,attempted=new Set(),errors=[];let native=[],count=0,total=0;
    async function read(url,depth=0){
      if(deps.now()>=deadline)throw Error('字幕读取总时限已到');
      if(!allowedURL(url))throw Error('字幕链接不在已支持的百度 HTTPS 域名内');
      if(depth>3||++count>MAX_REQUESTS)throw Error('字幕列表层数或请求数超出限制');
      const body=await deps.fetchText(url,Math.max(1,Math.min(8000,deadline-deps.now())));total+=body.length;
      if(total>MAX_TEXT)throw Error('字幕累计内容超出大小限制');
      if(!body.trimStart().startsWith('#EXTM3U'))return {cues:parseCues(body),notes:[]};
      const list=parsePlaylist(body,url);
      if(list.encrypted)throw Error('字幕列表含加密分段，未尝试解密');
      if(list.tracks.length){const first=list.tracks.sort((a,b)=>rank(a)-rank(b))[0];return read(first.url,depth+1);}
      if(!list.segments.length)throw Error('字幕列表没有可读取的字幕分段');
      const cues=[],notes=[];
      // Keep original segment timestamps; do not invent offsets when the server
      // uses a different timeline. Such archives remain explicitly review-only.
      notes.push('分段字幕保留原始时间戳，跨段时间与完整性需核验');
      if(!list.complete)notes.push('字幕列表未标记结束，可能仅含当前播放范围');
      for(const segment of list.segments){try{const data=await read(segment.url,depth+1);cues.push(...data.cues);notes.push(...data.notes);}catch(error){notes.push('部分字幕分段未读取：'+error.message);break;}}
      if(!cues.length)throw Error(notes.at(-1));return {cues:normalizeCues(cues),notes:[...new Set(notes)]};
    }
    try{
      deps.notify?.('未取得文稿，正在尝试播放器字幕…');
      while(deps.now()<deadline){
        const snapshot=await deps.snapshot();
        if(snapshot.sourcePath!==sourcePath)throw Error('播放器已切换到其他视频，停止字幕提取');
        if(snapshot.error)errors.push(snapshot.error);
        if(snapshot.native?.some(track=>track.cues?.length))native=snapshot.native;
        const tracks=[];
        for(const item of snapshot.manifests||[])tracks.push(...parsePlaylist(item.text,item.url).tracks);
        for(const track of tracks.sort((a,b)=>rank(a)-rank(b))){
          if(attempted.has(track.url))continue;attempted.add(track.url);
          try{const data=await read(track.url);return {status:'review',source:'subtitle',text:cueText(data.cues),reason:['文字来自播放器字幕（'+plain(track.name||track.language||'未标注语言')+'）','全文完整性需对照视频核验',...data.notes].join('；')};}
          catch(error){errors.push(error.message);}
        }
        await deps.sleep(Math.max(0,Math.min(pollMs,deadline-deps.now())));
      }
      for(const track of native.sort((a,b)=>rank(a)-rank(b))){
        const cues=normalizeCues((track.cues||[]).map(c=>({start:Number(c.start),end:Number(c.end),text:plain(c.text)})));
        if(cues.length)return {status:'review',source:'subtitle',text:cueText(cues),reason:'文字来自播放器原生字幕；可能只加载了部分字幕，需核验全文'+(errors.length?'；字幕链接读取有异常，已保留可见字幕':'')};
      }
      return errors.length?{status:'failed',reason:'字幕补提失败：'+[...new Set(errors)].slice(0,3).join('；')}:{status:'skipped',reason:'文稿不可用，等待后也未检测到可读取的播放器字幕，已跳过'};
    }catch(error){return {status:'failed',reason:'字幕补提中断：'+error.message};}
  }
  return {allowedURL,parsePlaylist,parseCues,normalizeCues,cueText,collect};
});
