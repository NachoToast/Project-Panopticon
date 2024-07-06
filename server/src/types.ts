import { Socket } from 'socket.io';
import { ClientEvents, ServerEvents } from './shared/index.js';

export type ServerSocket = Socket<ClientEvents.All, ServerEvents.All>;
