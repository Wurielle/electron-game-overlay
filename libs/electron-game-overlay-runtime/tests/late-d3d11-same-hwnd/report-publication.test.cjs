'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

// These source guards pin the Win32 ownership boundary. Actual filesystem
// contention and the controlled host are exercised by the coordinated runner.
const source = fs.readFileSync(path.join(__dirname, 'host.cpp'), 'utf8');
const code = source.replace(/\/\*[\s\S]*?\*\/|\/\/[^\r\n]*|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/g,
  value => value.replace(/[^\r\n]/g, ' '));
function body(name) {
  const signature = new RegExp(`\\bbool\\s+${name}\\s*\\([^)]*\\)\\s*\\{`, 'm').exec(code);
  assert.ok(signature, `Missing native report boundary ${name}`);
  const start = signature.index + signature[0].length;
  let depth = 1;
  for (let end = start; end < code.length; end++) {
    if (code[end] === '{') depth++;
    if (code[end] === '}' && --depth === 0) return code.slice(start, end);
  }
  assert.fail(`Unbalanced native report boundary ${name}`);
}

test('report ownership is based on exact regular-file handle identity and final path', () => {
  const identify = body('identify_owned_report_file');
  assert.match(identify, /GetFileType\s*\(\s*file\s*\)\s*!=\s*FILE_TYPE_DISK/);
  assert.match(identify, /GetFileInformationByHandle\s*\(\s*file\s*,\s*&information\s*\)/);
  assert.match(identify, /FILE_ATTRIBUTE_DIRECTORY\s*\|\s*FILE_ATTRIBUTE_REPARSE_POINT\s*\|\s*FILE_ATTRIBUTE_READONLY/);
  assert.match(identify, /information\.nNumberOfLinks\s*!=\s*1/);
  assert.match(identify, /GetFinalPathNameByHandleW[\s\S]*FILE_NAME_NORMALIZED\s*\|\s*VOLUME_NAME_DOS/);
  assert.match(identify, /_wcsicmp\s*\(\s*actual\.c_str\s*\(\s*\)\s*,\s*expected_path\.c_str\s*\(\s*\)\s*\)\s*!=\s*0/);
  const verify = body('verify_owned_report_file');
  assert.match(verify, /OPEN_EXISTING\s*,\s*FILE_FLAG_OPEN_REPARSE_POINT/);
  assert.match(verify, /actual\.volume_serial\s*==\s*expected\.volume_serial\s*&&\s*actual\.index_high\s*==\s*expected\.index_high\s*&&\s*actual\.index_low\s*==\s*expected\.index_low/);
});

test('first publication cannot replace an unknown destination and later publications require the last owned identity', () => {
  const verify = body('verify_atomic_report_files');
  assert.match(verify, /verify_owned_report_file\s*\(\s*temporary\s*,\s*temporary_identity\s*\)/);
  assert.match(verify, /if\s*\(\s*g_published_report_identity\.valid\s*\)\s*\{\s*if\s*\(\s*!verify_owned_report_file\s*\(\s*g_options\.report\s*,\s*g_published_report_identity\s*\)\s*\)\s*return\s+false/);
  assert.match(verify, /if\s*\(\s*require_existing_destination\s*\)\s*\{\s*SetLastError\s*\(\s*ERROR_FILE_INVALID\s*\)\s*;\s*return\s+false/);
  assert.match(verify, /attributes\s*==\s*INVALID_FILE_ATTRIBUTES\s*&&\s*GetLastError\s*\(\s*\)\s*==\s*ERROR_FILE_NOT_FOUND\s*\)\s*return\s+true/);
  const publish = body('write_report');
  assert.ok(publish.indexOf('identify_owned_report_file(output, temporary, temporary_identity)') < publish.indexOf('WriteFile(output'));
  assert.match(publish, /MoveFileExW\s*\([^;]*\)\s*!=\s*FALSE\s*\)\s*\{\s*g_published_report_identity\s*=\s*temporary_identity\s*;\s*return\s+true/);
});

test('a permanent DELETE access denial cannot be relabeled as transient reader contention', () => {
  const verify = body('verify_atomic_report_files');
  assert.match(verify, /return\s*!require_existing_destination\s*\|\|\s*\(\s*verify_owned_report_delete_access\s*\(\s*temporary\s*,\s*temporary_identity\s*\)\s*&&\s*verify_owned_report_delete_access\s*\(\s*g_options\.report\s*,\s*g_published_report_identity\s*\)/);
  const access = body('verify_owned_report_delete_access');
  assert.match(access, /verify_owned_report_file\s*\(\s*path\s*,\s*expected\s*,\s*DELETE\s*\|\s*FILE_READ_ATTRIBUTES\s*\)/);
  assert.match(access, /return\s+GetLastError\s*\(\s*\)\s*==\s*ERROR_SHARING_VIOLATION\s*&&\s*verify_owned_report_file\s*\(\s*path\s*,\s*expected\s*\)/);
  assert.doesNotMatch(access, /ERROR_ACCESS_DENIED/);
});

test('ACCESS_DENIED retries require verified owned temp and destination and keep the existing 50ms bound', () => {
  const publish = body('write_report');
  assert.match(publish, /for\s*\(\s*unsigned\s+attempt\s*=\s*0\s*;\s*attempt\s*!=\s*26\s*;\s*\+\+attempt\s*\)/);
  assert.match(publish, /if\s*\(\s*!verify_atomic_report_files\s*\(\s*temporary\s*,\s*temporary_identity\s*,\s*false\s*\)\s*\)\s*\{[^}]*break\s*;\s*\}\s*if\s*\(\s*MoveFileExW/);
  assert.match(publish, /verified_access_contention\s*=\s*error\s*==\s*ERROR_ACCESS_DENIED\s*&&\s*verify_atomic_report_files\s*\(\s*temporary\s*,\s*temporary_identity\s*,\s*true\s*\)/);
  assert.match(publish, /error\s*!=\s*ERROR_SHARING_VIOLATION\s*&&\s*error\s*!=\s*ERROR_LOCK_VIOLATION\s*&&\s*!verified_access_contention/);
  assert.match(publish, /attempt\s*==\s*25\s*\)\s*break\s*;\s*\+\+g_evidence\.report_publication_retries\s*;\s*Sleep\s*\(\s*2\s*\)/);
  assert.match(publish, /if\s*\(\s*verify_owned_report_file\s*\(\s*temporary\s*,\s*temporary_identity\s*\)\s*\)\s*static_cast<void>\s*\(\s*DeleteFileW\s*\(\s*temporary\.c_str\s*\(\s*\)\s*\)\s*\)/);
  assert.doesNotMatch(code, /\b(?:SetFileAttributesW?|SetFileSecurityW?|SetNamedSecurityInfoW?|SetSecurityInfo|SetEntriesInAclW?)\s*\(/);
});
