'use strict';

document.addEventListener('DOMContentLoaded', () => {
  const controls = {
    enabled: document.getElementById('enableToggle'),
    batchEnabled: document.getElementById('batchToggle'),
    pdfEnabled: document.getElementById('pdfToggle'),
  };
  const status = document.getElementById('status');
  const folderInput = document.getElementById('outputSubfolder');
  const saveFolder = document.getElementById('saveFolder');
  const folderMessage = document.getElementById('folderMessage');
  const saved = {};

  document.getElementById('version').textContent = `v${chrome.runtime.getManifest().version}`;

  function updateStatus() {
    const ready = controls.enabled.checked && controls.batchEnabled.checked;
    status.dataset.state = ready ? 'ready' : 'paused';
    status.textContent = !controls.enabled.checked
      ? '新任务已暂停 · 已打开的任务继续收尾'
      : !controls.batchEnabled.checked
        ? '目录面板已隐藏 · 开启后可启动任务'
        : '已就绪 · 请从目录面板开始导出';
  }

  chrome.storage.local.get([...Object.keys(controls), 'outputSubfolder'], result => {
    const error = chrome.runtime.lastError;
    if (error) {
      status.dataset.state = 'error';
      status.textContent = '设置读取失败，请关闭后重新打开扩展。';
      return;
    }
    for (const [key, control] of Object.entries(controls)) {
      saved[key] = result[key] !== false;
      control.checked = saved[key];
      control.disabled = false;
    }
    folderInput.value = typeof result.outputSubfolder === 'string' ? result.outputSubfolder : '文稿导出';
    folderInput.disabled = false;
    saveFolder.disabled = false;
    updateStatus();
  });

  for (const [key, control] of Object.entries(controls)) {
    control.addEventListener('change', () => {
      const value = control.checked;
      control.disabled = true;
      chrome.storage.local.set({ [key]: value }, () => {
        const error = chrome.runtime.lastError;
        control.disabled = false;
        if (error) {
          control.checked = saved[key];
          status.dataset.state = 'error';
          status.textContent = '设置保存失败，已恢复原值。请重试。';
          return;
        }
        saved[key] = value;
        updateStatus();
      });
    });
  }

  folderInput.addEventListener('input', () => {
    folderInput.removeAttribute('aria-invalid');
    folderMessage.textContent = '';
    folderMessage.removeAttribute('data-state');
  });

  document.getElementById('folderForm').addEventListener('submit', event => {
    event.preventDefault();
    if (saveFolder.disabled) return;
    const parsed = validateSubfolder(folderInput.value);
    if (parsed.error) {
      folderMessage.dataset.state = 'error';
      folderMessage.textContent = parsed.error;
      folderInput.setAttribute('aria-invalid', 'true');
      folderInput.focus();
      return;
    }
    saveFolder.disabled = true;
    folderInput.disabled = true;
    chrome.storage.local.set({ outputSubfolder: parsed.value }, () => {
      const error = chrome.runtime.lastError;
      folderInput.disabled = false;
      saveFolder.disabled = false;
      folderMessage.dataset.state = error ? 'error' : 'saved';
      if (error) {
        folderMessage.textContent = '保存失败，请重试。';
        return;
      }
      folderInput.value = parsed.value;
      folderMessage.textContent = parsed.value ? '已保存，将用于后续新下载。' : '已保存，将使用浏览器默认下载目录。';
    });
  });

  function validateSubfolder(value) {
    const normalized = value.trim().replace(/\\/g, '/');
    if (!normalized) return { value: '' };
    if (normalized.startsWith('/') || /^[a-z]:/i.test(normalized)) {
      return { error: '这里只填写子文件夹名；请在浏览器设置中修改磁盘和默认下载位置。' };
    }
    const parts = normalized.split('/');
    if (parts.some(part => !part || part === '.' || part === '..')) {
      return { error: '路径不能包含空层级、“.”或“..”。示例：课程/文稿。' };
    }
    if (parts.some(part => /[<>:"|?*\u0000-\u001f]/.test(part) || /[. ]$/.test(part) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) {
      return { error: '文件夹名含系统不支持的字符、保留名称或结尾空格/句点，请修改。' };
    }
    return { value: normalized };
  }
});
