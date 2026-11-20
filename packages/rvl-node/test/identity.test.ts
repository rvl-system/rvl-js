import { expect, test, vi } from 'vitest';

import {
  DEFAULT_INTERFACES,
  ipv4,
  loadNode,
  setInterfaces,
  startNode,
} from './harness.ts';
import { buildIdReply, buildIdRequest, RVLI_PORT } from './packets.ts';

test('an ID request goes out at init', async () => {
  const node = await startNode();
  expect(node.sent()).toHaveLength(1);
  expect(node.sent()[0].bytes).toEqual(buildIdRequest());
  expect(node.sent()[0].port).toBe(RVLI_PORT);
  expect(node.identity.isConnected()).toBe(false);
  expect(node.identity.getDeviceId()).toBeUndefined();
});

test('the request is repeated every second or so until a reply, then 10 s after it', async () => {
  const node = await startNode();
  await node.advance(999);
  expect(node.sent()).toHaveLength(1);
  await node.advance(251);
  expect(node.sent()).toHaveLength(2);
  await node.advance(1250);
  expect(node.sent()).toHaveLength(3);
  node.assignId(7);
  await node.advance(9999);
  expect(node.sent()).toHaveLength(3);
  await node.advance(1);
  expect(node.sent()).toHaveLength(4);
});

// A reply that left the timer alone would have each refresh retried a second
// later
test('a refresh carries the held ID, and an answered one waits another 10 s', async () => {
  const node = await startNode();
  node.assignId(7);
  await node.advance(10000);
  expect(node.sent()).toHaveLength(2);
  expect(node.sent()[1].bytes).toEqual(buildIdRequest(7));
  node.assignId(7);
  await node.advance(9999);
  expect(node.sent()).toHaveLength(2);
  await node.advance(1);
  expect(node.sent()).toHaveLength(3);
});

test('an unanswered refresh keeps the ID and is retried every second or so', async () => {
  const node = await startNode();
  node.assignId(7);
  await node.advance(10000);
  expect(node.sent()).toHaveLength(2);
  await node.advance(999);
  expect(node.sent()).toHaveLength(2);
  await node.advance(251);
  expect(node.sent()).toHaveLength(3);
  expect(node.sent()[2].bytes).toEqual(buildIdRequest(7));
  expect(node.identity.getDeviceId()).toBe(7);
});

test('a refresh answered with another ID takes it', async () => {
  const node = await startNode();
  node.assignId(7);
  await node.advance(10000);
  node.assignId(8);
  expect(node.identity.getDeviceId()).toBe(8);
  await node.advance(10000);
  expect(node.sent()).toHaveLength(3);
  expect(node.sent()[2].bytes).toEqual(buildIdRequest(8));
});

// Connected means the fleet can be addressed and its clock followed, so it
// waits for whichever of the ID and the first sync comes second
test('a reply assigns the ID, and the clock completes the connection', async () => {
  const node = await startNode();
  const connected = vi.fn();
  node.events.on('connected', connected);
  node.assignId(7);
  expect(node.identity.getDeviceId()).toBe(7);
  expect(node.identity.isConnected()).toBe(false);
  expect(connected).not.toHaveBeenCalled();
  await node.syncClock();
  expect(node.identity.isConnected()).toBe(true);
  expect(connected).toHaveBeenCalledTimes(1);
  node.assignId(7);
  expect(connected).toHaveBeenCalledTimes(1);
  // A changed ID while connected is taken without a second connected
  node.assignId(8);
  expect(node.identity.getDeviceId()).toBe(8);
  expect(connected).toHaveBeenCalledTimes(1);
});

// No payload, so the new ID has to be in place when the listener runs
test('a changed ID while connected emits deviceIdChanged, and a repeated one does not', async () => {
  const node = await startNode();
  const seen: (number | undefined)[] = [];
  node.events.on('deviceIdChanged', () => {
    seen.push(node.identity.getDeviceId());
  });
  node.assignId(7);
  await node.syncClock();
  node.assignId(7);
  expect(seen).toEqual([]);
  node.assignId(8);
  node.assignId(8);
  expect(seen).toEqual([8]);
});

// Nothing shows an ID before the clock has synced, and an ID lost with the
// address comes back as a connection
test('an ID changed before connecting, or across a lost address, emits no deviceIdChanged', async () => {
  const node = await startNode();
  const changed = vi.fn();
  node.events.on('deviceIdChanged', changed);
  node.assignId(7);
  node.assignId(8);
  await node.syncClock();
  setInterfaces({});
  await node.advance(250);
  setInterfaces(DEFAULT_INTERFACES);
  await node.advance(250);
  node.assignId(9);
  expect(node.identity.getDeviceId()).toBe(9);
  expect(changed).not.toHaveBeenCalled();
});

