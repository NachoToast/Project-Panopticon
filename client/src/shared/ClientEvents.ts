import { BaseUser } from './BaseUser.js';

export const enum Cinema {
    Play = 'cinema:play',

    Pause = 'cinema:pause',

    Seek = 'cinema:seek',
}

export const enum Admin {
    Kick = 'admin:kick',

    Ban = 'admin:ban',

    Approve = 'admin:approve',
}

export interface All {
    [Cinema.Play]: (time: number) => void;
    [Cinema.Pause]: (time: number) => void;
    [Cinema.Seek]: (time: number) => void;

    [Admin.Kick]: (target: BaseUser, reason?: string) => void;
    [Admin.Ban]: (target: BaseUser, reason?: string) => void;
    [Admin.Approve]: (target: BaseUser) => void;
}
