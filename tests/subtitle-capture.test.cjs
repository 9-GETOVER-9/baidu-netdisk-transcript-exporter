const test=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs');const path=require('node:path');
const api=fs.existsSync(path.join(__dirname,'../subtitle-capture.js'))?require('../subtitle-capture.js'):{};
function page(mark=true){
 class XHR{open(method,url){this.url=url;}send(){}addEventListener(type,fn){this.listener=fn;}finish(body){this.responseType='';this.responseText=body;this.listener?.();}}
 const track={kind:'subtitles',language:'zh',label:'中文',mode:'disabled',cues:[{startTime:1,endTime:2,text:'原生内容'}]};
 const video={paused:true,muted:false,textTracks:[track],play(){this.paused=false;return Promise.resolve();},pause(){this.paused=true;}};
 const win={location:{href:'https://pan.baidu.com/pfile/video?path=%2Fcourse%2Fa.mp4'+(mark?'&__pd_subtitle=1':'')},XMLHttpRequest:XHR,document:{querySelectorAll:()=>[video]},fetch:async()=>({clone(){return {headers:{get:()=>null},text:async()=>playlist};}})};
 return {win,XHR,video,track};
}
const playlist='#EXTM3U\n#EXT-X-MEDIA:TYPE=SUBTITLES,LANGUAGE="zh",URI="/sub.srt"';
test('manual video pages are not hooked or played',()=>{const x=page(false),open=x.XHR.prototype.open;assert.equal(api.install(x.win),null);assert.equal(x.XHR.prototype.open,open);assert.equal(x.video.paused,true);});
test('owned pages retain early XHR subtitles and restore temporary playback settings',()=>{
 const x=page();const collector=api.install(x.win);const req=new x.XHR();req.open('GET','/api/streaming?path=%2Fcourse%2Fa.mp4&type=M3U8_SUBTITLE_SRT');req.send();req.finish(playlist);
 assert.equal(x.video.paused,true);const snapshot=collector.snapshot(true);assert.equal(snapshot.manifests.length,1);assert.equal(snapshot.native[0].cues[0].text,'原生内容');assert.equal(x.video.muted,true);assert.equal(x.track.mode,'hidden');
 collector.stop();assert.equal(x.video.paused,true);assert.equal(x.video.muted,false);assert.equal(x.track.mode,'disabled');
});
test('fetch subtitles are captured and wrong-video responses are ignored',async()=>{
 const x=page(),c=api.install(x.win);await x.win.fetch('/api/streaming?path=%2Fcourse%2Fa.mp4&type=M3U8_SUBTITLE_SRT');await new Promise(setImmediate);assert.equal(c.snapshot().manifests.length,1);
 const req=new x.XHR();req.open('GET','/api/streaming?path=%2Fother.mp4&type=M3U8_SUBTITLE_SRT');req.send();req.finish(playlist);assert.equal(c.snapshot().manifests.length,1);
});

test('native subtitle snapshot has a bounded text budget',()=>{
 const x=page();x.track.cues=Array.from({length:300},(_,i)=>({startTime:i,endTime:i+1,text:'字'.repeat(10000)}));
 const state=api.install(x.win).snapshot();assert.ok(state.native.flatMap(t=>t.cues).reduce((sum,c)=>sum+c.text.length,0)<=1024*1024);
});
