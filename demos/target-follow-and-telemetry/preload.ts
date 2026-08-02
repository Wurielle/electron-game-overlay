import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('targetFollowDemo', {
  getState: () => ipcRenderer.invoke('demo:get-state'),
  setFollowMode: (mode: 'render' | 'client' | 'stopped') =>
    ipcRenderer.invoke('demo:set-follow-mode', mode),
  onState: (listener: (state: unknown) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, state: unknown) =>
      listener(state);
    ipcRenderer.on('demo:state', handler);
    return () => ipcRenderer.removeListener('demo:state', handler);
  },
});
