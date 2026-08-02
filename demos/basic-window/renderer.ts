type BasicWindowDemoApi = {
  getStatus(): Promise<string>;
  onStatus(listener: (status: string) => void): () => void;
};

const demo = (window as unknown as { basicWindowDemo: BasicWindowDemoApi })
  .basicWindowDemo;
const statusElement = document.querySelector<HTMLElement>('[data-status]');
const counterElement = document.querySelector<HTMLElement>('[data-count]');
const countButton =
  document.querySelector<HTMLButtonElement>('[data-count-up]');

if (!statusElement || !counterElement || !countButton) {
  throw new Error('The basic-window demo markup is incomplete.');
}

const setStatus = (status: string) => {
  statusElement.textContent = status;
};

void demo.getStatus().then(setStatus);
demo.onStatus(setStatus);

let count = 0;
countButton.addEventListener('click', () => {
  count += 1;
  counterElement.textContent = String(count);
});
