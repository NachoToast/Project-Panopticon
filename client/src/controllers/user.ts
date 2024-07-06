import { socket } from '../main';
import { BaseUser, ClientEvents, ServerEvents } from '../shared';

const BUTTONS = {
    approve: [
        '0 0 448 512',
        'M438.6 105.4c12.5 12.5 12.5 32.8 0 45.3l-256 256c-12.5 12.5-32.8 12.5-45.3 0l-128-128c-12.5-12.5-12.5-32.8 0-45.3s32.8-12.5 45.3 0L160 338.7 393.4 105.4c12.5-12.5 32.8-12.5 45.3 0z',
    ],
    kick: [
        '0 0 384 512',
        'M342.6 150.6c12.5-12.5 12.5-32.8 0-45.3s-32.8-12.5-45.3 0L192 210.7 86.6 105.4c-12.5-12.5-32.8-12.5-45.3 0s-12.5 32.8 0 45.3L146.7 256 41.4 361.4c-12.5 12.5-12.5 32.8 0 45.3s32.8 12.5 45.3 0L192 301.3 297.4 406.6c12.5 12.5 32.8 12.5 45.3 0s12.5-32.8 0-45.3L237.3 256 342.6 150.6z',
    ],
    ban: [
        '0 0 512 512',
        'M367.2 412.5L99.5 144.8C77.1 176.1 64 214.5 64 256c0 106 86 192 192 192c41.5 0 79.9-13.1 111.2-35.5zm45.3-45.3C434.9 335.9 448 297.5 448 256c0-106-86-192-192-192c-41.5 0-79.9 13.1-111.2 35.5L412.5 367.2zM0 256a256 256 0 1 1 512 0A256 256 0 1 1 0 256z',
    ],
} as const;

let isAdmin = false;

export function addListeners(): void {
    socket.on(ServerEvents.Connection.Accepted, (admin) => {
        isAdmin = admin;
    });

    socket.on('disconnect', () => {
        isAdmin = false;
    });
}

function makeButton(type: keyof typeof BUTTONS): HTMLButtonElement {
    const button = document.createElement('button');

    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');

    svg.setAttribute('viewBox', BUTTONS[type][0]);

    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');

    path.setAttribute('d', BUTTONS[type][1]);

    svg.appendChild(path);

    button.appendChild(svg);

    return button;
}

export function makeCard(
    user: BaseUser,
    inWaitingRoom: boolean,
): HTMLDivElement {
    const line = document.createElement('div');
    line.classList.add('user');

    const p = document.createElement('p');
    p.innerText = user.username;

    if (user.isAdmin) {
        p.classList.add('admin');
    }

    if (user.id === socket.id) {
        p.innerText += ' (you)';
    }

    line.appendChild(p);

    if (!isAdmin || user.id === socket.id) {
        return line;
    }

    if (inWaitingRoom) {
        const approveButton = makeButton('approve');

        approveButton.onclick = (): void => {
            socket.emit(ClientEvents.Admin.Approve, user);
        };

        line.appendChild(approveButton);
    }

    const kickButton = makeButton('kick');
    kickButton.onclick = (): void => {
        socket.emit(ClientEvents.Admin.Kick, user);
    };

    const banButton = makeButton('ban');

    banButton.onclick = (): void => {
        socket.emit(ClientEvents.Admin.Ban, user);
    };

    line.appendChild(kickButton);
    line.appendChild(banButton);

    return line;
}
