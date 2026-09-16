// Standalone diagnostic: never loads business settings or writes source images.
const { app, dialog } = require('electron');
const { mkdtempSync } = require('node:fs');
const { join } = require('node:path');
const { tmpdir } = require('node:os');
app.setPath('userData', mkdtempSync(join(tmpdir(), 'casebang-picker-test-')));
app.whenReady().then(async () => {
  console.log('PICKER_READY', process.pid, process.versions.electron);
  const start = Date.now();
  try {
    console.log('PICKER_OPEN', new Date().toISOString());
    const result = await dialog.showOpenDialog({
      title: 'CASEBANG 原版选择器独立测试',
      defaultPath: process.argv.includes('--empty-directory') ? mkdtempSync(join(tmpdir(), 'casebang-empty-images-')) : 'C:\\Users\\Administrator\\Desktop\\CASEBANG 表格编码自动化\\图片文件',
      properties: ['openFile'],
      filters: [{ name: '产品图片', extensions: ['png', 'jpg', 'jpeg', 'webp', 'tif', 'tiff'] }]
    });
    console.log('PICKER_RESULT', JSON.stringify(result), 'elapsedMs', Date.now() - start);
  } catch (error) { console.error(error); }
  app.quit();
});