test('the clock first, then the ID, connects just the same', async () => {
  const node = await startNode();
  const connected = vi.fn();
  node.events.on('connected', connected);
  await node.syncClock();
  expect(node.identity.isConnected()).toBe(false);
  expect(connected).not.toHaveBeenCalled();
  node.assignId(7);
  expect(node.identity.isConnected()).toBe(true);
  expect(connected).toHaveBeenCalledTimes(1);
});

test('replies that are not a reply to this node are dropped', async () => {
  const node = await startNode();
  node.assignId(10);
  const other = buildIdReply(11);
  const badSignature = Buffer.from(other);
  badSignature[3] = 0x58;
  const otherVersion = Buffer.from(other);
  otherVersion[4] = 2;
  for (const packet of [
    buildIdReply(11, 255),
    buildIdReply(11, 10),
    badSignature,
    otherVersion,
    other.subarray(0, 9),
    Buffer.concat([other, Buffer.from([0])]),
    buildIdReply(240),
    // Another node's request, which is the same RVLI type with the request
    // subtype
    buildIdRequest(30),
  ]) {
    node.deliver(packet);
    expect(node.identity.getDeviceId()).toBe(10);
  }
  node.deliver(other);
  expect(node.identity.getDeviceId()).toBe(11);
});

test('losing the address disconnects, and the ID is requested again on return', async () => {
  const node = await startNode();
  const connected = vi.fn();
  const disconnected = vi.fn();
  node.events.on('connected', connected);
  node.events.on('disconnected', disconnected);
  node.assignId(7);
  await node.syncClock();
  expect(connected).toHaveBeenCalledTimes(1);
  setInterfaces({});
  await node.advance(250);
  expect(disconnected).toHaveBeenCalledTimes(1);
  expect(node.identity.isConnected()).toBe(false);
  expect(node.identity.getDeviceId()).toBeUndefined();
  await node.advance(5000);
  expect(node.sent()).toHaveLength(1);

  setInterfaces(DEFAULT_INTERFACES);
  await node.advance(250);
  expect(node.sent()).toHaveLength(2);
  expect(node.sent()[1].bytes).toEqual(buildIdRequest());
  // The clock stays synced, so the ID alone reconnects
  node.assignId(9);
  expect(connected).toHaveBeenCalledTimes(2);
  expect(node.identity.getDeviceId()).toBe(9);
});

test('losing the address before the clock synced is no disconnection', async () => {
  const node = await startNode();
  const disconnected = vi.fn();
  node.events.on('disconnected', disconnected);
  node.assignId(7);
  setInterfaces({});
  await node.advance(250);
  expect(node.identity.getDeviceId()).toBeUndefined();
  expect(disconnected).not.toHaveBeenCalled();
});

test('a missing ID is warned about every ten seconds', async () => {
  const node = await startNode();
  await node.advance(9999);
  expect(node.warn).not.toHaveBeenCalled();
  await node.advance(1);
  expect(node.warn).toHaveBeenCalledTimes(1);
  expect(node.warn.mock.calls[0][0]).toMatch(/No device ID/);
  await node.advance(9999);
  expect(node.warn).toHaveBeenCalledTimes(1);
  await node.advance(1);
  expect(node.warn).toHaveBeenCalledTimes(2);
  node.assignId(7);
  await node.advance(10000);
  expect(node.warn).toHaveBeenCalledTimes(2);
});

// Counted from the first unanswered request, not the last reply: a refresh
// goes out 10 s after a reply by design
test('a coordinator that stops answering is warned about every ten seconds', async () => {
  const node = await startNode();
  node.assignId(7);
  await node.advance(19999);
  expect(node.warn).not.toHaveBeenCalled();
  await node.advance(1);
  expect(node.warn).toHaveBeenCalledTimes(1);
  expect(node.warn.mock.calls[0][0]).toMatch(
    /stopped answering device ID 7\. Is en0 \(192\.168\.4\.5\)/
  );
  await node.advance(10000);
  expect(node.warn).toHaveBeenCalledTimes(2);
  expect(node.identity.getDeviceId()).toBe(7);
  node.assignId(7);
  await node.advance(19999);
  expect(node.warn).toHaveBeenCalledTimes(2);
  await node.advance(1);
  expect(node.warn).toHaveBeenCalledTimes(3);
});

test('a missing address is warned about instead', async () => {
  const node = await loadNode({
    interfaces: { en0: [], en1: [ipv4('10.1.2.3')] },
  });
  node.rvl.init({ networkInterface: 'en0' });
  await node.advance(0);
  expect(node.sent()).toHaveLength(0);
  await node.advance(10000);
  expect(node.warn).toHaveBeenCalledTimes(1);
  expect(node.warn.mock.calls[0][0]).toMatch(/Waiting for en0.*en1/);
});
