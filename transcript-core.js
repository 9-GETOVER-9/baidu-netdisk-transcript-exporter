// Shared transcript logic. This module has no browser, network or storage side effects.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.BaiduTranscriptCore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  function normalizeText(value) {
    return String(value || '').replace(/\r\n?/g, '\n').trim();
  }

  function parseVideoLocation(href) {
    try {
      const params = new URL(href).searchParams;
      // URLSearchParams already decodes percent escapes. A second decode changes filenames.
      const parts = (params.get('path') || '').split('/').filter(Boolean);
      return {
        name: parts[parts.length - 1] || '未命名视频',
        relativeDirectory: params.has('relPath') ? params.get('relPath') : (parts[parts.length - 2] || ''),
      };
    } catch (_) {
      return { name: '未命名视频', relativeDirectory: '' };
    }
  }

  function sanitizeSegment(value) {
    let safe = String(value || '').replace(/[<>:"/\\|?*\u0000-\u001f\u007f]/g, '_').replace(/[. ]+$/g, '').trim();
    if (!safe || safe === '.' || safe === '..') safe = '_';
    if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(safe)) safe = '_' + safe;
    // Windows filenames are measured in UTF-16 units. Avoid ending on half a surrogate pair.
    safe = safe.slice(0, 120).replace(/[\uD800-\uDBFF]$/, '').replace(/[. ]+$/g, '');
    return safe || '_';
  }

  function makeDownloadPath(href) {
    const parsed = parseVideoLocation(href);
    const dirs = parsed.relativeDirectory.split(/[\\/]/).filter(Boolean).map(sanitizeSegment);
    const stem = parsed.name.replace(/\.[^.]+$/, '');
    return [...dirs, sanitizeSegment(stem) + '.md'].join('/');
  }

  function createStabilityTracker(stableMs) {
    let previous = '';
    let unchangedSince = null;
    return {
      observe(value, now) {
        const current = normalizeText(value);
        if (!current) { previous = ''; unchangedSince = null; return false; }
        if (current !== previous || unchangedSince === null) {
          previous = current;
          unchangedSince = now;
          return false;
        }
        return now - unchangedSince >= stableMs;
      },
    };
  }

  function isPlaceholder(text) {
    if (/^(?:文稿\s*)?(?:生成失败|加载失败|请求失败|网络异常|服务异常)[，,。.!！…\s]*(?:(?:请|点击|请点击)?(?:稍后重试|重新加载|刷新重试|重试))[。.!！…\s]*$/.test(text)) return true;
    return /^(?:文稿\s*)?(?:加载中|生成中|正在生成|识别中|转写中|正在转写|转录中|处理中|暂无文稿|暂无内容|文稿生成失败|生成失败|加载失败|请求失败|网络异常|服务异常|开通会员查看完整文稿|开通会员查看全文)[.。…\s]*$/.test(text);
  }

  function signals(snapshot) {
    const context = normalizeText(snapshot.context) + '\n' + normalizeText(snapshot.text);
    return {
      generating: /生成中|正在生成|识别中|转写中|正在转写|转录中|加载中|处理中/.test(context),
      restricted: /试看|试用|预览|部分文稿|开通[^\n]{0,20}会员|升级[^\n]{0,20}会员|解锁[^\n]{0,20}(全文|完整)|仅[^\n]{0,10}(分钟|字)/.test(context),
      summary: /摘要|总结|概要/.test(context),
      failed: /生成失败|加载失败|请求失败|网络异常|服务异常/.test(context),
    };
  }

  function assessTranscript(snapshot, timedOut = false) {
    const text = normalizeText(snapshot.text);
    const flags = signals(snapshot);
    const reasons = [];
    if (flags.generating) reasons.push('页面仍有生成或加载提示');
    if (flags.restricted) reasons.push('页面含预览或权限提示，可能只有部分文稿');
    if (flags.summary) reasons.push('页面含摘要或总结提示，请核对是否为逐字文稿');
    if (timedOut) reasons.push('等待文稿超时，仅保留已显示的文字');
    if (!text || isPlaceholder(text)) {
      return { status: 'skipped', text: '', reason: ['未取得可保存的文稿，已跳过', ...reasons].join('；') };
    }
    // Stable DOM is only a cue to stop waiting, never proof that the entire video was transcribed.
    reasons.push('无法自动确认文稿完整性，请对照视频时长核验');
    return { status: 'review', text, reason: reasons.join('；') };
  }

  function formatExport(text, reason, job = {}, source = 'manuscript') {
    let sourcePath='';
    try { sourcePath=new URL(job.url).searchParams.get('path') || ''; } catch {}
    const escape=value=>String(value).replace(/[\\`*_{}\[\]<>#]/g,'\\$&');
    const name=parseVideoLocation(job.url).name;
    return '# '+escape(name)+'\n\n> 已保存，需核验全文完整性。\n\n'+escape(reason)+'\n\n'+(sourcePath?'**网盘路径**：'+escape(sourcePath)+'\n\n':'')+'**文字来源**：'+(source==='subtitle'?'播放器字幕':'网页文稿')+'\n\n## '+(source==='subtitle'?'字幕正文（含时间戳）':'文稿')+'\n\n'+escape(text)+'\n';
  }

  async function runExport(job, deps, options = {}) {
    const config = {
      totalTimeoutMs: 8 * 60 * 1000,
      openTimeoutMs: 30 * 1000,
      emptyTimeoutMs: 30 * 1000,
      captureTimeoutMs: 5 * 60 * 1000,
      downloadTimeoutMs: 60 * 1000,
      pollMs: 3000,
      stableMs: 24000,
      ...options,
    };
    const deadline = deps.now() + config.totalTimeoutMs;
    const pause = async until => {
      const remaining = Math.max(0, Math.min(until, deadline) - deps.now());
      if (remaining > 0) await deps.sleep(Math.min(config.pollMs, remaining));
    };
    const report = message => { if (deps.notify) deps.notify(message); };
    const credentials = { taskId: job.taskId, batchId: job.batchId, attempt: job.attempt };
    let manuscriptObservation = job.archived ? job.manuscriptObservation || null : null;
    function observe(state, reason) {
      manuscriptObservation = {version:1,state,reason,checkedAt:new Date(deps.now()).toISOString(),attempt:job.attempt};
    }
    function observeEmpty(snapshot) {
      const flags = signals(snapshot);
      const checked = snapshot.panelFound === true && deps.isPageReady?.() === true && !flags.generating && !flags.restricted && !flags.failed;
      observe(checked ? 'not_detected' : 'unknown', checked ? '已找到文稿面板，等待后未读取到正文' : '文稿面板尚未就绪、存在生成/权限/错误提示或未识别到内容区域，无法判断');
    }
    async function saveAssessment(assessment) {
      if (deps.now() >= deadline) return { status:'failed', reason:'任务总时限已到，尚未完成缓存' };
      const source=assessment.source || 'manuscript';
      report('文字已提取，正在写入本地缓存，完成后统一打包 ZIP…');
      const started=await deps.send({action:'archiveTranscript',...credentials,filename:makeDownloadPath(job.url),source,manuscriptObservation,text:formatExport(assessment.text,assessment.reason,job,source)});
      if(!started?.ok || started.archived!==true)return {status:'failed',reason:'无法缓存 Markdown：'+(started?.error||'后台未确认缓存写入')};
      return {status:'review',archived:true,source,reason:assessment.reason};
    }
    async function fallback(original) {
      if(!deps.readSubtitles)return original;
      const result=await deps.readSubtitles({deadline});
      if(result?.status==='review' && result.text)return saveAssessment({...result,source:'subtitle',reason:original.reason+'；'+result.reason});
      if(!result || !['failed','skipped'].includes(result.status))return {status:'failed',reason:'字幕模块未返回有效结果'};
      if(original.status==='failed' && result.status==='skipped')return {status:'failed',reason:original.reason+'；'+result.reason};
      return {...result,reason:original.reason+'；'+result.reason};
    }
    async function execute() { try {
      if (job.archived) return { status: 'review', archived: true, source:job.source, reason: '已恢复缓存文稿，等待统一打包；全文完整性仍需核验' };
      report('等待页面中的“文稿”入口…');
      const openDeadline = Math.min(deadline, deps.now() + config.openTimeoutMs);
      let opened = false;
      while (deps.now() < openDeadline) {
        if (await deps.openDraft()) { opened = true; break; }
        await pause(openDeadline);
      }
      if (!opened) {
        if (deps.isPageReady && !deps.isPageReady()) {
          observe('unknown', '页面尚未确认就绪，无法判断文稿');
          return await fallback({ status: 'failed', reason: '页面尚未加载完成，无法判断文稿入口，请稍后重试' });
        }
        observe(deps.isPageReady?.() === true ? 'not_detected' : 'unknown', '有限等待后仍未检测到文稿入口；只有确认页面就绪才计入未检出样本');
        return await fallback({ status: 'skipped', reason: '等待后仍未检测到“文稿”入口' });
      }

      report('等待可见文稿稳定；完整性需要另行核验…');
      const captureStart = deps.now();
      const captureDeadline = Math.min(deadline, captureStart + config.captureTimeoutMs);
      const tracker = createStabilityTracker(config.stableMs);
      let retained = { text: '', context: '' };
      let lastSnapshot = retained;
      let stable = false;
      let lastSize = -1;
      while (deps.now() < captureDeadline) {
        const snapshot = deps.readSnapshot();
        lastSnapshot = snapshot;
        const assessment = assessTranscript(snapshot);
        if (assessment.text) {
          retained = { text: assessment.text, context: snapshot.context || '' };
          observe('present', '已读取到网页文稿正文；不代表全文完整');
        }
        if (!retained.text && deps.now() - captureStart >= config.emptyTimeoutMs && !signals(snapshot).generating) {
          observeEmpty(snapshot);
          return await fallback({ status: 'skipped', reason: '文稿面板等待后仍无可保存的文字' });
        }
        const unchanged = tracker.observe(assessment.text, deps.now());
        if (assessment.text.length !== lastSize) {
          lastSize = assessment.text.length;
          report(lastSize ? `已读取 ${lastSize} 字符，等待网页更新…` : '等待网页显示可读取文稿…');
        }
        if (unchanged && !signals(snapshot).generating) { stable = true; break; }
        await pause(captureDeadline);
      }
      // Keep a previously visible excerpt if a loading state replaces the panel at the deadline.
      const assessment = assessTranscript({
        text: retained.text,
        context: [retained.context, lastSnapshot.context || '', lastSnapshot.text || ''].join('\n'),
      }, !stable);
      if (assessment.status === 'skipped') { observeEmpty(lastSnapshot); return await fallback(assessment); }
      if (deps.now() >= deadline) return { status: 'failed', reason: '任务总时限已到，尚未完成保存；请手动重试' };

      return await saveAssessment(assessment);
    } catch (error) {
      return { status: 'failed', reason: '导出中断：' + (error && error.message || String(error)) };
    } }
    const result = await execute();
    if (!manuscriptObservation) observe('unknown', job.archived ? '历史缓存没有文稿检测记录' : '任务中断或尚未取得有效文稿检测结果');
    return {...result, manuscriptObservation};
  }

  return { normalizeText, parseVideoLocation, sanitizeSegment, makeDownloadPath, createStabilityTracker, assessTranscript, formatExport, runExport };
});

