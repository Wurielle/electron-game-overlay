const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const crypto = require('node:crypto');
const {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  ExistingReShadeInstallationError,
  existingReShadeAddonFileName,
  existingReShadeAddonMarkerFileName,
  existingReShadeAddonTransactionFileName,
  inspectLoadedOfficialReShadeAddon,
  prepareExistingReShadeAddon,
  removeOwnedExistingReShadeAddon,
} = require('../dist/lib/existing-reshade-installation.js');

const addonAbiExportName = 'ElectronGameOverlayReShadeAddonAbi';
const managerResultKind = 'electron-game-overlay-reshade-addon-manager-result';

const createPeX64 = (identity) => {
  const bytes = Buffer.alloc(512);
  bytes.write('MZ', 0, 'ascii');
  bytes.writeUInt32LE(0x80, 0x3c);
  bytes.write('PE\0\0', 0x80, 'ascii');
  bytes.writeUInt16LE(0x8664, 0x84);
  bytes.write(identity, 0x100, 'utf8');
  return bytes;
};

const createAddonPeX64 = (
  identity,
  { exportName = addonAbiExportName, abiValue = 1 } = {},
) => {
  const bytes = Buffer.alloc(0x600);
  const peOffset = 0x80;
  const fileHeaderOffset = peOffset + 4;
  const optionalHeaderOffset = fileHeaderOffset + 20;
  const optionalHeaderSize = 0xf0;
  const sectionTableOffset = optionalHeaderOffset + optionalHeaderSize;

  bytes.write('MZ', 0, 'ascii');
  bytes.writeUInt32LE(peOffset, 0x3c);
  bytes.write('PE\0\0', peOffset, 'ascii');
  bytes.writeUInt16LE(0x8664, fileHeaderOffset);
  bytes.writeUInt16LE(1, fileHeaderOffset + 2);
  bytes.writeUInt16LE(optionalHeaderSize, fileHeaderOffset + 16);
  bytes.writeUInt16LE(0x2022, fileHeaderOffset + 18);
  bytes.writeUInt16LE(0x20b, optionalHeaderOffset);
  bytes.writeUInt32LE(0x200, optionalHeaderOffset + 60);
  bytes.writeUInt32LE(16, optionalHeaderOffset + 108);
  bytes.writeUInt32LE(0x1000, optionalHeaderOffset + 112);
  bytes.writeUInt32LE(0x100, optionalHeaderOffset + 116);
  bytes.write('.rdata\0\0', sectionTableOffset, 'ascii');
  bytes.writeUInt32LE(0x400, sectionTableOffset + 8);
  bytes.writeUInt32LE(0x1000, sectionTableOffset + 12);
  bytes.writeUInt32LE(0x400, sectionTableOffset + 16);
  bytes.writeUInt32LE(0x200, sectionTableOffset + 20);

  const exportDirectoryOffset = 0x200;
  bytes.writeUInt32LE(1, exportDirectoryOffset + 16);
  bytes.writeUInt32LE(1, exportDirectoryOffset + 20);
  bytes.writeUInt32LE(1, exportDirectoryOffset + 24);
  bytes.writeUInt32LE(0x1040, exportDirectoryOffset + 28);
  bytes.writeUInt32LE(0x1044, exportDirectoryOffset + 32);
  bytes.writeUInt32LE(0x1048, exportDirectoryOffset + 36);
  bytes.writeUInt32LE(0x1200, 0x240);
  bytes.writeUInt32LE(0x1060, 0x244);
  bytes.writeUInt16LE(0, 0x248);
  bytes.write(`${exportName}\0`, 0x260, 'ascii');
  bytes.writeUInt32LE(abiValue, 0x400);
  bytes.write(identity, 0x480, 'utf8');
  return bytes;
};

const runtimeV1Bytes = createPeX64('arbitrary-reshade-v1');
const runtimeV2Bytes = createPeX64('arbitrary-reshade-v2');

const sha256 = (bytes) =>
  crypto.createHash('sha256').update(bytes).digest('hex').toUpperCase();

