/* Page-world observer. Independently implemented; only task-marked pages opt in. */
(function(factory){const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;else api.install(window);})(function(){
  'use strict';
  function install(win){
    const initial=new URL(win.location.href);
    if(initial.origin!=='https://pan.baidu.com'||initial.pathname!=='/pfile/video'||initial.searchParams.get('__pd_subtitle')!=='1')return null;
    if(win.__PDSubtitleCapture42)return win.__PDSubtitleCapture42;
    const sourcePath=initial.searchParams.get('path')||'',manifests=new Map(),players=new Map(),tracks=new Map();
    const installedAt=Date.now();let stopped=false,error='';const MAX=1024*1024;
    function current(){return new URL(win.location.href).searchParams.get('path')||'';}
    function eligible(value){
      if(stopped||Date.now()-installedAt>10*60*1000||current()!==sourcePath)return '';
      try{const url=new URL(value,win.location.href);const path=url.searchParams.get('path');return url.origin===initial.origin&&url.pathname==='/api/streaming'&&(!path||path===sourcePath)?url.href:'';}catch{return '';}
    }
    function keep(url,text){
      if(stopped||current()!==sourcePath||typeof text!=='string'||text.length>MAX||!text.includes('#EXTM3U')||!text.includes('SUBTITLES'))return;
      if(manifests.size>=12&&!manifests.has(url))manifests.delete(manifests.keys().next().value);
      manifests.set(url,{url,text});
    }
    const xhr=win.XMLHttpRequest?.prototype;
    if(xhr){const open=xhr.open,send=xhr.send;const urls=new WeakMap();
      xhr.open=function(method,url){urls.set(this,eligible(url));return open.apply(this,arguments);};
      xhr.send=function(){const url=urls.get(this);if(url)this.addEventListener('load',()=>{try{if(!this.responseType||this.responseType==='text')keep(url,this.responseText);}catch{}},{once:true});return send.apply(this,arguments);};
    }
    if(win.fetch){const fetch=win.fetch;
      win.fetch=function(input){const url=eligible(typeof input==='string'||input instanceof URL?String(input):input?.url);const promise=fetch.apply(this,arguments);
        if(url)promise.then(response=>{const clone=response.clone();return (async()=>{
          if(Number(clone.headers?.get('content-length'))>MAX)return;
          if(!clone.body?.getReader){keep(url,await clone.text());return;}
          const reader=clone.body.getReader(),decoder=new TextDecoder();let size=0,text='';
          try{while(true){const part=await reader.read();if(part.done)break;size+=part.value.byteLength;if(size>MAX){await reader.cancel();return;}text+=decoder.decode(part.value,{stream:true});}keep(url,text+decoder.decode());}finally{reader.releaseLock();}
        })();}).catch(()=>{});
        return promise;
      };
    }
    function start(){
      if(stopped||current()!==sourcePath)return;
      for(const video of win.document.querySelectorAll('video')){
        for(const track of Array.from(video.textTracks||[]))if(['subtitles','captions'].includes(track.kind)&&!tracks.has(track)){tracks.set(track,track.mode);if(track.mode==='disabled')track.mode='hidden';}
        if(players.has(video))continue;
        const state={muted:video.muted,paused:video.paused};players.set(video,state);
        if(state.paused){video.muted=true;try{const promise=video.play();promise?.catch(()=>{error='播放器未能自动开始播放，可能需要手动启动后重试';});}catch{error='播放器未能自动开始播放';}}
      }
    }
    function stop(){
      stopped=true;
      for(const [video,state]of players){try{if(state.paused){video.pause();video.muted=state.muted;}}catch{}}
      for(const [track,mode]of tracks){try{track.mode=mode;}catch{}}
    }
    function snapshot(probe=false){
      if(probe)start();const native=[];let budget=MAX;
      if(current()===sourcePath)for(const video of win.document.querySelectorAll('video'))for(const track of Array.from(video.textTracks||[])){
        if(!['subtitles','captions'].includes(track.kind))continue;
        try{
          const cues=[];
          for(const cue of Array.from(track.cues||[]).slice(0,50000)){
            const text=String(cue.text||'').slice(0,10000);if(text.length>budget)break;
            budget-=text.length;cues.push({start:cue.startTime,end:cue.endTime,text});
          }
          if(cues.length)native.push({language:track.language||'',name:track.label||'',cues});
        }catch{}
      }
      return {sourcePath:current(),manifests:current()===sourcePath?[...manifests.values()]:[],native,error};
    }
    const api={snapshot,stop};Object.defineProperty(win,'__PDSubtitleCapture42',{value:api,configurable:true});return api;
  }
  return {install};
});
