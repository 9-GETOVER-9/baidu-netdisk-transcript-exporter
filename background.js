'use strict';
importScripts('archive-store.js', 'subtitle-core.js', 'format-stats.js', 'background-controller.js');
const controller = PDBackground.createController(chrome, { archiveStore: PDArchiveStore });
chrome.runtime.onMessage.addListener((message, sender, respond) => {
  controller.handle(message, sender).then(respond);
  return true;
});
