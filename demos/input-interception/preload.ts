import { contextBridge, ipcRenderer } from 'electron';

type DemoState = Readonly<{
  attachment: string;
  intercepting: boolean;
  shortcut: string;
}>;

const STATE_CHANNEL = 'input-interception:state';

contextBridge.exposeInMainWorld('inputInterceptionDemo', {
  getState: (): Promise<DemoState> =>
    ipcRenderer.invoke('input-interception:get-state'),
  toggle: (): Promise<DemoState> =>
    ipcRenderer.invoke('input-interception:toggle'),
  onState: (listener: (state: DemoState) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, state: DemoState) =>
      listener(state);
    ipcRenderer.on(STATE_CHANNEL, handler);
    return () => ipcRenderer.removeListener(STATE_CHANNEL, handler);
  },
});
