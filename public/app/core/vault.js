import { base64url } from './oauth.js';
const STORAGE_KEY = 'cb.vault';
const ITERATIONS = 600_000;
function fromB64url(s) {
    const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/'));
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++)
        out[i] = bin.charCodeAt(i);
    return out;
}
async function deriveKey(passphrase, salt, iterations) {
    const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(passphrase), 'PBKDF2', false, ['deriveKey']);
    return crypto.subtle.deriveKey({ name: 'PBKDF2', salt, iterations, hash: 'SHA-256' }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}
export async function seal(creds, passphrase, iterations = ITERATIONS) {
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const key = await deriveKey(passphrase, salt, iterations);
    const data = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(JSON.stringify(creds)));
    const blob = { v: 1, salt: base64url(salt), iv: base64url(iv), data: base64url(new Uint8Array(data)) };
    return JSON.stringify(blob);
}
export async function open(sealed, passphrase, iterations = ITERATIONS) {
    const blob = JSON.parse(sealed);
    const key = await deriveKey(passphrase, fromB64url(blob.salt), iterations);
    try {
        const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromB64url(blob.iv) }, key, fromB64url(blob.data));
        return JSON.parse(new TextDecoder().decode(plain));
    }
    catch {
        throw new Error('Wrong passphrase.');
    }
}
export function hasStored(storage = localStorage) {
    try {
        return storage.getItem(STORAGE_KEY) !== null;
    }
    catch {
        return false;
    }
}
export async function store(creds, passphrase, storage = localStorage) {
    storage.setItem(STORAGE_KEY, await seal(creds, passphrase));
}
export async function unlock(passphrase, storage = localStorage) {
    const sealed = storage.getItem(STORAGE_KEY);
    if (!sealed)
        throw new Error('Nothing stored.');
    return open(sealed, passphrase);
}
export function forget(storage = localStorage) {
    try {
        storage.removeItem(STORAGE_KEY);
    }
    catch {
        /* storage unavailable */
    }
}
