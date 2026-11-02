# Web app

The web app in `apps/web/` is an Angular single-page app built from standalone components and
signals, with Angular Material and the CDK (drag and drop, overlays, accessibility helpers). Its
look is defined in [DESIGN.md](../DESIGN.md); this document covers how the code is put together.

## Structure

| Folder                    | Contents                                                                                                                                                                                                                                                                                     |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/app/app.routes.ts`   | All routes; every page is lazy-loaded                                                                                                                                                                                                                                                        |
| `src/app/app.config.ts`   | Providers: router with component input binding, `HttpClient` with the API interceptor, branding loaded before the first render                                                                                                                                                               |
| `src/app/core/`           | Services, stores and pure logic: API clients (`*-api.service.ts`), the session and notification stores, the project store, live updates, theming, shortcuts, and pure helpers (`board-logic.ts`, `timeline-logic.ts`, `bulk.ts`, `activity.ts`, `item-changes.ts`, `colour.ts`, `format.ts`) |
| `src/app/ui/`             | Shared components and services: icons, type and status signals, label pills, avatars and the person filter, empty states and skeletons, dialogs, toasts, the user picker, the date field, the image viewer, the conflict dialog                                                              |
| `src/app/pages/`          | One folder per screen                                                                                                                                                                                                                                                                        |
| `src/styles/`             | Global styles: `_tokens.scss` (design tokens), `_material.scss` (Material mapped to the tokens), shell, components, drawer, and stylesheets loaded only with their pages (timeline, live, settings, annotations)                                                                             |
| `src/testing/fixtures.ts` | Test builders (`makeProject`, `makeItem`, `makeMember`, …) and `settle()`                                                                                                                                                                                                                    |
| `e2e/`                    | Browser tests (see [TESTING.md](TESTING.md))                                                                                                                                                                                                                                                 |

Pure logic sits in plain functions in `core/` so it can be unit-tested without components.
Types and rules shared with the API (DTOs, permissions, the scheduling planner) come from
`@kloister/shared`.

## Routes

| Path                                                   | Page                                                                    |
| ------------------------------------------------------ | ----------------------------------------------------------------------- |
| `/`                                                    | Projects                                                                |
| `/login`, `/change-password`                           | Sign-in and the required password change                                |
| `/p/:key`                                              | Board; `/p/:key/items/:number` opens the item drawer over it            |
| `/p/:key/backlog`, `/p/:key/timeline`                  | Backlog tree and timeline, each with the same drawer route              |
| `/p/:key/sprints`                                      | Sprints                                                                 |
| `/p/:key/settings/:section`                            | Project settings tabs (general, members, teams, buckets, labels, trash) |
| `/p/:key/ado`                                          | ADO transfer                                                            |
| `/personal`                                            | The caller's personal space (`/p/personal`)                             |
| `/work`, `/people/:userId`                             | My work, and another person's work in shared projects                   |
| `/notifications`                                       | Notifications                                                           |
| `/settings`                                            | Account settings (name, password, theme)                                |
| `/help`                                                | Help and FAQ                                                            |
| `/admin/users`, `/admin/settings/:tab`, `/admin/audit` | Administration                                                          |

Child routes inherit `:key` (`paramsInheritanceStrategy: 'always'`), and route parameters bind to
component inputs. The guards in `core/auth.guards.ts` only shape navigation (signed in, password
change pending, administrator); the API checks every request.

## Talking to the API

- `core/api.ts` builds URLs relative to the document's base href, so the app works under whatever
  `/<app_name>/` path httpd serves it from.
- `core/api.interceptor.ts` adds `X-Requested-With: kloister` to every request that is not GET,
  HEAD or OPTIONS, adds the tab's random `X-Client-Id` (used by live updates to skip the tab's own
  echoes), and returns to the sign-in page when a session ends (401).
- Each area has a small API client in `core/` (`items-api.service.ts`, `projects-api.service.ts`,
  …) returning the DTO types from `@kloister/shared`.

## State

- `SessionStore` holds the signed-in user; `NotificationsStore` the unread count.
- `ProjectContext` (`core/project-context.ts`) is the store of the open project, provided by the
  project shell (`pages/project/project-shell.ts`) and shared by the board, backlog, timeline,
  sprints and the item drawer. It holds the project with the caller's permissions, its buckets,
  labels, sprints, members and teams, and every item visible to the caller, loaded page by page.
  Views derive what they show from it with `computed` signals, so a change made in the drawer is
  on the board at once. It also applies live updates (see [LIVE-UPDATES.md](LIVE-UPDATES.md)).
- Its capability helpers (`has()`, item `can` flags) decide which controls to show; the API
  decides what is allowed.
- `RescheduleFlow` (`core/reschedule.ts`), also provided by the project shell, handles every date
  change with dependent moves, previews and Undo (see [SCHEDULING.md](SCHEDULING.md)).
- Item references (M12): `core/rich-text.ts` turns stored marks into links (`forDisplay`), keeps
  them through editing (`forEditing`) and offers `#`/key autocomplete in the editor. The
  `appItemRefs` directive (`ui/item-refs.ts`) opens links inside the app and shows the hover card,
  reading the open project's live store; items of other projects come from `GET /references`
  through `core/trash-api.service.ts`, which also holds the trash calls so only lazy pages load
  them. The trash itself is `pages/project-settings/project-trash.ts`.

