import type { User } from '../generated/prisma/client.js';

/** The signed-in caller, attached to the request by the session guard. */
export interface AuthContext {
  /** The user row, loaded fresh for this request. */
  user: User;
  /** Id of the session used for this request. */
  sessionId: string;
}

declare module 'fastify' {
  interface FastifyRequest {
    /** Set by the session guard on authenticated requests. */
    auth?: AuthContext;
  }
}
