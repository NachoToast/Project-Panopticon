/** Queries the DOM for an element, throwing an error if it is not found or isn't the expected type. */
export function getElement<T extends Element>(selector: string, elementType: new () => T): T {
    const element = document.querySelector(selector);

    if (element === null) {
        throw new Error(`Element with selector ${selector} not found.`);
    }

    if (!(element instanceof elementType)) {
        throw new Error(`Element with selector ${selector} is not ${elementType.name}.`);
    }

    return element;
}
