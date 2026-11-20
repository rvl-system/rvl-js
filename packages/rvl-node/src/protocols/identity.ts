import { AppendBuffer } from '../buffer.ts';
import { isClockSynchronized, waitForClockSync } from '../clock.ts';
import {
  EVERY_DEVICE_ID,
  ID_REQUEST_TYPE,
  RVLI_PACKET_TYPE_ID_ASSIGNMENT,
  RVLI_PORT,
  UNASSIGNED_DEVICE_ID,
} from '../config.ts';
import { emit } from '../events.ts';
import { getAvailableInterfaces } from '../net.ts';
import {
  assertInitialized,
  getInterfaceAddress,
  getNetworkInterface,
  send,
} from '../transport.ts';
import { writeInfrastructureHeader } from './infrastructure.ts';

const IDENTITY_LOOP_INTERVAL = 250;
const ID_RETRY_INTERVAL = 1000;
const ID_RETRY_JITTER = 250;
const ID_REFRESH_INTERVAL = 10000;
const ID_WARNING_INTERVAL = 10000;

let deviceId: number | undefined;
// Whether connected has been announced and not yet taken back
let connected = false;
let nextIdRequestTime = 0;
let idRequested = false;
let lastIdRequestTime = 0;
let nextIdWarningTime = 0;

export function getDeviceId(): number | undefined {
  assertInitialized();
  return deviceId;
}

// Connected is being able to address the fleet and share its time: a device
// ID, which is only held while the interface has an address, and the first
// clock sync, which lasts
export function isConnected(): boolean {
  assertInitialized();
  return deviceId !== undefined && isClockSynchronized();
}

function announceIfConnected(): void {
  if (!connected && deviceId !== undefined && isClockSynchronized()) {
    connected = true;
    emit('connected');
  }
}

export function startIdentityProtocol(): void {
  const now = performance.now();
  nextIdRequestTime = now;
  nextIdWarningTime = now + ID_WARNING_INTERVAL;
  void waitForClockSync().then(announceIfConnected);
  runIdentityLoop();
  setInterval(runIdentityLoop, IDENTITY_LOOP_INTERVAL);
}

// A port of the firmware's ProtocolIdentity::loop(), with the interface
// having an IPv4 address standing in for the transport's link state. Only
// whether it has one matters, never which one
function runIdentityLoop(): void {
  const now = performance.now();
  const interfaceAddress = getInterfaceAddress();
  if (!interfaceAddress) {
    if (deviceId !== undefined) {
      deviceId = undefined;
      nextIdWarningTime = now + ID_WARNING_INTERVAL;
      if (connected) {
        connected = false;
        emit('disconnected');
      }
    }
    nextIdRequestTime = now;
    idRequested = false;
  } else if (now >= nextIdRequestTime) {
    if (!idRequested) {
      console.info('Requesting device ID');
      idRequested = true;
    }
    lastIdRequestTime = now;
    sendIdRequest();
    nextIdRequestTime =
      now + ID_RETRY_INTERVAL + Math.random() * ID_RETRY_JITTER;
  }

  if (now >= nextIdWarningTime) {
    nextIdWarningTime = now + ID_WARNING_INTERVAL;
    if (!interfaceAddress) {
      console.warn(
        `Waiting for ${getNetworkInterface()} to get an IPv4 address. ` +
          `Available interfaces: ${getAvailableInterfaces().join(', ')}`
      );
    } else if (deviceId === undefined) {
      console.warn(
        `No device ID from the coordinator yet. Is ${getNetworkInterface()} ` +
          `(${interfaceAddress.address}) on the fleet's network?`
      );
    } else {
      console.warn(
        `The coordinator has stopped answering device ID ${deviceId}. Is ` +
          `${getNetworkInterface()} (${interfaceAddress.address}) still on ` +
          `the fleet's network?`
      );
    }
  }
}

function sendIdRequest(): void {
  const packet = new AppendBuffer();
  writeInfrastructureHeader(
    packet,
    deviceId ?? UNASSIGNED_DEVICE_ID,
    RVLI_PACKET_TYPE_ID_ASSIGNMENT,
    EVERY_DEVICE_ID
  );
  packet.append8(ID_REQUEST_TYPE);
  void send(packet, RVLI_PORT);
}

export function handleIdReply(id: number): void {
  const now = performance.now();
  // Before the return for an unchanged ID, or every refresh would be retried
  // each second
  nextIdRequestTime = now + ID_REFRESH_INTERVAL;
  nextIdWarningTime = nextIdRequestTime + ID_WARNING_INTERVAL;
  if (id === deviceId) {
    return;
  }
  const roundTrip = now - lastIdRequestTime;
  console.info(
    `Assigned device ID ${id}, ${roundTrip.toFixed(1)} ms after the request`
  );
  deviceId = id;
  if (connected) {
    emit('deviceIdChanged');
  }
  announceIfConnected();
}
