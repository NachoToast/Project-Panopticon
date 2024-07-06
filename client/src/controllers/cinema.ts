import { Sidebar, User } from '.';
import { socket } from '../main';
import { BaseUser, ServerEvents } from '../shared';
import { getElement } from '../util';

const element = getElement<HTMLDivElement>('#cinema');

const title = getElement<HTMLHeadingElement>('#cinema > h3');

const userContainer = getElement<HTMLDivElement>('#cinema > div');

const users = new Map<string, HTMLDivElement>();

export function addListeners(): void {
    socket.on('disconnect', () => {
        setHidden(true);
        clearUsers();
    });

    socket.on(ServerEvents.Cinema.Joined, (user) => {
        addUser(user);
    });

    socket.on(ServerEvents.Cinema.Left, (user) => {
        removeUser(user);
    });

    socket.on(ServerEvents.Cinema.Users, (users) => {
        setHidden(false);

        for (const user of users) {
            addUser(user);
        }
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
    title.textContent = `Cinema (${users.size.toString()})`;
}

function addUser(user: BaseUser): void {
    const element = User.makeCard(user, false);

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
