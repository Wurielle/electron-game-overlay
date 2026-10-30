import { contextBridge, ipcRenderer } from 'electron';

const STATUS_CHANNEL = 'basic-window:status';

contextBridge.exposeInMainWorld('basicWindowDemo', {
  getStatus: (): Promise<string> =>
    ipcRenderer.invoke('basic-window:get-status'),
  onStatus: (listener: (status: string) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, status: string) =>
      listener(status);
    ipcRenderer.on(STATUS_CHANNEL, handler);
    return () => ipcRenderer.removeListener(STATUS_CHANNEL, handler);
  },
});
