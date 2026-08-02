import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('exactProcessDemo', {
  getState: () => ipcRenderer.invoke('demo:get-state'),
  setIntercepting: (intercepting: boolean) =>
    ipcRenderer.invoke('demo:set-intercepting', intercepting),
  onState: (listener: (state: unknown) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, state: unknown) =>
      listener(state);
    ipcRenderer.on('demo:state', handler);
    return () => ipcRenderer.removeListener('demo:state', handler);
  },
});
