import { BaseUser } from './shared/index.js';
import { ServerSocket } from './types.js';

export class User {
    public readonly socket: ServerSocket;

    public readonly username: string;

    public readonly isAdmin: boolean;

    public readonly joinedAt: number;

    public constructor(
        socket: ServerSocket,
        username: string,
        isAdmin: boolean,
    ) {
        this.socket = socket;
        this.username = username;
        this.isAdmin = isAdmin;
        this.joinedAt = Date.now();
    }

    public get id(): string {
        return this.socket.id;
    }

    public get ip(): string {
        return this.socket.handshake.address;
    }

    public toBasic(): BaseUser {
        const { username, isAdmin, joinedAt, id } = this;

        return {
            id,
            username,
            isAdmin,
            joinedAt,
        };
    }
}
