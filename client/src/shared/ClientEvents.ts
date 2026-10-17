import { BaseUser } from './BaseUser.js';
import { PlaybackCommand } from './PlaybackState.js';

export const enum Cinema {
    Play = 'cinema:play',

    Pause = 'cinema:pause',

    Seek = 'cinema:seek',

    /** Host announces its configured media identity (admin only). */
    Select = 'cinema:select',
}

export const enum Admin {
    Kick = 'admin:kick',

    Ban = 'admin:ban',

    Approve = 'admin:approve',
}

export interface All {
    [Cinema.Play]: (command: PlaybackCommand) => void;
    [Cinema.Pause]: (command: PlaybackCommand) => void;
    [Cinema.Seek]: (command: PlaybackCommand) => void;
    [Cinema.Select]: (mediaId: string) => void;

    [Admin.Kick]: (target: BaseUser, reason?: string) => void;
    [Admin.Ban]: (target: BaseUser, reason?: string) => void;
    [Admin.Approve]: (target: BaseUser) => void;
}
