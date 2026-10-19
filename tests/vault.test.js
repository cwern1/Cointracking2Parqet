import { describe, it, afterEach } from 'node:test';
import { expect, vi } from './helpers/expect.js';
import { open, seal } from '../public/app/core/vault.js';
describe('credential vault', () => {
    it('round-trips with the right passphrase and fails with a wrong one', async () => {
        const sealed = await seal({ key: 'k', secret: 's' }, 'correct horse', 1000);
        expect(sealed).not.toContain('"s"');
        expect(await open(sealed, 'correct horse', 1000)).toEqual({ key: 'k', secret: 's' });
        await expect(open(sealed, 'wrong', 1000)).rejects.toThrow('Wrong passphrase.');
    });
});
