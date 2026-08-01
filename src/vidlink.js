import nacl from "tweetnacl";

const KEY_HEX = "c75136c5668bbfe65a7ecad431a745db68b5f381555b38d8f6c699449cf11fcd";
const KEY = hexToBytes(KEY_HEX);

function hexToBytes(hex) {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.substring(i, i + 2), 16);
  }
  return bytes;
}

function bytesToBase64Url(bytes) {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function encryptVidlinkToken(mediaId, skewSec = 0) {
  const timestamp = Math.floor(Date.now() / 1000) + 480 + skewSec;
  const idBytes = new TextEncoder().encode(String(mediaId));
  const tsBuf = new Uint8Array(8);
  const view = new DataView(tsBuf.buffer);
  view.setUint32(0, Math.floor(timestamp / 0x100000000));
  view.setUint32(4, timestamp >>> 0);
  const message = new Uint8Array(idBytes.length + 8);
  message.set(idBytes);
  message.set(tsBuf, idBytes.length);
  const nonce = new Uint8Array(24);
  const encrypted = nacl.secretbox(message, nonce, KEY);
  const payload = new Uint8Array(24 + encrypted.length);
  payload.set(nonce);
  payload.set(encrypted, 24);
  return bytesToBase64Url(payload);
}
