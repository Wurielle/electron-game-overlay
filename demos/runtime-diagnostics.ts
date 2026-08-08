import type { BrowserWindow } from 'electron';
import {
  failDemoSmoke,
  markDemoSmokeRendererReady,
  registerDemoSmokeRenderer,
} from './demo-smoke';

const RENDERER_READY_EXPRESSION =
  "document.documentElement.dataset.electronGameOverlayDemoReady === 'true'";

export function observeRenderer(
  browserWindow: BrowserWindow,
  label: string,
): void {
  const prefix = `[demo:${label}]`;
  const webContents = browserWindow.webContents;
  registerDemoSmokeRenderer(label);

  webContents.once('did-finish-load', () => {
    void verifyRendererBundle(browserWindow, label, prefix);
  });
  webContents.on('console-message', (details) => {
    if (details.level !== 'error') return;
    reportRendererFailure(
      label,
      `${prefix} renderer console error at ${details.sourceId}:${details.lineNumber}: ${details.message}`,
    );
  });
  webContents.on(
    'did-fail-load',
    (_event, errorCode, errorDescription, validatedUrl, isMainFrame) => {
      if (isMainFrame) {
        reportRendererFailure(
          label,
          `${prefix} renderer failed to load ${validatedUrl}: ` +
            `${errorDescription} (${errorCode}).`,
        );
      }
    },
  );
  webContents.on('preload-error', (_event, preloadPath, error) => {
    reportRendererFailure(
      label,
      `${prefix} preload failed at ${preloadPath}: ${error.stack ?? error.message}`,
    );
  });
  webContents.on('render-process-gone', (_event, details) => {
    if (details.reason !== 'clean-exit') {
      reportRendererFailure(
        label,
        `${prefix} renderer exited unexpectedly (${details.reason}, ` +
          `code ${details.exitCode}).`,
      );
    }
  });
}

async function verifyRendererBundle(
  browserWindow: BrowserWindow,
  label: string,
  prefix: string,
): Promise<void> {
  try {
    if (browserWindow.isDestroyed()) return;
    const ready = await browserWindow.webContents.executeJavaScript(
      RENDERER_READY_EXPRESSION,
      true,
    );
    if (ready !== true) {
      reportRendererFailure(
        label,
        `${prefix} renderer bundle did not publish its ready marker.`,
      );
      return;
    }
    console.log(`${prefix} renderer ready.`);
    markDemoSmokeRendererReady(label);
  } catch (error) {
    reportRendererFailure(
      label,
      `${prefix} could not verify the renderer bundle: ${errorMessage(error)}`,
    );
  }
}

function reportRendererFailure(label: string, message: string): void {
  console.error(message);
  failDemoSmoke(`renderer=${label}`);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
