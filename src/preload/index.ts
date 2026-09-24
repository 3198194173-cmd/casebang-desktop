import { contextBridge, ipcRenderer } from 'electron'
import type { CasebangDesktopApi } from '@shared/contracts'
import { IPC_CHANNELS } from '@shared/ipc-channels'

const api: CasebangDesktopApi = {
  lifecycle: {
    list: () => ipcRenderer.invoke(IPC_CHANNELS.lifecycleList),
    importWorkbook: () => ipcRenderer.invoke(IPC_CHANNELS.lifecycleImport),
    inspectWorkbook: (input) => ipcRenderer.invoke(IPC_CHANNELS.lifecycleInspectWorkbook, input),
    get: (id) => ipcRenderer.invoke(IPC_CHANNELS.lifecycleGet, id),
    save: (input) => ipcRenderer.invoke(IPC_CHANNELS.lifecycleSave, input),
    preview: (id) => ipcRenderer.invoke(IPC_CHANNELS.lifecyclePreview, id),
    analyzeShared: (input) => ipcRenderer.invoke(IPC_CHANNELS.lifecycleAnalyzeShared, input),
    applyShared: (input) => ipcRenderer.invoke(IPC_CHANNELS.lifecycleApplyShared, input),
    previewMaterialMaster: (input) => ipcRenderer.invoke(IPC_CHANNELS.lifecyclePreviewMaterialMaster, input),
    listMaterialModels: () => ipcRenderer.invoke(IPC_CHANNELS.lifecycleListMaterialModels),
    saveMaterialModel: (input) => ipcRenderer.invoke(IPC_CHANNELS.lifecycleSaveMaterialModel, input)
  },
  supplement: {
    getMaster: () => ipcRenderer.invoke(IPC_CHANNELS.supplementGetMaster),
    selectMaster: () => ipcRenderer.invoke(IPC_CHANNELS.supplementSelectMaster),
    select: () => ipcRenderer.invoke(IPC_CHANNELS.supplementSelect),
    analyze: (input) => ipcRenderer.invoke(IPC_CHANNELS.supplementAnalyze, input),
    export: (input) => ipcRenderer.invoke(IPC_CHANNELS.supplementExport, input),
    publishShared: (input) => ipcRenderer.invoke(IPC_CHANNELS.supplementPublishShared, input)
  },
  app: {
    getSnapshot: () => ipcRenderer.invoke(IPC_CHANNELS.appGetSnapshot)
  },
  settings: {
    get: () => ipcRenderer.invoke(IPC_CHANNELS.settingsGet),
    save: (input) => ipcRenderer.invoke(IPC_CHANNELS.settingsSave, input)
  },
  account: {
    get: () => ipcRenderer.invoke(IPC_CHANNELS.accountGet),
    login: (businessRole) => ipcRenderer.invoke(IPC_CHANNELS.accountLogin, businessRole),
    logout: () => ipcRenderer.invoke(IPC_CHANNELS.accountLogout)
  },
  collaboration: {
    members: () => ipcRenderer.invoke(IPC_CHANNELS.collaborationMembers),
    workItems: () => ipcRenderer.invoke(IPC_CHANNELS.collaborationWorkItems),
    activities: (input) => ipcRenderer.invoke(IPC_CHANNELS.collaborationActivities, input),
    publishWorkbook: (input) => ipcRenderer.invoke(IPC_CHANNELS.collaborationPublishWorkbook, input),
    submitLifecycle: (input) => ipcRenderer.invoke(IPC_CHANNELS.collaborationSubmitLifecycle, input),
    act: (input) => ipcRenderer.invoke(IPC_CHANNELS.collaborationAct, input),
    openWorkbook: (input) => ipcRenderer.invoke(IPC_CHANNELS.collaborationOpenWorkbook, input),
    openLocalWorkbook: (input) => ipcRenderer.invoke(IPC_CHANNELS.collaborationOpenLocalWorkbook, input),
    openOnlineWorkbook: (input) => ipcRenderer.invoke(IPC_CHANNELS.collaborationOpenOnlineWorkbook, input),
    activeLocalEdit: (input) => ipcRenderer.invoke(IPC_CHANNELS.collaborationActiveLocalEdit, input),
    localEditor: () => ipcRenderer.invoke(IPC_CHANNELS.collaborationLocalEditor),
    selectLocalEditor: () => ipcRenderer.invoke(IPC_CHANNELS.collaborationSelectLocalEditor),
    clearLocalEditor: () => ipcRenderer.invoke(IPC_CHANNELS.collaborationClearLocalEditor),
    beginLocalEdit: (input) => ipcRenderer.invoke(IPC_CHANNELS.collaborationBeginLocalEdit, input),
    openLocalEdit: (input) => ipcRenderer.invoke(IPC_CHANNELS.collaborationOpenLocalEdit, input),
    commitLocalEdit: (input) => ipcRenderer.invoke(IPC_CHANNELS.collaborationCommitLocalEdit, input),
    endLocalEdit: (input) => ipcRenderer.invoke(IPC_CHANNELS.collaborationEndLocalEdit, input),
    materialMaster: () => ipcRenderer.invoke(IPC_CHANNELS.collaborationMaterialMaster),
    publishMaterialMaster: () => ipcRenderer.invoke(IPC_CHANNELS.collaborationPublishMaterialMaster),
    syncMaterialMaster: () => ipcRenderer.invoke(IPC_CHANNELS.collaborationSyncMaterialMaster),
    artworkSource: () => ipcRenderer.invoke(IPC_CHANNELS.collaborationArtworkSource),
    bindArtworkSource: (input) => ipcRenderer.invoke(IPC_CHANNELS.collaborationBindArtworkSource, input),
    syncArtworkSource: () => ipcRenderer.invoke(IPC_CHANNELS.collaborationSyncArtworkSource),
    searchArtworkEntries: (input) => ipcRenderer.invoke(IPC_CHANNELS.collaborationSearchArtworkEntries, input),
    artworkTarget: (input) => ipcRenderer.invoke(IPC_CHANNELS.collaborationArtworkTarget, input),
    bindArtworkTarget: (input) => ipcRenderer.invoke(IPC_CHANNELS.collaborationBindArtworkTarget, input),
    artworkPdf: (input) => ipcRenderer.invoke(IPC_CHANNELS.collaborationArtworkPdf, input),
    cancelArtworkPdf: (input) => ipcRenderer.invoke(IPC_CHANNELS.collaborationCancelArtworkPdf, input)
  },
  baseFiles: {
    select: (kind) => ipcRenderer.invoke(IPC_CHANNELS.baseFilesSelect, kind),
    preview: (input) => ipcRenderer.invoke(IPC_CHANNELS.baseFilesPreview, input),
    history: () => ipcRenderer.invoke(IPC_CHANNELS.baseFilesHistory),
    rollback: (recordId) => ipcRenderer.invoke(IPC_CHANNELS.baseFilesRollback, recordId)
  },
  tasks: {
    selectMasterImage: () => ipcRenderer.invoke(IPC_CHANNELS.tasksSelectMasterImage),
    createDraft: (input) => ipcRenderer.invoke(IPC_CHANNELS.tasksCreateDraft, input),
    exportGenerationWorkbook: (input) => ipcRenderer.invoke(IPC_CHANNELS.tasksExportGenerationWorkbook, input),
    publishGenerationWorkbook: (input) => ipcRenderer.invoke(IPC_CHANNELS.tasksPublishGenerationWorkbook, input)
  },
  images: {
    analyze: (input) => ipcRenderer.invoke(IPC_CHANNELS.imagesAnalyze, input),
    refineCrop: (input) => ipcRenderer.invoke(IPC_CHANNELS.imagesRefineCrop, input),
    exportCrops: (input) => ipcRenderer.invoke(IPC_CHANNELS.imagesExportCrops, input)
  },
  ai: {
    getSettings: () => ipcRenderer.invoke(IPC_CHANNELS.aiGetSettings),
    saveSettings: (input) => ipcRenderer.invoke(IPC_CHANNELS.aiSaveSettings, input),
    testConnection: () => ipcRenderer.invoke(IPC_CHANNELS.aiTestConnection),
    recognizeMaterial: (input) => ipcRenderer.invoke(IPC_CHANNELS.aiRecognizeMaterial, input),
    comparePatterns: (input) => ipcRenderer.invoke(IPC_CHANNELS.aiComparePatterns, input),
    compareArtworkImages: (input) => ipcRenderer.invoke(IPC_CHANNELS.aiCompareArtworkImages, input),
    suggestImageNames: (input) => ipcRenderer.invoke(IPC_CHANNELS.aiSuggestImageNames, input),
    suggestImageNamesBatch: (input) => ipcRenderer.invoke(IPC_CHANNELS.aiSuggestImageNamesBatch, input),
    translateSeriesName: (input) => ipcRenderer.invoke(IPC_CHANNELS.aiTranslateSeriesName, input)
  },
  integrations: {
    test: (input) => ipcRenderer.invoke(IPC_CHANNELS.integrationsTest, input)
  },
  excel: {
    inspectBaseFiles: () => ipcRenderer.invoke(IPC_CHANNELS.excelInspectBaseFiles),
    cloneTemplateWorkbook: (input) =>
      ipcRenderer.invoke(IPC_CHANNELS.excelCloneTemplateWorkbook, input),
    generateTemplateConfig: (input) =>
      ipcRenderer.invoke(IPC_CHANNELS.excelGenerateTemplateConfig, input),
    controlledWrite: (input) =>
      ipcRenderer.invoke(IPC_CHANNELS.excelControlledWrite, input),
    buildEncodingPreview: (input) =>
      ipcRenderer.invoke(IPC_CHANNELS.excelBuildEncodingPreview, input)
  }
}

contextBridge.exposeInMainWorld('casebang', api)