const createFixture = (runtimeBytes = runtimeV1Bytes) => {
  const rootDirectory = mkdtempSync(
    path.join(tmpdir(), 'electron-game-overlay-existing-reshade-'),
  );
  const gameDirectory = path.join(rootDirectory, 'game');
  const sourceDirectory = path.join(rootDirectory, 'sdk');
  mkdirSync(gameDirectory);
  mkdirSync(sourceDirectory);

  const targetExecutablePath = path.join(gameDirectory, 'game.exe');
  const reshadeModulePath = path.join(gameDirectory, 'dxgi.dll');
  const addonSourcePath = path.join(
    sourceDirectory,
    existingReShadeAddonFileName,
  );
  const managerExecutablePath = path.join(
    sourceDirectory,
    'electron_game_overlay_reshade_manager.exe',
  );
  writeFileSync(targetExecutablePath, createPeX64('target-game'));
  writeFileSync(reshadeModulePath, runtimeBytes);
  writeFileSync(addonSourcePath, createAddonPeX64('addon-current'));
  writeFileSync(managerExecutablePath, createPeX64('native-manager'));
  writeFileSync(path.join(gameDirectory, 'ReShade.ini'), 'preserve=true\n');
  writeFileSync(path.join(gameDirectory, 'foreign.addon64'), 'foreign\n');

  return {
    rootDirectory,
    gameDirectory,
    targetExecutablePath,
    reshadeModulePath,
    addonSourcePath,
    managerExecutablePath,
    targetEffectiveSettings: {
      reshadeBasePath: gameDirectory,
      addonDirectoryPath: gameDirectory,
      electronGameOverlayAddonDisabled: false,
    },
    dispose: () => rmSync(rootDirectory, { recursive: true, force: true }),
  };
};

const snapshotTree = (rootDirectory) => {
  const entries = [];
  const visit = (directoryPath) => {
    for (const entry of readdirSync(directoryPath, { withFileTypes: true })) {
      const entryPath = path.join(directoryPath, entry.name);
      const relativePath = path
        .relative(rootDirectory, entryPath)
        .split(path.sep)
        .join('/');
      if (entry.isDirectory()) {
        entries.push(`D|${relativePath}`);
        visit(entryPath);
      } else {
        entries.push(`F|${relativePath}|${sha256(readFileSync(entryPath))}`);
      }
    }
  };
  visit(rootDirectory);
  return entries.sort();
};

const optionValue = (arguments_, name) => {
  const index = arguments_.indexOf(name);
  assert.notEqual(index, -1, `missing manager argument ${name}`);
  return arguments_[index + 1];
};

const managerSuccess = (
  arguments_,
  {
    status = 'installed',
    addonSha256,
    previousAddonSha256 = null,
    recoveredTransaction = false,
  } = {},
) => {
  const operation = arguments_[0];
  const directory = optionValue(arguments_, '--directory');
  const sourceHash =
    operation === 'remove' ? null : optionValue(arguments_, '--source-sha256');
  const reshadeModulePath = optionValue(arguments_, '--reshade-module');
  const reshadeModuleSha256 = optionValue(
    arguments_,
    '--reshade-module-sha256',
  );
  const inferredAddonSha256 =
    addonSha256 === undefined
      ? status === 'not-installed' ||
        status === 'foreign-collision' ||
        status === 'transaction-pending'
        ? null
        : status === 'update-required' || status === 'owned-tampered'
          ? 'B'.repeat(64)
          : sourceHash
      : addonSha256;
  const restartRequired =
    operation !== 'inspect' ||
    status === 'update-required' ||
    status === 'transaction-pending';
  return `${JSON.stringify({
    schemaVersion: 1,
    kind: managerResultKind,
    operation,
    status,
    addonPath: path.join(directory, existingReShadeAddonFileName),
    markerPath: path.join(directory, existingReShadeAddonMarkerFileName),
    addonSha256: inferredAddonSha256,
    expectedAddonSha256: sourceHash,
    previousAddonSha256:
      status === 'updated' || status === 'removed'
        ? (previousAddonSha256 ?? 'C'.repeat(64))
        : previousAddonSha256,
    reshadeModulePath,
    reshadeModuleSha256,
    recoveredTransaction,
    restartRequired,
  })}\n`;
};

