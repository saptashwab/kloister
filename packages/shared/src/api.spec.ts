import { API_PREFIX } from './index.js';

describe('API_PREFIX', () => {
  it('is relative so the app works under any base path', () => {
    expect(API_PREFIX.startsWith('/')).toBe(false);
    expect(API_PREFIX).toBe('api/v1');
  });
});
