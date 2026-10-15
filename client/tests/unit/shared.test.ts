import { describe, expect, it } from 'vitest';
import { ClientEvents, ServerEvents } from '../../src/shared';

// These strings are the wire protocol between client and server; pinning them
// catches accidental renames that would silently break synchronization.
describe('shared event contracts', (): void => {
    it('pins the connection events', (): void => {
        expect(ServerEvents.Connection.Accepted).toBe('connection:accepted');
        expect(ServerEvents.Connection.Rejected).toBe('connection:rejected');
    });

    it('pins the waiting-room events', (): void => {
        expect(ServerEvents.WaitingRoom.Joined).toBe('waiting-room:joined');
        expect(ServerEvents.WaitingRoom.Left).toBe('waiting-room:left');
    });

    it('pins the cinema events', (): void => {
        expect(ClientEvents.Cinema.Play).toBe('cinema:play');
        expect(ClientEvents.Cinema.Pause).toBe('cinema:pause');
        expect(ClientEvents.Cinema.Seek).toBe('cinema:seek');

        expect(ServerEvents.Cinema.Joined).toBe('cinema:joined');
        expect(ServerEvents.Cinema.Left).toBe('cinema:left');
        expect(ServerEvents.Cinema.Users).toBe('cinema:users');
        expect(ServerEvents.Cinema.Playing).toBe('cinema:playing');
        expect(ServerEvents.Cinema.Paused).toBe('cinema:paused');
        expect(ServerEvents.Cinema.Seeked).toBe('cinema:seeked');
    });

    it('pins the admin events', (): void => {
        expect(ClientEvents.Admin.Kick).toBe('admin:kick');
        expect(ClientEvents.Admin.Ban).toBe('admin:ban');
        expect(ClientEvents.Admin.Approve).toBe('admin:approve');

        expect(ServerEvents.Admin.Added).toBe('admin:added');
        expect(ServerEvents.Admin.Left).toBe('admin:left');
        expect(ServerEvents.Admin.Users).toBe('admin:users');
        expect(ServerEvents.Admin.Kicked).toBe('admin:kicked');
        expect(ServerEvents.Admin.Banned).toBe('admin:banned');
        expect(ServerEvents.Admin.Approved).toBe('admin:approved');
    });
});
