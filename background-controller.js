/* Persistent task routing for Manifest V3; browser actions require a batch request. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.PDBackground = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const STORE = 'pd_runtime_v4';
  function isPage(url, pathname) {
    try { const u = new URL(url); return u.origin === 'https://pan.baidu.com' && u.pathname === pathname; }
    catch { return false; }
  }
  function sameVideo(a, b) {
    if (!isPage(a, '/pfile/video') || !isPage(b, '/pfile/video')) return false;
    const x = new URL(a), y = new URL(b);
    return x.searchParams.get('path') === y.searchParams.get('path') && x.searchParams.get('fid') === y.searchParams.get('fid');
  }
  function sanitizeRelativePath(value) {
    if (typeof value !== 'string' || !value.trim() || /^[\\/]|^[a-z]:/i.test(value.trim())) throw Error('下载路径必须是相对文件夹');
    return value.replace(/\\/g, '/').split('/').map(part => {
      part = part.trim();
      if (!part || part === '.' || part === '..') throw Error('下载路径不可包含空层级、. 或 ..');
      part = part.replace(/[<>:"|?*\x00-\x1f]/g, '_').replace(/[. ]+$/g, '');
      if (!part) part = '_';
      if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part)) part = '_' + part;
      return part;
    }).join('/');
  }
  function validIdentity(m) {
    return typeof m.taskId === 'string' && m.taskId.length > 0 && typeof m.batchId === 'string' && m.batchId.length > 0 && Number.isInteger(m.attempt) && m.attempt > 0;
  }
  function identityMatches(job, m) { return validIdentity(m) && job.taskId === m.taskId && job.batchId === m.batchId && job.attempt === m.attempt; }

  // Serialized by chrome.scripting; no closure dependencies. Tokens stay in the page.
  async function resolveDocumentURL(fsId) {
    let token = '';
    if (typeof yunData !== 'undefined' && yunData) token = yunData.MYBDSTOKEN || yunData.bdstoken || '';
    if (!token) token = document.cookie.match(/BDSTOKEN=([^;]+)/i)?.[1] || '';
    if (!token) { try { token = localStorage.getItem('bdstoken') || ''; } catch {} }
    if (!token) {
      for (const script of document.querySelectorAll('script')) {
        const found = script.textContent.match(/bdstoken["']?\s*[:=]\s*["']?([a-f0-9]{32})/i);
        if (found) { token = found[1]; break; }
      }
    }
    if (!token) return { ok: false, error: '页面未提供下载令牌，请刷新并确认登录' };
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), 20000);
    try {
      const params = new URLSearchParams({ fsids: JSON.stringify([String(fsId)]), dlink: '1', web: '1', bdstoken: token });
      const response = await fetch('/api/filemetas?' + params, { credentials: 'same-origin', signal: abort.signal });
      if (!response.ok) throw Error('HTTP_' + response.status);
      const data = await response.json();
      if (data.errno !== 0) throw Error('ERRNO_' + data.errno);
      const dlink = data.info?.[0]?.dlink;
      if (!dlink) throw Error('NO_DLINK');
      return { ok: true, dlink };
    } catch (error) { return { ok: false, error: error.message }; }
    finally { clearTimeout(timer); }
  }

  const subtitleTools=typeof module==='object'&&module.exports?require('./subtitle-core.js'):globalThis.PDSubtitles;
  const formatStats=typeof module==='object'&&module.exports?require('./format-stats.js'):globalThis.PDFormatStats;
  // This function is serialized by chrome.scripting into the task's page world.
  function subtitlePageState(stop) {
    const bridge=globalThis.__PDSubtitleCapture42;
    if(!bridge)throw Error('字幕监听模块未加载，请更新扩展并重试任务');
    if(stop){bridge.stop();return {stopped:true};}
    return bridge.snapshot(true);
  }
  function createController(chrome, { archiveStore, fetchImpl=globalThis.fetch } = {}) {
    const cacheTools=typeof module==='object'&&module.exports?require('./cache-management.js'):globalThis.PDCacheManagement;
    const cacheManager=archiveStore?.metadata?cacheTools.createManager(chrome,archiveStore):null;
    let tail = Promise.resolve();
    function serial(fn) {
      const result = tail.then(async () => {
        const stored = await chrome.storage.session.get(STORE);
        const state = stored[STORE] || { jobs: {}, downloads: {}, owners: {} };
        state.owners ||= {};
        if(cacheManager)await cacheManager.recover(state);
        const value = await fn(state);
        await chrome.storage.session.set({ [STORE]: state });
        return value;
      });
      tail = result.catch(() => {});
      return result;
    }
    async function liveTab(id) { try { return await chrome.tabs.get(id); } catch { return null; } }
    async function relay(job) { try { await chrome.tabs.sendMessage(job.ownerTabId, { action: 'batchTaskResult', ...job.result }); } catch {} }
    function resultFor(job, values) { return { tabId: job.tabId, taskId: job.taskId, batchId: job.batchId, attempt: job.attempt, finishedAt: Date.now(), ...values }; }
    async function verifyCache(job) {
      if (!archiveStore?.get) return !!job.archived;
      const record = await archiveStore.get(job.rootDir || '/', job.taskId);
      job.archived = !!(record?.markdown?.trim() && record.batchId === job.batchId && record.attempt === job.attempt && record.sourcePath === new URL(job.url).searchParams.get('path') && record.sourceSize === job.size && record.sourceMtime === job.mtime);
      if (job.archived) {
        job.source = ['manuscript','subtitle'].includes(record.source) ? record.source : null;
        job.manuscriptObservation = formatStats.normalizeObservation(record.manuscriptObservation,job.attempt);
      }
      return job.archived;
    }
    function requireJob(state, sender, message, withIdentity = false) {
      const job = state.jobs[sender.tab?.id];
      if (!job || !sameVideo(sender.tab?.url, job.url)) throw Error('不是扩展创建的当前任务页');
      if (withIdentity && !identityMatches(job, message)) throw Error('任务标识或重试轮次不匹配');
      return job;
    }
    async function fileStatus(state, downloadId, sender) {
      const owned = state.downloads[downloadId];
      if (!owned || ![owned.tabId, owned.ownerTabId].includes(sender.tab?.id)) throw Error('下载记录不属于当前任务');
      const item = (await chrome.downloads.search({ id: downloadId }))[0];
      return { ok: true, state: item?.state || 'missing', error: item?.error || '', filename: item?.filename || '', downloadId };
    }
    async function download(state, sender, filename, url, job) {
      const settings = await chrome.storage.local.get('outputSubfolder');
      const prefix = settings.outputSubfolder === undefined ? '文稿导出' : settings.outputSubfolder;
      const safePath = sanitizeRelativePath(filename);
      const fullPath = prefix ? sanitizeRelativePath(prefix) + '/' + safePath : safePath;
      const downloadId = await chrome.downloads.download({ url, filename: fullPath, saveAs: false, conflictAction: 'uniquify' });
      if (!Number.isInteger(downloadId)) throw Error('下载未能创建');
      state.downloads[downloadId] = { tabId: sender.tab.id, ownerTabId: job?.ownerTabId ?? sender.tab.id };
      if (job) job.downloadId = downloadId;
      return { ok: true, downloadId };
    }
    async function process(message, sender) {
      if (!message || typeof message.action !== 'string') return { ok: false, error: '无效消息' };
      if(['subtitleSnapshot','subtitleText','stopSubtitleProbe'].includes(message.action)){
        // Authorize under the writer; page and network waits happen outside it.
        await serial(async state=>{
          const job=requireJob(state,sender,message,true);
          if(job.result&&message.action!=='stopSubtitleProbe')throw Error('任务已经结束');
          const tab=await liveTab(job.tabId);if(!tab||!sameVideo(tab.url,job.url))throw Error('任务页已关闭或切换，停止字幕操作');
        });
        if(message.action!=='subtitleText'){
          const results=await chrome.scripting.executeScript({target:{tabId:sender.tab.id},world:'MAIN',func:subtitlePageState,args:[message.action==='stopSubtitleProbe']});
          if(!results?.[0]?.result)throw Error('未取得播放器字幕状态');
          return {ok:true,snapshot:results[0].result};
        }
        if(!subtitleTools.allowedURL(message.url))throw Error('字幕链接不在已支持的百度 HTTPS 域名内');
        const abort=new AbortController(),timeout=setTimeout(()=>abort.abort(),Math.max(1,Math.min(Number(message.timeoutMs)||8000,8000)));
        try{
          // Do not follow signed links onto unapproved hosts, or return HTML login pages as text.
          const response=await fetchImpl(message.url,{credentials:'include',redirect:'error',signal:abort.signal});
          if(!response.ok)throw Error('字幕 HTTP '+response.status);
          if(response.url&&!subtitleTools.allowedURL(response.url))throw Error('字幕响应来源不受支持');
          const max=8*1024*1024;if(Number(response.headers.get('content-length'))>max)throw Error('字幕响应超出大小限制');
          const reader=response.body?.getReader();let text='';
          if(reader){const decoder=new TextDecoder();let size=0;try{while(true){const part=await reader.read();if(part.done)break;size+=part.value.byteLength;if(size>max){await reader.cancel();throw Error('字幕响应超出大小限制');}text+=decoder.decode(part.value,{stream:true});}text+=decoder.decode();}finally{reader.releaseLock();}}
          else{text=await response.text();if(text.length>max)throw Error('字幕响应超出大小限制');}
          return {ok:true,text};
        }finally{clearTimeout(timeout);}
      }
      let documentLink;
      // Page/network work must not hold the state writer and block task heartbeats.
      if (message.action === 'downloadPDF') {
        if (!isPage(sender.tab?.url, '/disk/main') || !/^\d+$/.test(String(message.fs_id))) throw Error('无效的文档请求');
        const injected = await chrome.scripting.executeScript({ target: { tabId: sender.tab.id }, world: 'MAIN', func: resolveDocumentURL, args: [String(message.fs_id)] });
        const result = injected?.[0]?.result;
        if (!result?.ok) throw Error(result?.error || '未取得文档链接');
        if (!['http:', 'https:'].includes(new URL(result.dlink).protocol)) throw Error('不支持的文档链接');
        documentLink = result.dlink;
      }
      return serial(async state => {
        if(['cacheSummary','cachePreview','cacheClear'].includes(message.action)){
          if(!cacheManager)throw Error('缓存管理不可用，请重新加载扩展');
          return cacheManager.handle(message,sender,state);
        }
        const directory = isPage(sender.tab?.url, '/disk/main');
        switch (message.action) {
          case 'openVideoTab': {
            if (!directory || !validIdentity(message) || !isPage(message.url, '/pfile/video')) throw Error('无效的目录任务请求');
            const batchOwner = Object.values(state.owners).find(owner => owner.batchId === message.batchId);
            if (batchOwner && batchOwner.tabId !== sender.tab.id && await liveTab(batchOwner.tabId)) throw Error('另一目录页正在控制此任务');
            const existing = Object.values(state.jobs).find(job => identityMatches(job, message));
            if (existing) {
              if (existing.ownerTabId !== sender.tab.id && await liveTab(existing.ownerTabId)) throw Error('任务正在另一目录页运行');
              if (existing.result || !await liveTab(existing.tabId)) throw Error('此任务轮次已结束，请显式重试');
              existing.ownerTabId = sender.tab.id;
              return { ok: true, tabId: existing.tabId };
            }
            // Without windowId Chrome uses the current window, which may differ from
            // the directory's window. Resolve live state in case the tab was moved.
            const ownerTab = await chrome.tabs.get(sender.tab.id);
            const markedURL=new URL(message.url);markedURL.searchParams.set('__pd_subtitle','1');
            const createOptions = { url: markedURL.href, active: false, openerTabId: sender.tab.id };
            if (Number.isInteger(ownerTab.windowId)) createOptions.windowId = ownerTab.windowId;
            const tab = await chrome.tabs.create(createOptions);
            if (!Number.isInteger(tab?.id)) throw Error('未能打开视频页');
            const sourcePath = new URL(message.url).searchParams.get('path') || '';
            const rootDir = message.rootDir || Object.keys(state.owners).find(key=>state.owners[key].batchId===message.batchId) || sourcePath.slice(0,sourcePath.lastIndexOf('/')) || '/';
            state.jobs[tab.id] = { tabId: tab.id, ownerTabId: sender.tab.id, taskId: message.taskId, batchId: message.batchId, attempt: message.attempt, rootDir, size:message.size, mtime:message.mtime, url: message.url, openedAt: Date.now(), result: null };
            return { ok: true, tabId: tab.id };
          }
          case 'getTask': {
            const job = state.jobs[sender.tab?.id];
            if (job && sameVideo(sender.tab?.url, job.url) && !job.result) await verifyCache(job);
            return { ok: true, job: job && sameVideo(sender.tab?.url, job.url) ? job : null };
          }
          // Legacy pages must never start another individual Save As dialog either.
          case 'downloadText':
          case 'archiveTranscript': {
            const job = requireJob(state, sender, message, true);
            if (job.result) throw Error('任务已经结束');
            if (await verifyCache(job)) return { ok: true, archived: true };
            if (typeof message.text !== 'string' || !message.text.trim()) throw Error('文稿为空');
            if (!archiveStore) throw Error('本地文稿缓存不可用，请重新加载扩展');
            await archiveStore.put({
              rootDir:job.rootDir || '/', taskId:job.taskId, batchId:job.batchId, attempt:job.attempt,
              sourcePath:new URL(job.url).searchParams.get('path') || '', sourceSize:job.size, sourceMtime:job.mtime,
              markdown:message.text, source:message.source==='subtitle'?'subtitle':'manuscript',
              manuscriptObservation:formatStats.normalizeObservation(message.manuscriptObservation,job.attempt), capturedAt:new Date().toISOString()
            });
            job.archived = true;
            job.source = message.source === 'subtitle' ? 'subtitle' : 'manuscript';
            job.manuscriptObservation = formatStats.normalizeObservation(message.manuscriptObservation,job.attempt);
            return { ok: true, archived: true };
          }
          case 'getDownloadStatus': return fileStatus(state, message.downloadId, sender);
          case 'taskResult': {
            const job = requireJob(state, sender, message, true);
            if (job.result) return { ok: true, result: job.result };
            if (!['saved', 'review', 'failed', 'skipped'].includes(message.status)) throw Error('无效的任务状态');
            if (message.status === 'saved' || message.status === 'review') {
              if (!await verifyCache(job)) throw Error('文稿尚未写入本地缓存，不能标记为已提取');
            }
            job.result = resultFor(job, { status: message.status, reason: String(message.reason || '').slice(0, 1000), archived: !!job.archived,
              source:job.source || null,
              manuscriptObservation:formatStats.normalizeObservation(message.manuscriptObservation,job.attempt) || job.manuscriptObservation || null });
            await chrome.storage.session.set({ [STORE]: state });
            await relay(job);
            return { ok: true, result: job.result };
          }
          case 'checkTabs': {
            if (!directory || typeof message.batchId !== 'string') throw Error('无效的任务查询');
            const key = message.rootDir;
            const owner = key ? state.owners[key] : null;
            if (owner && owner.tabId !== sender.tab.id && await liveTab(owner.tabId)) return { ok: true, batchBusy: true, jobs: [], results: [], aliveTabIds: [] };
            const matching = Object.values(state.jobs).filter(job => job.batchId === message.batchId);
            // Validate before changing ownership: a failed claim must leave the lock intact.
            for (const job of matching) {
              if (!job.result && job.ownerTabId !== sender.tab.id && await liveTab(job.ownerTabId)) return { ok: true, batchBusy: true, jobs: [], results: [], aliveTabIds: [] };
            }
            if (message.claim && key) state.owners[key] = { batchId: message.batchId, tabId: sender.tab.id };
            const jobs = [], results = [], aliveTabIds = [];
            for (const job of matching) {
              if (job.ownerTabId !== sender.tab.id) {
                job.ownerTabId = sender.tab.id;
                if (job.downloadId && state.downloads[job.downloadId]) state.downloads[job.downloadId].ownerTabId = sender.tab.id;
              }
              const tab = await liveTab(job.tabId);
              if (tab && sameVideo(tab.url, job.url)) {
                if (!job.result && Date.now() - job.openedAt > 12 * 60 * 1000) job.result = resultFor(job, { status: 'failed', reason: '任务超过 12 分钟仍未回报，已停止；请检查后手动重试', downloadId: job.downloadId });
                const expired = Date.now() - job.openedAt > 12 * 60 * 1000;
                const leftover = job.result && Date.now() - job.result.finishedAt > 15000;
                if (expired || leftover) {
                  try { await chrome.tabs.remove(job.tabId); } catch { aliveTabIds.push(job.tabId); }
                } else aliveTabIds.push(job.tabId);
              }
              else if (!job.result) job.result = resultFor(job, { status: 'failed', reason: '视频页已关闭或离开，未收到完成回报', downloadId: job.downloadId });
              jobs.push(job);
              if (job.result) results.push(job.result);
            }
            return { ok: true, batchBusy: false, jobs, results, aliveTabIds };
          }
          case 'releaseBatch': {
            if (!directory) throw Error('只允许目录页释放任务');
            const owner = state.owners[message.rootDir];
            if (owner?.tabId === sender.tab.id && owner.batchId === message.batchId) {
              if (Object.values(state.jobs).some(job => job.batchId === message.batchId && !job.result)) throw Error('仍有任务在运行');
              delete state.owners[message.rootDir];
            }
            return { ok: true };
          }
          case 'closeTab': {
            const job = requireJob(state, sender, message);
            if (!job.result) throw Error('请先记录任务结果');
            await chrome.tabs.remove(job.tabId);
            return { ok: true };
          }
          case 'prepareArchive': {
            if (!directory || typeof message.rootDir !== 'string' || typeof message.batchId !== 'string') throw Error('无效的打包请求');
            const key='pandownload.queue.v1.'+encodeURIComponent(message.rootDir);
            const snapshot=(await chrome.storage.local.get(key))[key];
            if (!snapshot?.queue || snapshot.queue.rootDir!==message.rootDir || snapshot.queue.batchId!==message.batchId) throw Error('未找到当前批次检查点，请先扫描或恢复任务');
            if (message.auto && snapshot.queue.videos.some(v=>['pending','opening','opened'].includes(v.status))) throw Error('任务尚未结束，不能标为最终打包');
            const signature=JSON.stringify(snapshot.queue.videos.map(v=>[v.taskId,v.attempt,v.status]));
            state.archives ||= {};
            if (message.auto && state.archives[message.batchId]===signature) return {ok:true,alreadyOpened:true};
            const url=new URL(chrome.runtime.getURL('export.html'));
            url.search=new URLSearchParams({root:message.rootDir,batch:message.batchId}).toString();
            const tab=await chrome.tabs.create({url:url.href,active:true});
            if (message.auto) state.archives[message.batchId]=signature;
            return {ok:true,tabId:tab.id};
          }
          case 'downloadPDF': {
            return download(state, sender, message.filename, documentLink);
          }
          default: return { ok: false, error: '不支持的操作' };
        }
      });
    }
    return { handle: (message, sender) => process(message, sender).catch(error => ({ ok: false, error: error.message })) };
  }
  return { createController, sanitizeRelativePath };
});
