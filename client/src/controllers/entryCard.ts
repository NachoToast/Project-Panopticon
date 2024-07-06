import { socket } from '../main';
import { ServerEvents } from '../shared';
import { getElement } from '../util';

const cardElement = getElement<HTMLDivElement>('#entry-card');

const titleElement = getElement<HTMLHeadingElement>('#entry-card h1');

const descriptionElement = getElement<HTMLParagraphElement>('#entry-card p');

const inputElement = getElement<HTMLInputElement>('#entry-card input');

interface ShowProps {
    title: string;

    description: string;

    input?: boolean;
}

export function addListeners(): void {
    socket.on(ServerEvents.Connection.Accepted, (isAdmin) => {
        if (isAdmin) {
            hide();
        } else {
            show({
                title: 'Waiting Room',
                description: 'You will be admitted shortly.',
            });
        }
    });

    socket.on(ServerEvents.Connection.Rejected, (reason) => {
        show({
            title: 'Disconnected',
            description: reason ? reason + '.' : 'No reason provided.',
        });
    });

    socket.on(ServerEvents.Cinema.Users, () => {
        hide();
    });
}

function hide(): void {
    cardElement.hidden = true;
}

export function show(props: ShowProps): void {
    cardElement.hidden = false;

    if (props.title) {
        titleElement.innerText = props.title;
    }

    if (props.description) {
        descriptionElement.innerText = props.description;
    }

    if (props.input) {
        inputElement.hidden = false;
        inputElement.focus();
    } else {
        inputElement.hidden = true;
    }
}
