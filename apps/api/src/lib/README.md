# `apps/api/src/lib/` — framework-agnostic helpers

This directory holds the api process's domain logic that does NOT participate
in NestJS dependency injection. Everything in here is a plain function or
module that can be called from:

- NestJS services / controllers (they `import` and call directly),
- BullMQ worker callbacks running detached from a request,
- Module-load contexts (e.g. the Better Auth singleton at `apps/api/src/auth/better-auth.ts` calls `prismaAdapter(db, …)` at import time),
- Standalone scripts (`prisma/seed*.ts`).

NestJS code lives one level up — at `apps/api/src/{conversations,messages,…}`,
one folder per HTTP module, each holding the `*.controller.ts`, `*.service.ts`,
and `*.module.ts` triple. Those services do the framework-level wiring
(guards, pipes, DI) and delegate business logic into this directory.

## Why two directories with parallel names

Several subfolders here share a name with their NestJS counterpart
(`lib/conversations/`, `lib/messages/`, `lib/messaging/`, `lib/team-chat/`).
That's deliberate: each pair represents the same domain split by layer.

```
apps/api/src/conversations/conversations.service.ts   ← NestJS @Injectable
apps/api/src/lib/conversations/analytics.ts           ← pure functions
                                                       reused by the service
```

The service is the public boundary (route handlers + guards + DI). The
`lib/` helpers are the implementation it calls when the request needs to
do real work. Splitting them means the same code runs identically from
HTTP, from a workflow step, and from a broadcast runner — without any
copy of "is this code being called from NestJS or from a worker right now?"
branching.

## Subfolders

| Folder | What's inside | Consumers |
|---|---|---|
| `blob-storage/` | UploadThing client + the `BlobStorageProvider` interface; swap impls here to change providers | media upload paths in messages/messaging |
| `broadcast-runner.ts` | The async loop that walks a broadcast's recipient list, sends templates, and publishes per-recipient bus events | `BroadcastsService` (kicked off via `setImmediate`) |
| `conversations/` | Analytics helpers (event-recording, audit-trail entries) | audit subscriber + ConversationsService |
| `crypto/` | AES-256-GCM envelope wrapper for per-team Meta secrets | `lib/providers/config.ts` |
| `events/subscribers/` | Subscribers that listen on the in-process event bus (analytics, audit, workflow-dispatch). Registered by NestJS lifecycle hooks | `RealtimeFanoutService` + dispatcher service |
| `inbox/` | Conversation-event recording (`events.ts`) | audit subscriber |
| `messages/` | `idempotent-create.ts` — the dedupe-by-externalId message insert. Used by both inbound ingest and outbound send paths | ingest, MessagesService |
| `messaging/` | Outbound text + template senders that wrap the Meta provider with bookkeeping (Conversation reopen, lastMessageAt bump, bus emit) | MessagesService, broadcast runner, workflow steps |
| `providers/` | The `MessagingProvider` interface + `MetaProvider` impl (`meta.ts`, 1k+ lines: send + ingest + media). Provider config loader (`config.ts`) reads per-team Meta secrets and caches them | controllers, broadcast runner, workflow steps, webhook controller |
| `queries/` | Read-side query helpers — `listConversations`, `listContacts`, snippet/tag/stage/audience-group fetches. All keyset-paginated where order matters | RSC pages via the api() layer, list endpoints, external API |
| `sweepers/` | Background reconcilers — currently only `inbound-media.ts` (retries failed Meta media downloads on a schedule) | `WorkflowWorkerService.onModuleInit` |
| `team-chat/queries.ts` | Reads for the internal team-chat channels feature | TeamChatChannelsService |
| `workflows/` | The workflow engine: graph parser, DAG runner, step handlers, BullMQ queue + worker bootstrap, event-to-trigger dispatcher | `WorkflowWorkerService`, `WorkflowDispatcherService`, `WorkflowSubscribersService` |
| `csv.ts` | papaparse wrapper for contact import/export | ContactsService |
| `db.ts` | Lazy Proxy over `PrismaService`. See the file header — one pool per process, populated by `PrismaModule.onModuleInit` | every file here that touches Postgres |
| `env.ts` | Boot-time required/optional env var validation | `main.ts` (or a future PreBootGuard) |
| `external-shapes.ts` | API-shape mappers for the public `/v1` API. Quarantined here so `/v1` response shapes can't accidentally drift with internal type changes | `ExternalV1Service` |
| `media-storage.ts` | Helper bridge between MediaKind/MimeType and the blob-storage provider | messaging + ingest |
| `rate-limit.ts` | In-process fixed-window rate limiter. MVP-scoped: counters live in this process's memory | guards that need request-rate ceilings |

## Conventions for code in this directory

1. **No NestJS imports.** No `@Injectable()`, no `@Inject()`, no NestJS DI
   tokens. The whole point is to be callable from contexts NestJS doesn't
   manage. If you find yourself wanting a constructor injection, the
   abstraction belongs upstairs in a NestJS service, not here.
2. **`db` comes from `@/lib/db`** — the Proxy that resolves to the shared
   PrismaService instance after boot. Don't `new PrismaClient()` anywhere
   else in this tree; it would re-introduce the dual-pool bug the Proxy
   exists to prevent.
3. **No `console.log/.error`.** Use `console.warn` for the boot-only worker
   log line if you must (BullMQ patterns require it), but prefer to let
   the caller's injected `Logger` do the logging.
4. **Pure where possible.** Functions that don't strictly need IO should
   take their inputs as parameters and return a value. Helps with
   reasoning about side effects across the workflow runner / broadcast
   runner / ingest paths.

## Things this directory is NOT

- It is NOT `packages/shared/`. That package holds types and constants
  consumed by BOTH `apps/web` and `apps/api` (DTOs, socket event types,
  template-binding regexes, etc.). Code in `lib/` is api-process-only.
- It is NOT "dead code from the pre-migration." The migration deleted the
  pre-migration `app/api/**/route.ts` route handlers; the framework-
  agnostic helpers they called were moved here intentionally. See the
  "Architectural calls" section of the root CLAUDE.md.

## Future direction

If `apps/web` ever needs to call any of these helpers directly (it doesn't
today — web talks to api over HTTP via `apps/web/src/lib/api-client.ts`),
that helper should be promoted to a new `packages/server-lib/` workspace
package. The api side keeps importing from the same path; the web side
becomes a legitimate second consumer. Until that happens, keeping these
files inside `apps/api/src/lib/` avoids workspace-package ceremony for
zero added value.
