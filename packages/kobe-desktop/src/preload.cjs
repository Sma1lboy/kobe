const { contextBridge, ipcRenderer } = require("electron")

contextBridge.exposeInMainWorld("kobeDesktopWindow", {
  close: () => ipcRenderer.send("kobe-window:close"),
  minimize: () => ipcRenderer.send("kobe-window:minimize"),
  toggleMaximize: () => ipcRenderer.send("kobe-window:toggle-maximize"),
})
