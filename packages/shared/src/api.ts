/**
 * Path prefix for every REST endpoint (SPEC §8).
 *
 * Relative on purpose: the web app calls the API with relative URLs only, so
 * it works under whatever `/<app_name>/` path httpd serves it from (SPEC §9.2).
 */
export const API_PREFIX = 'api/v1';

/**
 * Body returned by `GET /api/v1/health`.
 *
 * The endpoint needs no authentication; install and start scripts poll it to
 * decide whether the backend came up.
 */
export interface HealthResponse {
  /** Always `'ok'` when the process is able to answer requests. */
  status: 'ok';
}