## Shared UI and theming

- Design tokens are CSS custom properties in `src/styles/_tokens.scss` (colour, type, spacing,
  radius, elevation, motion), with light and dark values. Material is mapped onto them in
  `_material.scss`. New screens use the tokens and the `ui/` pieces and never name colours or sizes
  directly.
- Themes: `core/theme.ts` derives a full palette from the chosen primary and accent colours with AA
  contrast; `ThemeService` applies the administrator's default theme and branding before the first
  render, then the person's own theme. Fonts are bundled or uploaded by an administrator; nothing
  is loaded from another host.
- Feedback goes through shared services: `ToastService` (one toast at a time, with Undo for
  reversible changes) and `Dialogs` (confirm and prompt dialogs). Pages never use `alert()` or
  `confirm()`.
- Phone layouts switch markup with `PHONE_QUERY` (`ui/row-cards.ts`, below 600 px) where styles
  alone are not enough, for example tables shown as stacked cards.

## Keyboard and accessibility

- `core/shortcuts.ts` is the single keyboard entry point: pages register contextual actions, and
  the help and command dialogs load on demand. Single-key shortcuts work only outside text fields
  and can be switched off per browser (WCAG 2.1.4). The keys are listed in DESIGN §12.
- Every drag has a keyboard or menu alternative (move to bucket, reorder, timeline cell entry).
- Focus is visible on every control, dialogs and the drawer trap and restore focus, toasts are
  announced, icon-only buttons have names, and reduced motion removes transitions. The full list
  is in DESIGN §13.

## Bundle budget and lazy loading

The production build fails above 1 MB of initial JavaScript and warns above 500 kB; a component's
styles warn above 4 kB and fail above 8 kB (`angular.json`). To stay inside:

- every page and the item drawer are lazy-loaded routes;
- live updates and the first-login introduction load after sign-in (`core/signed-in.ts`);
- dialogs used rarely (reschedule, conflict, keyboard help, command palette) are imported when
  first opened;
- large page styles live in global stylesheets that load with their page (for example
  `_timeline-*.scss`);
- `ThemeService` uses `HttpClient` directly instead of a larger client.

## Adding a screen

1. Add a lazy route in `app.routes.ts` (under `p/:key` for a project page, so it shares
   `ProjectContext`).
2. Build it from `ui/` components and tokens; add phone and keyboard behaviour from the start.
3. Put rules in pure functions in `core/` with unit tests; keep the component thin.
4. Call the API through a `core/*-api.service.ts` client using `@kloister/shared` types.
5. Show controls by the caller's permissions, and handle 403 and 404 as the API will still refuse.
6. Add unit tests next to the files and a browser test in `e2e/` for the new screen.
7. Check the bundle budget in the build output.
