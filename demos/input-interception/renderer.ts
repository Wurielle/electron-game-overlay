import { markDemoRendererReady } from '../renderer-ready';

type DemoState = Readonly<{
  attachment: string;
  intercepting: boolean;
  shortcut: string;
}>;

type InputInterceptionDemoApi = {
  getState(): Promise<DemoState>;
  toggle(): Promise<DemoState>;
  onState(listener: (state: DemoState) => void): () => void;
};

const demo = (
  window as unknown as { inputInterceptionDemo: InputInterceptionDemoApi }
).inputInterceptionDemo;
const panel = document.querySelector<HTMLElement>('[data-panel]');
const attachment = document.querySelector<HTMLElement>('[data-attachment]');
const mode = document.querySelector<HTMLElement>('[data-mode]');
const shortcut = document.querySelector<HTMLElement>('[data-shortcut]');
const toggle = document.querySelector<HTMLButtonElement>('[data-toggle]');

if (!panel || !attachment || !mode || !shortcut || !toggle) {
  throw new Error('The input-interception demo markup is incomplete.');
}

const render = (state: DemoState) => {
  attachment.textContent = state.attachment;
  shortcut.textContent = state.shortcut;
  mode.textContent = state.intercepting ? 'Intercepting' : 'Released';
  toggle.textContent = state.intercepting
    ? 'Release game input'
    : 'Intercept game input';
  panel.dataset.intercepting = String(state.intercepting);
};

void demo.getState().then(render);
demo.onState(render);
toggle.addEventListener('click', () => void demo.toggle().then(render));
markDemoRendererReady();