const stubManager = (respond) => {
  const originalExecFile = childProcess.execFile;
  const calls = [];
  childProcess.execFile = (executable, arguments_, options, callback) => {
    const call = { executable, arguments: arguments_, options };
    calls.push(call);
    queueMicrotask(() => {
      const response = respond(call);
      callback(
        response.error ?? null,
        response.stdout ?? '',
        response.stderr ?? '',
      );
    });
    return {};
  };
  return {
    calls,
    restore() {
      childProcess.execFile = originalExecFile;
    },
  };
};

const assertOperationError = async (operation, code) => {
  await assert.rejects(operation, (error) => {
    assert.equal(error instanceof ExistingReShadeInstallationError, true);
    assert.equal(error.code, code);
    return true;
  });
};

test('prepares only the reserved add-on through the exact native-manager request', async () => {
  const fixture = createFixture();
  const before = snapshotTree(fixture.rootDirectory);
  const manager = stubManager(({ arguments: arguments_ }) => ({
    stdout: managerSuccess(arguments_),
  }));
  try {
    const result = await prepareExistingReShadeAddon(fixture);

    assert.equal(result.status, 'installed');
    assert.equal(result.reshadeModuleSha256, sha256(runtimeV1Bytes));
    assert.equal(result.restartRequired, true);
    assert.equal(result.addonDirectoryPath, fixture.gameDirectory);
    assert.equal(
      result.addonDestinationPath,
      path.join(fixture.gameDirectory, existingReShadeAddonFileName),
    );
    assert.deepEqual(snapshotTree(fixture.rootDirectory), before);
    assert.equal(manager.calls.length, 1);
    const call = manager.calls[0];
    assert.equal(call.executable, fixture.managerExecutablePath);
    assert.deepEqual(call.arguments, [
      'prepare',
      '--directory',
      fixture.gameDirectory,
      '--source',
      fixture.addonSourcePath,
      '--source-sha256',
      sha256(readFileSync(fixture.addonSourcePath)),
      '--reshade-module',
      fixture.reshadeModulePath,
      '--reshade-module-sha256',
      sha256(runtimeV1Bytes),
    ]);
    assert.equal(call.options.windowsHide, true);
    assert.equal(call.options.timeout, 30_000);
    assert.equal(call.options.maxBuffer, 64 * 1024);
  } finally {
    manager.restore();
    fixture.dispose();
  }
});

test('maps native already-current and updated results without claiming a process load', async (t) => {
  for (const status of ['already-current', 'updated']) {
    await t.test(status, async () => {
      const fixture = createFixture();
      const manager = stubManager(({ arguments: arguments_ }) => ({
        stdout: managerSuccess(arguments_, { status }),
      }));
      try {
        const result = await prepareExistingReShadeAddon(fixture);
        assert.equal(result.status, status);
        assert.equal(result.currentProcessLoadState, 'unknown');
        assert.equal(result.restartRequired, true);
        if (status === 'updated') {
          assert.equal(result.previousAddonSha256, 'C'.repeat(64));
        }
      } finally {
        manager.restore();
        fixture.dispose();
      }
    });
  }
});

test('respects target-effective DisabledAddons without invoking the manager', async () => {
  const fixture = createFixture();
  const manager = stubManager(() => {
    throw new Error('manager must not run');
  });
  try {
    const result = await prepareExistingReShadeAddon({
      ...fixture,
      targetEffectiveSettings: {
        ...fixture.targetEffectiveSettings,
        electronGameOverlayAddonDisabled: true,
      },
    });
    assert.equal(result.status, 'disabled-by-user');
    assert.equal(result.restartRequired, false);
    assert.equal(manager.calls.length, 0);
  } finally {
    manager.restore();
    fixture.dispose();
  }
});

