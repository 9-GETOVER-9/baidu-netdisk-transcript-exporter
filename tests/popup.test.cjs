'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '..', 'popup.js'), 'utf8');

// These tests execute the real popup script with isolated DOM/Chrome API mocks.
// They do not load an extension, contact a service, or access browser state.
function fixture(initial = {}, readFails = false) {
  const nodes = new Map();
  function element() {
    return {
      checked: false, disabled: true, value: '', textContent: '',
      dataset: {}, attrs: {}, events: {},
      addEventListener(key, callback) { this.events[key] = callback; },
      setAttribute(key, value) { this.attrs[key] = value; },
      removeAttribute(key) { delete this.attrs[key]; },
      focus() { this.focused = true; },
    };
  }
  let ready;
  const writes = [];
  const chrome = {
    runtime: { getManifest: () => ({ version: '3.3.0' }) },
    storage: { local: {
      get(keys, callback) {
        if (readFails) chrome.runtime.lastError = { message: 'read failed' };
        callback(initial);
        delete chrome.runtime.lastError;
      },
      set(value, callback) {
        writes.push(value);
        if (chrome.failNext) {
          chrome.runtime.lastError = { message: 'write failed' };
          chrome.failNext = false;
        }
        callback();
        delete chrome.runtime.lastError;
      },
    } },
  };
  vm.runInNewContext(source, {
    chrome,
    document: {
      addEventListener(key, callback) { ready = callback; },
      getElementById(id) {
        if (!nodes.has(id)) nodes.set(id, element());
        return nodes.get(id);
      },
    },
  });
  ready();
  return {
    writes, chrome,
    node: id => nodes.get(id),
    submit: () => nodes.get('folderForm').events.submit({ preventDefault() {} }),
    toggle(id, checked) {
      nodes.get(id).checked = checked;
      nodes.get(id).events.change();
    },
  };
}

test('restores existing options without replacing explicit false or empty values', () => {
  const f = fixture({ enabled: false, batchEnabled: true, pdfEnabled: false, outputSubfolder: '' });
  assert.equal(f.node('enableToggle').checked, false);
  assert.equal(f.node('batchToggle').checked, true);
  assert.equal(f.node('pdfToggle').checked, false);
  assert.equal(f.node('outputSubfolder').value, '');
  assert.match(f.node('status').textContent, /新任务已暂停/);
  assert.equal(f.writes.length, 0);
});

test('defaults to ready and to the documented transcript subfolder', () => {
  const f = fixture();
  assert.equal(f.node('enableToggle').checked, true);
  assert.equal(f.node('batchToggle').checked, true);
  assert.equal(f.node('pdfToggle').checked, true);
  assert.equal(f.node('outputSubfolder').value, '文稿导出');
  assert.equal(f.node('status').dataset.state, 'ready');
});

test('persists each existing storage key and reflects batch visibility independently', () => {
  const f = fixture();
  f.toggle('batchToggle', false);
  assert.equal(f.writes.at(-1).batchEnabled, false);
  assert.match(f.node('status').textContent, /目录面板已隐藏/);
  f.toggle('pdfToggle', false);
  assert.equal(f.writes.at(-1).pdfEnabled, false);
  f.toggle('enableToggle', false);
  assert.equal(f.writes.at(-1).enabled, false);
  assert.match(f.node('status').textContent, /新任务已暂停/);
});

test('failed toggle saves restore the last saved value and let the user retry', () => {
  const f = fixture({ enabled: false });
  f.toggle('enableToggle', true);
  f.chrome.failNext = true;
  f.toggle('enableToggle', false);
  assert.equal(f.node('enableToggle').checked, true);
  assert.equal(f.node('enableToggle').disabled, false);
  assert.equal(f.node('status').dataset.state, 'error');
});

test('rejects absolute, traversal and unsupported Windows paths before saving', () => {
  const f = fixture();
  for (const value of ['D:\\secret', '/secret', '\\\\server\\share', '../secret', '课程/../secret', '课程/./文稿', '课程//文稿', '课程/CON.txt', '课程/name.', '课程/a?.txt']) {
    const before = f.writes.length;
    f.node('outputSubfolder').value = value;
    f.submit();
    assert.equal(f.writes.length, before, `must reject ${value}`);
    assert.equal(f.node('folderMessage').dataset.state, 'error');
    assert.equal(f.node('outputSubfolder').attrs['aria-invalid'], 'true');
  }
});

test('normalizes relative subfolders and permits using the Downloads base directly', () => {
  const f = fixture();
  f.node('outputSubfolder').value = '  课程\\文稿  ';
  f.submit();
  assert.equal(f.writes.at(-1).outputSubfolder, '课程/文稿');
  assert.equal(f.node('outputSubfolder').value, '课程/文稿');
  f.node('outputSubfolder').value = '';
  f.submit();
  assert.equal(f.writes.at(-1).outputSubfolder, '');
});

test('failed subfolder saves report failure rather than a false success', () => {
  const f = fixture();
  f.chrome.failNext = true;
  f.node('outputSubfolder').value = '新目录';
  f.submit();
  assert.equal(f.node('folderMessage').dataset.state, 'error');
  assert.equal(f.node('outputSubfolder').disabled, false);
  assert.equal(f.node('saveFolder').disabled, false);
});

test('failed settings reads leave all writes disabled and show the error', () => {
  const f = fixture({}, true);
  assert.equal(f.node('enableToggle').disabled, true);
  assert.equal(f.node('batchToggle').disabled, true);
  assert.equal(f.node('pdfToggle').disabled, true);
  assert.equal(f.node('outputSubfolder').disabled, true);
  assert.equal(f.node('saveFolder').disabled, true);
  assert.equal(f.node('status').dataset.state, 'error');
});
