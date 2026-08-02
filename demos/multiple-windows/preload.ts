import { contextBridge, ipcRenderer } from 'electron';

const STATUS_CHANNEL = 'multiple-windows:status';

contextBridge.exposeInMainWorld('multipleWindowsDemo', {
  getStatus: (): Promise<string> =>
    ipcRenderer.invoke('multiple-windows:get-status'),
  onStatus: (listener: (status: string) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, status: string) =>
      listener(status);
    ipcRenderer.on(STATUS_CHANNEL, handler);
    return () => ipcRenderer.removeListener(STATUS_CHANNEL, handler);
  },
});
