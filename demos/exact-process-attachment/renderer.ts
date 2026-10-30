import { markDemoRendererReady } from '../renderer-ready';

type DemoState = Readonly<{
  phase: string;
  target: string;
  detail: string;
  intercepting: boolean;
}>;

const exactProcessDemo = (
  window as unknown as {
    exactProcessDemo: {
      getState(): Promise<DemoState>;
      setIntercepting(intercepting: boolean): Promise<DemoState>;
      onState(listener: (state: DemoState) => void): () => void;
    };
  }
).exactProcessDemo;

const phase = document.querySelector<HTMLElement>('[data-phase]')!;
const target = document.querySelector<HTMLElement>('[data-target]')!;
const detail = document.querySelector<HTMLElement>('[data-detail]')!;
const intercept =
  document.querySelector<HTMLButtonElement>('[data-intercept]')!;

function render(state: DemoState): void {
  phase.textContent = state.phase;
  phase.dataset.value = state.phase;
  target.textContent = state.target;
  detail.textContent = state.detail;
  intercept.textContent = state.intercepting
    ? 'Release game input'
    : 'Intercept game input';
  intercept.setAttribute('aria-pressed', String(state.intercepting));
}

intercept.addEventListener('click', async () => {
  const pressed = intercept.getAttribute('aria-pressed') === 'true';
  render(await exactProcessDemo.setIntercepting(!pressed));
});

exactProcessDemo.onState(render);
void exactProcessDemo.getState().then(render);
markDemoRendererReady();

export {};
