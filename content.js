// Video-page adapter. Only tabs explicitly owned by an extension batch may run.
(function () {
  'use strict';
  if (window.__BaiduPanSubtitleAutoExported__) return;
  window.__BaiduPanSubtitleAutoExported__ = true;

  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  let panel = null;
  let heading = null;
  let status = null;

  function send(message) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const timeout = setTimeout(() => {
        if (!settled) { settled = true; reject(new Error('扩展后台响应超时')); }
      }, 10000);
      try {
        chrome.runtime.sendMessage(message, response => {
          if (settled) return;
          settled = true;
          clearTimeout(timeout);
          const error = chrome.runtime.lastError;
          if (error) reject(new Error(error.message));
          else resolve(response);
        });
      } catch (error) {
        if (!settled) { settled = true; clearTimeout(timeout); reject(error); }
      }
    });
  }

  function createPanel() {
    panel = document.createElement('section');
    panel.id = '__subtitle_auto_panel__';
    panel.setAttribute('aria-label', '文稿整理状态');
    panel.style.cssText = 'position:fixed;top:16px;right:16px;z-index:2147483647;background:#faf9f4;color:#33443b;padding:18px 20px;border:1px solid #dce3da;border-radius:18px;font:13px/1.65 "Microsoft YaHei",sans-serif;box-shadow:0 10px 35px #233e2f18;max-width:360px;pointer-events:none;';
    heading = document.createElement('div');
    heading.textContent = '文稿整理 · 4.2.3 · 仅 ZIP';
    heading.style.cssText = 'font-size:15px;font-weight:600;margin-bottom:7px;';
    status = document.createElement('div');
    status.id = '__subtitle_status__';
    status.setAttribute('role', 'status');
    const note = document.createElement('div');
    note.textContent = '页面脚本 4.2.3 · 中途仅缓存 · 结束统一打包 ZIP';
    note.style.cssText = 'font-size:11px;color:#69776c;margin-top:9px;';
    panel.append(heading, status, note);
    document.documentElement.appendChild(panel);
  }

  function log(message, state = 'working') {
    if (status) status.textContent = message;
    if (panel) panel.dataset.state = state;
    if (heading && state === 'review') heading.textContent = '已缓存 · 等待统一打包';
    if (heading && state === 'failed') heading.textContent = '本项未完成';
    if (heading && state === 'skipped') heading.textContent = '文稿与字幕均未取得 · 已跳过';
  }

  function visible(element) {
    if (element.offsetParent === null) return false;
    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  function openDraft() {
    const tabs = [...document.querySelectorAll('div.vp-tabs__header-item')];
    const preferred = tabs.find(tab => tab.textContent.trim() === '文稿' && visible(tab));
    if (preferred) { preferred.click(); return true; }
    // Keep the original fallback for layout variants, but click just the smallest visible label.
    const candidates = [...document.querySelectorAll('button, [role="tab"], div')]
      .filter(element => element.textContent.trim() === '文稿' && visible(element));
    candidates.sort((a, b) => {
      const first = a.getBoundingClientRect();
      const second = b.getBoundingClientRect();
      return first.width * first.height - second.width * second.height;
    });
    if (!candidates.length) return false;
    candidates[0].click();
    return true;
  }

  function readSnapshot() {
    const wrap = document.querySelector('.ai-draft__wrap-content');
    const scope = document.querySelector('.ai-draft') || document.querySelector('.ai-draft__wrap') || (wrap && wrap.parentElement);
    return {
      text: wrap ? wrap.innerText || '' : '',
      context: scope ? scope.innerText || '' : '',
      panelFound: !!wrap && visible(wrap),
    };
  }

  async function reportResult(job, result) {
    const identity = { taskId: job.taskId, batchId: job.batchId, attempt: job.attempt };
    let error = '';
    let acknowledged = false;
    // Acknowledgement retries are bounded and idempotent; extraction/download is never repeated here.
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const response = await send({ action: 'taskResult', ...identity, ...result });
        if (response && response.ok) {
          acknowledged = true;
          break;
        }
        error = response && response.error || '后台未确认结果';
      } catch (failure) {
        error = failure.message;
      }
      if (attempt === 0) await sleep(1000);
    }
    if (!acknowledged) {
      log(`结果未能写回任务清单：${error}。此页已保留，请检查扩展状态。`, 'failed');
      return;
    }
    await closeRecordedTask(job, result);
  }

  async function closeRecordedTask(job, result) {
    const identity = { taskId: job.taskId, batchId: job.batchId, attempt: job.attempt };
    log(result.reason, result.status);
    await sleep(700);
    try {
      const response = await send({ action: 'closeTab', ...identity });
      if (!response || !response.ok) throw new Error(response && response.error || '后台未确认关闭');
    } catch (failure) {
      log(`结果已记录，标签页未能自动关闭：${failure.message}。可以手动关闭本页。`, result.status);
    }
  }

  async function main() {
    // Do this before any DOM reads, clicks or panel insertion. Manual videos remain untouched.
    const response = await send({ action: 'getTask' });
    const job = response && response.ok && response.job;
    if (!job || !job.taskId || !job.batchId || !Number.isInteger(job.attempt)) return;
    createPanel();
    if (job.result) {
      await closeRecordedTask(job, job.result);
      return;
    }
    if (!globalThis.BaiduTranscriptCore) {
      await reportResult(job, { status: 'failed', reason: '文稿模块未加载，请重新加载扩展后手动重试' });
      return;
    }
    const result = await BaiduTranscriptCore.runExport(job, {
      now: () => Date.now(), sleep, openDraft, readSnapshot, send, notify: log,
      isPageReady: () => document.readyState === 'complete' && (
        [...document.querySelectorAll('div.vp-tabs__header-item, [role="tab"]')].some(el => visible(el) && /^(视频|笔记|文稿|课件|AI看)$/.test(el.textContent.trim())) ||
        [...document.querySelectorAll('video')].some(el => visible(el) && el.readyState >= 1)
      ),
      readSubtitles: async ({deadline}) => {
        if(!globalThis.PDSubtitles)return {status:'failed',reason:'字幕模块未加载，请更新扩展后重试'};
        const identity={taskId:job.taskId,batchId:job.batchId,attempt:job.attempt};
        try {
          return await PDSubtitles.collect(new URL(job.url).searchParams.get('path')||'', {
            now:()=>Date.now(),sleep,notify:log,
            snapshot:async()=>{const r=await send({action:'subtitleSnapshot',...identity});if(!r?.ok)throw Error(r?.error||'字幕状态读取失败');return r.snapshot;},
            fetchText:async(url,timeoutMs)=>{const r=await send({action:'subtitleText',...identity,url,timeoutMs});if(!r?.ok)throw Error(r?.error||'字幕读取失败');return r.text;},
          }, {deadline});
        } finally {
          try{await send({action:'stopSubtitleProbe',...identity});}catch{}
        }
      },
    });
    await reportResult(job, result);
  }

  main().catch(error => {
    // A communication failure is not permission to reload or retry the video indefinitely.
    if (panel) log(`任务已停止：${error.message}`, 'failed');
    console.warn('[文稿整理] 任务已停止：' + error.message);
  });
})();
