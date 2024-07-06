/** Queries the DOM for an element, throwing an error if it is not found. */
export function getElement<T extends Element>(selector: string): T {
    const element = document.querySelector<T>(selector);

    if (element === null) {
        throw new Error(`Element with selector ${selector} not found.`);
    }

    return element;
}
