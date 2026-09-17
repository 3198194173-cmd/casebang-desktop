import { app, BrowserWindow, session } from 'electron'
import { BaseFileService } from '@main/modules/base-files/base-file-service'
import { ConnectorRegistry } from '@main/modules/integrations/connector-registry'
import { TaskService } from '@main/modules/tasks/task-service'
import { ExcelTemplateEngine } from '@main/modules/spreadsheet/excel-template-engine'
import { ImageWorkspaceService } from '@main/modules/image/image-workspace-service'
import { VisionAiService } from '@main/modules/naming/vision-ai-service'
import { SettingsRepository } from '@main/infrastructure/settings-repository'
import { registerIpcHandlers, unregisterIpcHandlers } from '@main/ipc/register-ipc-handlers'
import { createMainWindow } from '@main/windows/create-main-window'
import { CollaborationAuthService } from '@main/modules/collaboration/collaboration-auth-service'
import { CollaborationService } from '@main/modules/collaboration/collaboration-service'

const hasSingleInstanceLock = app.requestSingleInstanceLock()

if (!hasSingleInstanceLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    const mainWindow = BrowserWindow.getAllWindows()[0]
    if (!mainWindow) return
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.show()
    mainWindow.focus()
  })

  app.whenReady().then(async () => {
    app.setAppUserModelId('com.casebang.automation')

    session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => {
      callback(false)
    })

    const settings = new SettingsRepository()
    registerIpcHandlers({
      settings,
      baseFiles: new BaseFileService(settings),
      tasks: new TaskService(settings),
      images: new ImageWorkspaceService(),
      connectors: new ConnectorRegistry(settings),
      excel: new ExcelTemplateEngine(settings),
      ai: new VisionAiService(settings),
      account: new CollaborationAuthService(settings),
      collaboration: new CollaborationService(settings)
    })

    createMainWindow()

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createMainWindow()
    })
  })
}

app.on('before-quit', () => {
  unregisterIpcHandlers()
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
