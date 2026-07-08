import { BrowserWindow, screen } from "electron";
import { AppWindows } from "./window-names";

type NativeOverlay = any;

type OverlayHostOptions = {
  getWindow: (name: string) => Electron.BrowserWindow | null;
  isQuitting: () => boolean;
  onShowExampleVideoOverlay: () => void;
};

export class OverlayHost {
  private scaleFactor = 1.0;

  constructor(
    private readonly overlay: NativeOverlay,
    private readonly options: OverlayHostOptions
  ) {}

  public initializeScaleFactor() {
    this.scaleFactor = screen.getDisplayNearestPoint({
      x: 0,
      y: 0,
    }).scaleFactor;
  }

  public start() {
    this.overlay.start();
    this.overlay.setHotkeys([
      {
        name: "overlay.hotkey.toggleInputIntercept",
        keyCode: 113,
        modifiers: { ctrl: true },
      },
      {
        name: "app.showExampleVideoOverlay",
        keyCode: 114,
        modifiers: { ctrl: true },
      },
    ]);

    this.overlay.setEventCallback((event: string, payload: any) => {
      this.handleEvent(event, payload);
    });
  }

  public stop() {
    this.overlay.stop();
  }

  public addWindow(
    name: string,
    window: Electron.BrowserWindow,
    dragborder: number = 0,
    captionHeight: number = 0,
    transparent: boolean = false
  ) {
    const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());

    this.overlay.addWindow(window.id, {
      name,
      transparent,
      resizable: window.isResizable(),
      maxWidth: window.isResizable()
        ? display.bounds.width
        : window.getBounds().width,
      maxHeight: window.isResizable()
        ? display.bounds.height
        : window.getBounds().height,
      minWidth: window.isResizable() ? 100 : window.getBounds().width,
      minHeight: window.isResizable() ? 100 : window.getBounds().height,
      nativeHandle: window.getNativeWindowHandle().readUInt32LE(0),
      rect: {
        x: window.getBounds().x,
        y: window.getBounds().y,
        width: Math.floor(window.getBounds().width * this.scaleFactor),
        height: Math.floor(window.getBounds().height * this.scaleFactor),
      },
      caption: {
        left: Math.floor(dragborder * this.scaleFactor),
        right: Math.floor(dragborder * this.scaleFactor),
        top: Math.floor(dragborder * this.scaleFactor),
        height: Math.floor(captionHeight * this.scaleFactor),
      },
      dragBorderWidth: Math.floor(dragborder),
    });

    window.webContents.on(
      "paint",
      (event, dirty, image: Electron.NativeImage) => {
        if (this.options.isQuitting()) {
          return;
        }
        this.overlay.sendFrameBuffer(
          window.id,
          image.getBitmap(),
          image.getSize().width,
          image.getSize().height
        );
      }
    );

    window.on("ready-to-show", () => {
      window.focusOnWebView();
    });

    window.on("resize", () => {
      console.log(`${name} resizing`);
      this.overlay.sendWindowBounds(window.id, {
        rect: {
          x: window.getBounds().x,
          y: window.getBounds().y,
          width: Math.floor(window.getBounds().width * this.scaleFactor),
          height: Math.floor(window.getBounds().height * this.scaleFactor),
        },
      });
    });

    const windowId = window.id;
    window.on("closed", () => {
      this.overlay.closeWindow(windowId);
    });

    window.webContents.on("cursor-changed", (event, type) => {
      let cursor;
      switch (type) {
        case "default":
          cursor = "IDC_ARROW";
          break;
        case "pointer":
          cursor = "IDC_HAND";
          break;
        case "crosshair":
          cursor = "IDC_CROSS";
          break;
        case "text":
          cursor = "IDC_IBEAM";
          break;
        case "wait":
          cursor = "IDC_WAIT";
          break;
        case "help":
          cursor = "IDC_HELP";
          break;
        case "move":
          cursor = "IDC_SIZEALL";
          break;
        case "nwse-resize":
          cursor = "IDC_SIZENWSE";
          break;
        case "nesw-resize":
          cursor = "IDC_SIZENESW";
          break;
        case "ns-resize":
          cursor = "IDC_SIZENS";
          break;
        case "ew-resize":
          cursor = "IDC_SIZEWE";
          break;
        case "none":
          cursor = "";
          break;
      }
      this.overlay.sendCommand({ command: "cursor", cursor });
    });
  }

  public injectProcessByTitle(title: string) {
    console.log(`--------------------\n try inject ${title}`);
    for (const window of this.overlay.getTopWindows()) {
      if (window.title.indexOf(title) !== -1) {
        console.log(`--------------------\n injecting ${JSON.stringify(window)}`);
        this.overlay.injectProcess(window);
      }
    }
  }

  public setInputIntercept(intercept: boolean) {
    this.overlay.sendCommand({
      command: "input.intercept",
      intercept,
    });
  }

  private handleEvent(event: string, payload: any) {
    if (event === "game.input") {
      this.forwardGameInput(payload);
    } else if (event === "graphics.fps") {
      const window = this.options.getWindow(AppWindows.exampleStatusOverlay);
      if (window) {
        window.webContents.send("fps", payload.fps);
      }
    } else if (event === "game.hotkey.down") {
      if (payload.name === "app.showExampleVideoOverlay") {
        this.options.onShowExampleVideoOverlay();
      }
    } else if (event === "game.window.focused") {
      console.log("focusWindowId", payload.focusWindowId);

      BrowserWindow.getAllWindows().forEach((window) => {
        window.blurWebView();
      });

      const focusWin = BrowserWindow.fromId(payload.focusWindowId);
      if (focusWin) {
        focusWin.focusOnWebView();
      }
    }
  }

  private forwardGameInput(payload: any) {
    const window = BrowserWindow.fromId(payload.windowId);
    if (!window) {
      return;
    }

    const inputEvent = this.overlay.translateInputEvent(payload);
    if (!inputEvent) {
      return;
    }

    if ("x" in inputEvent) {
      inputEvent.x = Math.round(inputEvent.x / this.scaleFactor);
    }
    if ("y" in inputEvent) {
      inputEvent.y = Math.round(inputEvent.y / this.scaleFactor);
    }

    window.webContents.sendInputEvent(inputEvent);
  }
}