test('prepares arbitrary x64 ReShade identities through the same manager boundary', async (t) => {
  for (const [name, runtimeBytes] of [
    ['first identity', runtimeV1Bytes],
    ['second identity', runtimeV2Bytes],
  ]) {
    await t.test(name, async () => {
      const fixture = createFixture(runtimeBytes);
      const before = snapshotTree(fixture.rootDirectory);
      const manager = stubManager(({ arguments: arguments_ }) => ({
        stdout: managerSuccess(arguments_),
      }));
      try {
        const result = await prepareExistingReShadeAddon(fixture);
        assert.equal(result.status, 'installed');
        assert.equal(result.reshadeModuleSha256, sha256(runtimeBytes));
        assert.equal(result.restartRequired, true);
        assert.deepEqual(snapshotTree(fixture.rootDirectory), before);
        assert.equal(manager.calls.length, 1);
        assert.equal(manager.calls[0].arguments[0], 'prepare');
        assert.equal(
          optionValue(manager.calls[0].arguments, '--reshade-module-sha256'),
          sha256(runtimeBytes),
        );
      } finally {
        manager.restore();
        fixture.dispose();
      }
    });
  }
});

test('a changed ReShade identity keeps the current owned add-on managed', async () => {
  const fixture = createFixture(runtimeV2Bytes);
  const addonDestinationPath = path.join(
    fixture.gameDirectory,
    existingReShadeAddonFileName,
  );
  const ownershipMarkerPath = path.join(
    fixture.gameDirectory,
    existingReShadeAddonMarkerFileName,
  );
  cpSync(fixture.addonSourcePath, addonDestinationPath);
  writeFileSync(ownershipMarkerPath, '{"owned":"fixture"}\n');
  const before = snapshotTree(fixture.rootDirectory);
  const manager = stubManager(({ arguments: arguments_ }) => ({
    stdout: managerSuccess(arguments_, {
      status: 'already-current',
    }),
  }));
  try {
    const preparation = await prepareExistingReShadeAddon(fixture);
    assert.equal(preparation.status, 'already-current');
    assert.equal(preparation.reshadeModuleSha256, sha256(runtimeV2Bytes));
    assert.equal(preparation.addonDestinationPath, addonDestinationPath);
    assert.equal(preparation.ownershipMarkerPath, ownershipMarkerPath);
    assert.equal(preparation.restartRequired, true);
    assert.deepEqual(snapshotTree(fixture.rootDirectory), before);
    assert.equal(manager.calls.length, 1);
    assert.equal(manager.calls[0].arguments[0], 'prepare');
  } finally {
    manager.restore();
    fixture.dispose();
  }
});

test('explicit owned add-on removal accepts an arbitrary ReShade identity', async () => {
  const fixture = createFixture(runtimeV2Bytes);
  const manager = stubManager(({ arguments: arguments_ }) => ({
    stdout: managerSuccess(arguments_, { status: 'removed' }),
  }));
  try {
    const removal = await removeOwnedExistingReShadeAddon(fixture);
    assert.equal(removal.status, 'removed');
    assert.equal(removal.previousAddonSha256, 'C'.repeat(64));
    assert.deepEqual(manager.calls[0].arguments, [
      'remove',
      '--directory',
      fixture.gameDirectory,
      '--reshade-module',
      fixture.reshadeModulePath,
      '--reshade-module-sha256',
      sha256(runtimeV2Bytes),
    ]);
  } finally {
    manager.restore();
    fixture.dispose();
  }
});

test('a valid pending transaction is recovered during version-agnostic preparation', async () => {
  const fixture = createFixture(runtimeV2Bytes);
  const transactionPath = path.join(
    fixture.gameDirectory,
    existingReShadeAddonTransactionFileName,
  );
  writeFileSync(transactionPath, '{"pending":"fixture"}\n');
  const before = snapshotTree(fixture.rootDirectory);
  const manager = stubManager(({ arguments: arguments_ }) => ({
    stdout: managerSuccess(arguments_, {
      status: 'already-current',
      recoveredTransaction: true,
    }),
  }));
  try {
    const preparation = await prepareExistingReShadeAddon(fixture);
    assert.equal(preparation.status, 'already-current');
    assert.equal(preparation.reshadeModuleSha256, sha256(runtimeV2Bytes));
    assert.equal(preparation.restartRequired, true);
    assert.deepEqual(snapshotTree(fixture.rootDirectory), before);
    assert.equal(manager.calls.length, 1);
    assert.equal(manager.calls[0].arguments[0], 'prepare');
  } finally {
    manager.restore();
    fixture.dispose();
  }
});

