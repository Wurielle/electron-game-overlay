type MultipleWindowsDemoApi = {
  getStatus(): Promise<string>;
  onStatus(listener: (status: string) => void): () => void;
};

const demo = (
  window as unknown as { multipleWindowsDemo: MultipleWindowsDemoApi }
).multipleWindowsDemo;
const panelName = new URLSearchParams(window.location.search).get('panel');
const title = document.querySelector<HTMLElement>('[data-title]');
const description = document.querySelector<HTMLElement>('[data-description]');
const status = document.querySelector<HTMLElement>('[data-status]');
const action = document.querySelector<HTMLButtonElement>('[data-action]');

if (!title || !description || !status || !action) {
  throw new Error('The multiple-windows demo markup is incomplete.');
}

if (panelName === 'telemetry') {
  document.body.dataset.panel = 'telemetry';
  title.textContent = 'Telemetry';
  description.textContent = 'A second independent Electron window.';
  action.textContent = 'Ping';
} else {
  document.body.dataset.panel = 'controls';
  title.textContent = 'Controls';
  description.textContent = 'The primary interactive overlay window.';
  action.textContent = 'Run action';
}

const setStatus = (nextStatus: string) => {
  status.textContent = nextStatus;
};

void demo.getStatus().then(setStatus);
demo.onStatus(setStatus);

let actions = 0;
action.addEventListener('click', () => {
  actions += 1;
  action.textContent = `${panelName === 'telemetry' ? 'Pings' : 'Actions'}: ${actions}`;
});
