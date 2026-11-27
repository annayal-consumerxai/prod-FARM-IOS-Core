import assert from 'node:assert/strict';
import test from 'node:test';

import { isWdaConnectionLost } from '../src/devices/wda/connection-lost.js';
import { resolveDeveloperDir } from '../src/devices/wda/xcode-env.js';

test('resolveDeveloperDir prefers XCODE_DEVELOPER_DIR', () => {
    assert.equal(resolveDeveloperDir({ XCODE_DEVELOPER_DIR: '/Applications/Xcode-beta.app/Contents/Developer' }, () => '/x'),
        '/Applications/Xcode-beta.app/Contents/Developer');
});

test('resolveDeveloperDir falls back to xcode-select, skipping Command Line Tools', () => {
    assert.equal(resolveDeveloperDir({}, () => '/Applications/Xcode_26.6.app/Contents/Developer'),
        '/Applications/Xcode_26.6.app/Contents/Developer');
    assert.equal(resolveDeveloperDir({}, () => '/Library/Developer/CommandLineTools'),
        '/Applications/Xcode.app/Contents/Developer');
    assert.equal(resolveDeveloperDir({ XCODE_DEVELOPER_DIR: ' ' }, () => undefined),
        '/Applications/Xcode.app/Contents/Developer');
});

test('isWdaConnectionLost spots a closed WDA port forward', () => {
    assert.equal(isWdaConnectionLost(new Error('Could not proxy command to the remote server. Original error: connect ECONNREFUSED 127.0.0.1:8101')), true);
    assert.equal(isWdaConnectionLost(new Error('socket hang up')), true);
    assert.equal(isWdaConnectionLost('read ECONNRESET'), true);
    assert.equal(isWdaConnectionLost(new Error('The Profile tap produced no visible screen change')), false);
});
