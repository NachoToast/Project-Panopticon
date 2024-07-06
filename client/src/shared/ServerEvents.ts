import { BaseUser } from './BaseUser.js';

export const enum Connection {
    Accepted = 'connection:accepted',

    Rejected = 'connection:rejected',
}

export const enum WaitingRoom {
    Joined = 'waiting-room:joined',

    Left = 'waiting-room:left',
}

export const enum Cinema {
    Joined = 'cinema:joined',

    Left = 'cinema:left',

    Users = 'cinema:users',

    Playing = 'cinema:playing',

    Paused = 'cinema:paused',

    Seeked = 'cinema:seeked',
}

export const enum Admin {
    Added = 'admin:added',

    Left = 'admin:left',

    Users = 'admin:users',

    Kicked = 'admin:kicked',

    Banned = 'admin:banned',

    Approved = 'admin:approved',
}

export interface All {
    [Connection.Accepted]: (isAdmin: boolean) => void;
    [Connection.Rejected]: (reason?: string) => void;

    [WaitingRoom.Joined]: (user: BaseUser) => void;
    [WaitingRoom.Left]: (user: BaseUser) => void;

    [Cinema.Joined]: (user: BaseUser) => void;
    [Cinema.Left]: (user: BaseUser) => void;
    [Cinema.Users]: (users: BaseUser[], playing: boolean, time: number) => void;
    [Cinema.Playing]: (admin: BaseUser, time: number) => void;
    [Cinema.Paused]: (admin: BaseUser, time: number) => void;
    [Cinema.Seeked]: (admin: BaseUser, time: number) => void;

    [Admin.Added]: (user: BaseUser) => void;
    [Admin.Left]: (user: BaseUser) => void;
    [Admin.Users]: (users: BaseUser[]) => void;
    [Admin.Kicked]: (
        admin: BaseUser,
        target: BaseUser,
        reason?: string,
    ) => void;
    [Admin.Banned]: (
        admin: BaseUser,
        target: BaseUser,
        reason?: string,
    ) => void;
    [Admin.Approved]: (admin: BaseUser, target: BaseUser) => void;
}
