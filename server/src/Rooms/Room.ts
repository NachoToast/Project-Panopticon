import { logApplicationState } from '../index.js';
import { BaseUser } from '../shared/BaseUser.js';
import { User } from '../User.js';
import { removeActiveUsername } from '../validation.js';

export abstract class Room {
    public readonly roomName: string;

    private readonly users = new Map<string, User>();

    private readonly userList = new Array<BaseUser>();

    protected constructor(roomName: string) {
        this.roomName = roomName;
    }

    public isEmpty(): boolean {
        return this.users.size === 0;
    }

    public toString(): string {
        return `${
            this.constructor.name
        }(${this.users.size.toString()}) { ${this.getUserList()
            .map((e) => e.username)
            .join(', ')} }`;
    }

    public async add(user: User): Promise<void> {
        if (user.socket.listenersAny().length > 0) {
            console.log(
                `Adding ${user.username} to ${this.roomName} but already has socket listeners!`,
                user.socket.listenersAny(),
            );
        }

        user.socket.on('disconnect', () => {
            removeActiveUsername(user.username);
            void this.remove(user);
            logApplicationState();
        });

        this.users.set(user.id, user);
        this.userList.push(user.toBasic());
        this.onJoin(user);

        await user.socket.join(this.roomName);
    }

    public async remove(user: User): Promise<void> {
        user.socket.removeAllListeners();

        this.users.delete(user.id);
        const index = this.userList.findIndex((u) => u.id === user.id);
        if (index !== -1) this.userList.splice(index, 1);
        this.onLeave(user);

        await user.socket.leave(this.roomName);
    }

    public tryGetUser(baseUser: BaseUser): User | undefined {
        return this.users.get(baseUser.id);
    }

    protected getIdenticalUsers(ip: string): User[] {
        return Array.from(this.users.values()).filter((user) => user.ip === ip);
    }

    protected getUserList(): BaseUser[] {
        return this.userList;
    }

    protected abstract onJoin(user: User): void;

    protected abstract onLeave(user: User): void;
}
