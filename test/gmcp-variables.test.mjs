import test from 'node:test';
import assert from 'node:assert/strict';

class CustomEventMock {
  constructor(type, options = {}) {
    this.type = type;
    this.detail = options.detail;
  }
}

function createLocalStorage() {
  const values = new Map();
  return {
    getItem(key) {
      return values.has(key) ? values.get(key) : null;
    },
    setItem(key, value) {
      values.set(key, String(value));
    },
    removeItem(key) {
      values.delete(key);
    },
    clear() {
      values.clear();
    },
  };
}

globalThis.CustomEvent = CustomEventMock;
globalThis.window = { dispatchEvent() {} };
globalThis.localStorage = createLocalStorage();

const { aliasManager } = await import('../public/js/alias-manager.js');
const {
  getGmcpVariables,
  listGmcpVariables,
  registerGmcpVariables,
  resetGmcpVariables,
} = await import('../public/js/gmcp-variables.js');

test('GMCP messages flatten into automation variables', () => {
  resetGmcpVariables();
  registerGmcpVariables('Char.Vitals', {
    hp: 42,
    maxhp: 100,
    opponent: {
      name: 'a test target',
      hp: 7,
    },
  });

  const variables = getGmcpVariables();
  assert.equal(variables.gmcp_char_vitals_hp, '42');
  assert.equal(variables.gmcp_char_vitals_maxhp, '100');
  assert.equal(variables.gmcp_char_vitals_opponent_name, 'a test target');
  assert.equal(variables.gmcp_char_vitals_opponent_hp, '7');
  assert.equal(JSON.parse(variables.gmcp_char_vitals).hp, 42);
});

test('GMCP arrays expose indexed variables', () => {
  resetGmcpVariables();
  registerGmcpVariables('Comm.Channel.List', [
    { name: 'gossip', command: 'gossip' },
    { name: 'shout', command: 'shout' },
  ]);

  const variables = getGmcpVariables();
  assert.equal(variables.gmcp_comm_channel_list_0_name, 'gossip');
  assert.equal(variables.gmcp_comm_channel_list_1_command, 'shout');
  assert.equal(JSON.parse(variables.gmcp_comm_channel_list)[0].name, 'gossip');
});

test('GMCP variables reset and list in sorted order', () => {
  resetGmcpVariables();
  registerGmcpVariables('Room.Info', { name: 'The Crossroads', num: 100 });

  assert.deepEqual(
    listGmcpVariables().map((entry) => entry.name),
    ['gmcp_room_info', 'gmcp_room_info_name', 'gmcp_room_info_num'],
  );

  resetGmcpVariables();
  assert.deepEqual(getGmcpVariables(), {});
});

test('saved automation variables override matching GMCP variable names', () => {
  const scopeKey = 'ws://test:4242';
  localStorage.clear();
  resetGmcpVariables();
  aliasManager._data = { scopes: {} };

  registerGmcpVariables('Char.Vitals', { hp: 42 });
  aliasManager.saveScope(scopeKey, {
    aliases: [],
    variables: {
      gmcp_char_vitals_hp: 'manual',
    },
  });

  assert.equal(aliasManager.getAutomationVariables(scopeKey).gmcp_char_vitals_hp, 'manual');
});

test('GMCP frames are flattened on read, latest payload per package, and stay cumulative across reads', () => {
  resetGmcpVariables();
  registerGmcpVariables('Char.Vitals', { hp: 10, stale: 1 });
  registerGmcpVariables('Char.Vitals', { hp: 20 });
  registerGmcpVariables('Room.Info', { num: 7 });
  const first = getGmcpVariables();
  assert.equal(first.gmcp_char_vitals_hp, '20', 'the newer payload wins before the first read');
  assert.equal(first.gmcp_char_vitals_stale, undefined, 'keys only in an older unread payload are not kept');
  assert.equal(first.gmcp_room_info_num, '7');
  registerGmcpVariables('Char.Vitals', { sp: 5 });
  const second = getGmcpVariables();
  assert.equal(second.gmcp_char_vitals_hp, '20', 'variables flattened by an earlier read survive later frames');
  assert.equal(second.gmcp_char_vitals_sp, '5');
  assert.deepEqual(listGmcpVariables().map((entry) => entry.name).slice(0, 2), ['gmcp_char_vitals', 'gmcp_char_vitals_hp']);
  resetGmcpVariables();
  assert.deepEqual(getGmcpVariables(), {}, 'reset drops queued frames too');
});
