const {test:base, expect, chromium} = require('@playwright/test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {spawnSync} = require('node:child_process');
const {startNetwork} = require('./network.cjs');
const version = require('../../manifest.json').version;
const root = '/回归课程';
const names = ['预览文稿.mp4', '字幕备用.mov', '关闭中断.mp4'];
const urls = Object.fromEntries(names.map(n => [n, `${root}/第一章/${n}`]));

function python(args) {
  const result = spawnSync(process.env.PYTHON || 'python', args, {encoding:'utf8'});
  if (result.status !== 0) throw Error(result.stderr || result.stdout || result.error?.message);
  return result.stdout;
}

const test = base.extend({
  app:async ({}, use, info) => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-browser-'));
    let context, network;
    try {
    const profile = path.join(temp, 'profile');
    const downloads = path.join(temp, 'downloads');
    const extension = path.join(temp, 'extension');
    const output = info.outputPath('package');
    python(['scripts/package.py', '--output', output]);
    python(['-c', 'import zipfile,sys; zipfile.ZipFile(sys.argv[1]).extractall(sys.argv[2])', path.join(output, `baidu-netdisk-transcript-exporter-v${version}.zip`), extension]);
    fs.mkdirSync(path.join(profile,'Default'), {recursive:true});
    fs.mkdirSync(downloads);
    fs.writeFileSync(path.join(profile,'Default','Preferences'), JSON.stringify({download:{default_directory:downloads,prompt_for_download:false,directory_upgrade:true}}));
    network = await startNetwork(temp, u => {
      if (u.pathname === '/disk/main') return ({contentType:'text/html',body:'<!doctype html><meta charset="utf-8"><h1>合成网盘目录</h1>'});
      if (u.pathname === '/api/list') {
        const dir = u.searchParams.get('dir');
        const list = dir === root ? [{server_filename:'第一章',path:root+'/第一章',fs_id:9,isdir:1}] : names.map((n,i)=>({server_filename:n,path:urls[n],fs_id:i+1,isdir:0,size:100,server_mtime:1}));
        return ({json:{errno:0,list}});
      }
      if (u.pathname === '/api/streaming') return ({contentType:'application/vnd.apple.mpegurl',body:'#EXTM3U\n#EXT-X-MEDIA:TYPE=SUBTITLES,NAME="中文",LANGUAGE="zh",URI="https://pan.baidu.com/fixture.srt"\n'});
      if (u.pathname === '/fixture.srt') return ({contentType:'text/plain',body:'1\n00:00:01,000 --> 00:00:03,000\n这是 MOV 字幕回退正文。\n\n2\n00:00:04,000 --> 00:00:06,000\n第二条字幕用于核对归档。\n'});
      if (u.pathname === '/pfile/video') {
        const source = u.searchParams.get('path');
        const preview = source === urls[names[0]];
        // A late-rendered real DOM exercises wait/stability/preview handling.
        const body = '<!doctype html><meta charset="utf-8"><style>[role=tab]{padding:12px} .ai-draft{margin:30px}</style><div role="tab">视频</div>' + (preview ? '<div role="tab" onclick="document.querySelector(\'.ai-draft\').hidden=false">文稿</div><section class="ai-draft" hidden><p>预览文稿，仅显示部分内容</p><div class="ai-draft__wrap-content">生成中</div></section><script>setTimeout(()=>document.querySelector(".ai-draft__wrap-content").textContent="延迟出现的网页文稿正文。此内容属于合成测试。",1800)</script>' : '') + (source === urls[names[1]] ? '<script>fetch("/api/streaming?path="+encodeURIComponent(new URL(location.href).searchParams.get("path")))</script>' : '');
        return ({contentType:'text/html',body});
      }
      return ({status:404,body:'Fixture endpoint not defined'});
    });
    context = await chromium.launchPersistentContext(profile, {
      channel:'chromium', headless:true, acceptDownloads:true, downloadsPath:downloads,
      ignoreHTTPSErrors:true, proxy:{server:network.url},
      // Only this disposable fixture browser trusts its ephemeral test certificate.
      args:[`--disable-extensions-except=${extension}`, `--load-extension=${extension}`, '--ignore-certificate-errors'],
    });
    await context.tracing.start({screenshots:true,snapshots:true});
    let worker = context.serviceWorkers()[0];
    if (!worker) worker = await context.waitForEvent('serviceworker');
    const id = new URL(worker.url()).host;
    await use({context,worker,id,downloads,network});
    }
    finally {
      if(context) {
        await context.tracing.stop({path:info.outputPath('trace.zip')}).catch(()=>{});
        await context.close();
      }
      if(network) await network.close();
      const resolved = path.resolve(temp), parent = path.resolve(os.tmpdir());
      if (path.dirname(resolved) !== parent || !path.basename(resolved).startsWith('pd-browser-')) throw Error('Unsafe temporary cleanup');
      fs.rmSync(resolved,{recursive:true,force:true});
    }
  },
});

