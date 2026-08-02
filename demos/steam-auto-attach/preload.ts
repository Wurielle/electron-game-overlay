import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('steamAutoAttachDemo', {
  getState: () => ipcRenderer.invoke('demo:get-state'),
  onState: (listener: (state: unknown) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, state: unknown) =>
      listener(state);
    ipcRenderer.on('demo:state', handler);
    return () => ipcRenderer.removeListener('demo:state', handler);
  },
});
