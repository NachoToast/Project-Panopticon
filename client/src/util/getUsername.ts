import { EntryCard } from '../controllers';
import { getElement } from './getElement';
import { safeStorage } from './storage';

const usernameInput = getElement('#username-input', HTMLInputElement);

const LOCAL_STORAGE_KEY = 'username';

/** Gets a valid username from the user. */
export function getUsername(): Promise<string> {
    return new Promise((resolve) => {
        function handleKeyPress(event: KeyboardEvent): void {
            if (event.key !== 'Enter') return;
            if (!usernameInput.validity.valid) return;

            const username = usernameInput.value.trim();

            safeStorage.writeStoredString(LOCAL_STORAGE_KEY, username);

            window.removeEventListener('keypress', handleKeyPress);

            EntryCard.show({
                title: 'Logging In',
                description: 'Connecting to the server...',
            });
            resolve(username);
        }

        window.addEventListener('keypress', handleKeyPress);

        const storedUsername = safeStorage.readStoredString(LOCAL_STORAGE_KEY);

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
