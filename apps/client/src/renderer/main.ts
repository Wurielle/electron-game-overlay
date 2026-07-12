import { ipcRenderer, IpcRendererEvent } from "electron";

type DemoState = {
  overlayStarted: boolean;
  inputIntercepting: boolean;
  hudhookBackend: "d3d11" | "d3d12" | null;
  windows: Record<string, boolean>;
};

const overlayWindows = {
  main: "example-main-overlay",
  status: "example-status-overlay",
  video: "example-video-overlay",
};

const windowTitleStorageKey = "demo.windowTitle";
const demoStateChangedChannel = "overlay:state-changed";
const inputInterceptAccelerator = "Ctrl+I";

let state: DemoState = {
  overlayStarted: false,
  inputIntercepting: false,
  hudhookBackend: null,
  windows: {},
};

const startButton = document.getElementById("start") as HTMLButtonElement;
const interceptButton = document.getElementById(
  "intercept"
) as HTMLButtonElement;
const injectButton = document.getElementById("inject") as HTMLButtonElement;
const popupButton = document.getElementById(
  "show-popup-overlay"
) as HTMLButtonElement;
const mainOverlayButton = document.getElementById(
  "toggle-main-overlay"
) as HTMLButtonElement;
const statusOverlayButton = document.getElementById(
  "toggle-status-overlay"
) as HTMLButtonElement;
const videoOverlayButton = document.getElementById(
  "toggle-video-overlay"
) as HTMLButtonElement;
const titleInput = document.getElementById("title") as HTMLInputElement;
const statusElement = document.getElementById("status") as HTMLDivElement;
const imageElem = document.getElementById("image") as HTMLImageElement;

titleInput.value =
  localStorage.getItem(windowTitleStorageKey) ?? titleInput.value;

startButton.addEventListener("click", async () => {
  await updateState(ipcRenderer.invoke("overlay:start"));
});

interceptButton.addEventListener("click", async () => {
  await updateState(
    ipcRenderer.invoke(
      "overlay:set-input-intercept",
      !state.inputIntercepting
    )
  );
});

injectButton.addEventListener("click", async () => {
  const title = titleInput.value.trim();
  if (!title) {
    return;
  }

  injectButton.disabled = true;
  statusElement.classList.remove("error");
  statusElement.textContent = `Attaching to ${title}...`;
  try {
    await updateState(ipcRenderer.invoke("overlay:inject", title));
    statusElement.textContent = `Connected to ${title} with ${state.hudhookBackend?.toUpperCase()}`;
  } catch (error) {
    statusElement.classList.add("error");
    statusElement.textContent = getErrorMessage(error);
  } finally {
    injectButton.disabled = state.hudhookBackend === null;
  }
});

mainOverlayButton.addEventListener("click", () => {
  toggleOverlayWindow(overlayWindows.main);
});

statusOverlayButton.addEventListener("click", () => {
  toggleOverlayWindow(overlayWindows.status);
});

videoOverlayButton.addEventListener("click", () => {
  toggleOverlayWindow(overlayWindows.video);
});

popupButton.addEventListener("click", () => {
  ipcRenderer.send("showExamplePopupOverlay");
});

titleInput.addEventListener("input", () => {
  localStorage.setItem(windowTitleStorageKey, titleInput.value);
});

ipcRenderer.on(
  "exampleMainOverlayImage",
  (event: IpcRendererEvent, arg: { image: string }) => {
    const { image } = arg;
    // imageElem.onload = function() {
    //   context.clearRect(0, 0, canvas.width, canvas.height)
    //   context.drawImage(
    //     imageElem,
    //     0,
    //     0,
    //     imageElem.width,
    //     imageElem.height,
    //     0,
    //     0,
    //     canvas.width,
    //     canvas.height
    //   )
    // }
    imageElem.src = image;
  }
);

ipcRenderer.on(
  demoStateChangedChannel,
  (event: IpcRendererEvent, nextState: DemoState) => {
    state = nextState;
    renderState();
  }
);

window.onfocus = function () {
  console.log("focus");
};
window.onblur = function () {
  console.log("blur");
};

void updateState(ipcRenderer.invoke("overlay:get-state"));

async function toggleOverlayWindow(name: string) {
  await updateState(
    ipcRenderer.invoke(
      "overlay:set-window-visible",
      name,
      !state.windows[name]
    )
  );
}

async function updateState(statePromise: Promise<DemoState>) {
  state = await statePromise;
  renderState();
}

function renderState() {
  startButton.classList.toggle("active", state.overlayStarted);
  interceptButton.classList.toggle("active", state.inputIntercepting);
  injectButton.disabled = state.hudhookBackend === null;

  startButton.textContent = state.overlayStarted
    ? "Session running"
    : "Start session";
  interceptButton.textContent = state.inputIntercepting
    ? `Release input (${inputInterceptAccelerator})`
    : `Intercept input (${inputInterceptAccelerator})`;

  renderOverlayButton(mainOverlayButton, overlayWindows.main, "main overlay");
  renderOverlayButton(
    statusOverlayButton,
    overlayWindows.status,
    "status overlay"
  );
  renderOverlayButton(videoOverlayButton, overlayWindows.video, "video overlay");

  statusElement.classList.remove("error");
  statusElement.textContent = state.hudhookBackend
    ? `${state.overlayStarted ? "Session ready" : "Session idle"} · ${state.hudhookBackend.toUpperCase()}`
    : "Injection disabled: restart the client with a Hudhook backend";
}

function getErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function renderOverlayButton(
  button: HTMLButtonElement,
  windowName: string,
  label: string
) {
  const visible = Boolean(state.windows[windowName]);
  button.classList.toggle("active", visible);
  button.textContent = `${visible ? "Hide" : "Show"} ${label}`;
}
