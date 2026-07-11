import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  buildHudhookInvocation,
  parseHudhookLaunchConfig,
} from '../src/main/electron/hudhook-launch.ts';

const temporaryDirectories = new Set();

test.afterEach(() => {
  for (const directory of temporaryDirectories) {
    rmSync(directory, { force: true, recursive: true });
  }
  temporaryDirectories.clear();
});

test('hudhook stays disabled without the explicit startup opt-in', () => {
  assert.equal(
    parseHudhookLaunchConfig([
      'electron.exe',
      '--hudhook-backend=d3d11',
      '--hudhook-runtime-dir=ignored',
    ]),
    null,
  );
});

for (const [backend, payloadName] of [
  ['d3d11', 'hudhook_imgui_overlay_dx11.dll'],
  ['d3d12', 'hudhook_imgui_overlay_dx12.dll'],
]) {
  test(`${backend} derives the matching staged payload and no-shell argv`, () => {
    const runtimeDirectory = createRuntime(payloadName);
    const processName = `${backend}_overlay_test_host.exe`;
    const config = parseHudhookLaunchConfig([
      'electron.exe',
      '--hudhook-overlay',
      `--hudhook-backend=${backend}`,
      `--hudhook-runtime-dir=${runtimeDirectory}`,
      `--hudhook-auto-target-process=${processName}`,
      '--hudhook-expected-target-pid=4242',
    ]);

    assert.ok(config);
    assert.equal(config.backend, backend);
    assert.equal(
      path.basename(config.injectorPath),
      'hudhook_overlay_injector.exe',
    );
    assert.equal(path.basename(config.payloadPath), payloadName);
    assert.equal(config.autoTargetProcess, processName);
    assert.equal(config.expectedTargetPid, 4242);

    assert.deepEqual(buildHudhookInvocation(config, { processName }), {
      executable: config.injectorPath,
      arguments: [
        '--process',
        processName,
        '--backend',
        backend,
        '--dll',
        config.payloadPath,
      ],
      targetLabel: `process:${processName}`,
    });
  });
}

test('startup parsing rejects incomplete, duplicate, and unsafe options', () => {
  const runtimeDirectory = createRuntime('hudhook_imgui_overlay_dx11.dll');
  const valid = [
    'electron.exe',
    '--hudhook-overlay',
    '--hudhook-backend=d3d11',
    `--hudhook-runtime-dir=${runtimeDirectory}`,
    '--hudhook-auto-target-process=game.exe',
  ];

  assert.throws(
    () => parseHudhookLaunchConfig([...valid, '--hudhook-overlay']),
    /exactly once/,
  );
  assert.throws(
    () =>
      parseHudhookLaunchConfig([
        ...valid.filter(
          (argument) => !argument.startsWith('--hudhook-auto-target-process='),
        ),
        '--hudhook-expected-target-pid=42',
      ]),
    /expected-target-pid.*requires.*auto-target-process/,
  );
  assert.throws(
    () =>
      parseHudhookLaunchConfig(
        valid.map((argument) =>
          argument === '--hudhook-backend=d3d11'
            ? '--hudhook-backend=vulkan'
            : argument,
        ),
      ),
    /d3d11 or d3d12/,
  );
  assert.throws(
    () =>
      parseHudhookLaunchConfig(
        valid.map((argument) =>
          argument === '--hudhook-auto-target-process=game.exe'
            ? '--hudhook-auto-target-process=..\\game.exe'
            : argument,
        ),
      ),
    /\.exe basename/,
  );
  assert.throws(
    () =>
      parseHudhookLaunchConfig([...valid, '--hudhook-expected-target-pid=0']),
    /positive integer/,
  );
});

test('a window title remains one injector argument even with metacharacters', () => {
  const runtimeDirectory = createRuntime('hudhook_imgui_overlay_dx11.dll');
  const config = parseHudhookLaunchConfig([
    'electron.exe',
    '--hudhook-overlay',
    '--hudhook-backend=d3d11',
    `--hudhook-runtime-dir=${runtimeDirectory}`,
  ]);
  assert.ok(config);

  const title = 'Offline game & echo never-runs';
  const invocation = buildHudhookInvocation(config, { windowTitle: title });
  assert.deepEqual(invocation.arguments.slice(0, 2), ['--title', title]);
});

function createRuntime(payloadName) {
  const directory = mkdtempSync(path.join(tmpdir(), 'hudhook-client-launch-'));
  temporaryDirectories.add(directory);
  writeFileSync(path.join(directory, 'hudhook_overlay_injector.exe'), 'test');
  writeFileSync(path.join(directory, payloadName), 'test');
  return directory;
}
