const test=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs');
const api=fs.existsSync(require('node:path').join(__dirname,'../subtitle-core.js'))?require('../subtitle-core.js'):{};
const base='https://pan.baidu.com/api/streaming?path=%2Fcourse%2Fa.mp4&type=M3U8_SUBTITLE_SRT';
const sample='1\n00:00:01,000 --> 00:00:03,500\n第一节课程\n\n2\n00:00:04,000 --> 00:00:06,000\n<b>你好</b> &amp; 欢迎';
test('subtitle playlist supports quoted commas, URI attributes and legacy next-line URLs',()=>{
 const t=api.parsePlaylist('#EXTM3U\n#EXT-X-MEDIA:TYPE=SUBTITLES,NAME="中文,原声",LANGUAGE="zh-CN",URI="/sub.srt?q=1,2"\n#EXT-X-MEDIA:TYPE=SUBTITLES,NAME="English",LANGUAGE="en"\nhttps://pan.baidu.com/en.srt',base);
 assert.equal(t.tracks.length,2);assert.equal(t.tracks[0].url,'https://pan.baidu.com/sub.srt?q=1,2');assert.equal(t.tracks[0].name,'中文,原声');
});
test('only subtitle HTTPS sources on the allowed hosts can be fetched',()=>{
 for(const url of ['http://pan.baidu.com/a','https://pan.baidu.com.evil.test/a','file:///a','https://127.0.0.1/a','https://user:pass@pan.baidu.com/a'])assert.equal(api.allowedURL(url),false,url);
 assert.equal(api.allowedURL('https://d.pcs.baidu.com/a'),false);
 assert.equal(api.allowedURL('https://d.baidupcs.com/a'),true);
});
test('SRT and WebVTT preserve times, plain text and meaningful repeated sentences',()=>{
 const cues=api.parseCues(sample);assert.equal(cues.length,2);assert.equal(cues[1].text,'你好 & 欢迎');assert.equal(cues[0].start,1);
 const v=api.parseCues('WEBVTT\n\nNOTE comment\nignored\n\nid\n00:02.000 --> 00:03.000 align:start\n<c.green>同一句</c>\n\n00:04.000 --> 00:05.000\n同一句');assert.equal(v.length,2);assert.equal(v[1].start,4);
 assert.throws(()=>api.parseCues('<html>login required</html>'),/字幕/);
});
function h(snapshot){let time=0;const calls=[];return {calls,deps:{now:()=>time,sleep:async ms=>{time+=ms;},snapshot:async()=>snapshot,fetchText:async url=>{calls.push(url);return sample;},notify(){}},options:{timeoutMs:100,pollMs:10}};}
test('collector chooses Chinese and returns timestamped subtitle text',async()=>{
 const x=h({sourcePath:'/course/a.mp4',manifests:[{url:base,text:'#EXTM3U\n#EXT-X-MEDIA:TYPE=SUBTITLES,LANGUAGE="en",URI="/en.srt"\n#EXT-X-MEDIA:TYPE=SUBTITLES,LANGUAGE="zh",URI="/zh.srt"'}],native:[]});
 const r=await api.collect('/course/a.mp4',x.deps,x.options);assert.equal(r.status,'review');assert.equal(r.source,'subtitle');assert.match(r.text,/00:00:01/);assert.match(x.calls[0],/zh.srt/);assert.equal(x.calls.length,1);
});
test('missing subtitles and retrieval failures are distinct terminal outcomes',async()=>{
 const x=h({sourcePath:'/course/a.mp4',manifests:[],native:[]});assert.equal((await api.collect('/course/a.mp4',x.deps,x.options)).status,'skipped');
 x.deps.snapshot=async()=>({sourcePath:'/course/a.mp4',manifests:[{url:base,text:'#EXTM3U\n#EXT-X-MEDIA:TYPE=SUBTITLES,URI="/a.srt"'}],native:[]});x.deps.fetchText=async()=>{throw Error('HTTP 403');};
 const r=await api.collect('/course/a.mp4',x.deps,x.options);assert.equal(r.status,'failed');assert.match(r.reason,/403/);
});
test('another video snapshot is never archived under the current video',async()=>{
 const x=h({sourcePath:'/different.mp4',manifests:[],native:[{language:'zh',cues:[{start:0,end:1,text:'错误视频'}]}]});const r=await api.collect('/course/a.mp4',x.deps,x.options);assert.equal(r.status,'failed');assert.equal(x.calls.length,0);
});
test('native cues are a fallback and marked as potentially partial',async()=>{
 const x=h({sourcePath:'/course/a.mp4',manifests:[],native:[{language:'zh',cues:[{start:0,end:1,text:'原生字幕'}]}]});const r=await api.collect('/course/a.mp4',x.deps,x.options);assert.equal(r.status,'review');assert.match(r.reason,/部分/);
});

test('segmented subtitles deduplicate overlapping cues and flag incomplete lists',async()=>{
 const x=h({sourcePath:'/course/a.mp4',manifests:[{url:base,text:'#EXTM3U\n#EXT-X-MEDIA:TYPE=SUBTITLES,URI="/segments.m3u8"'}],native:[]});
 x.deps.fetchText=async url=>url.endsWith('m3u8')?'#EXTM3U\n#EXTINF:3,\na.vtt\n#EXTINF:3,\nb.vtt':'WEBVTT\n\n00:00:01.000 --> 00:00:02.000\n重叠字幕';
 const result=await api.collect('/course/a.mp4',x.deps,x.options);assert.equal(result.status,'review');assert.equal(result.text.match(/重叠字幕/g).length,1);assert.match(result.reason,/未标记结束/);
});
test('one failed subtitle segment preserves readable text with a partial warning',async()=>{
 const x=h({sourcePath:'/course/a.mp4',manifests:[{url:base,text:'#EXTM3U\n#EXT-X-MEDIA:TYPE=SUBTITLES,URI="/segments.m3u8"'}],native:[]});
 x.deps.fetchText=async url=>{if(url.endsWith('m3u8'))return '#EXTM3U\n#EXTINF:3,\na.vtt\n#EXTINF:3,\nb.vtt\n#EXT-X-ENDLIST';if(url.endsWith('b.vtt'))throw Error('HTTP 403');return sample;};
 const result=await api.collect('/course/a.mp4',x.deps,x.options);assert.equal(result.status,'review');assert.match(result.reason,/部分字幕分段未读取/);
});
test('encrypted or looping subtitle playlists terminate without attempting media decryption',async()=>{
 const x=h({sourcePath:'/course/a.mp4',manifests:[{url:base,text:'#EXTM3U\n#EXT-X-MEDIA:TYPE=SUBTITLES,URI="/segments.m3u8"'}],native:[]});
 x.deps.fetchText=async()=> '#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="key"\n#EXTINF:3,\na.vtt';
 const result=await api.collect('/course/a.mp4',x.deps,x.options);assert.equal(result.status,'failed');assert.match(result.reason,/加密/);
});
