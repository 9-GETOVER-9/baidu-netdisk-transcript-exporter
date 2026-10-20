'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const core = require('../transcript-core.js');
const source = fs.readFileSync(path.join(__dirname, '..', 'content.js'), 'utf8');

async function executeContent({ owned = true, acknowledge = true, closeThrows = false, completed = false, noDraft = false } = {}) {
  const calls = [];
  let domAccesses = 0;
  let draftClicks = 0;
  let clock = 0;
  let nextTimer = 1;
  const timers = new Map();
  const node = () => {
    const value = { style: {}, dataset: {}, textContent: '', appendChild() {}, append() {}, setAttribute() {} };
    value.querySelector = () => value;
    return value;
  };
  const draft = { textContent: '文稿', offsetParent: {}, getBoundingClientRect: () => ({ width: 50, height: 30 }), click: () => { draftClicks++; } };
  const scope = { innerText: '实际可见文字。', textContent: '实际可见文字。' };
  const wrap = { innerText: '实际可见文字。', parentElement: scope, closest: () => scope, offsetParent:{}, getBoundingClientRect:()=>({width:200,height:100}) };
  const document = {
    readyState: 'complete', documentElement: node(),
    createElement: () => { domAccesses++; return node(); },
    querySelectorAll: () => { domAccesses++; return noDraft ? [] : [draft]; },
    querySelector: selector => { domAccesses++; return selector === '.ai-draft__wrap-content' ? wrap : scope; },
  };
  const job = { taskId: 't1', batchId: 'b1', attempt: 2, url: 'https://pan.baidu.com/pfile/video?path=%2Fvideo.mp4&relPath=' };
  if (completed) job.result = { status: 'review', reason: '已有下载已保存，仍需核验', downloadId: 7 };
  class FakeDate extends Date { static now() { return clock; } }
  const window = { location: { href: job.url }, addEventListener() {} };
  const context = {
    window, document, URL, Date: FakeDate, BaiduTranscriptCore: core, PDSubtitles: require('../subtitle-core.js'),
    console: { log() {}, error() {}, warn() {} },
    setTimeout: (fn, delay = 0) => { const id = nextTimer++; timers.set(id, { fn, at: clock + delay }); return id; },
    clearTimeout: id => timers.delete(id),
    chrome: {
      storage: { local: { get: async () => ({ enabled: true }), set() {}, remove() {} } },
      runtime: {
        lastError: null,
        sendMessage(message, callback) {
          calls.push(message);
          if (closeThrows && message.action === 'closeTab') throw new Error('Cannot close tab');
          const replies = {
            getTask: { ok: true, job: owned ? job : null },
            archiveTranscript: { ok: true, archived: true },
            subtitleSnapshot: {ok:true,snapshot:{sourcePath:'/video.mp4',manifests:[{url:'https://pan.baidu.com/api/streaming',text:'#EXTM3U\n#EXT-X-MEDIA:TYPE=SUBTITLES,LANGUAGE="zh",URI="/sub.srt"'}],native:[]}},
            subtitleText: {ok:true,text:'1\n00:00:01,000 --> 00:00:02,000\n真实适配器字幕'},
            stopSubtitleProbe: {ok:true},
            getDownloadStatus: { ok: true, state: 'complete' },
            taskResult: acknowledge ? { ok: true } : { ok: false, error: 'storage unavailable' },
            closeTab: { ok: true },
          };
          if (callback) callback(replies[message.action] || { ok: false });
        },
      },
    },
  };
  vm.runInNewContext(source, context, { filename: 'content.js' });
  for (let i = 0; i < 300; i++) {
    // Let real async continuations settle before advancing the fake browser timer boundary.
    for (let j = 0; j < 20; j++) await Promise.resolve();
    if (!timers.size) break;
    const [id, timer] = [...timers].sort((a, b) => a[1].at - b[1].at)[0];
    timers.delete(id);
    clock = timer.at;
    timer.fn();
  }
  for (let j = 0; j < 20; j++) await Promise.resolve();
  return { calls, domAccesses, draftClicks, clock };
}

test('manually opened video is untouched when background supplies no owned job', async () => {
  const result = await executeContent({ owned: false });
  assert.equal(result.calls[0]?.action, 'getTask');
  assert.equal(result.domAccesses, 0);
  assert.equal(result.draftClicks, 0);
  assert.deepEqual(result.calls.map(x => x.action), ['getTask']);
});

test('owned task reports committed cache with task identity before closing', async () => {
  const result = await executeContent();
  const final = result.calls.find(x => x.action === 'taskResult');
  assert.ok(final, 'must report an explicit terminal result');
  assert.equal(final.status, 'review');
  assert.equal(final.taskId, 't1');
  assert.equal(final.batchId, 'b1');
  assert.equal(final.attempt, 2);
  assert.equal(final.archived, true);
  assert.equal(result.draftClicks, 1);
  const actions = result.calls.map(x => x.action);
  assert.ok(actions.indexOf('archiveTranscript') < actions.indexOf('taskResult'));
  assert.equal(actions.includes('downloadText'),false);
  assert.equal(actions.includes('getDownloadStatus'),false);
  assert.ok(actions.indexOf('taskResult') < actions.indexOf('closeTab'));
  assert.equal(actions.includes('reloadTab'), false);
});

test('a failed result acknowledgement is retried finitely and leaves the tab open', async () => {
  const result = await executeContent({ acknowledge: false });
  assert.equal(result.calls.filter(x => x.action === 'taskResult').length, 2);
  assert.equal(result.calls.some(x => x.action === 'closeTab'), false);
  assert.equal(result.calls.some(x => x.action === 'reloadTab'), false);
  assert.ok(result.clock < 480000);
});

test('a tab-close failure never repeats an already acknowledged result', async () => {
  const result = await executeContent({ closeThrows: true });
  assert.equal(result.calls.filter(x => x.action === 'taskResult').length, 1);
  assert.equal(result.calls.filter(x => x.action === 'closeTab').length, 1);
});

test('refresh of a finished task only closes it, without recapturing or reporting again', async () => {
  const result = await executeContent({ completed: true });
  assert.equal(result.draftClicks, 0);
  assert.deepEqual(result.calls.map(x => x.action), ['getTask', 'closeTab']);
});

test('production content adapter wires subtitle fallback and stops its probe before reporting',async()=>{
 const result=await executeContent({noDraft:true});const actions=result.calls.map(m=>m.action);
 assert.equal(result.calls.find(m=>m.action==='taskResult').status,'review');
 assert.match(result.calls.find(m=>m.action==='archiveTranscript').text,/真实适配器字幕/);
 assert.ok(actions.indexOf('stopSubtitleProbe')<actions.indexOf('taskResult'));assert.equal(actions.includes('downloadText'),false);
});
