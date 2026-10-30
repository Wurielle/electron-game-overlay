import { app } from 'electron';

const expectedRenderers = new Set<string>();
const readyRenderers = new Set<string>();
let watcherReady = false;
let failed = false;
let completionTimer: NodeJS.Timeout | null = null;

export function registerDemoSmokeRenderer(label: string): void {
  if (!isSmokeRun()) return;
  expectedRenderers.add(label);
}

export function markDemoSmokeRendererReady(label: string): void {
  if (!isSmokeRun() || failed) return;
  readyRenderers.add(label);
  console.log(`[demo-smoke] milestone=renderer label=${label}`);
  scheduleCompletionIfReady();
}

export function markDemoSmokeWatcherReady(): void {
  if (!isSmokeRun() || failed) return;
  watcherReady = true;
  console.log('[demo-smoke] milestone=watcher');
  scheduleCompletionIfReady();
}

export function failDemoSmoke(detail: string): void {
  if (!isSmokeRun() || failed) return;
  failed = true;
  if (completionTimer) clearTimeout(completionTimer);
  completionTimer = null;
  console.error(`[demo-smoke] failure ${detail}`);
  setImmediate(() => {
    app.once('will-quit', (event) => {
      event.preventDefault();
      app.exit(1);
    });
    app.quit();
  });
}

function scheduleCompletionIfReady(): void {
  if (
    completionTimer ||
    !watcherReady ||
    expectedRenderers.size === 0 ||
    !Array.from(expectedRenderers).every((label) => readyRenderers.has(label))
  ) {
    return;
  }

  completionTimer = setTimeout(() => {
    completionTimer = null;
    if (failed) return;
    console.log(
      `[demo-smoke] ready demo=${process.env.ELECTRON_GAME_OVERLAY_DEMO ?? 'unknown'}`,
    );
    app.quit();
  }, 500);
}

function isSmokeRun(): boolean {
  return process.env.ELECTRON_GAME_OVERLAY_DEMO_SMOKE === '1';
}
