import { markDemoRendererReady } from '../renderer-ready';

type TargetState = Readonly<{
  pid: number;
  processName: string;
  executablePath: string;
  phase: 'attaching' | 'connected' | 'failed';
  detail: string;
}>;
type DemoState = Readonly<{
  watcherStatus: string;
  targets: readonly TargetState[];
}>;

const steamAutoAttachDemo = (
  window as unknown as {
    steamAutoAttachDemo: {
      getState(): Promise<DemoState>;
      onState(listener: (state: DemoState) => void): () => void;
    };
  }
).steamAutoAttachDemo;

const watcher = document.querySelector<HTMLElement>('[data-watcher]')!;
const count = document.querySelector<HTMLElement>('[data-count]')!;
const targets = document.querySelector<HTMLElement>('[data-targets]')!;

function render(state: DemoState): void {
  watcher.textContent = state.watcherStatus;
  count.textContent = String(state.targets.length);
  targets.replaceChildren(
    ...state.targets.map((target) => {
      const item = document.createElement('article');
      item.className = 'target';
      item.dataset.phase = target.phase;

      const heading = document.createElement('div');
      const name = document.createElement('strong');
      name.textContent = target.processName;
      const phase = document.createElement('span');
      phase.textContent = target.phase;
      heading.append(name, phase);

      const metadata = document.createElement('code');
      metadata.textContent = `pid ${target.pid} · ${target.executablePath}`;
      const detail = document.createElement('p');
      detail.textContent = target.detail;
      item.append(heading, metadata, detail);
      return item;
    }),
  );
}

steamAutoAttachDemo.onState(render);
void steamAutoAttachDemo.getState().then(render);
markDemoRendererReady();

export {};