test('a foreign pending transaction remains preserved and does not authorize cleanup', async () => {
  const fixture = createFixture(runtimeV2Bytes);
  const transactionPath = path.join(
    fixture.gameDirectory,
    existingReShadeAddonTransactionFileName,
  );
  writeFileSync(transactionPath, '{"foreign":"fixture"}\n');
  const before = snapshotTree(fixture.rootDirectory);
  const manager = stubManager(() => ({
    error: Object.assign(new Error('preserved'), { code: 5 }),
    stdout: `${JSON.stringify({
      schemaVersion: 1,
      kind: managerResultKind,
      operation: 'prepare',
      status: 'error',
      code: 'transaction-invalid',
      message: 'reserved journal is foreign',
      windowsError: null,
    })}\n`,
  }));
  try {
    await assertOperationError(
      () => prepareExistingReShadeAddon(fixture),
      'write-race',
    );
    assert.deepEqual(snapshotTree(fixture.rootDirectory), before);
    assert.equal(manager.calls.length, 1);
    assert.equal(manager.calls[0].arguments[0], 'prepare');
  } finally {
    manager.restore();
    fixture.dispose();
  }
});

test('requires the exact x64 add-on ABI before starting the native manager', async () => {
  const fixture = createFixture();
  writeFileSync(
    fixture.addonSourcePath,
    createAddonPeX64('wrong-abi', { abiValue: 2 }),
  );
  const manager = stubManager(() => {
    throw new Error('manager must not run');
  });
  try {
    await assertOperationError(
      () => prepareExistingReShadeAddon(fixture),
      'addon-source-invalid',
    );
    assert.equal(manager.calls.length, 0);
  } finally {
    manager.restore();
    fixture.dispose();
  }
});

test('refuses target-effective path escape and directory reparse points before mutation', async (t) => {
  await t.test('BasePath escape', async () => {
    const fixture = createFixture();
    const outside = path.join(fixture.rootDirectory, 'outside');
    mkdirSync(outside);
    try {
      await assertOperationError(
        () =>
          prepareExistingReShadeAddon({
            ...fixture,
            targetEffectiveSettings: {
              ...fixture.targetEffectiveSettings,
              reshadeBasePath: outside,
            },
          }),
        'configured-path-escape',
      );
    } finally {
      fixture.dispose();
    }
  });

  await t.test('AddonPath junction', async (context) => {
    const fixture = createFixture();
    const realDirectory = path.join(fixture.gameDirectory, 'real-addons');
    const junctionPath = path.join(fixture.gameDirectory, 'linked-addons');
    mkdirSync(realDirectory);
    try {
      try {
        symlinkSync(realDirectory, junctionPath, 'junction');
      } catch (error) {
        if (error?.code === 'EPERM') {
          context.skip('junction creation requires Windows developer mode');
          return;
        }
        throw error;
      }
      await assertOperationError(
        () =>
          prepareExistingReShadeAddon({
            ...fixture,
            targetEffectiveSettings: {
              ...fixture.targetEffectiveSettings,
              addonDirectoryPath: junctionPath,
            },
          }),
        'path-reparse-point',
      );
    } finally {
      fixture.dispose();
    }
  });
});

