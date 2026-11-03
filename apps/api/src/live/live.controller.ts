import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Put,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import type { LiveStatusDto } from '@kloister/shared';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { AuthContext } from '../auth/auth-context.js';
import { CurrentAuth, KeepSessionIdle } from '../auth/decorators.js';
import { SettingsService } from '../settings/settings.service.js';
import { parseClientId } from './client-id.js';
import { LiveHub } from './live-hub.js';
import { LivePresenceDto, LiveSubscribeDto, LiveWorkDto } from './live.dto.js';

/**
 * Live updates (M10 plan section 6): the Server-Sent Events stream and its
 * control routes, under `/api/v1/events`.
 *
 * Permissions: every route needs a session and none refreshes it
 * (`@KeepSessionIdle()`), so the stream itself never keeps a session alive. A
 * stream carries only its owner's notifications, the events of one project
 * they are a member of and of the work it follows (theirs, or a person's
 * they may look up), filtered by their visibility (SPEC §3.3).
 */
@Controller('events')
@KeepSessionIdle()
export class LiveController {
  /**
   * Receives its collaborators through Nest dependency injection.
   *
   * @param hub The stream registry.
   * @param settings The live switch.
   */
  constructor(
    private readonly hub: LiveHub,
    private readonly settings: SettingsService,
  ) {}

  /**
   * Reports whether live updates are on, so the web app knows whether to
   * open a stream.
   *
   * @returns The switch.
   */
  @Get('status')
  async status(): Promise<LiveStatusDto> {
    return { enabled: (await this.settings.getLive()).enabled };
  }

  /**
   * Opens the event stream; the first event is `hello` with the stream id.
   * Answers 204 (which browsers do not retry) while live updates are off.
   * The response is never compressed or cached and asks proxies not to
   * buffer it (M10 plan section 7).
   *
   * @param auth The caller.
   * @param request The request, to notice the client leaving.
   * @param reply The response, taken over for streaming.
   * @param client The tab's client id (EventSource cannot send headers).
   * @returns Resolves once the stream is open.
   */
  @Get()
  async open(
    @CurrentAuth() auth: AuthContext,
    @Req() request: FastifyRequest,
    @Res() reply: FastifyReply,
    @Query('client') client?: string,
  ): Promise<void> {
    if (!(await this.settings.getLive()).enabled) {
      await reply.status(HttpStatus.NO_CONTENT).send();
      return;
    }
    reply.hijack();
    const raw = reply.raw;
    raw.writeHead(HttpStatus.OK, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      'X-Accel-Buffering': 'no',
      'X-Content-Type-Options': 'nosniff',
    });
    const id = this.hub.open(auth, parseClientId(client), {
      write: (chunk) => {
        if (raw.destroyed) throw new Error('Stream closed');
        raw.write(chunk);
      },
      end: () => raw.end(),
    });
    request.raw.on('close', () => this.hub.close(id));
  }

  /**
   * Follows a project with the stream, or none.
   *
   * Permissions: own stream only; members of the project only (personal
   * spaces: the owner). 404 otherwise, also for administrators who are not
   * members.
   *
   * @param auth The caller.
   * @param streamId The stream.
   * @param body The project.
   * @returns Resolves once followed (204).
   */
  @Put(':streamId/project')
  @HttpCode(HttpStatus.NO_CONTENT)
  subscribe(
    @CurrentAuth() auth: AuthContext,
    @Param('streamId', ParseUUIDPipe) streamId: string,
    @Body() body: LiveSubscribeDto,
  ): Promise<void> {
    return this.hub.subscribe(auth, streamId, body.projectId);
  }

  /**
   * Follows a person's work with the stream (v1.4.0), so "all their work"
   * refreshes when their items change, or none (null: the caller's own work).
   * Events still pass the caller's own visibility in each project they are a
   * member of; personal spaces of others never match.
   *
   * Permissions: own stream only; the same people the caller may look up in
   * `GET /users/:userId/work` (administrators anyone, others only people who
   * share a project with them). 404 otherwise.
   *
   * @param auth The caller.
   * @param streamId The stream.
   * @param body The person.
   * @returns Resolves once followed (204).
   */
  @Put(':streamId/work')
  @HttpCode(HttpStatus.NO_CONTENT)
  work(
    @CurrentAuth() auth: AuthContext,
    @Param('streamId', ParseUUIDPipe) streamId: string,
    @Body() body: LiveWorkDto,
  ): Promise<void> {
    return this.hub.followWork(auth, streamId, body.userId);
  }

  /**
   * Reports what the tab is doing (presence); kept in memory only.
   *
   * Permissions: own stream only, following a project; the item must be
   * visible to the caller (404 otherwise).
   *
   * @param auth The caller.
   * @param streamId The stream.
   * @param body Item, action and field.
   * @returns Resolves once accepted (204).
   */
  @Put(':streamId/presence')
  @HttpCode(HttpStatus.NO_CONTENT)
  presence(
    @CurrentAuth() auth: AuthContext,
    @Param('streamId', ParseUUIDPipe) streamId: string,
    @Body() body: LivePresenceDto,
  ): Promise<void> {
    return this.hub.reportPresence(auth, streamId, { ...body, field: body.field ?? null });
  }
}
