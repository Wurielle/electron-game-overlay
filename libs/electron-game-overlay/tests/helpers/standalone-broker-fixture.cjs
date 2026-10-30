const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const { createHash } = require('node:crypto');
const fs = require('node:fs/promises');
const { createReadStream } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { promisify } = require('node:util');

const program = `
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const sea = require('node:sea');
const directory = sea.isSea() ? path.dirname(process.execPath) : __dirname;
const config = JSON.parse(fs.readFileSync(path.join(directory, 'fixture-config.json'), 'utf8'));
fs.appendFileSync(config.log, JSON.stringify({ version: config.version, pid: process.pid, inheritedHooks: Object.keys(process.env).filter(key => ['NODE_OPTIONS', 'NODE_PATH', 'ELECTRON_RUN_AS_NODE'].includes(key.toUpperCase())) }) + '\\n');
if (config.mode === 'exit') process.exit(7);
if (config.mode === 'stall') setInterval(() => {}, 1000);
else setTimeout(() => {
  const server = net.createServer(socket => {
    let input = Buffer.alloc(0);
    socket.on('error', () => {});
    socket.on('data', chunk => {
      input = Buffer.concat([input, chunk]);
      if (input.length < 5 || input.length < input.readUInt32LE(0) + 5) return;
      const hello = JSON.parse(input.subarray(5, 5 + input.readUInt32LE(0)));
      input = Buffer.alloc(0);
      if (hello.type !== 'broker.hello') return;
      const body = Buffer.from(JSON.stringify({ type: 'broker.welcome', protocolVersion: 1, brokerPid: process.pid, sessionId: 'fixture', capabilities: config.capabilities }));
      const header = Buffer.alloc(5); header.writeUInt32LE(body.length); header[4] = 1;
      socket.write(Buffer.concat([header, body]));
    });
  });
  server.listen({ path: process.env.ELECTRON_GAME_OVERLAY_BROKER_PIPE, exclusive: true });
}, config.delayMs);
setTimeout(() => process.exit(), 60000).unref();
`;

let built;
let work;
async function nativeFixture() {
  if (!built)
    built = (async () => {
      work = await fs.mkdtemp(path.join(tmpdir(), 'ego-sea-fixture-'));
      await fs.writeFile(path.join(work, 'main.cjs'), program);
      const executable = path.join(
        work,
        `fixture${process.platform === 'win32' ? '.exe' : ''}`,
      );
      const config = path.join(work, 'sea.json');
      await fs.writeFile(
        config,
        JSON.stringify({
          main: 'main.cjs',
          output: executable,
          disableExperimentalSEAWarning: true,
          useSnapshot: false,
          useCodeCache: false,
          execArgvExtension: 'none',
        }),
      );
      await promisify(childProcess.execFile)(
        process.execPath,
        ['--build-sea', config],
        { cwd: work, timeout: 120000 },
      );
      await fs.chmod(executable, 0o700);
      return executable;
    })();
  return built;
}

async function payloadIdentity(directory, relative) {
  const filename = path.join(directory, relative);
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filename)) hash.update(chunk);
  return {
    path: relative,
    size: (await fs.stat(filename)).size,
    sha256: hash.digest('hex'),
  };
}

async function writeFixtureDistribution(source, config, forceNative = false) {
  const executable = `electron-game-overlay-broker${process.platform === 'win32' ? '.exe' : ''}`;
  if (forceNative || process.platform === 'win32') {
    // Build once and reuse the generic executable; config, not the binary,
    // varies per case. Production still makes independent immutable cache copies.
    await fs.link(await nativeFixture(), path.join(source, executable));
  } else {
    await fs.writeFile(
      path.join(source, executable),
      `#!${process.execPath}\n${program}`,
      { mode: 0o700 },
    );
  }
  await fs.writeFile(
    path.join(source, 'fixture-config.json'),
    JSON.stringify(config),
  );
  await fs.writeFile(
    path.join(source, 'broker-manifest.json'),
    JSON.stringify({
      schema: 1,
      version: config.version,
      protocolMin: 1,
      protocolMax: 1,
      platform: process.platform,
      arch: process.arch,
      executable,
      files: await Promise.all(
        [executable, 'fixture-config.json'].map((file) =>
          payloadIdentity(source, file),
        ),
      ),
    }),
  );
}

async function disposeFixture() {
  if (work)
    await fs.rm(work, {
      recursive: true,
      force: true,
      maxRetries: 20,
      retryDelay: 100,
    });
}

function controlPrivilegeProbe() {
  if (process.platform !== 'win32') return () => {};
  const original = childProcess.execFile;
  const nativeFs = require('node:fs');
  const originalRealpath = nativeFs.realpath.native;
  nativeFs.realpath.native = function (input, callback) {
    if (input !== '\\\\?\\GLOBALROOT\\SystemRoot\\System32')
      return originalRealpath.apply(this, arguments);
    queueMicrotask(() => callback(null, 'Z:\\OS Installation\\System32'));
  };
  childProcess.execFile = function (file, args, options, callback) {
    if (file !== 'Z:\\OS Installation\\System32\\whoami.exe')
      return original.apply(this, arguments);
    assert.deepEqual(args, ['/groups', '/fo', 'csv', '/nh']);
    assert.equal(options.cwd, 'Z:\\OS Installation\\System32');
    assert.equal(options.shell, false);
    queueMicrotask(() =>
      callback(null, '"Mandatory Label","Label","S-1-16-8192",""'),
    );
  };
  return () => {
    childProcess.execFile = original;
    nativeFs.realpath.native = originalRealpath;
  };
}

module.exports = {
  writeFixtureDistribution,
  disposeFixture,
  controlPrivilegeProbe,
};
