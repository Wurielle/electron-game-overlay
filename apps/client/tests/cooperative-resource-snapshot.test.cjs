'use strict';
// Source/layout guards only. These tests do not execute C#, inspect a process,
// or establish actual SDK/native resource acceptance.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '../../..');
const filename = path.join(root, 'libs/electron-game-overlay-runtime/scripts/cooperative-resource-snapshot.ps1');
const source = fs.readFileSync(filename, 'utf8');
const header = fs.readFileSync(path.join(root, 'libs/electron-game-overlay-runtime/src/ego_cooperative_registry.hpp'), 'utf8');

test('resource observer matches the explicit current x64 registry layout and fails unknown layouts closed', () => {
  for (const declaration of [
    'constexpr std::uint32_t max_participants = 512;',
    'constexpr std::uint32_t max_windows = 8192;',
    'constexpr std::uint32_t max_surfaces = 512;',
    'sizeof(participant_entry) == (sizeof(void *) == 8 ? 96 : 64)',
    'sizeof(callbacks_v1) == (sizeof(void *) == 8 ? 72 : 40)',
    'offsetof(shared_state, participants) == 144',
    'sizeof(window_slot) == 80',
    'sizeof(rank_slot) == 32',
    'sizeof(frame_slot) == 16 && sizeof(input_decision) == 40 && sizeof(source_decision) == 32',
  ]) assert.ok(header.includes(declaration), `Canonical registry layout changed: ${declaration}`);
  assert.match(source, /const int MaxParticipants = 512, MaxWindows = 8192/u);
  assert.match(source, /const int ParticipantOffset = 144, ParticipantStride = 96/u);
  assert.match(source, /WindowOffset = ParticipantOffset \+ MaxParticipants \* ParticipantStride/u);
  assert.match(source, /FrameOffset = WindowOffset \+ MaxWindows \* 80/u);
  assert.match(source, /DecisionOffset = FrameOffset \+ 64 \* 16/u);
  assert.match(source, /SourceOffset = DecisionOffset \+ 8192 \* 40/u);
  assert.match(source, /RankOffset = SourceOffset \+ 8192 \* 32/u);
  assert.match(source, /WatermarkOffset = RankOffset \+ MaxWindows \* 32/u);
  assert.match(source, /RegistryBytes = SurfaceOffset \+ 512 \* 16/u);
  const bytes = 144 + 512 * 96 + 8192 * 80 + 64 * 16 + 8192 * 40 + 8192 * 32 + 8192 * 32 + 8 + 512 * 16;
  assert.equal(bytes, 1565848);
  assert.match(source, /U64\(data, 0\) != 0x3147455243504f45UL/u);
  assert.match(source, /U32\(data, 8\) != 1 \|\| U32\(data, 12\) != RegistryBytes \|\| U32\(data, 16\) != 64/u);
  assert.match(source, /offset \+ 24\)/u); // prepare_frame: id + context + callback header.
  assert.match(source, /offset \+ 92\)/u); // immutable lifetime reservation.
  assert.match(source, /U32\(data, offset \+ 88\)/u); // own interception.
});

test('observer reads existing state under a mutex without target mutation or eager native execution', () => {
  assert.match(source, /^function Get-CooperativeResourceSnapshot \{/mu);
  assert.ok(source.indexOf('Add-Type -TypeDefinition') > source.indexOf('function Get-CooperativeResourceSnapshot'));
  assert.match(source, /OpenMutex\(SYNCHRONIZE \| MUTEX_MODIFY_STATE, false/u);
  assert.match(source, /OpenFileMapping\(FILE_MAP_READ, false/u);
  assert.match(source, /MapViewOfFile\(mapping, FILE_MAP_READ/u);
  assert.match(source, /if \(status != WAIT_OBJECT_0\) throw/u);
  assert.match(source, /finally \{ if \(acquired\) ReleaseMutex\(mutex\); CloseHandle\(mutex\); \}/u);
  for (const forbidden of ['CreateFileMapping', 'CreateMutex', 'WriteProcessMemory', 'VirtualAllocEx', 'CreateRemoteThread', 'TerminateProcess', 'OpenProcess', 'PAGE_READWRITE', 'FILE_MAP_ALL_ACCESS']) assert.ok(!source.includes(forbidden), `${forbidden} must not be used by the observer`);
  assert.equal((source.match(/ValidateProcess\(process, processId, expectedCreation\);/gu) || []).length, 2);
  assert.match(source, /GetProcessId\(process\) != processId/u);
  assert.match(source, /actual != expectedCreation \|\| WaitForSingleObject\(process, 0\) != WAIT_TIMEOUT/u);
  assert.match(source, /description == "electron-overlay-frame"/u);
  assert.match(source, /description == "electron-overlay-tcp"/u);
  assert.match(source, /Participant callback does not belong to a mapped target module/u);
});
