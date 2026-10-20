/* Queue and directory traversal logic. No browser side effects at module load. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.PanDownloadQueue = api;
})(typeof globalThis === 'object' ? globalThis : this, function () {
  'use strict';
  const ACTIVE = new Set(['opening', 'opened']);
  const TERMINAL = new Set(['saved', 'review', 'failed', 'skipped']);
  const VIDEO_EXTS = new Set(['mp4', 'm4v', 'mkv', 'avi', 'mov', 'flv', 'wmv', 'webm']);
  const identity = video => `${String(video.fs_id || '')}:${video.path}`;
  const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
  const isVideoFile = name => VIDEO_EXTS.has(String(name).split('.').pop().toLowerCase());
  function getDirPath(hash) {
    return new URLSearchParams(String(hash).split('?')[1] || '').get('path') || '/';
  }
  class Queue {
    constructor({batchId, rootDir, videos = []}) {
      this.batchId = batchId;
      this.rootDir = rootDir;
      const seen = new Set();
      this.videos = videos.filter(v => {
        const id = identity(v); if (seen.has(id)) return false; seen.add(id); return true;
      }).map(v => ({...v, taskId: identity(v), attempt: Number(v.attempt) || 0,
        status: ACTIVE.has(v.status) || TERMINAL.has(v.status) ? v.status : 'pending'}));
    }
    active() { return this.videos.filter(v => ACTIVE.has(v.status)); }
    counts() {
      const counts = {pending:0, active:0, saved:0, review:0, failed:0, skipped:0};
      this.videos.forEach(v => counts[ACTIVE.has(v.status) ? 'active' : v.status]++);
      return counts;
    }
    reserve(limit) {
      const jobs = [];
      let slots = Math.max(0, Math.floor(limit) - this.active().length);
      for (const v of this.videos) {
        if (!slots) break;
        if (v.status !== 'pending') continue;
        Object.assign(v, {status:'opening', attempt:v.attempt + 1, tabId:null, openedAt:Date.now(), reason:'', manuscriptObservation:null, source:null});
        jobs.push({...v, batchId:this.batchId}); slots--;
      }
      return jobs;
    }
    match(job) {
      if (job.batchId !== this.batchId) return null;
      const v = this.videos.find(v => v.taskId === job.taskId && v.attempt === job.attempt);
      return v && ACTIVE.has(v.status) ? v : null;
    }
    markOpened(job, tabId) {
      const v = this.match(job); if (!v) return false;
      v.status = 'opened'; v.tabId = tabId; return true;
    }
    cancelReservation(job) {
      const v = this.match(job);
      if (!v || v.status !== 'opening' || Number.isInteger(v.tabId)) return false;
      v.status = 'pending'; v.reason = ''; return true;
    }
    applyResult(result) {
      const v = this.match(result);
      if (!v || !TERMINAL.has(result.status)) return false;
      const stats = typeof module === 'object' && module.exports ? require('./format-stats.js') : globalThis.PDFormatStats;
      Object.assign(v, {status:result.status, reason:String(result.reason || ''), archived:result.archived === true, downloadId:result.downloadId ?? null, tabId:null,
        manuscriptObservation:stats?.normalizeObservation(result.manuscriptObservation, v.attempt) || null,
        source:['manuscript','subtitle'].includes(result.source) ? result.source : null});
      return true;
    }
    markMissing(queriedIds, aliveIds) {
      const queried = new Set(queriedIds), alive = new Set(aliveIds);
      for (const v of this.active()) {
        if (queried.has(v.tabId) && !alive.has(v.tabId)) {
          this.applyResult({...v,batchId:this.batchId,status:'failed',reason:'播放页已关闭，未收到确认结果'});
        }
      }
    }
    retryFailed() {
      for (const v of this.videos) if (v.status === 'failed') { v.status = 'pending'; v.reason = ''; v.tabId = null; }
    }
    retrySkipped() {
      for (const v of this.videos) if (v.status === 'skipped') { v.status = 'pending'; v.reason = ''; v.tabId = null; }
    }
    mergeScan(videos) {
      if (this.active().length) throw new Error('仍有活动任务，不能重新扫描');
      const old = new Map(this.videos.map(v => [identity(v),v]));
      this.videos = new Queue({batchId:this.batchId,rootDir:this.rootDir,videos:videos.map(v => {
        const prev = old.get(identity(v));
        if (!prev) return v;
        if (prev.size === v.size && prev.mtime === v.mtime) return {...v,...prev};
        // The same identity still has old attempts in the background ledger.
        // New content needs fresh work without reusing a completed attempt ID.
        return {...v,status:'pending',attempt:prev.attempt};
      })}).videos;
    }
    snapshot() { return {batchId:this.batchId,rootDir:this.rootDir,videos:this.videos.map(v => ({...v}))}; }
  }
  async function listDir(dirPath, fetcher, options = {}) {
    const {num = 100, maxRetries = 3, sleep = ms => new Promise(r => setTimeout(r,ms))} = options;
    let lastError = '目录读取失败';
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        const all = [], signatures = new Set();
        for (let page = 1; ; page++) {
          const controller = new AbortController();
          const timeout = setTimeout(() => controller.abort(), 30000);
          let data;
          try {
            const response = await fetcher(`https://pan.baidu.com/api/list?order=name&desc=0&showempty=0&web=1&page=${page}&num=${num}&dir=${encodeURIComponent(dirPath)}`, {signal:controller.signal,credentials:'same-origin'});
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            data = await response.json();
          } finally { clearTimeout(timeout); }
          if (data.errno !== 0) throw new Error(`page=${page}, errno=${data.errno}`);
          if (!Array.isArray(data.list)) throw new Error(`page=${page}, 无效目录响应`);
          const signature = JSON.stringify(data.list.map(item => [item.fs_id,item.path]));
          if (data.list.length && signatures.has(signature)) throw new Error(`page=${page}, 分页重复`);
          signatures.add(signature); all.push(...data.list);
          if (data.list.length < num) break;
        }
        const files = [], dirs = [];
        for (const item of all) {
          if (!item.path || typeof item.server_filename !== 'string') throw new Error('文件记录缺少名称或路径');
          const file = {name:item.server_filename,path:item.path,fs_id:item.fs_id,size:item.size,mtime:item.server_mtime ?? item.local_mtime};
          (item.isdir === 1 || item.isdir === true ? dirs : files).push(file);
        }
        return {files, dirs, error:null};
      } catch (error) {
        lastError = error.message || String(error);
        if (attempt + 1 < maxRetries) await sleep(500 * (attempt + 1));
      }
    }
    return {files:[], dirs:[], error:lastError};
  }
  async function scanTree(rootPath, list, {concurrency = 3, onDirectory = () => {}} = {}) {
    const pending = [rootPath], visited = new Set([rootPath]), directories = [], failedDirs = [];
    while (pending.length) {
      const batch = pending.splice(0, Math.max(1,concurrency));
      const results = await Promise.all(batch.map(async path => {
        let result;
        try { result = await list(path); } catch (error) { result = {files:[],dirs:[],error:error.message}; }
        return {path,...result};
      }));
      for (const result of results) {
        directories.push(result);
        if (result.error) failedDirs.push({path:result.path,error:result.error,retries:3});
        else for (const dir of result.dirs) if (!visited.has(dir.path)) { visited.add(dir.path); pending.push(dir.path); }
        onDirectory(result);
      }
    }
    return {directories,failedDirs};
  }
  return {Queue,escapeHtml,isVideoFile,getDirPath,listDir,scanTree};
});
