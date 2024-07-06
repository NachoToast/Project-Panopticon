import { EntryCard } from '../controllers';
import { getElement } from './getElement';

const usernameInput = getElement<HTMLInputElement>('#username-input');

const LOCAL_STORAGE_KEY = 'username';

/** Gets a valid username from the user. */
export function getUsername(): Promise<string> {
    return new Promise((resolve) => {
        function handleKeyPress(event: KeyboardEvent): void {
            if (event.key !== 'Enter') return;
            if (!usernameInput.validity.valid) return;

            const username = usernameInput.value.trim();

            localStorage.setItem(LOCAL_STORAGE_KEY, username);

            window.removeEventListener('keypress', handleKeyPress);

            EntryCard.show({
                title: 'Logging In',
                description: 'Connecting to the server...',
            });
            resolve(username);
        }

        window.addEventListener('keypress', handleKeyPress);

        const storedUsername = localStorage.getItem(LOCAL_STORAGE_KEY);

        if (storedUsername !== null) {
            usernameInput.value = storedUsername;
        }

        EntryCard.show({
            title: 'Enter Username',
            description: 'Press enter when done.',
            input: true,
        });
        usernameInput.focus();
    });
}
