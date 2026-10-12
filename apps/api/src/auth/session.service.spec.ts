import { fakePrisma, fakeSettings, makeConfig, makeUser } from '../../test/support/fakes.js';
import { hashToken, SessionService } from './session.service.js';

describe('SessionService', () => {
  const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000);
  const inMinutes = (m: number) => new Date(Date.now() + m * 60_000);

  function setup() {
    const { fake, prisma } = fakePrisma();
    const service = new SessionService(
      prisma,
      fakeSettings({ idleTimeoutMinutes: 60, absoluteTimeoutMinutes: 600 }),
      makeConfig(),
    );
    return { fake, service };
  }

  it('creates a session storing only the token hash', async () => {
    const { fake, service } = setup();
    fake.session.create.mockImplementation((args: unknown) =>
      Promise.resolve({ id: 's1', ...(args as { data: object }).data }),
    );
    const session = await service.create('u1', { userAgent: 'UA', ip: '203.0.113.1' });
    const data = (fake.session.create.mock.calls[0]?.[0] as { data: Record<string, unknown> }).data;
    expect(data['tokenHash']).toBe(hashToken(session.token));
    expect(data).not.toHaveProperty('token');
    expect(data['ip']).toBe('203.0.113.1');
    const lifetime = session.expiresAt.getTime() - Date.now();
    expect(lifetime).toBeGreaterThan(599 * 60_000);
    expect(lifetime).toBeLessThanOrEqual(600 * 60_000);
  });

  it('returns null for an unknown token', async () => {
    const { fake, service } = setup();
    fake.session.findUnique.mockResolvedValue(null);
    await expect(service.validate('nope')).resolves.toBeNull();
  });

  it.each([
    ['absolute expiry passed', { expiresAt: minutesAgo(1), lastSeenAt: minutesAgo(1) }, {}],
    ['idle timeout passed', { expiresAt: inMinutes(100), lastSeenAt: minutesAgo(61) }, {}],
    [
      'user deactivated',
      { expiresAt: inMinutes(100), lastSeenAt: minutesAgo(1) },
      { isActive: false },
    ],
  ])('deletes and rejects the session when %s', async (_label, times, userFields) => {
    const { fake, service } = setup();
    fake.session.findUnique.mockResolvedValue({ id: 's1', ...times, user: makeUser(userFields) });
    await expect(service.validate('t')).resolves.toBeNull();
    expect(fake.session.deleteMany).toHaveBeenCalledWith({ where: { id: 's1' } });
  });

  it('accepts a live session and refreshes a stale lastSeenAt', async () => {
    const { fake, service } = setup();
    const user = makeUser();
    fake.session.findUnique.mockResolvedValue({
      id: 's1',
      expiresAt: inMinutes(100),
      lastSeenAt: minutesAgo(5),
      user,
    });
    await expect(service.validate('t')).resolves.toEqual({ user, sessionId: 's1' });
    expect(fake.session.update).toHaveBeenCalledTimes(1);
  });

  it('does not write when lastSeenAt is fresh', async () => {
    const { fake, service } = setup();
    fake.session.findUnique.mockResolvedValue({
      id: 's1',
      expiresAt: inMinutes(100),
      lastSeenAt: new Date(),
      user: makeUser(),
    });
    await service.validate('t');
    expect(fake.session.update).not.toHaveBeenCalled();
  });

  it('revokes all sessions except the current one', async () => {
    const { fake, service } = setup();
    fake.session.deleteMany.mockResolvedValue({ count: 2 });
    await expect(service.revokeAllForUser('u1', 's1')).resolves.toBe(2);
    expect(fake.session.deleteMany).toHaveBeenCalledWith({
      where: { userId: 'u1', id: { not: 's1' } },
    });
  });

  it('sets the cookie attributes required by SPEC §5', () => {
    const { service } = setup();
    expect(service.cookieOptions()).toEqual({
      httpOnly: true,
      secure: true,
      sameSite: 'strict',
      path: '/kloister-test/',
    });
  });
});
