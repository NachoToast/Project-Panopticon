import { Cinema, WaitingRoom } from '.';
import { getElement } from '../util';

const element = getElement<HTMLDivElement>('#sidebar');

export function update(): void {
    element.hidden = Cinema.isHidden() && WaitingRoom.isHidden();
}
