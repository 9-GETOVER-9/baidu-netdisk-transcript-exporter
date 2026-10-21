const {defineConfig} = require('@playwright/test');
module.exports = defineConfig({
  testDir:'./tests/browser',
  timeout:180000,
  expect:{timeout:15000},
  workers:1,
  retries:0,
  outputDir:'output/playwright/results',
  reporter:[['list'], ['html', {outputFolder:'output/playwright/report', open:'never'}]],
});
