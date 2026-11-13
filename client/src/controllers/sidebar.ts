import { Cinema, WaitingRoom } from '.';
import { getElement } from '../util';

const element = getElement('#sidebar', HTMLDivElement);

export function update(): void {
    element.hidden = Cinema.isHidden() && WaitingRoom.isHidden();
}
