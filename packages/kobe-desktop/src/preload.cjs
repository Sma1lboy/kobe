const { contextBridge, ipcRenderer } = require("electron")

contextBridge.exposeInMainWorld("kobeDesktopWindow", {
  close: () => ipcRenderer.send("kobe-window:close"),
  minimize: () => ipcRenderer.send("kobe-window:minimize"),
  toggleMaximize: () => ipcRenderer.send("kobe-window:toggle-maximize"),
  // Cmd+W routed from the main process (before-input-event) — the renderer
  // decides what "close" means (tab, or the Settings view).
  onCloseTab: (cb) => {
    const handler = () => cb()
    ipcRenderer.on("kobe-chord:close-tab", handler)
    return () => ipcRenderer.removeListener("kobe-chord:close-tab", handler)
  },
})