test('rejects malformed, contradictory, timed-out, and foreign manager outcomes', async (t) => {
  const scenarios = [
    {
      name: 'malformed JSON',
      response: () => ({ stdout: '{bad-json}\n' }),
      code: 'manager-invalid',
    },
    {
      name: 'contradictory prepare status',
      response: ({ arguments: arguments_ }) => ({
        stdout: managerSuccess(arguments_, {
          status: 'update-required',
        }),
      }),
      code: 'manager-invalid',
    },
    {
      name: 'timeout',
      response: () => ({
        error: Object.assign(new Error('timed out'), {
          code: 'ETIMEDOUT',
          killed: true,
        }),
      }),
      code: 'manager-timeout',
    },
    {
      name: 'foreign collision',
      response: ({ arguments: arguments_ }) => ({
        error: Object.assign(new Error('preserved'), { code: 3 }),
        stdout: `${JSON.stringify({
          schemaVersion: 1,
          kind: managerResultKind,
          operation: 'prepare',
          status: 'error',
          code: 'foreign-addon-collision',
          message: 'reserved path is foreign',
          windowsError: null,
        })}\n`,
      }),
      code: 'foreign-addon-collision',
    },
    {
      name: 'native write race',
      response: () => ({
        error: Object.assign(new Error('preserved'), { code: 5 }),
        stdout: `${JSON.stringify({
          schemaVersion: 1,
          kind: managerResultKind,
          operation: 'prepare',
          status: 'error',
          code: 'write-race',
          message: 'managed file changed during the transaction',
          windowsError: null,
        })}\n`,
      }),
      code: 'write-race',
    },
    {
      name: 'ReShade module changed',
      response: () => ({
        error: Object.assign(new Error('preserved'), { code: 5 }),
        stdout: `${JSON.stringify({
          schemaVersion: 1,
          kind: managerResultKind,
          operation: 'prepare',
          status: 'error',
          code: 'reshade-module-changed',
          message: 'ReShade changed after verification',
          windowsError: null,
        })}\n`,
      }),
      code: 'file-changed',
    },
  ];

  for (const scenario of scenarios) {
    await t.test(scenario.name, async () => {
      const fixture = createFixture();
      const manager = stubManager(scenario.response);
      try {
        await assertOperationError(
          () => prepareExistingReShadeAddon(fixture),
          scenario.code,
        );
      } finally {
        manager.restore();
        fixture.dispose();
      }
    });
  }
});

test('accepts an arbitrary loaded ReShade host only when native inspection proves the exact current add-on generation', async () => {
  const fixture = createFixture(runtimeV2Bytes);
  const loadedAddonModulePath = path.join(
    fixture.gameDirectory,
    existingReShadeAddonFileName,
  );
  cpSync(fixture.addonSourcePath, loadedAddonModulePath);
  const manager = stubManager(({ arguments: arguments_ }) => ({
    stdout: managerSuccess(arguments_, {
      status: 'already-current',
    }),
  }));
  try {
    const result = await inspectLoadedOfficialReShadeAddon({
      ...fixture,
      loadedAddonModulePath,
    });
    assert.equal(result.status, 'already-current');
    assert.equal(result.reshadeModuleSha256, sha256(runtimeV2Bytes));
    assert.equal(result.loadedAddonModulePath, loadedAddonModulePath);
    assert.equal(result.restartRequired, false);
    assert.equal(manager.calls[0].arguments[0], 'inspect');
  } finally {
    manager.restore();
    fixture.dispose();
  }
});

test('returns a valid read-only update-required state but refuses wrong effective loaded paths', async () => {
  const fixture = createFixture();
  const loadedAddonModulePath = path.join(
    fixture.gameDirectory,
    existingReShadeAddonFileName,
  );
  writeFileSync(loadedAddonModulePath, createAddonPeX64('addon-old'));
  const manager = stubManager(({ arguments: arguments_ }) => ({
    stdout: managerSuccess(arguments_, {
      status: 'update-required',
    }),
  }));
  try {
    const result = await inspectLoadedOfficialReShadeAddon({
      ...fixture,
      loadedAddonModulePath,
    });
    assert.equal(result.status, 'update-required');
    assert.equal(result.restartRequired, true);

    const otherDirectory = path.join(fixture.gameDirectory, 'other');
    mkdirSync(otherDirectory);
    await assertOperationError(
      () =>
        inspectLoadedOfficialReShadeAddon({
          ...fixture,
          loadedAddonModulePath,
          targetEffectiveSettings: {
            ...fixture.targetEffectiveSettings,
            addonDirectoryPath: otherDirectory,
          },
        }),
      'target-module-mismatch',
    );
  } finally {
    manager.restore();
    fixture.dispose();
  }
});
