import { Sidebar, User } from '.';
import { socket } from '../main';
import { BaseUser, ServerEvents } from '../shared';
import { getElement } from '../util';

const element = getElement<HTMLDivElement>('#waiting-room');

const title = getElement<HTMLHeadingElement>('#waiting-room > h3');

const userContainer = getElement<HTMLDivElement>('#waiting-room > div');

const users = new Map<string, HTMLDivElement>();

export function addListeners(): void {
    socket.on(ServerEvents.Connection.Accepted, (isAdmin) => {
        setHidden(!isAdmin);
    });

    socket.on('disconnect', () => {
        setHidden(true);
        clearUsers();
    });

    socket.on(ServerEvents.Connection.Rejected, () => {
        setHidden(true);
    });

    socket.on(ServerEvents.WaitingRoom.Joined, (user) => {
        addUser(user);
    });

    socket.on(ServerEvents.WaitingRoom.Left, (user) => {
        removeUser(user);
    });
}

function setHidden(hidden: boolean): void {
    element.hidden = hidden;
    Sidebar.update();
}

export function isHidden(): boolean {
    return element.hidden;
}

function updateTitle(): void {
    title.textContent = `Waiting Room (${users.size.toString()})`;
}

function addUser(user: BaseUser): void {
    const element = User.makeCard(user, true);

    userContainer.appendChild(element);
    users.set(user.id, element);
    updateTitle();
}

function removeUser(user: BaseUser): void {
    const element = users.get(user.id);
    if (!element) return;

    userContainer.removeChild(element);
    users.delete(user.id);
    updateTitle();
}

function clearUsers(): void {
    userContainer.innerHTML = '';
    users.clear();
    updateTitle();
}
