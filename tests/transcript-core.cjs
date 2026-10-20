'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const modulePath = path.join(__dirname, '..', 'transcript-core.js');
const core = fs.existsSync(modulePath) ? require(modulePath) : {};

test('URL path and relative directories are decoded exactly once', () => {
  const url = 'https://pan.baidu.com/pfile/video?path=' + encodeURIComponent('/课程/100%25%完成.mp4') + '&relPath=' + encodeURIComponent('课程%25/100%');
  assert.deepEqual(core.parseVideoLocation(url), { name: '100%25%完成.mp4', relativeDirectory: '课程%25/100%' });
});

test('download filename removes Windows hazards and traversal but preserves percent text', () => {
  const url = 'https://pan.baidu.com/pfile/video?path=' + encodeURIComponent('/课程/CON.mp4') + '&relPath=' + encodeURIComponent('../AUX/课程. /100%');
  assert.equal(core.makeDownloadPath(url), '_/_AUX/课程/100%/_CON.md');
  const longUrl = 'https://pan.baidu.com/pfile/video?path=' + encodeURIComponent('/' + '字'.repeat(200) + '.mkv') + '&relPath=';
  assert.ok(core.makeDownloadPath(longUrl).length <= 124);
  assert.match(core.makeDownloadPath(longUrl), /\.md$/);
});

test('whole-text stability resets when same-length content changes', () => {
  const track = core.createStabilityTracker(100);
  assert.equal(track.observe('甲乙', 0), false);
  assert.equal(track.observe('丙丁', 100), false);
  assert.equal(track.observe('丙丁', 199), false);
  assert.equal(track.observe('丙丁', 200), true);
});

test('short genuine text is retained and stable DOM never proves completeness', () => {
  const result = core.assessTranscript({ text: '这是一节很短的课程。', context: '' });
  assert.equal(result.status, 'review');
  assert.equal(result.text, '这是一节很短的课程。');
  assert.match(result.reason, /完整/);
});

test('preview, generation, summary and timeout reasons stay attached to saved excerpt', () => {
  const result = core.assessTranscript({ text: '当前可见的课程内容。', context: '文稿生成中，预览。开通会员解锁全文。摘要' }, true);
  assert.equal(result.status, 'review');
  for (const word of ['生成', '预览', '摘要', '超时']) assert.ok(result.reason.includes(word), result.reason);
});

test('empty or UI-only placeholders are skipped, not a saved transcript', () => {
  for (const text of ['', '  ', '正在生成…', '加载中...', '开通会员查看完整文稿']) {
    assert.equal(core.assessTranscript({ text, context: text }).status, 'skipped', text);
  }
});

function harness(overrides = {}) {
  let clock = 0;
  const calls = [];
  const job = { taskId: 'file-1', batchId: 'batch-1', attempt: 1, url: 'https://pan.baidu.com/pfile/video?path=%2Fcourse%2Flesson.mp4&relPath=' };
  const deps = {
    now: () => clock,
    sleep: async ms => { clock += ms; },
    openDraft: () => true,
    readSnapshot: () => ({ text: '可见的课程文字。', context: '' }),
    notify: () => {},
    send: async message => {
      calls.push(message);
      if (message.action === 'archiveTranscript') return { ok: true, archived: true };
      if (message.action === 'getDownloadStatus') return { ok: true, state: 'complete' };
      throw new Error('Unexpected action: ' + message.action);
    },
    ...overrides,
  };
  return { job, deps, calls, getClock: () => clock, config: { totalTimeoutMs: 1000, openTimeoutMs: 100, captureTimeoutMs: 400, downloadTimeoutMs: 200, pollMs: 10, stableMs: 30 } };
}

test('capture waits for durable cache acknowledgement and never requests a single-file download', async () => {
  const h=harness();
  const result=await core.runExport(h.job,h.deps,h.config);
  assert.equal(result.status,'review');assert.equal(result.archived,true);
  assert.deepEqual(h.calls.map(x=>x.action),['archiveTranscript']);
  assert.match(h.calls[0].text,/可见的课程文字/);
  assert.match(h.calls[0].filename,/\.md$/);
});