test('installed popup validates relative paths and persists settings across reload', async ({app}) => {
  const page = await app.context.newPage();
  await page.goto(`chrome-extension://${app.id}/popup.html`);
  await expect(page.locator('#version')).toContainText(version);
  await page.locator('#outputSubfolder').fill('../escape');
  await page.locator('#saveFolder').click();
  await expect(page.locator('#outputSubfolder')).toHaveAttribute('aria-invalid','true');
  await page.locator('#outputSubfolder').fill('合成课程/文字');
  await page.locator('#saveFolder').click();
  await page.reload();
  await expect(page.locator('#outputSubfolder')).toHaveValue('合成课程/文字');
  await page.screenshot({path:test.info().outputPath('popup.png')});

});

test('a manually opened video is not captured or closed by the extension', async ({app}) => {
  const page = await app.context.newPage();
  await page.goto('https://pan.baidu.com/pfile/video?path='+encodeURIComponent(urls[names[0]])+'&fid=1');
  // Wait for actual isolated-world content script execution, not a blind timer.
  await expect.poll(()=>app.worker.evaluate(async () => {
    const [tab] = await chrome.tabs.query({url:'https://pan.baidu.com/pfile/video*'});
    const result = await chrome.scripting.executeScript({target:{tabId:tab.id},func:()=>window.__BaiduPanSubtitleAutoExported__});
    return result[0].result;
  })).toBe(true);
  expect(page.isClosed()).toBe(false);
  await expect(page.locator('#__subtitle_auto_panel__')).toHaveCount(0);
  expect(await page.evaluate(()=>Boolean(window.__PDSubtitleCapture42))).toBe(false);
  expect(await app.worker.evaluate(()=>PDArchiveStore.list('/回归课程'))).toEqual([]);
});

test('directory → delayed manuscript + MOV subtitle → durable cache → one real ZIP, with interrupted file reported', async ({app}) => {
  const page = await app.context.newPage();
  await page.goto('https://pan.baidu.com/disk/main#/index?path='+encodeURIComponent(root));
  await page.locator('#__batch_scan_btn__').click();
  await expect(page.locator('.pd-equation')).toContainText('3 个视频');
  await page.locator('#__batch_video_btn__').click();
  await expect.poll(()=>app.worker.evaluate(async source=>{
    const tabs=await chrome.tabs.query({url:'https://pan.baidu.com/pfile/video*'});
    const tab=tabs.find(t=>t.url && t.status==='complete' && new URL(t.url).searchParams.get('path')===source);
    if(!tab)return false;
    await chrome.tabs.remove(tab.id);return true;
  },urls[names[2]]),{timeout:100000}).toBe(true);
  await expect.poll(()=>app.worker.evaluate(async()=>{
    const all=await chrome.tabs.query({});return all.find(t=>t.url?.includes('/export.html?'))?.url;
  }),{timeout:100000}).toBeTruthy();
  await expect.poll(()=>app.worker.evaluate(async()=>{
    const downloads=await chrome.downloads.search({});return downloads.filter(d=>d.state==='complete').length;
  }),{timeout:30000}).toBe(1);
  const downloads = await app.worker.evaluate(()=>chrome.downloads.search({}));
  expect(downloads).toHaveLength(1);
  expect(downloads[0].mime).toBe('application/zip');
  const saved = test.info().outputPath('result.zip');
  fs.copyFileSync(downloads[0].filename,saved);
  const reportFile=test.info().outputPath('offline-report.html');
  python(['tests/browser/verify_archive.py', saved, reportFile]);
  expect(app.network.requests).toContain('/fixture.srt');
  const records = await app.worker.evaluate(()=>PDArchiveStore.list('/回归课程'));
  expect(records.map(r=>r.source).sort()).toEqual(['manuscript','subtitle']);
  expect(records.find(r=>r.source==='manuscript').markdown).toContain('预览');
  expect(records.find(r=>r.source==='subtitle').markdown).toContain('MOV 字幕回退正文');
  await page.reload();
  await expect(page.locator('.pd-equation')).toContainText('2 已缓存');
  await expect(page.locator('#__batch_retry_failed__')).toContainText('1');
  await page.setViewportSize({width:420,height:900});
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await page.screenshot({path:test.info().outputPath('directory.png'),fullPage:true});
  const report=await app.context.newPage();
  await report.setContent(fs.readFileSync(reportFile,'utf8'));
  await report.locator('[data-filter="failed"]').click();
  await expect(report.locator('#rows tr')).toHaveCount(1);
  await expect(report.locator('#rows')).toContainText(urls[names[2]]);
  await report.locator('[data-filter="all"]').click();
  await report.locator('[data-source-filter="subtitle"]').click();
  await expect(report.locator('#rows tr')).toHaveCount(1);
  await report.locator('#search').fill('字幕备用.mov');
  await expect(report.locator('#rows')).toContainText(urls[names[1]]);
  await report.screenshot({path:test.info().outputPath('report.png'),fullPage:true});

});


test('the fixture proxy rejects every non-fixture Internet host', async ({app}) => {
  const page=await app.context.newPage();
  await expect(page.goto('https://example.invalid/not-a-fixture')).rejects.toThrow();
  expect(app.network.blocked).toContain('example.invalid:443');
});
