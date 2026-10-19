/**
 * Optional "remember in this browser" for the CoinTracking key and secret.
 * They are encrypted with AES-GCM under a key derived from a passphrase (PBKDF2, SHA-256).
 * Without the passphrase the stored blob is useless.
 */
import type { CtCredentials } from './cointracking';
import { base64url } from './oauth';

const STORAGE_KEY = 'cb.vault';
const ITERATIONS = 600_000;

interface Blob {
  v: 1;
  salt: string;
  iv: string;
  data: string;
}

function fromB64url(s: string): Uint8Array<ArrayBuffer> {
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/'));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function deriveKey(passphrase: string, salt: Uint8Array<ArrayBuffer>, iterations: number): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(passphrase), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

export async function seal(creds: CtCredentials, passphrase: string, iterations = ITERATIONS): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(passphrase, salt, iterations);
  const data = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(JSON.stringify(creds)));
  const blob: Blob = { v: 1, salt: base64url(salt), iv: base64url(iv), data: base64url(new Uint8Array(data)) };
  return JSON.stringify(blob);
}

export async function open(sealed: string, passphrase: string, iterations = ITERATIONS): Promise<CtCredentials> {
  const blob = JSON.parse(sealed) as Blob;
  const key = await deriveKey(passphrase, fromB64url(blob.salt), iterations);
  try {
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromB64url(blob.iv) }, key, fromB64url(blob.data));
    return JSON.parse(new TextDecoder().decode(plain)) as CtCredentials;
  } catch {
    throw new Error('Wrong passphrase.');
  }
}

export function hasStored(storage: Storage = localStorage): boolean {
  try {
    return storage.getItem(STORAGE_KEY) !== null;
  } catch {
    return false;
  }
}

export async function store(creds: CtCredentials, passphrase: string, storage: Storage = localStorage): Promise<void> {
  storage.setItem(STORAGE_KEY, await seal(creds, passphrase));
}

export async function unlock(passphrase: string, storage: Storage = localStorage): Promise<CtCredentials> {
  const sealed = storage.getItem(STORAGE_KEY);
  if (!sealed) throw new Error('Nothing stored.');
  return open(sealed, passphrase);
}

export function forget(storage: Storage = localStorage): void {
  try {
    storage.removeItem(STORAGE_KEY);
  } catch {
    /* storage unavailable */
  }
}
