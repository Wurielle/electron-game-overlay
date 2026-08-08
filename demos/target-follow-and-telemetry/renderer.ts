import { markDemoRendererReady } from '../renderer-ready';

type FollowMode = 'render' | 'client' | 'stopped';
type Surface = Readonly<{
  surfaceId: string;
  graphicsApi: string;
  renderSize: Readonly<{ width: number; height: number }>;
  clientScreenBounds: Readonly<{
    x: number;
    y: number;
    width: number;
    height: number;
  }>;
  dpi: Readonly<{ x: number; y: number; scaleFactor: number }>;
  focused: boolean;
  fullscreen: boolean;
}>;
type DemoState = Readonly<{
  phase: string;
  target: string;
  detail: string;
  followMode: FollowMode;
  fps: number | null;
  surface: Surface | null;
  events: readonly string[];
}>;

const targetFollowDemo = (
  window as unknown as {
    targetFollowDemo: {
      getState(): Promise<DemoState>;
      setFollowMode(mode: FollowMode): Promise<DemoState>;
      onState(listener: (state: DemoState) => void): () => void;
    };
  }
).targetFollowDemo;

const phase = document.querySelector<HTMLElement>('[data-phase]')!;
const target = document.querySelector<HTMLElement>('[data-target]')!;
const detail = document.querySelector<HTMLElement>('[data-detail]')!;
const metrics = document.querySelector<HTMLElement>('[data-metrics]')!;
const events = document.querySelector<HTMLUListElement>('[data-events]')!;
const buttons = Array.from(
  document.querySelectorAll<HTMLButtonElement>('[data-mode]'),
);

function render(state: DemoState): void {
  phase.textContent = state.phase;
  phase.dataset.value = state.phase;
  target.textContent = state.target;
  detail.textContent = state.detail;
  for (const button of buttons) {
    button.setAttribute(
      'aria-pressed',
      String(button.dataset.mode === state.followMode),
    );
  }

  const surface = state.surface;
  metrics.textContent = surface
    ? `${surface.graphicsApi.toUpperCase()} · ${surface.renderSize.width}×${surface.renderSize.height} render · ${surface.clientScreenBounds.width}×${surface.clientScreenBounds.height} client · ${surface.dpi.scaleFactor}× DPI · ${state.fps ?? '—'} FPS · ${surface.focused ? 'focused' : 'unfocused'} · ${surface.fullscreen ? 'fullscreen' : 'windowed'}`
    : `Waiting for a target surface · ${state.fps ?? '—'} FPS`;

  events.replaceChildren(
    ...state.events.map((message) => {
      const item = document.createElement('li');
      item.textContent = message;
      return item;
    }),
  );
}

for (const button of buttons) {
  button.addEventListener('click', async () => {
    const mode = button.dataset.mode as FollowMode;
    render(await targetFollowDemo.setFollowMode(mode));
  });
}

targetFollowDemo.onState(render);
void targetFollowDemo.getState().then(render);
markDemoRendererReady();

export {};
