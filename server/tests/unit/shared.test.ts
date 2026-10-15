import { describe, expect, it } from 'vitest';
import { ServerEvents } from '../../src/shared/index.js';

// These strings are the wire protocol between client and server; pinning them
// catches accidental renames that would silently break synchronization.
describe('shared event contracts', (): void => {
    it('pins the connection events', (): void => {
        expect(ServerEvents.Connection.Accepted).toBe('connection:accepted');
        expect(ServerEvents.Connection.Rejected).toBe('connection:rejected');
    });

    it('pins the cinema room events', (): void => {
        expect(ServerEvents.Cinema.Users).toBe('cinema:users');
        expect(ServerEvents.Cinema.Joined).toBe('cinema:joined');
        expect(ServerEvents.Cinema.Left).toBe('cinema:left');
    });
});
