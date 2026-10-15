import { describe, expect, it } from 'vitest';
import { ClientEvents, ServerEvents } from '../../src/shared';

// These strings are the wire protocol between client and server; pinning them
// catches accidental renames that would silently break synchronization.
describe('shared event contracts', (): void => {
    it('pins the connection events', (): void => {
        expect(ServerEvents.Connection.Accepted).toBe('connection:accepted');
        expect(ServerEvents.Connection.Rejected).toBe('connection:rejected');
    });

    it('pins the cinema playback events', (): void => {
        expect(ClientEvents.Cinema.Play).toBe('cinema:play');
        expect(ClientEvents.Cinema.Pause).toBe('cinema:pause');
        expect(ClientEvents.Cinema.Seek).toBe('cinema:seek');

        expect(ServerEvents.Cinema.Playing).toBe('cinema:playing');
        expect(ServerEvents.Cinema.Paused).toBe('cinema:paused');
        expect(ServerEvents.Cinema.Seeked).toBe('cinema:seeked');
    });
});
