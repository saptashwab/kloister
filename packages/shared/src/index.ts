/**
 * Public entry point of `@kloister/shared`.
 *
 * Re-exports every type and constant that both the API and the web app rely
 * on, so the two sides of the wire cannot drift apart.
 */
export * from './api.js';
