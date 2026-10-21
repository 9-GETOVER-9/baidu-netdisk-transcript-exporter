// content_dir.js — 注入到百度网盘目录页
// 在页面右上角添加批量控制面板，自动递归扫描所有子目录的视频/文档文件
// Local 4.0: persistent task queue, confirmed downloads, explicit review status.

(function () {
  'use strict';

  if (window.__BaiduPanBatchController__) return;
  window.__BaiduPanBatchController__ = true;
  const Core = globalThis.PanDownloadQueue;
  const esc = Core.escapeHtml;
  let queue = null;
  let saveChain = Promise.resolve();
  let polling = false;
  let claiming = false;
  let ownsBatch = false;
  let finishing = false;
  let packing = false;

  // ========== 支持下载的文件类型 ==========
  const DOC_TYPES = {
    documents: ['pdf', 'doc', 'docx', 'ppt', 'pptx', 'xls', 'xlsx', 'csv'],
    images: ['jpg', 'jpeg', 'png', 'webp'],
    text: ['md', 'txt'],
    audio: ['mp3', 'm4a', 'wav', 'aac'],
    other: ['xmind', 'html'],
  };
  const ALL_DOC_EXTS = Object.values(DOC_TYPES).flat();

  // ========== 默认选中的下载类型 ==========
  const DEFAULT_SELECTED = new Set(['pdf', 'doc', 'docx', 'ppt', 'pptx', 'xls', 'xlsx', 'md', 'txt']);

  const STATE = {
    enabled: false,
    paused: false,
    collapsed: false,   // 是否最小化面板
    videos: [],
    currentIndex: 0,
    activeTabs: [],
    maxConcurrent: 2,
    userConcurrency: 2,
    totalDone: 0,
    totalSkip: 0,
    totalReview: 0,
    totalFailed: 0,
    pollTimer: null,
    rootDir: '',
    scanning: false,
    scanProgress: '',
    notice: '先扫描目录，再开始提取。优先读取网页文稿，没有可读文稿时尝试字幕。',
    extensionEnabled: true,
    batchEnabled: true,
    pdfEnabled: true,
    scanStats: {
      totalDirs: 0,
      totalFiles: 0,
      totalVideos: 0,
      totalNonVideos: 0,
      failedDirs: [],
      nonVideoFiles: [],
      dirDetails: [],
    },
    showDetails: false,
    showFailed: false,
    showCached: false,
    showManuscriptStats: false,
    problemFilter: 'all',
    // === 文档下载相关 ===
    docs: [],              // [{name, path, fs_id, relPath, size, status, ext}]
    docMode: 'idle',       // 'idle' | 'downloading' | 'done'
    docsTotal: 0,
    docsDone: 0,
    docsFailed: 0,
    docsFailList: [],
    docsCurrentName: '',
    selectedDocTypes: DEFAULT_SELECTED, // Set of selected extensions
    showDocTypes: false,   // 是否展开文件类型选择
  };

  function log(msg) {
    console.log(`[批量导出] ${msg}`);
    STATE.notice = msg;
    updatePanel();
  }

  // ========== 浮动控制面板 ==========
  let panelEl = null;
  let panelInner = null;  // 内层可滚动容器

  function createPanel() {
    if (panelEl) return;
    panelEl = document.createElement('div');
    panelEl.id = '__batch_subtitle_panel__';
    panelEl.style.cssText = `
      position: fixed;
      top: 12px;
      right: 12px;
      z-index: 2147483647;
      background: rgba(30, 30, 40, 0.97);
      color: #fff;
      padding: 0;
      border-radius: 10px;
      font-size: 13px;
      font-family: -apple-system, "Microsoft YaHei", sans-serif;
      box-shadow: 0 6px 20px rgba(0,0,0,0.5);
      width: 420px;
      line-height: 1.5;
    `;

    // 内层容器：内容自适应高度，超出自动滚动
    if (!panelInner) {
      panelInner = document.createElement('div');
      panelInner.style.cssText = `
        padding: 10px 12px;
        overflow-y: auto;
        overflow-x: hidden;
        box-sizing: border-box;
      `;
      panelEl.appendChild(panelInner);
    }
    (document.body || document.documentElement).appendChild(panelEl);
    console.log('[BatchPanel] 面板已创建, panelEl:', panelEl);
    renderPanel();
    console.log('[BatchPanel] 初始渲染完成, currentDir:', getCurrentDirPath());
  }

  // ========== 获取文件扩展名 ==========
  function getExt(filename) {
    const idx = filename.lastIndexOf('.');
    return idx >= 0 ? filename.substring(idx + 1).toLowerCase() : '';
  }

  // ========== 判断是否是视频文件 ==========
  function isVideoFile(filename) {
    return Core.isVideoFile(filename);
  }

  // ========== 判断是否是选中的文档文件 ==========
  function isDocFile(filename) {
    return STATE.selectedDocTypes.has(getExt(filename));
  }

  // ========== 渲染面板 ==========
  function renderPanel() {
    if (!panelEl) return;

    const previousScroll = panelInner.scrollTop;
    const focusedId = panelEl.contains(document.activeElement) ? document.activeElement.id : '';

    const currentDir = getCurrentDirPath();
    const hasScanned = STATE.scanStats.totalDirs > 0;

    // ===== 扫描区域 =====
    const scanBtnText = STATE.scanning
      ? '⏳ 扫描中...'
      : (hasScanned ? '🔄 重新扫描' : '🔍 扫描目录');
    const scanBtnColor = STATE.scanning ? '#7f8c8d' : '#3498db';
    const scanInfo = STATE.scanning
      ? `<div style="margin-top:3px;font-size:11px;opacity:0.8;color:#f39c12;">🔄 ${esc(STATE.scanProgress)}</div>`
      : '';

    // ===== 视频字幕导出按钮 =====
    const videoTotal = STATE.videos.length;
    const videoDone = STATE.totalDone;
    const videoFailed = STATE.totalFailed;
    const videoReview = STATE.totalReview;
    const videoSkip = STATE.totalSkip;
    const videoActive = STATE.activeTabs.length;
    const videoProcessing = videoTotal > 0 ? (videoDone + videoReview + videoSkip + videoFailed) : 0;
    const videoRemaining = Math.max(0, videoTotal - videoProcessing - videoActive);
    const videoProgress = videoTotal > 0 ? Math.round((videoProcessing / videoTotal) * 100) : 0;
    const isVideoRunning = STATE.enabled;

    let videoBtnText = '🎬 开始提取文字';
    let videoBtnColor = '#2ea0a3';
    if (isVideoRunning && !STATE.paused) {
      videoBtnText = '⏸ 暂停';
      videoBtnColor = '#e67e22';
    } else if (isVideoRunning && STATE.paused) {
      videoBtnText = '▶ 继续';
      videoBtnColor = '#27ae60';
    } else if (videoProcessing > 0 && !isVideoRunning) {
      videoBtnText = '▶ 继续导出';
      videoBtnColor = '#2ea0a3';
    }

    // ===== 文档下载按钮 =====
    const docTotal = STATE.docs.length;
    const isDocDownloading = STATE.docMode === 'downloading';
    const isDocDone = STATE.docMode === 'done';
    const docProgress = docTotal > 0 ? Math.round((STATE.docsDone / docTotal) * 100) : 0;
    const docRemaining = docTotal - STATE.docsDone - STATE.docsFailed;

    let docBtnText = '📄 下载文档';
    let docBtnColor = '#e67e22';
    if (isDocDownloading) {
      docBtnText = '⏳ 下载中...';
      docBtnColor = '#c0392b';
    } else if (isDocDone && STATE.docsFailed > 0) {
      docBtnText = '🔁 重新下载';
      docBtnColor = '#e67e22';
    } else if (isDocDone) {
      docBtnText = '✅ 下载完成';
      docBtnColor = '#27ae60';
    }

    // ===== 组装HTML =====
    let html = '';
    html += `<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">`;
    html += `<span style="font-weight:bold;font-size:15px;">📂 文字稿归档 · 4.2.2</span>`;
    html += `<button id="__batch_toggle_collapse__" style="
      background:rgba(255,255,255,0.15);color:#fff;border:none;padding:2px 8px;
      border-radius:4px;font-size:11px;cursor:pointer;
    ">${STATE.collapsed ? '▼ 展开' : '▲ 收起'}</button>`;
    html += `</div>`;

    // ===== 折叠内容 =====
    if (STATE.collapsed) {
      const vc = STATE.videos.length;
      const dc = STATE.docs.length;
      html += `<div style="font-size:11px;opacity:0.6;">`;
      html += `已缓存文字 ${STATE.totalDone + STATE.totalReview}/${vc} · 失败 ${STATE.totalFailed} · 跳过 ${STATE.totalSkip} · 文档 ${STATE.docsDone}/${dc}`;
      html += `</div>`;
      panelInner.innerHTML = html;
      panelEl.style.height = '42px';
      const collapseBtn = panelInner.querySelector('#__batch_toggle_collapse__');
      if (collapseBtn) collapseBtn.addEventListener('click', () => {
        STATE.collapsed = false;
        panelEl.style.height = 'auto';
        updatePanel();
      });
      return;
    }

    // 展开时恢复正常高度
    panelEl.style.height = 'auto';

    // 扫描按钮行
    html += `<div style="margin-bottom:6px;">`;
    html += `<button id="__batch_scan_btn__" style="
      background:${scanBtnColor};color:#fff;border:none;padding:6px 14px;
      border-radius:6px;font-size:13px;font-weight:bold;cursor:pointer;
    " ${STATE.scanning || STATE.enabled || STATE.activeTabs.length || STATE.docMode === 'downloading' ? 'disabled' : ''}>${scanBtnText}</button>`;
    if (currentDir) {
      const displayDir = STATE.rootDir || currentDir;
      const shortDir = displayDir.length > 40 ? '...' + displayDir.substring(displayDir.length - 37) : displayDir;
      html += `<span class="pd-muted" title="${esc(displayDir)}" style="margin-left:8px;font-size:11px;opacity:0.5;">${STATE.rootDir ? '任务目录：' : '当前目录：'}${esc(shortDir)}</span>`;
    }
    html += `</div>`;
    html += scanInfo;
    html += `<p class="pd-notice" role="status" aria-live="polite">${esc(STATE.notice)}</p>`;
    if (STATE.rootDir && STATE.rootDir !== currentDir) html += `<p class="pd-muted">浏览目录已变化。请返回上方任务目录继续导出；重新扫描会读取当前目录。</p>`;

    // ===== 两个操作按钮（扫描完成后才显示）=====
    if (hasScanned) {
      html += `<div style="border-top:1px solid rgba(255,255,255,0.2);margin:6px 0;padding-top:6px;">`;

      // ===== 视频字幕导出区域 =====
      html += `<div style="margin-bottom:6px;">`;
      html += `<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px;">`;
      html += `<span style="font-weight:bold;">🎬 视频文字提取</span>`;
      html += `<span style="font-size:12px;opacity:0.7;">${videoTotal} 个视频</span>`;
      html += `</div>`;

      html += renderResultSummaryHtml();

      // 并发控制（加减按钮，实时生效）
      if (videoTotal > 0) {
        html += `<div style="display:flex;align-items:center;gap:6px;margin-bottom:5px;font-size:11px;">`;
        html += `<span style="opacity:0.7;">并发:</span>`;
        html += `<button id="__batch_conc_dec__" style="background:rgba(255,255,255,0.15);color:#fff;border:none;width:22px;height:22px;border-radius:4px;cursor:pointer;font-size:13px;line-height:1;padding:0;">−</button>`;
        html += `<span id="__batch_conc_val__" style="min-width:20px;text-align:center;font-weight:bold;">${STATE.userConcurrency}</span>`;
        html += `<button id="__batch_conc_inc__" style="background:rgba(255,255,255,0.15);color:#fff;border:none;width:22px;height:22px;border-radius:4px;cursor:pointer;font-size:13px;line-height:1;padding:0;">+</button>`;
        html += `<span style="opacity:0.5;font-size:10px;margin-left:2px;">(1-10)</span>`;
        html += `</div>`;
      }

      html += `<button id="__batch_video_btn__" style="
        background:${videoBtnColor};color:#fff;border:none;padding:6px 12px;
        border-radius:5px;font-size:13px;font-weight:bold;cursor:pointer;width:100%;
      ">${videoBtnText}</button>`;

      // 视频进度
      if (videoProcessing > 0 || videoActive > 0) {
        html += `<div style="margin-top:4px;">`;
        html += `<div style="font-size:11px;opacity:0.85;">`;
        html += `本轮已结束 ${videoProcessing} / ${videoTotal} 项 · 处理中 ${videoActive} · 待处理 ${videoRemaining}`;
        html += `</div>`;
        html += `<div style="margin-top:3px;height:4px;background:rgba(255,255,255,0.15);border-radius:2px;">`;
        html += `<div style="height:100%;width:${videoProgress}%;background:#2ea0a3;border-radius:2px;transition:width 0.3s;"></div>`;
        html += `</div>`;
        if (STATE.activeTabs.length > 0) {
          html += `<div style="margin-top:3px;font-size:11px;opacity:0.7;">`;
          for (const t of STATE.activeTabs.slice(0, 2)) {
            const v = STATE.videos[t.videoIndex];
            if (v) {
              const sn = v.name.length > 38 ? v.name.substring(0, 35) + '...' : v.name;
              const el = Math.round((Date.now() - t.openedAt) / 1000);
              html += `<div class="pd-task-row">⏳ ${esc(sn)} (${el}s)</div>`;
            }
          }
          html += `</div>`;
        }
        html += `</div>`;
      }

      html += renderFormatStatsHtml();
      html += renderFailedHtml();
      html += renderCachedHtml();
      html += `</div>`;

      // ===== 文档下载区域 =====
      if (STATE.pdfEnabled) {
      html += `<div style="border-top:1px solid rgba(255,255,255,0.15);padding-top:8px;">`;
      html += `<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px;">`;
      html += `<span style="font-weight:bold;">📄 文档下载</span>`;
      html += `<span style="font-size:12px;opacity:0.7;">${docTotal} 个文件</span>`;
      html += `</div>`;

      // 文件类型选择（可展开）
      html += `<div style="margin-bottom:6px;">`;
      html += `<button id="__batch_toggle_doc_types__" style="
        background:rgba(255,255,255,0.1);color:#fff;border:1px solid rgba(255,255,255,0.25);
        padding:3px 10px;border-radius:4px;font-size:11px;cursor:pointer;
      ">${STATE.showDocTypes ? '收起' : '选择文件类型'} (已选${STATE.selectedDocTypes.size}种)</button>`;
      html += `</div>`;

      if (STATE.showDocTypes) {
        html += `<div style="background:rgba(0,0,0,0.25);border-radius:6px;padding:10px;margin-bottom:8px;font-size:11px;">`;

        const renderGroup = (label, exts, color) => {
          html += `<div style="margin-bottom:6px;"><span style="color:${color};font-weight:bold;">${label}:</span></div>`;
          html += `<div style="display:flex;flex-wrap:wrap;gap:4px;margin-bottom:8px;">`;
          for (const ext of exts) {
            const checked = STATE.selectedDocTypes.has(ext);
            const id = `__doc_type_${ext}__`;
            html += `<label style="display:flex;align-items:center;gap:3px;cursor:pointer;background:rgba(255,255,255,${checked ? '0.2' : '0.08'});padding:2px 7px;border-radius:3px;border:1px solid rgba(255,255,255,${checked ? '0.4' : '0.15'});">`;
            html += `<input type="checkbox" id="${id}" data-ext="${ext}" ${checked ? 'checked' : ''} style="cursor:pointer;">`;
            html += `<span>.${ext}</span>`;
            html += `</label>`;
          }
          html += `</div>`;
        };

        renderGroup('📕 文档', DOC_TYPES.documents, '#e74c3c');
        renderGroup('🖼 图片', DOC_TYPES.images, '#3498db');
        renderGroup('📝 文本', DOC_TYPES.text, '#2ecc71');
        renderGroup('🎵 音频', DOC_TYPES.audio, '#9b59b6');
        renderGroup('📎 其他', DOC_TYPES.other, '#f39c12');

        // 快速操作
        html += `<div style="display:flex;gap:6px;margin-top:4px;">`;
        html += `<button id="__doc_select_all__" style="background:#3498db;color:#fff;border:none;padding:3px 10px;border-radius:4px;font-size:11px;cursor:pointer;">全选</button>`;
        html += `<button id="__doc_select_none__" style="background:#7f8c8d;color:#fff;border:none;padding:3px 10px;border-radius:4px;font-size:11px;cursor:pointer;">清空</button>`;
        html += `</div>`;
        html += `</div>`;
      }

      html += `<button id="__batch_doc_btn__" style="
        background:${docBtnColor};color:#fff;border:none;padding:6px 12px;
        border-radius:5px;font-size:13px;font-weight:bold;cursor:pointer;width:100%;
      ">${docBtnText}</button>`;

      // 文档下载进度
      if (isDocDownloading || isDocDone) {
        html += `<div style="margin-top:4px;">`;
        html += `<div style="font-size:11px;opacity:0.85;">`;
        html += `✅${STATE.docsDone} ❌${STATE.docsFailed} ⏳${docRemaining} 📊${docProgress}%`;
        html += `</div>`;
        if (STATE.docsCurrentName) {
          html += `<div style="font-size:10px;opacity:0.5;margin-top:2px;">📥 ${esc(STATE.docsCurrentName)}</div>`;
        }
        html += `<div style="margin-top:2px;height:4px;background:rgba(255,255,255,0.15);border-radius:2px;">`;
        html += `<div style="height:100%;width:${docProgress}%;background:#e67e22;border-radius:2px;transition:width 0.3s;"></div>`;
        html += `</div>`;
        html += `</div>`;
      }

      // 文档失败列表
      if (STATE.docsFailList.length > 0 && !isDocDownloading) {
        html += `<div style="margin-top:4px;font-size:11px;opacity:0.75;max-height:80px;overflow-y:auto;">`;
        html += `<div style="color:#e74c3c;">失败 (${STATE.docsFailList.length})：</div>`;
        for (const f of STATE.docsFailList.slice(-8)) {
          html += `<div style="padding-left:6px;">  ❌ ${esc(f)}</div>`;
        }
        html += `</div>`;
      }
      html += `</div>`; // end 文档下载区域
      }

      // ===== 扫描统计 =====
      const stats = STATE.scanStats;
      html += `<div style="margin-top:6px;border-top:1px solid rgba(255,255,255,0.2);padding-top:5px;">`;
      html += `<div style="font-weight:bold;margin-bottom:2px;">📊 扫描统计</div>`;
      html += `<div style="font-size:11px;opacity:0.85;">`;
      html += `📁目录 <b>${stats.totalDirs}</b> 📄文件 <b>${stats.totalFiles}</b> 🎬视频 <b style="color:#2ea0a3;">${stats.totalVideos}</b> 📄文档 <b style="color:#e67e22;">${docTotal}</b>`;
      html += `</div>`;
      if (stats.failedDirs.length > 0) {
        html += `<div style="font-size:11px;color:#e74c3c;margin-top:2px;">⚠️ ${stats.failedDirs.length} 个目录扫描失败</div>`;
      }
      html += `<div style="margin-top:3px;">`;
      html += `<button id="__batch_toggle_details__" style="
        background:rgba(255,255,255,0.15);color:#fff;border:1px solid rgba(255,255,255,0.3);
        padding:3px 10px;border-radius:4px;font-size:11px;cursor:pointer;
      ">${STATE.showDetails ? '隐藏' : '显示'}详细信息</button>`;
      html += `</div>`;
      if (STATE.showDetails) html += renderDetailsHtml();
      html += `</div>`;

      html += `</div>`;
    }

    if (!hasScanned && !STATE.scanning) {
      html += `<div style="margin-top:4px;font-size:11px;opacity:0.45;">点击"扫描目录"分析所有子文件夹</div>`;
    }

    if (queue && STATE.scanStats.totalDirs) html += `<section class="pd-archive"><button id="__batch_pack_archive__" ${packing || STATE.scanning || STATE.activeTabs.length ? 'disabled' : ''}>${packing ? '正在准备打包…' : '打包 ZIP · Markdown 与报告'}</button><p class="pd-muted">本轮结束会自动打包。暂停并等待当前任务收尾后，也可打包阶段成果；未处理项会列入报告。</p></section>`;
    html += `<p class="pd-muted">文字先缓存在浏览器，最后按网盘目录生成 MD 并保存 ZIP；不逐篇下载。暂停后已打开的任务会继续收尾。</p>`;
    html += `<div class="pd-version">页面脚本 4.2.2 · 文稿优先 · 字幕补提 · 统一 ZIP</div>`;

    panelInner.innerHTML = html;
    panelInner.scrollTop = previousScroll;

    // ===== 绑定事件 =====
    panelEl.querySelector('#__batch_pack_archive__')?.addEventListener('click', packCurrentArchive);
    const scanBtn = panelEl.querySelector('#__batch_scan_btn__');
    if (scanBtn) scanBtn.addEventListener('click', () => {
      // 扫描前先根据当前选中类型重新收集文件
      doScan();
    });

    const videoBtn = panelEl.querySelector('#__batch_video_btn__');
    if (videoBtn) videoBtn.addEventListener('click', window.__toggleVideoExport);

    const docBtn = panelEl.querySelector('#__batch_doc_btn__');
    if (docBtn) docBtn.addEventListener('click', startDocDownload);

    // 并发加减按钮（实时生效）
    const concVal = panelEl.querySelector('#__batch_conc_val__');
    const concDec = panelEl.querySelector('#__batch_conc_dec__');
    const concInc = panelEl.querySelector('#__batch_conc_inc__');

    if (concDec && concInc && concVal) {
      concDec.addEventListener('click', () => {
        if (STATE.userConcurrency > 1) {
          STATE.userConcurrency--;
          STATE.maxConcurrent = STATE.userConcurrency;
          persistCheckpoint();
          renderPanel();
          // 正在运行时立即触发调度
          if (STATE.enabled && !STATE.paused) {
            for (let i = 0; i < STATE.userConcurrency; i++) scheduleNext();
          }
        }
      });
      concInc.addEventListener('click', () => {
        if (STATE.userConcurrency < 10) {
          STATE.userConcurrency++;
          STATE.maxConcurrent = STATE.userConcurrency;
          persistCheckpoint();
          renderPanel();
          // 正在运行时立即触发调度
          if (STATE.enabled && !STATE.paused) {
            for (let i = 0; i < STATE.userConcurrency; i++) scheduleNext();
          }
        }
      });
    }
    STATE.maxConcurrent = STATE.userConcurrency;

    const detailBtn = panelEl.querySelector('#__batch_toggle_details__');
    if (detailBtn) {
      detailBtn.addEventListener('click', () => {
        STATE.showDetails = !STATE.showDetails;
        renderPanel();
      });
    }

    const retryBtn = panelEl.querySelector('#__batch_retry_failed__');
    if (retryBtn) retryBtn.addEventListener('click', retryFailedVideos);
    const retrySkippedBtn = panelEl.querySelector('#__batch_retry_skipped__');
    if (retrySkippedBtn) retrySkippedBtn.addEventListener('click', () => beginRun('skipped'));
    const attention = panelEl.querySelector('#__batch_attention__');
    if (attention) attention.addEventListener('toggle', () => { if (attention.isConnected) STATE.showFailed = attention.open; });
    const cached = panelEl.querySelector('#__batch_cached__');
    if (cached) cached.addEventListener('toggle', () => { if (cached.isConnected) STATE.showCached = cached.open; });
    const manuscriptStats = panelEl.querySelector('#__batch_manuscript_stats__');
    if (manuscriptStats) manuscriptStats.addEventListener('toggle', () => { if (manuscriptStats.isConnected) STATE.showManuscriptStats = manuscriptStats.open; });
    panelEl.querySelectorAll('button[data-problem-filter]').forEach(button => button.addEventListener('click', () => {
      STATE.problemFilter = button.dataset.problemFilter;
      STATE.showFailed = true;
      renderPanel();
    }));

    // 文档类型选择
    const toggleDocTypesBtn = panelEl.querySelector('#__batch_toggle_doc_types__');
    if (toggleDocTypesBtn) {
      toggleDocTypesBtn.addEventListener('click', () => {
        STATE.showDocTypes = !STATE.showDocTypes;
        renderPanel();
      });
    }

    // 文件类型复选框
    panelEl.querySelectorAll('input[data-ext]').forEach(cb => {
      cb.addEventListener('change', () => {
        if (STATE.docMode === 'downloading') return;
        const ext = cb.dataset.ext;
        if (cb.checked) {
          STATE.selectedDocTypes.add(ext);
        } else {
          STATE.selectedDocTypes.delete(ext);
        }
        // 重新收集文件
        reCollectDocs();
        renderPanel();
      });
    });

    // 折叠按钮
    const collapseBtn = panelEl.querySelector('#__batch_toggle_collapse__');
    if (collapseBtn) {
      collapseBtn.addEventListener('click', () => {
        STATE.collapsed = !STATE.collapsed;
        updatePanel();
      });
    }

    const selectAllBtn = panelEl.querySelector('#__doc_select_all__');
    if (selectAllBtn) {
      selectAllBtn.addEventListener('click', () => {
        ALL_DOC_EXTS.forEach(e => STATE.selectedDocTypes.add(e));
        reCollectDocs();
        renderPanel();
      });
    }

    const selectNoneBtn = panelEl.querySelector('#__doc_select_none__');
    if (selectNoneBtn) {
      selectNoneBtn.addEventListener('click', () => {
        STATE.selectedDocTypes.clear();
        reCollectDocs();
        renderPanel();
      });
    }
    if (focusedId) panelEl.querySelector('#' + focusedId)?.focus({preventScroll:true});
  }

  // ========== 根据当前选中类型重新收集文档 ==========
  function reCollectDocs() {
    if (STATE.docMode === 'downloading') return;
    const previous = new Map(STATE.docs.map(doc=>[String(doc.fs_id) + ':' + doc.path,doc]));
    // 从已扫描的 nonVideoFiles 中按扩展名重新筛选
    const newDocs = [];
    for (const f of STATE.scanStats.nonVideoFiles) {
      if (STATE.selectedDocTypes.has(f.ext)) {
        const old = previous.get(String(f.fs_id) + ':' + f.path);
        newDocs.push({
          name: f.name,
          path: f.path,
          fs_id: f.fs_id,
          relPath: f.dir === '(根目录)' ? '' : f.dir,
          size: f.size || 0,
          status: old && old.size === (f.size || 0) && old.mtime === f.mtime ? old.status : 'pending',
          mtime: f.mtime,
          ext: f.ext,
        });
      }
    }
    STATE.docs = newDocs;
    STATE.docsTotal = newDocs.length;
    STATE.docsDone = newDocs.filter(d=>d.status==='done').length;
    STATE.docsFailed = newDocs.filter(d=>d.status==='failed').length;
    STATE.docsFailList = newDocs.filter(d=>d.status==='failed').map(d=>(d.relPath ? d.relPath + '/' : '') + d.name);
    STATE.docMode = 'idle';
    log(`已按所选类型筛选文档: ${newDocs.length} 个文件`);
  }

  function renderResultSummaryHtml() {
    const result = PDResultStats.summarize(STATE.videos);
    return `<section class="pd-result-summary" aria-label="文字提取结果"><p class="pd-equation">${result.total} 个视频 = ${result.obtained} 已缓存 + ${result.missing} 尚未取得</p><div class="pd-result-grid"><div class="pd-result-card pd-result-success"><span>已缓存文字</span><strong>${result.obtained}</strong><small>等待统一打包成 MD</small></div><div class="pd-result-card pd-result-missing"><span>尚未取得</span><strong>${result.missing}</strong><small>包含失败、跳过和未完成</small></div></div><div class="pd-result-sources"><span>网页文稿 <strong>${result.manuscript}</strong></span><span>字幕补提 <strong>${result.subtitle}</strong></span>${result.sourceUnknown ? `<span>旧记录来源未标明 <strong>${result.sourceUnknown}</strong></span>` : ''}</div><p class="pd-result-breakdown">尚未取得：失败 ${result.failed} · 跳过 ${result.skipped} · 处理中 ${result.active} · 待处理 ${result.pending}</p><p class="pd-muted">以上为队列缓存记录；ZIP 打包时会核验实际内容，最终份数以打包页为准。</p></section>`;
  }

  function renderFormatStatsHtml() {
    const outcomes = PDResultStats.byFormat(STATE.videos);
    const hasUnknownSource = outcomes.some(row => row.sourceUnknown);
    let html = '<section class="pd-format-stats"><h3>按格式看提取结果</h3><div class="pd-table-scroll"><table><thead><tr><th>格式</th><th>总数</th><th>网页<br>文稿</th><th>字幕<br>补提</th>' + (hasUnknownSource ? '<th>来源<br>未标明</th>' : '') + '<th>尚未<br>取得</th></tr></thead><tbody>';
    html += outcomes.map(row => '<tr><th scope="row">' + esc(row.format.toUpperCase()) + '</th><td>' + row.total + '</td><td>' + row.manuscript + '</td><td>' + row.subtitle + '</td>' + (hasUnknownSource ? '<td>' + row.sourceUnknown + '</td>' : '') + '<td>' + row.missing + '</td></tr>').join('');
    html += '</tbody></table></div><p class="pd-muted">网页文稿 + 字幕补提' + (hasUnknownSource ? ' + 来源未标明' : '') + ' = 已缓存文字。没有文稿，也可能已通过字幕取得文字。</p>';
    if (!globalThis.PDFormatStats) return html + '</section>';
    const rows = PDFormatStats.summarize(STATE.videos);
    html += '<details id="__batch_manuscript_stats__" class="pd-disclosure"' + (STATE.showManuscriptStats ? ' open' : '') + '><summary>仅看网页文稿：检出率与检测记录</summary><p class="pd-muted">这张表只回答“有没有读到网页文稿”，不是最终提取成败。</p><div class="pd-table-scroll"><table><thead><tr><th>格式</th><th>总数</th><th>检出</th><th>未检出</th><th>未知</th><th>检出率</th></tr></thead><tbody>' + rows.map(row =>
      '<tr><th scope="row">' + esc(row.format.toUpperCase()) + '</th><td>' + row.total + '</td><td>' + row.present + '</td><td>' + row.notDetected + '</td><td>' + row.unknown + '</td><td>' + (row.rate === null ? '暂无样本' : (row.rate * 100).toFixed(1) + '%') + '</td></tr>'
    ).join('') + '</tbody></table></div><p class="pd-muted">未检出：本次有限等待内没读到正文，不证明永久没有。未知：没有有效检测记录，不等于提取失败，部分文件可能已有字幕。</p><p class="pd-muted">检出率 = 检出正文 ÷（检出 + 检查后未检出）。未知不进分母；字幕不算文稿。仅反映本目录当前记录，不代表平台概率。</p></details></section>';
    return html;
  }

  // ========== 渲染详细诊断信息 ==========
  function renderDetailsHtml() {
    const stats = STATE.scanStats;
    let html = '<div style="margin-top:8px;font-size:11px;opacity:0.85;max-height:300px;overflow-y:auto;border:1px solid rgba(255,255,255,0.15);padding:8px;border-radius:4px;">';

    if (stats.failedDirs.length > 0) {
      html += '<div style="color:#e74c3c;font-weight:bold;margin-bottom:4px;">⚠️ 扫描失败的目录：</div>';
      for (const fd of stats.failedDirs) {
        html += `<div style="color:#e74c3c;">  ❌ ${esc(fd.path)} (尝试${fd.retries}次: ${esc(fd.error)})</div>`;
      }
      html += '<hr style="border-color:rgba(255,255,255,0.15);margin:6px 0;">';
    }

    html += '<div style="font-weight:bold;margin-bottom:4px;">📁 各目录详情：</div>';
    for (const dir of stats.dirDetails) {
      const shortPath = dir.path.length > 60 ? '...' + dir.path.substring(dir.path.length - 57) : dir.path;
      html += `<div style="margin-bottom:3px;">`;
      html += `<div style="color:#aaa;">📂 ${esc(shortPath)}</div>`;
      html += `<div style="padding-left:12px;">总文件: ${dir.totalFiles}, 视频: <span style="color:#2ea0a3;">${dir.videos}</span>, 非视频: <span style="color:#f39c12;">${dir.nonVideos}</span></div>`;
      if (dir.nonVideoNames.length > 0) {
        html += '<div style="padding-left:12px;font-size:10px;opacity:0.7;">非视频文件：</div>';
        for (const nv of dir.nonVideoNames) {
          html += `<div style="padding-left:24px;font-size:10px;opacity:0.6;">📎 ${esc(nv)}</div>`;
        }
      }
      html += `</div>`;
    }

    if (stats.nonVideoFiles.length > 0) {
      html += '<hr style="border-color:rgba(255,255,255,0.15);margin:6px 0;">';
      html += `<div style="font-weight:bold;margin-bottom:4px;">📎 全部非视频文件 (${stats.nonVideoFiles.length})：</div>`;
      const extMap = Object.create(null);
      for (const nvf of stats.nonVideoFiles) {
        const ext = nvf.ext || '(无扩展名)';
        if (!extMap[ext]) extMap[ext] = [];
        extMap[ext].push(nvf);
      }
      for (const ext of Object.keys(extMap).sort()) {
        const list = extMap[ext];
        const isSelected = STATE.selectedDocTypes.has(ext);
        html += `<div style="margin-bottom:3px;"><b style="color:${isSelected ? '#e67e22' : '#f39c12'};">.${esc(ext)}</b> (${list.length}个)${isSelected ? ' ✅' : ''}</div>`;
        for (const nvf of list.slice(0, 3)) {
          const shortDir = nvf.dir.length > 40 ? '...' + nvf.dir.substring(nvf.dir.length - 37) : nvf.dir;
          html += `<div style="padding-left:12px;font-size:10px;opacity:0.6;">${esc(nvf.name)} <span style="opacity:0.5;">@ ${esc(shortDir)}</span></div>`;
        }
        if (list.length > 3) {
          html += `<div style="padding-left:12px;font-size:10px;opacity:0.4;">... 还有 ${list.length - 3} 个</div>`;
        }
      }
    }

    html += '</div>';
    return html;
  }

  function updatePanel() {
    if (panelEl) renderPanel();
  }

  // Result list uses escaped text, including remote file names and error messages.
  function renderFailedHtml() {
    const problems = STATE.videos.filter(v => ['failed','skipped'].includes(v.status));
    if (!problems.length) return '<p class="pd-muted pd-problems-empty">当前没有失败或跳过的文件。</p>';
    const failed = problems.filter(v => v.status === 'failed').length;
    const skipped = problems.length - failed;
    const filter = ['failed','skipped'].includes(STATE.problemFilter) ? STATE.problemFilter : 'all';
    const visible = problems.filter(v => filter === 'all' || v.status === filter);
    let html = '<section class="pd-problems"><h3>待处理的问题 (' + problems.length + ')</h3><p class="pd-muted">这些文件尚未取得文字。已缓存、全文待核对的文件列在下方。</p><div class="pd-filter-buttons" aria-label="查看问题文件">';
    for (const [value,label,count] of [['all','查看全部',problems.length],['failed','查看失败',failed],['skipped','查看跳过',skipped]]) {
      html += `<button id="__batch_filter_${value}__" data-problem-filter="${value}" aria-pressed="${filter === value}">${label} (${count})</button>`;
    }
    html += '</div><details id="__batch_attention__" class="pd-disclosure"' + (STATE.showFailed ? ' open' : '') + '><summary>文件位置与原因 (' + visible.length + ')</summary><div class="pd-task-list">';
    for (const v of visible) html += `<div class="pd-task-row" data-status="${v.status}"><strong>${v.status === 'skipped' ? '跳过' : '失败'}</strong><span class="pd-file-name">${esc(v.name)}</span><div class="pd-full-path">${esc(fullVideoPath(v))}</div><div class="pd-muted">${esc(v.reason || '未记录具体原因')}</div></div>`;
    if (!visible.length) html += '<p class="pd-muted">此分类目前没有文件。</p>';
    html += '</div></details><div class="pd-retry-buttons">';
    if (failed) html += `<button id="__batch_retry_failed__">重试失败 (${failed})</button>`;
    if (skipped) html += `<button id="__batch_retry_skipped__">重试已跳过 · 尝试字幕 (${skipped})</button>`;
    html += '</div></section>';
    return html;
  }

  function fullVideoPath(video) {
    if (video.path) return video.path;
    return [STATE.rootDir.replace(/\/$/, ''), video.relPath || '', video.name || ''].filter(Boolean).join('/');
  }

  function renderCachedHtml() {
    const cached = STATE.videos.filter(v => ['saved','review'].includes(v.status));
    if (!cached.length) return '';
    let html = '<details id="__batch_cached__" class="pd-disclosure"' + (STATE.showCached ? ' open' : '') + '><summary>已缓存文字清单 (' + cached.length + ')</summary><p class="pd-muted">已取得文字，不是提取失败。全文完整性仍需核对；是否实际收入 ZIP，以打包页核验为准。</p><div class="pd-task-list">';
    for (const v of cached) {
      const source = v.source === 'manuscript' ? '网页文稿' : v.source === 'subtitle' ? '字幕补提' : '旧记录：来源未标明';
      html += `<div class="pd-task-row" data-status="cached"><strong>${source}</strong><span class="pd-file-name">${esc(v.name)}</span><div class="pd-full-path">${esc(fullVideoPath(v))}</div><div class="pd-muted">${v.status === 'review' ? '全文待核对' : '已缓存'}${v.reason ? ' · ' + esc(v.reason) : ''}</div></div>`;
    }
    return html + '</div></details>';
  }

  function send(message) {
    return new Promise(resolve => chrome.runtime.sendMessage(message, response => {
      const error = chrome.runtime.lastError;
      resolve(error ? {ok:false,error:error.message} : (response || {ok:false,error:'扩展未响应'}));
    }));
  }
  function storageGet(key) {
    return new Promise(resolve => chrome.storage.local.get(key, result => resolve(chrome.runtime.lastError ? {} : result)));
  }
  const checkpointKey = root => 'pandownload.queue.v1.' + encodeURIComponent(root);
  function syncQueue() {
    if (!queue) return;
    STATE.videos = queue.videos;
    const counts = queue.counts();
    STATE.totalDone = counts.saved;
    STATE.totalReview = counts.review;
    STATE.totalFailed = counts.failed;
    STATE.totalSkip = counts.skipped;
    STATE.activeTabs = queue.active().map(v => ({...v,videoIndex:STATE.videos.indexOf(v)}));
  }
  function persistCheckpoint() {
    if (!queue) return Promise.resolve(true);
    const key = checkpointKey(queue.rootDir);
    const snapshot = {version:1,queue:queue.snapshot(),scanStats:STATE.scanStats,docs:STATE.docs,
      selectedDocTypes:Array.from(STATE.selectedDocTypes),userConcurrency:STATE.userConcurrency,updatedAt:Date.now()};
    // Clone now so later queue edits cannot change a write already waiting in the chain.
    const value = JSON.parse(JSON.stringify(snapshot));
    const write = () => new Promise(resolve => chrome.storage.local.set({[key]:value}, () => {
      const error = chrome.runtime.lastError;
      if (error) { STATE.paused = true; log('进度保存失败，已暂停新任务：' + error.message); }
      resolve(!error);
    }));
    saveChain = saveChain.then(write,write);
    return saveChain;
  }
  async function restoreCheckpoint(rootDir, duringScan = false) {
    if (STATE.enabled || queue?.active().length || (STATE.scanning && !duringScan) || STATE.docMode === 'downloading') return false;
    const key = checkpointKey(rootDir);
    const saved = (await storageGet(key))[key];
    if (!saved || saved.version !== 1 || saved.queue?.rootDir !== rootDir || !Array.isArray(saved.queue.videos)) return false;
    queue = new Core.Queue(saved.queue);
    STATE.rootDir = rootDir;
    STATE.scanStats = saved.scanStats || STATE.scanStats;
    STATE.docs = saved.docs || [];
    STATE.selectedDocTypes = new Set(saved.selectedDocTypes || DEFAULT_SELECTED);
    STATE.userConcurrency = Math.min(10,Math.max(1,Number(saved.userConcurrency) || 2));
    STATE.docsDone = STATE.docs.filter(d => d.status === 'done').length;
    STATE.docsFailed = STATE.docs.filter(d => d.status === 'failed').length;
    STATE.docsTotal = STATE.docs.length;
    STATE.paused = true;
    STATE.enabled = false;
    ownsBatch = false;
    syncQueue();
    log('已恢复本地进度。点击“继续导出”后核对活动任务，再处理未完成文件。');
    return true;
  }
  async function claimAndReconcile() {
    if (!queue) return false;
    await saveChain;
    const hadOwnership = ownsBatch;
    let queriedIds = queue.active().map(v=>v.tabId).filter(Number.isInteger);
    let response = await send({action:'checkTabs',batchId:queue.batchId,rootDir:queue.rootDir,tabIds:queriedIds,claim:true});
    if (response.batchBusy) { STATE.paused = true; ownsBatch = false; log('此目录已在另一个标签页处理中，请回到原任务面板操作。'); return false; }
    if (response.ok === false) { STATE.paused = true; log('无法核对任务：' + (response.error || '扩展未响应')); return false; }
    ownsBatch = true;
    if (!hadOwnership) {
      // Another directory tab may have completed this checkpoint while this
      // panel was merely viewing it. Read its latest state after taking the lock.
      const key = checkpointKey(queue.rootDir);
      const saved = (await storageGet(key))[key];
      if (saved?.version === 1 && saved.queue?.rootDir === queue.rootDir && Array.isArray(saved.queue.videos)) {
        const oldBatchId = queue.batchId;
        queue = new Core.Queue(saved.queue);
        STATE.scanStats = saved.scanStats || STATE.scanStats;
        if (STATE.docMode !== 'downloading') {
          STATE.docs = saved.docs || STATE.docs;
          STATE.docsDone = STATE.docs.filter(d=>d.status==='done').length;
          STATE.docsFailed = STATE.docs.filter(d=>d.status==='failed').length;
          STATE.docsTotal = STATE.docs.length;
        }
        if (queue.batchId !== oldBatchId) {
          queriedIds = queue.active().map(v=>v.tabId).filter(Number.isInteger);
          response = await send({action:'checkTabs',batchId:queue.batchId,rootDir:queue.rootDir,tabIds:queriedIds,claim:true});
          if (response.ok === false || response.batchBusy) { ownsBatch = false; STATE.paused = true; log('任务归属已变化，请重新继续。'); return false; }
        }
      }
    }
    reconcile(response, !hadOwnership, queriedIds);
    return true;
  }
  function reconcile(response, restored = false, queriedIds = []) {
    if (!queue) return;
    for (const result of response.results || []) queue.applyResult(result);
    const jobs = response.jobs || [];
    for (const job of jobs) {
      if (job.result) queue.applyResult(job.result);
      else if (Number.isInteger(job.tabId)) queue.markOpened(job,job.tabId);
    }
    // At restore, missing reservations are safe to fail only after the background
    // has checked the batch and returned its complete set of surviving jobs.
    const alive = response.aliveTabIds || [];
    queue.markMissing(restored ? queue.active().map(v=>v.tabId).filter(Number.isInteger) : queriedIds, alive);
    if (restored) for (const v of queue.active()) if (!Number.isInteger(v.tabId)) {
      queue.applyResult({...v,batchId:queue.batchId,status:'failed',reason:'上次启动被中断，未找到活动播放页，可重试此文件'});
    }
    syncQueue();
  }
  async function beginRun(retryFailed) {
    if (!queue || claiming || finishing || STATE.scanning) return;
    if (getCurrentDirPath() !== queue.rootDir) { log('请返回任务目录继续导出：' + queue.rootDir); return; }
    if (!STATE.extensionEnabled || !STATE.batchEnabled) { log('请先在扩展弹窗开启导出和批量面板。'); return; }
    claiming = true;
    try {
      if (!await claimAndReconcile()) return;
      if (retryFailed === 'skipped') queue.retrySkipped();
      else if (retryFailed) queue.retryFailed();
      STATE.enabled = true;
      STATE.paused = false;
      syncQueue();
      await persistCheckpoint();
      log(retryFailed === 'skipped' ? '已将跳过任务加入重试；没有文稿时尝试播放器字幕。' : retryFailed ? '已将失败任务加入重试；已缓存和待核对文件保留。' : '开始处理尚未导出的文件。');
      scheduleNext();
      startPolling();
    } finally { claiming = false; }
  }
  function retryFailedVideos() {
    if (STATE.scanning) return;
    return beginRun(true);
  }
  function receiveResult(message) {
    if (!queue || !queue.applyResult(message)) return;
    syncQueue();
    persistCheckpoint();
    log(message.status === 'skipped' ? '本项尚未取得文字，已跳过；文件位置与原因见“待处理的问题”。' : message.status === 'failed' ? '有文件提取失败，文件位置与原因见“待处理的问题”。' : message.status === 'review' ? '文字已缓存，全文完整性仍需核对；可在“已缓存文字清单”查看。' : '文字已缓存，等待统一打包。');
    scheduleNext();
  }
  chrome.runtime.onMessage.addListener(message => {
    if (message.action === 'batchTaskResult') receiveResult(message);
  });
  async function openReserved(job) {
    const url = `https://pan.baidu.com/pfile/video?path=${encodeURIComponent(job.path)}&fid=${encodeURIComponent(job.fs_id)}&relPath=${encodeURIComponent(job.relPath || '')}`;
    const response = await send({action:'openVideoTab',url,taskId:job.taskId,batchId:job.batchId,attempt:job.attempt,rootDir:queue.rootDir,size:job.size,mtime:job.mtime});
    if (queue?.batchId !== job.batchId) return;
    if (response.ok && Number.isInteger(response.tabId)) queue.markOpened(job,response.tabId);
    else queue.applyResult({...job,status:'failed',reason:'播放页打开失败：' + (response.error || '没有返回标签页')});
    syncQueue();
    await persistCheckpoint();
    updatePanel();
    scheduleNext();
  }
  function scheduleNext() {
    if (!queue || !ownsBatch || !STATE.enabled || STATE.paused || !STATE.extensionEnabled || !STATE.batchEnabled) return;
    const jobs = queue.reserve(STATE.userConcurrency);
    syncQueue();
    updatePanel();
    if (!jobs.length) { finishIfDone(); return; }
    // reserve() is synchronous: all event handlers see occupied slots immediately.
    persistCheckpoint().then(saved => {
      if (!saved) {
        for (const job of jobs) queue.applyResult({...job,status:'failed',reason:'进度保存失败，播放页未打开'});
        syncQueue(); return;
      }
      if (STATE.paused || !STATE.extensionEnabled || !STATE.batchEnabled || !STATE.enabled) {
        for (const job of jobs) queue.cancelReservation(job);
        syncQueue(); persistCheckpoint(); updatePanel(); return;
      }
      for (const job of jobs) openReserved(job);
    });
  }
  async function finishIfDone() {
    if (!queue || finishing || !STATE.enabled || queue.active().length || queue.counts().pending) return;
    finishing = true;
    STATE.enabled = false;
    STATE.paused = false;
    stopPolling();
    log(`本轮处理结束：已缓存文字 ${STATE.totalDone + STATE.totalReview}，尚未取得 ${STATE.totalSkip + STATE.totalFailed}（失败 ${STATE.totalFailed}、跳过 ${STATE.totalSkip}）。正在准备 ZIP。`);
    try {
      await persistCheckpoint();
      await send({action:'releaseBatch',batchId:queue.batchId,rootDir:queue.rootDir});
      ownsBatch = false;
      const packed = await send({action:'prepareArchive',batchId:queue.batchId,rootDir:queue.rootDir,auto:true});
      if (!packed.ok) log('任务已结束，自动打包未能打开：'+(packed.error||'请点击打包按钮重试'));
    } finally { finishing = false; }
  }
  async function packCurrentArchive() {
    if (!queue || packing || STATE.scanning || queue.active().length) { log('请先暂停，并等已打开的任务收尾后再打包。'); return; }
    packing = true;updatePanel();
    try {
      if (ownsBatch && !await persistCheckpoint()) return;
      await saveChain;
      const response=await send({action:'prepareArchive',rootDir:queue.rootDir,batchId:queue.batchId,auto:false});
      log(response.ok?'已打开 ZIP 打包页，请保持打包页打开，直到显示保存完成。':'无法准备压缩包：'+(response.error||'请重试'));
    } catch(error) {log('打包失败：'+error.message);}
    finally {packing=false;updatePanel();}
  }
  async function pollOnce() {
    if (!queue || polling || !ownsBatch) return;
    polling = true;
    const current = queue;
    const ids = current.active().map(v=>v.tabId).filter(Number.isInteger);
    try {
      const response = await send({action:'checkTabs',batchId:current.batchId,rootDir:current.rootDir,tabIds:ids});
      if (queue !== current) return;
      if (response.ok === false || response.batchBusy) {
        STATE.paused = true;
        if (response.batchBusy) ownsBatch = false;
        log('任务状态暂时无法核对，已暂停新任务。'); return;
      }
      reconcile(response,false,ids);
      await persistCheckpoint();
      scheduleNext();
      finishIfDone();
      updatePanel();
    } finally { polling = false; }
  }
  function startPolling() {
    if (!STATE.pollTimer) STATE.pollTimer = setInterval(pollOnce,2000);
  }
  function stopPolling() {
    if (STATE.pollTimer) clearInterval(STATE.pollTimer);
    STATE.pollTimer = null;
  }

  // Document download completion follows Chrome's actual download state.
  async function triggerDocDownload(fs_id, filename) {
    const response = await send({action:'downloadPDF',fs_id,filename});
    if (!response.ok || !Number.isInteger(response.downloadId)) return false;
    const startedAt = Date.now();
    while (Date.now() - startedAt < 30 * 60 * 1000) {
      const status = await send({action:'getDownloadStatus',downloadId:response.downloadId});
      if (status.state === 'complete') return true;
      if (!status.ok || ['interrupted','missing'].includes(status.state)) return false;
      await new Promise(resolve=>setTimeout(resolve,1000));
    }
    log('下载等待超过 30 分钟，请在浏览器下载列表核对后再重试。');
    return false;
  }
  async function startDocDownload() {
    if (STATE.docMode === 'downloading' || STATE.scanning) return;
    if (!STATE.pdfEnabled || !STATE.extensionEnabled || !STATE.batchEnabled) { log('文档下载已关闭，请先在扩展弹窗开启。'); return; }
    if (queue && getCurrentDirPath() !== queue.rootDir) { log('请返回任务目录下载文档：' + queue.rootDir); return; }
    if (STATE.scanStats.totalDirs === 0) await doScan();
    if (!STATE.docs.length) { log('没有可下载的文档，请先扫描或选择文件类型。'); return; }
    STATE.docMode = 'downloading';
    STATE.docsFailList = [];
    for (const doc of STATE.docs) {
      if (!STATE.pdfEnabled || !STATE.extensionEnabled || !STATE.batchEnabled) break;
      if (doc.status === 'done') continue;
      const displayName = (doc.relPath ? doc.relPath + '/' : '') + doc.name;
      STATE.docsCurrentName = displayName;
      updatePanel();
      const ok = await triggerDocDownload(doc.fs_id,displayName);
      doc.status = ok ? 'done' : 'failed';
      if (!ok) STATE.docsFailList.push(displayName);
      STATE.docsDone = STATE.docs.filter(d=>d.status==='done').length;
      STATE.docsFailed = STATE.docs.filter(d=>d.status==='failed').length;
      await persistCheckpoint();
    }
    STATE.docMode = STATE.docs.some(d=>d.status==='pending') ? 'idle' : 'done'; STATE.docsCurrentName = '';
    log(`文档下载${STATE.docMode === 'idle' ? '已暂停' : '结束'}：完成 ${STATE.docsDone}，失败或未确认 ${STATE.docsFailed}。`);
  }
  function getCurrentDirPath() { return Core.getDirPath(window.location.hash); }
  function listDir(dirPath) { return Core.listDir(dirPath,fetch); }
  async function scanAllVideos(rootPath) {
    const videos = [], stats = {totalDirs:0,totalFiles:0,totalVideos:0,totalNonVideos:0,failedDirs:[],nonVideoFiles:[],dirDetails:[]};
    STATE.scanStats = stats;
    await Core.scanTree(rootPath,listDir,{concurrency:3,onDirectory(result) {
      const dir = {path:result.path,totalFiles:result.files.length,videos:0,nonVideos:0,nonVideoNames:[]};
      stats.totalDirs++;
      if (result.error) stats.failedDirs.push({path:result.path,error:result.error,retries:3});
      else {
        const relPath = result.path === rootPath ? '' : result.path.slice(rootPath === '/' ? 1 : rootPath.length + 1);
        for (const file of result.files) {
          stats.totalFiles++;
          if (isVideoFile(file.name)) { videos.push({...file,relPath,status:'pending'});stats.totalVideos++;dir.videos++; }
          else { stats.nonVideoFiles.push({...file,dir:relPath || '(根目录)',ext:getExt(file.name)});stats.totalNonVideos++;dir.nonVideos++;dir.nonVideoNames.push(file.name); }
        }
      }
      stats.dirDetails.push(dir);
      STATE.scanProgress = `已扫描 ${stats.totalDirs} 个目录 · ${stats.totalVideos} 个视频`;
      updatePanel();
    }});
    return videos.sort((a,b)=>(a.relPath+'/'+a.name).localeCompare(b.relPath+'/'+b.name,'zh-CN'));
  }
  async function doScan() {
    if (finishing || STATE.scanning || STATE.enabled || queue?.active().length || STATE.docMode === 'downloading') {
      log('仍有运行或暂停中的任务，请等本轮任务结束后重新扫描。'); return;
    }
    STATE.scanning = true; // Reserve the scan before the first asynchronous read.
    let scanQueue = null;
    let previousStats = STATE.scanStats;
    try {
      const currentDir = getCurrentDirPath();
      if (!queue || queue.rootDir !== currentDir) await restoreCheckpoint(currentDir,true);
      if (queue?.active().length) { log('已恢复未完成任务，请先继续处理并核对状态。'); return; }
      if (!queue || queue.rootDir !== currentDir) {
        queue = new Core.Queue({rootDir:currentDir,batchId:'batch-' + Date.now() + '-' + Math.random().toString(36).slice(2),videos:[]});
        STATE.docs = [];
      }
      if (!await claimAndReconcile()) return;
      scanQueue = queue;
      STATE.rootDir = currentDir;
      previousStats = STATE.scanStats;
      log('正在扫描目录，尚未启动导出。');
      const videos = await scanAllVideos(currentDir);
      // Keep earlier entries from failed subtrees; never call a partial scan complete.
      const failedPaths = STATE.scanStats.failedDirs.map(d=>d.path);
      const inFailedDir = path => failedPaths.some(p=>String(path).startsWith(p === '/' ? '/' : p + '/'));
      const retained = queue.videos.filter(v=>inFailedDir(v.path));
      for (const file of previousStats.nonVideoFiles || []) if (inFailedDir(file.path)) STATE.scanStats.nonVideoFiles.push(file);
      queue.mergeScan([...videos,...retained]);
      syncQueue();
      reCollectDocs();
      STATE.docMode = 'idle'; STATE.paused = false;
      await persistCheckpoint();
      log(`扫描结束：${queue.videos.length} 个视频，${STATE.docs.length} 个文档${STATE.scanStats.failedDirs.length ? '；存在读取失败目录，结果不完整，请查看详细信息。' : '。'}`);
    } catch (error) {
      STATE.scanStats = previousStats;
      log('扫描失败，保留原有进度：' + error.message);
    } finally {
      STATE.scanning = false; STATE.scanProgress = '';
      if (scanQueue) await send({action:'releaseBatch',batchId:scanQueue.batchId,rootDir:scanQueue.rootDir});
      ownsBatch = false;
      updatePanel();
    }
  }  window.__toggleVideoExport = function () {
    if (!queue || !queue.videos.length) { log('请先扫描目录中的视频。'); return; }
    if (STATE.enabled && !STATE.paused) {
      STATE.paused = true;
      log('已暂停分配新任务；已打开的任务继续收尾。');
      persistCheckpoint();
    } else beginRun(false);
  };
  async function init() {
    const settings = await storageGet(['enabled','batchEnabled','pdfEnabled']);
    STATE.extensionEnabled = settings.enabled !== false;
    STATE.batchEnabled = settings.batchEnabled !== false;
    STATE.pdfEnabled = settings.pdfEnabled !== false;
    if (STATE.batchEnabled) createPanel();
    await restoreCheckpoint(getCurrentDirPath());
  }
  chrome.storage.onChanged.addListener((changes,area) => {
    if (area !== 'local') return;
    if (changes.enabled) STATE.extensionEnabled = changes.enabled.newValue !== false;
    if (changes.batchEnabled) STATE.batchEnabled = changes.batchEnabled.newValue !== false;
    if (changes.pdfEnabled) {
      STATE.pdfEnabled = changes.pdfEnabled.newValue !== false;
      if (!STATE.pdfEnabled && STATE.docMode === 'downloading') log('文档下载已关闭；当前文件继续收尾，后续文件暂停。');
    }
    if (!STATE.extensionEnabled || !STATE.batchEnabled) { STATE.paused = true; log('扩展已暂停分配新任务。'); }
    if (panelEl) panelEl.hidden = !STATE.batchEnabled;
    else if (STATE.batchEnabled) createPanel();
    updatePanel();
  });
  setTimeout(init,1000);
  window.addEventListener('hashchange',()=>updatePanel());
})();
