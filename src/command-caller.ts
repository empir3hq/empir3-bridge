import type {IncomingMessage} from 'node:http';

export interface CommandCaller {
  origin?: string;
  userAgent?: string;
  clientId?: string;
  remoteAddress?: string;
  remotePort?: number;
}

/** Diagnostic hints only: never use these caller-controlled labels for policy. */
export function commandCaller(req: Pick<IncomingMessage,'headers'|'socket'>): CommandCaller {
  const caller: CommandCaller = {};
  const origin = req.headers.origin;
  if (typeof origin==='string') {
    try { const parsed=new URL(origin);if(['http:','https:'].includes(parsed.protocol))caller.origin=parsed.origin; } catch { /* absent/opaque origin */ }
  }
  const agent=req.headers['user-agent'];
  if (typeof agent==='string') caller.userAgent=agent.replace(/[\x00-\x1f\x7f]/g,' ').slice(0,256);
  const id=req.headers['x-empir3-client-id'];
  if (typeof id==='string' && /^[a-z0-9_.:-]{1,96}$/i.test(id))caller.clientId=id;
  if (req.socket?.remoteAddress)caller.remoteAddress=req.socket.remoteAddress;
  if (req.socket?.remotePort)caller.remotePort=req.socket.remotePort;
  return caller;
}