test('failed or missing durable cache acknowledgement is a failure', async () => {
  for(const response of [{ok:false,error:'DISK_FULL'},{ok:true,downloadId:42}]) {
    const h=harness({send:async()=>response});
    const result=await core.runExport(h.job,h.deps,h.config);
    assert.equal(result.status,'failed');assert.match(result.reason,/缓存/);
  }
});

test('missing draft button terminates within the time budget without download or reload', async () => {
  const h = harness({ openDraft: () => false });
  const result = await core.runExport(h.job, h.deps, h.config);
  assert.equal(result.status, 'skipped');
  assert.match(result.reason, /文稿/);
  assert.equal(h.calls.length, 0);
  assert.ok(h.getClock() <= 1000);
});

test('generating forever saves last visible excerpt with timeout reason', async () => {
  const h = harness({ readSnapshot: () => ({ text: '尚未生成完的文稿。', context: '正在生成' }) });
  const result = await core.runExport(h.job, h.deps, h.config);
  assert.equal(result.status, 'review');
  assert.match(result.reason, /超时/);
  assert.match(result.reason, /生成/);
});

test('no visible transcript is skipped after a bounded empty-content wait', async () => {
  const h = harness({ readSnapshot: () => ({ text: '', context: '' }) });
  const result = await core.runExport(h.job, h.deps, h.config);
  assert.equal(result.status, 'skipped');
  assert.equal(h.calls.length, 0);
  assert.ok(h.getClock() <= 1000);
});

test('a page that never finishes loading is a failure rather than a no-draft skip', async () => {
  const h = harness({ openDraft: () => false, isPageReady: () => false });
  const result = await core.runExport(h.job, h.deps, h.config);
  assert.equal(result.status, 'failed');
  assert.match(result.reason, /加载/);
  assert.equal(h.calls.length, 0);
});

test('a draft button appearing during the entry grace period is still exported', async () => {
  const h = harness();
  h.deps.openDraft = () => h.getClock() >= 60;
  const result = await core.runExport(h.job, h.deps, h.config);
  assert.equal(result.status, 'review');
  assert.equal(h.calls.filter(x => x.action === 'archiveTranscript').length, 1);
});

test('empty pane without generation signs is skipped sooner than capture timeout', async () => {
  const h = harness({ readSnapshot: () => ({ text: '', context: '' }) });
  const result = await core.runExport(h.job, h.deps, { ...h.config, emptyTimeoutMs: 30 });
  assert.equal(result.status, 'skipped');
  assert.ok(h.getClock() <= 40);
  assert.equal(h.calls.length, 0);
});

test('refresh resumes committed cache without clicking, capturing or downloading again', async () => {
  const h=harness({openDraft:()=>{throw Error('must not open');},readSnapshot:()=>{throw Error('must not read');}});
  h.job.archived=true;
  const result=await core.runExport(h.job,h.deps,h.config);
  assert.equal(result.status,'review');assert.equal(result.archived,true);assert.deepEqual(h.calls,[]);
});

test('missing manuscript falls back to subtitles and caches labelled Markdown once',async()=>{
 const h=harness({openDraft:()=>false,readSubtitles:async()=>({status:'review',source:'subtitle',text:'[00:00:01] 字幕内容',reason:'播放器字幕，需核验'})});
 const r=await core.runExport(h.job,h.deps,h.config);assert.equal(r.status,'review');assert.equal(r.source,'subtitle');
 assert.equal(h.calls.length,1);assert.match(h.calls[0].text,/文字来源.*播放器字幕/);assert.match(h.calls[0].text,/字幕内容/);
});
test('visible manuscript takes priority and never probes subtitles',async()=>{
 const h=harness({readSubtitles:async()=>{throw Error('must not probe');}});assert.equal((await core.runExport(h.job,h.deps,h.config)).status,'review');
});
test('empty manuscript uses subtitle fallback and preserves subtitle failures',async()=>{
 const h=harness({readSnapshot:()=>({text:'',context:''}),readSubtitles:async()=>({status:'failed',reason:'字幕 HTTP 403'})});
 const r=await core.runExport(h.job,h.deps,{...h.config,emptyTimeoutMs:10});assert.equal(r.status,'failed');assert.match(r.reason,/403/);assert.equal(h.calls.length,0);
});
