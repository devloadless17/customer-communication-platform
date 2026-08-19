import { Prisma } from "@prisma/client";
import { resolveRecipientAccounts } from "@/lib/broadcasts/resolve-recipient-accounts";
import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  type OnModuleDestroy,
  type OnModuleInit,
} from "@nestjs/common";

import {
  CANCEL_RECIPIENT_MARKER,
  MAX_RECIPIENTS_IN_PROCESS,
  SYNC_MATERIALIZE_MAX,
  getInFlightRunPromises,
  pruneBroadcastInMemoryStateForTerminalRows,
  reconcileOrphanedBroadcasts,
  resumeBroadcastManually,
  signalShutdown,
  startBroadcast,
} from "@/lib/broadcast-runner";
import {
  enqueueScheduledBroadcast,
  removeScheduledBroadcast,
} from "@/lib/broadcasts/schedule-queue";
import {
  enqueueBroadcastMaterialize,
  removeBroadcastMaterialize,
} from "@/lib/broadcasts/materialize-queue";
import {
  checkBroadcastEligibility,
  fetchWhatsappHealthFromGraph,
  getMessagingHealthSummary,
  type MessagingHealthSummary,
} from "@/lib/providers/meta-health";
import { buildBroadcastAssignmentPlan } from "@/lib/assignment/broadcast-plan";
import {
  analyticsWindowEnd,
  getBroadcastReport,
  recipientOutcomeWhere,
} from "@/lib/broadcast-report";
import {
  refreshTemplateAnalytics,
  resolveCampaignTemplate,
} from "@/lib/analytics/template-analytics";
import { csvHeader, csvRows } from "@/lib/csv";
import { countTemplatePlaceholders } from "@/lib/providers/meta";
import type { TemplateComponent } from "@ccp/shared/providers/types";
import {
  LIMITED_TIME_OFFER_LIMITS,
  TEMPLATE_AUTO_ARCHIVE_MONTHS,
  TEMPLATE_LIMITS,
  templateDeletionDaysLeft,
  requiredCarouselCards,
  requiredTemplateButtonParams,
  templateNeedsOfferExpiry,
  templateNamedPlaceholders,
  unsupportedTemplateFeature,
} from "@ccp/shared/template-render";
import type { Channel, ContactFieldFilter } from "@ccp/shared/types";
import {
  BROADCASTABLE_CHANNELS,
  CHANNEL_CAPABILITIES,
  isAccountScopedIdentity,
} from "@ccp/shared/providers/capabilities";
import { checkTextCap } from "../lib/messaging/text-cap";
import {
  contactFieldFilterClauses,
  fieldFiltersToJson,
  parseStoredFieldFilters,
} from "@/lib/contact-fields/filter-where";
import { directoryContactWhere, resolveAudienceGroupMembers } from "@/lib/queries";
import { channelAccountDisplayName } from "@/lib/channel-accounts/display";
import {
  parseVariableBindings,
  resolveBinding,
  type VariableBinding,
} from "@ccp/shared/template-bindings";
import { resolveFieldTokens } from "@ccp/shared/field-tokens";

import { DbService } from "../db/db.service";
import { EventBus } from "../events/event-bus.module";
import type {
  AudienceInput,
  BroadcastListQuery,
  CreateBroadcastInput,
  PreviewMissingFieldsInput,
} from "./broadcasts.schemas";

/** Friendly field name for a variable binding, for the pre-send warning.
 *  null for manual (agent-typed) variables — those "empty" cases are the
 *  agent's own blank input, not a missing contact field. */
function bindingFieldLabel(binding: VariableBinding | undefined): string | null {
  if (!binding || binding.source.kind === "manual") return null;
  if (binding.source.kind === "contact_field") {
    return binding.source.field === "phoneNumber"
      ? "phone number"
      : binding.source.field;
  }
  return binding.source.key;
}


/**
 * How long a contact is skipped for MARKETING sends after hitting Meta's
 * per-user marketing cap (131049).
 *
 * Meta's own number: "wait at least 24 hours before attempting to resend."
 * Sooner earns the same error, and a WABA that repeatedly retries capped users
 * can have delivery to those users cut off for up to 24 hours.
 */
const PER_USER_MARKETING_CAP_COOLDOWN_MS = 24 * 60 * 60 * 1000;

@Injectable()
export class BroadcastsService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(BroadcastsService.name);

  constructor(
    private readonly db: DbService,
    private readonly bus: EventBus,
  ) {}

  /**
   * Boot-time crash recovery + paused-broadcast resume. See
   * `reconcileOrphanedBroadcasts` in lib/broadcast-runner.ts for the full
   * rationale; in short, `running` orphans get demoted to `paused`, and
   * every `paused` row gets re-fired through startBroadcast() so the
   * runner picks up where the prior process left off (CAS per recipient).
   */
  async onModuleInit(): Promise<void> {
    try {
      await reconcileOrphanedBroadcasts();
    } catch (err) {
      this.logger.error("orphan reconciler failed on boot", err);
    }
    // Prune in-memory Map entries pinned to broadcasts that died in a terminal
    // state in a prior process. Must run AFTER reconcileOrphanedBroadcasts so
    // `running`/`paused` rows have already been demoted; what remains as
    // terminal is the safe-to-prune set. See header doc-comment in
    // broadcast-runner.ts for the list of Maps this touches.
    try {
      await pruneBroadcastInMemoryStateForTerminalRows();
    } catch (err) {
      this.logger.error("in-memory state prune failed on boot", err);
    }
    // Re-enqueue delayed jobs for any `scheduled` broadcasts. Covers the case
    // where Redis lost the job (flush / non-persistent restart) while the row
    // still says scheduled. Idempotent: enqueue uses jobId=bcast-<id>, so a
    // surviving job isn't duplicated. A past scheduledAt → clamped to fire
    // immediately (the worker's CAS still guards a canceled row).
    try {
      const scheduled = await this.db.broadcast.findMany({
        where: { status: "scheduled" },
        select: { id: true, scheduledAt: true },
      });
      for (const b of scheduled) {
        const delay = (b.scheduledAt?.getTime() ?? Date.now()) - Date.now();
        await enqueueScheduledBroadcast(b.id, delay).catch((err) =>
          this.logger.warn(
            `re-enqueue scheduled broadcast ${b.id} failed: ${err instanceof Error ? err.message : err}`,
          ),
        );
      }
      if (scheduled.length > 0) {
        this.logger.log(`re-enqueued ${scheduled.length} scheduled broadcast(s) on boot`);
      }
    } catch (err) {
      this.logger.error("scheduled-broadcast reconciler failed on boot", err);
    }
  }

  /**
   * Graceful drain — fired by NestJS when main.ts triggers app.close().
   * Order is:
   *   1. signalShutdown() — sets the in-process flag the runner's lanes
   *      check between recipients. New startBroadcast() calls are also
   *      refused (would 503 the create endpoint, but we're shutting down
   *      so no new broadcasts should be hitting us anyway).
   *   2. Await the in-flight `runBroadcast(id)` promises with a timeout
   *      budget. Returning from each promise means every lane has finished
   *      its CURRENT recipient (Meta call + DB write) and the runner has
   *      stamped the parent row as `paused`.
   *   3. The timeout budget here matches main.ts's overall systemd
   *      TimeoutStopSec=120s minus headroom for the other onModuleDestroy
   *      hooks (workers, sweepers, queue close, Prisma pool drain). 25s
   *      covers ~125 recipient drain at 5 lanes × 200ms gap. Past that,
   *      any still-running lanes are killed mid-recipient and the boot
   *      reconciler will resume that broadcast cleanly (recipient stays
   *      `queued`, runner re-fires after restart).
   */
  async onModuleDestroy(): Promise<void> {
    signalShutdown();
    const inFlight = getInFlightRunPromises();
    if (inFlight.length === 0) return;

    this.logger.log(
      `draining ${inFlight.length} in-flight broadcast(s) for graceful shutdown`,
    );

    const drainTimeoutMs = 25_000;
    await Promise.race([
      Promise.allSettled(inFlight),
      new Promise<void>((resolve) =>
        setTimeout(() => {
          this.logger.warn(
            `broadcast drain exceeded ${drainTimeoutMs}ms — abandoning in-flight runs; boot reconciler will resume them`,
          );
          resolve();
        }, drainTimeoutMs).unref(),
      ),
    ]);
  }

  /**
   * Create a Broadcast row + snapshot recipients + fire-and-forget the
   * runner. Returns the new id immediately so the UI can redirect to the
   * detail page and watch progress via the bus events.
   *
   * Audience resolution happens HERE (not in the runner) so the audience
   * snapshot is locked at creation time — later tagging changes don't
   * affect an already-queued broadcast.
   *
   * Runner kickoff is `setImmediate` inside startBroadcast — the HTTP
   * response returns before any Meta sends happen. The runner publish()
   * events reach realtime-fanout in this same process with zero pub/sub hop.
   */
  /**
   * The account a campaign sends from: the one the operator chose, else the
   * channel's default.
   *
   * Validated against the workspace AND the channel — an id from the request
   * body could otherwise name another tenant's connection, or a Messenger Page
   * on a WhatsApp campaign.
   */
  private async resolveSendingAccount(
    workspaceId: string,
    channel: Channel,
    requested: string | undefined,
  ): Promise<string | null> {
    if (requested) {
      const row = await this.db.channelConnection.findFirst({
        where: { id: requested, workspaceId, channel },
        select: { id: true, isActive: true },
      });
      if (!row) {
        throw new BadRequestException({
          error: "unknown_account",
          detail: `That ${channel} account doesn't belong to this workspace.`,
        });
      }
      if (!row.isActive) {
        throw new BadRequestException({
          error: "account_inactive",
          detail: `That ${channel} account isn't connected right now. Reconnect it or pick another.`,
        });
      }
      return row.id;
    }
    const fallback = await this.db.channelConnection.findFirst({
      where: { workspaceId, channel, isActive: true },
      orderBy: [{ isDefault: "desc" }, { createdAt: "asc" }],
      select: { id: true },
    });
    return fallback?.id ?? null;
  }

  async create(
    workspaceId: string,
    /** Null when an API key launched it — an integration is not a person.
     *  `Broadcast.createdById` is already nullable for exactly this. */
    userId: string | null,
    input: CreateBroadcastInput,
  ): Promise<{ broadcastId: string; totalCount: number; scheduled: boolean }> {
    const { templateId, audience, variables } = input;

    // Resolve the schedule up front. A scheduledAt in the future → the
    // broadcast is created `scheduled` and a delayed job fires it later; a
    // null/past value → send now (legacy path).
    const SCHEDULE_LEAD_MS = 30_000; // treat <30s-out as "now" — not worth a job
    const scheduledAtDate = input.scheduledAt ? new Date(input.scheduledAt) : null;
    const isFutureSchedule =
      scheduledAtDate !== null &&
      scheduledAtDate.getTime() - Date.now() > SCHEDULE_LEAD_MS;
    const name = input.name && input.name.length > 0 ? input.name : null;

    // `freeform` broadcasts (Messenger/Instagram) send a plain body to a target
    // channel and skip the whole template gauntlet. `template` broadcasts load +
    // validate the approved WhatsApp template exactly as before. The input
    // schema's refine already guarantees the right fields per kind.
    const effectiveKind = input.kind;
    const freeformChannel = input.kind === "freeform" ? input.channel! : null;
    const template =
      effectiveKind === "template"
        ? await this.db.messageTemplate.findFirst({ where: { id: templateId, workspaceId } })
        : null;
    if (effectiveKind === "template" && !template) {
      throw new NotFoundException({ error: "template_not_found" });
    }
    if (template) {
      if (template.status !== "approved") {
        // Archived is the one non-sendable state with a way back AND a deadline
        // — and a broadcast is exactly where an operator meets a template they
        // haven't used in a year. "Template is archived" alone would be true and
        // useless.
        const days =
          template.status === "archived"
            ? templateDeletionDaysLeft(template.archivedAt)
            : null;
        throw new ConflictException({
          error: "template_not_approved",
          detail:
            template.status === "archived"
              ? `Template was archived after ${TEMPLATE_AUTO_ARCHIVE_MONTHS} months without use. ` +
                `Unarchive it in WhatsApp Manager to restore it` +
                (days !== null
                  ? ` — Meta deletes it permanently in about ${days} day${days === 1 ? "" : "s"}.`
                  : `.`)
              : `Template is ${template.status}. Only approved templates can be broadcast.`,
        });
      }

      // Commerce templates need send-time product parameters nothing here
      // collects — launching one mass-fails the whole audience with an
      // unlabelled Meta error per recipient. Same guard as the single-send
      // path; refusing at create is what keeps the failure report empty.
      {
        const unsupported = unsupportedTemplateFeature(template.components);
        if (unsupported) {
          throw new BadRequestException({
            error: "template_feature_unsupported",
            detail: `This template uses ${unsupported}, which this platform can't send yet.`,
          });
        }
      }

      // NAMED vs POSITIONAL is `parameterFormat`, Meta's own answer stored at
      // sync time — never a regex over the body (§18): a positional template
      // carrying a literal `{{order_id}}` in its copy would be misread, and the
      // wrong wire shape fails every recipient with 132000.
      //
      // Named templates ARE broadcastable: the composer collects one value per
      // placeholder in FIRST-APPEARANCE order and the runner zips the array back
      // against the names, so both counts below adapt to the format exactly as
      // the runner's own guard does.
      const parameterFormat: "named" | "positional" =
        template.parameterFormat === "named" ? "named" : "positional";
      const namedBodyVars =
        parameterFormat === "named" ? templateNamedPlaceholders(template.bodyText) : [];
      // Button values are CAMPAIGN-LEVEL (one coupon code / URL suffix for
      // every recipient — same shape as the location pin and the LTO expiry).
      // Every button the template demands must be covered, or Meta rejects
      // every recipient.
      const requiredButtons = requiredTemplateButtonParams(
        template.components,
        template.category,
      );
      if (requiredButtons.length > 0) {
        const suppliedButtons = variables.buttons ?? [];
        const missing = requiredButtons.filter(
          (need) =>
            !suppliedButtons.some(
              (b) =>
                b.index === need.index &&
                b.subType === need.subType &&
                b.text.trim() !== "",
            ),
        );
        if (missing.length > 0) {
          throw new BadRequestException({
            error: "template_needs_button_parameters",
            detail:
              `This template's button(s) need a send-time value: ${missing
                .map((b) => `#${b.index + 1} (${b.subType})`)
                .join(", ")}. Supply them as \`variables.buttons\` — one value ` +
              `for the whole campaign.`,
          });
        }
        // Same caps as the single-send path: a plain coupon code caps at 20,
        // a limited-time-offer code at 15 — over either, Meta fails every
        // recipient without naming the field.
        const hasLto = (template.components as Array<{ type?: unknown }>).some(
          (c) =>
            typeof c?.type === "string" &&
            c.type.toUpperCase() === "LIMITED_TIME_OFFER",
        );
        const codeMax = hasLto
          ? LIMITED_TIME_OFFER_LIMITS.offerCodeMaxLength
          : TEMPLATE_LIMITS.copyCodeExampleMaxLength;
        for (const b of suppliedButtons) {
          if (b.subType === "copy_code" && b.text.length > codeMax) {
            throw new BadRequestException({
              error: "coupon_code_too_long",
              detail:
                `${hasLto ? "A limited-time offer code" : "Coupon codes"} ` +
                `${hasLto ? "is" : "are"} limited to ${codeMax} characters — ` +
                `button #${b.index + 1}'s is ${b.text.length}.`,
            });
          }
        }
      }

      // Variable count sanity check — fire BEFORE creating the row so the UI
      // can correct without a broadcast row hanging around in `queued`. A named
      // body's expected count is the number of DISTINCT names, not the highest
      // `{{n}}` (the runner's guard is the same shape).
      const bodyVarCount =
        parameterFormat === "named"
          ? namedBodyVars.length
          : countTemplatePlaceholders(template.bodyText);
      if (variables.body.length !== bodyVarCount) {
        throw new BadRequestException({
          error: "wrong_variable_count",
          detail: `Template expects ${bodyVarCount} body variable(s), got ${variables.body.length}.`,
        });
      }
      const components = Array.isArray(template.components)
        ? (template.components as unknown as TemplateComponent[])
        : [];
      const headerComp = components.find((c) => c.type === "HEADER");
      // A NAMED-format header ({{customer_name}}) carries at most ONE parameter,
      // sent with its `parameter_name` (see send-template-internal's headerNamed
      // path) — so the composer collects a single header value for it, exactly
      // as it does for a positional `{{1}}`. Counted by format for the same
      // reason as the body: a regex here would misread a positional header whose
      // copy contains a literal {{word}}.
      const headerVarCount =
        headerComp?.format === "TEXT" && headerComp.text
          ? parameterFormat === "named"
            ? templateNamedPlaceholders(headerComp.text).length > 0
              ? 1
              : 0
            : countTemplatePlaceholders(headerComp.text)
          : 0;
      if (headerVarCount > 0 && (!variables.header || variables.header.length === 0)) {
        throw new BadRequestException({
          error: "header_variable_required",
          detail: "This template's header has a placeholder — fill it in.",
        });
      }
      // A GIF header is confined to Meta's Marketing Messages API — without
      // this refusal it falls past the media map below and every recipient
      // fails at Meta with an unlabelled 400 (same guard as the send path).
      if (headerComp?.format === "GIF") {
        throw new BadRequestException({
          error: "template_feature_unsupported",
          detail:
            "This template's GIF header can only be sent through Meta's Marketing Messages API — pick a template with an image or video header.",
        });
      }
      // Media-header templates (IMAGE/VIDEO/DOCUMENT) need the campaign media
      // supplied as a public link — one media reused across every recipient.
      const HEADER_MEDIA_FORMATS: Record<string, "image" | "video" | "document"> = {
        IMAGE: "image",
        VIDEO: "video",
        DOCUMENT: "document",
      };
      const headerMediaKind = headerComp?.format
        ? HEADER_MEDIA_FORMATS[headerComp.format]
        : undefined;
      if (headerMediaKind) {
        if (!variables.headerMedia?.link) {
          throw new BadRequestException({
            error: "header_media_required",
            detail: `This template's header is a ${headerMediaKind} — attach one before scheduling.`,
          });
        }
        if (variables.headerMedia.kind !== headerMediaKind) {
          throw new BadRequestException({
            error: "header_media_kind_mismatch",
            detail: `This template's header expects a ${headerMediaKind}.`,
          });
        }
      }
      // Carousel cards. The count is FIXED at approval — a mismatch fails every
      // recipient at Meta, so it is caught before the campaign is scheduled.
      const cardRequirements = requiredCarouselCards(components);
      if (cardRequirements.length > 0) {
        const supplied = variables.cards ?? [];
        if (supplied.length !== cardRequirements.length) {
          throw new BadRequestException({
            error: "carousel_cards_required",
            detail: `This template was approved with ${cardRequirements.length} cards — supply all of them.`,
          });
        }
        for (const [i, need] of cardRequirements.entries()) {
          const card = supplied[i]!;
          if (card.kind !== need.headerKind) {
            throw new BadRequestException({
              error: "carousel_cards_required",
              detail: `Card ${i + 1} of this template is a ${need.headerKind} — attach one.`,
            });
          }
          if ((card.body?.length ?? 0) !== need.bodyVarCount) {
            throw new BadRequestException({
              error: "carousel_cards_required",
              detail: `Card ${i + 1} needs ${need.bodyVarCount} value(s) filled in.`,
            });
          }
          for (const b of need.buttons) {
            const value = (card.buttons ?? []).find(
              (x) => x.index === b.index && x.subType === b.subType,
            );
            if (!value || value.text.trim() === "") {
              throw new BadRequestException({
                error: "carousel_cards_required",
                detail: `Card ${i + 1}'s button needs a value.`,
              });
            }
          }
        }
      }
      // A LOCATION header carries no coordinates on the template — the pin is
      // per-message. Campaign-level here: one store opening, one venue.
      if (headerComp?.format === "LOCATION" && !variables.headerLocation) {
        throw new BadRequestException({
          error: "header_location_required",
          detail: "This template shows a map — set the location before scheduling.",
        });
      }
      // A countdown template needs the instant it counts to. It is campaign-
      // level (one deadline for the whole send), and without it Meta rejects
      // EVERY recipient — so it is caught here, like the header media above.
      if (templateNeedsOfferExpiry(components)) {
        const expiresAt = variables.limitedTimeOfferExpiresAtMs;
        if (expiresAt === undefined) {
          throw new BadRequestException({
            error: "offer_expiry_required",
            detail: "This template shows a countdown — set when the offer expires.",
          });
        }
        // Checked against NOW rather than the scheduled send time: a campaign
        // scheduled for next week whose offer expires tomorrow is a real (if
        // odd) choice, but one that has ALREADY expired is always a mistake.
        if (expiresAt <= Date.now()) {
          throw new BadRequestException({
            error: "offer_expiry_required",
            detail: "That offer expiry is in the past — pick a future time.",
          });
        }
      }
    }

    // Freeform body length gate — the composer's 2000-char Textarea/schema bound
    // is the WhatsApp/Messenger limit, but Instagram's is 1000 UTF-8 BYTES
    // (CHANNEL_CAPABILITIES.instagram: messageTextMaxChars=1000 + textLimitIsBytes).
    // Without this an Instagram freeform broadcast with an over-limit body sails
    // through create and then fails EVERY recipient at Meta. Reuse the shared,
    // byte-aware `checkTextCap` the four other send paths use so a multibyte
    // (Arabic/emoji) body is measured in the SAME unit Meta enforces — a bare
    // `.length` char count silently under-counts Instagram's byte cap. For a
    // fixed freeform channel we cap against that channel; customer-mode resolves
    // a channel per recipient, so we check EVERY live channel and raise on the
    // first (strictest, byte-aware) bound any recipient could hit.
    if (effectiveKind === "freeform" && input.bodyText) {
      const capChannels = freeformChannel ? [freeformChannel] : [...BROADCASTABLE_CHANNELS];
      for (const c of capChannels) {
        const over = checkTextCap(input.bodyText, CHANNEL_CAPABILITIES[c], c);
        if (over) {
          throw new BadRequestException({
            error: "message_too_long",
            detail: freeformChannel
              ? over.detail
              : `${over.detail} (must fit every channel to reach all recipients).`,
          });
        }
      }
    }

    // Resolve recipient contact ids based on audience mode. `by_tag` is the
    // OR-union over selected tags (matches segmentation-tool convention).
    let recipientIds: string[] = [];
    let validatedTagIds: string[] = [];
    let resolvedGroupId: string | null = null;
    let resolvedGroupName: string | null = null;

    // Select-field predicates: AND-narrow the WHOLE resolved audience (see
    // AudienceFieldFiltersSchema). Deliberately NOT pruned to owned ids here —
    // a stale/foreign option id matches nothing, which NARROWS; pruning it
    // would silently widen a billed send past what the operator asked for.
    // (`group` mode overwrites this with the group's STORED filters below.)
    let appliedFieldFilters: ContactFieldFilter[] =
      (audience.mode === "all" ||
        audience.mode === "by_tag" ||
        audience.mode === "custom") &&
      audience.fieldFilters?.length
        ? audience.fieldFilters
        : [];
    const fieldAnd = () =>
      appliedFieldFilters.length > 0
        ? { AND: contactFieldFilterClauses(appliedFieldFilters) }
        : {};

    if (audience.mode === "all") {
      // COUNT BEFORE FETCH. The ceiling is enforced below, but it used to be
      // checked only AFTER this findMany had already materialised every id — so a
      // tenant with a large contact table transiently allocated hundreds of MB
      // inside a plain retryable POST, and a couple of concurrent retries could
      // OOM-restart the container for ALL tenants. Counting first rejects the
      // oversized audience for the cost of one index-only scan, and the `take`
      // bounds the fetch even if the count races an import.
      // Exclude ANONYMOUS ephemeral (widget) sessions from BOTH the cap count
      // and the fetch — they're never sent to, so counting them inflated the
      // total against the policy cap and rejected large mixed-channel tenants
      // whose actual reachable audience was under the limit. Use the canonical
      // directory filter (identityChannel-not-ephemeral OR phone OR email) rather
      // than a blanket channel exclusion, so a widget visitor who SELF-IDENTIFIED
      // (gained a phone/email → promoted into the directory) still counts. Safe
      // scalar AND — directoryContactWhere's OR has no sibling OR here.
      const allModeWhere: Prisma.ContactWhereInput = {
        workspaceId,
        deletedAt: null,
        ...directoryContactWhere,
        // Field predicates ride an AND key — no collision with the directory
        // filter's OR, and they can only narrow.
        ...fieldAnd(),
      };
      await this.assertAudienceWithinCap(
        this.db.contact.count({ where: allModeWhere }),
      );
      recipientIds = (
        await this.db.contact.findMany({
          where: allModeWhere,
          select: { id: true },
          take: MAX_RECIPIENTS_IN_PROCESS + 1,
        })
      ).map((c) => c.id);
    } else if (audience.mode === "by_tag") {
      if (audience.tagIds.length === 0) {
        throw new BadRequestException({
          error: "no_tags_selected",
          detail: "Pick at least one tag.",
        });
      }
      // Validate tag ownership before the contact lookup — a foreign-team
      // id would silently yield zero recipients otherwise.
      const tagRows = await this.db.tag.findMany({
        where: { workspaceId, id: { in: audience.tagIds } },
        select: { id: true },
      });
      validatedTagIds = tagRows.map((t) => t.id);
      if (validatedTagIds.length === 0) {
        throw new BadRequestException({
          error: "no_valid_tags",
          detail: "None of the selected tags belong to this team.",
        });
      }
      // Same count-before-fetch guard as `mode: "all"` — a broadly-applied tag
      // reaches the same size and the same OOM shape.
      const tagWhere: Prisma.ContactWhereInput = {
        workspaceId,
        deletedAt: null,
        tags: { some: { id: { in: validatedTagIds } } },
        ...fieldAnd(),
      };
      await this.assertAudienceWithinCap(this.db.contact.count({ where: tagWhere }));
      const taggedContacts = await this.db.contact.findMany({
        where: tagWhere,
        select: { id: true },
        take: MAX_RECIPIENTS_IN_PROCESS + 1,
      });
      recipientIds = taggedContacts.map((c) => c.id);
    } else if (audience.mode === "group") {
      if (!audience.groupId) {
        throw new BadRequestException({
          error: "group_id_required",
          detail: "Pick a saved group.",
        });
      }
      const group = await this.db.audienceGroup.findFirst({
        where: { id: audience.groupId, workspaceId },
        include: {
          tags: { select: { id: true } },
          contacts: { select: { id: true } },
        },
      });
      if (!group) {
        throw new NotFoundException({
          error: "group_not_found",
          detail: "This audience group no longer exists.",
        });
      }
      // Snapshot the group's tag + manual membership into a concrete id set
      // at THIS moment. New contacts matching the tag criteria after this
      // point won't join the in-flight broadcast. The group's STORED field
      // filters apply here (and are stamped on the row for the audit trail).
      appliedFieldFilters = parseStoredFieldFilters(group.fieldFilters);
      recipientIds = await resolveAudienceGroupMembers(workspaceId, {
        tagIds: group.tags.map((t) => t.id),
        manualContactIds: group.contacts.map((c) => c.id),
        fieldFilters: appliedFieldFilters,
        // +1 so the over-cap check below still sees "more than the limit".
        limit: MAX_RECIPIENTS_IN_PROCESS + 1,
      });
      resolvedGroupId = group.id;
      resolvedGroupName = group.name;
    } else if (audience.mode === "custom") {
      // One-off audience built inline — same UNION semantics as a saved group
      // (contacts carrying ANY chosen tag, OR hand-picked by id), resolved and
      // snapshotted now. Tags are validated for the stored audit set; foreign
      // contact ids drop out automatically (the resolver scopes by workspaceId).
      const tagRows = audience.tagIds.length
        ? await this.db.tag.findMany({
            where: { workspaceId, id: { in: audience.tagIds } },
            select: { id: true },
          })
        : [];
      validatedTagIds = tagRows.map((t) => t.id);
      recipientIds = await resolveAudienceGroupMembers(workspaceId, {
        tagIds: validatedTagIds,
        manualContactIds: audience.contactIds,
        fieldFilters: appliedFieldFilters,
        limit: MAX_RECIPIENTS_IN_PROCESS + 1,
      });
    } else {
      // mode === "selected"
      recipientIds = Array.from(
        new Set(
          (
            await this.db.contact.findMany({
              where: { workspaceId, deletedAt: null, id: { in: audience.contactIds } },
              select: { id: true },
            })
          ).map((c) => c.id),
        ),
      );
    }

    // Resolve the recipient ROWS. A broadcast is strictly SINGLE-CHANNEL:
    // drop contacts whose identity channel doesn't match — a mixed
    // audience/tag/group sweeps in others that can't receive this send. (The
    // runner + Meta enforce the per-send window for freeform.) The omnichannel
    // `customer` mode was removed 2026-07-27; see broadcasts.schemas.ts.
    const filterChannel: Channel = template ? "whatsapp" : freeformChannel ?? "whatsapp";
    const hadAnyBeforeFilter = recipientIds.length > 0;

    // ── The sending ACCOUNT ─────────────────────────────────────────────────
    // Which number / Page / handle this campaign goes out on. A workspace can
    // hold several per channel, and every one of them is a distinct sender
    // identity to the customer — so the campaign binds to one, and both the
    // audience and the template catalogue are scoped to it below.
    //
    // `allAccounts` is the one shape that binds NONE. Where identity is
    // account-scoped no single account can address everyone, so the campaign
    // stores a NULL account and the runner routes each recipient through the one
    // that issued their id (`isSocialFanOut` — lib/broadcasts/social-account-
    // router.ts). Resolving the channel default here regardless is what made
    // that whole path unreachable, and it silently dropped every other account's
    // contacts in the scoping block below.
    const fanOutAccounts = input.allAccounts === true;
    if (fanOutAccounts && !isAccountScopedIdentity(filterChannel)) {
      throw new BadRequestException({
        error: "all_accounts_not_supported",
        detail:
          `On ${filterChannel} a phone number is global, so any of your numbers can message anyone — ` +
          "which one a campaign sends from is a deliberate choice rather than a forced one. Pick the " +
          'sending account, and turn on "include contacts from other accounts" to reach the rest from it.',
      });
    }
    const sendingAccountId = fanOutAccounts
      ? null
      : await this.resolveSendingAccount(
          workspaceId,
          filterChannel,
          input.channelConnectionId,
        );

    // A template belongs to a WhatsApp Business Account, and a number can only
    // send templates from its OWN WABA. Sending one from the wrong account is
    // rejected by Meta per-recipient with an opaque error, so catch it here —
    // before a single row is written.
    if (template && sendingAccountId) {
      const account = await this.db.channelConnection.findFirst({
        where: { id: sendingAccountId, workspaceId },
        select: { wabaAccountId: true },
      });
      // A missing account WABA is a REFUSAL, not "no opinion" — see the same
      // hardening in send-template-internal.ts. The old form defaulted both sides
      // to the `""` sentinel and so passed whenever either was unknown, which let
      // a WABA-less number blast any template in the workspace.
      if (!account?.wabaAccountId) {
        throw new BadRequestException({
          error: "waba_unknown",
          detail:
            "The number you're sending from has no WhatsApp Business Account linked, so " +
            "it has no template catalog. Add its WABA ID in WhatsApp settings first.",
        });
      }
      if (account.wabaAccountId !== template.wabaAccountId) {
        throw new BadRequestException({
          error: "template_wrong_account",
          detail:
            "That template belongs to a different WhatsApp Business Account than the number " +
            "you're sending from. Pick a template from this account, or switch the sending number.",
        });
      }
    }

    // The `limit: MAX + 1` on the group/custom resolvers above is a HEAP guard,
    // and it must be converted into a rejection HERE — before the channel and
    // opt-out filters below shrink the list.
    //
    // Otherwise the +1 sentinel is destroyed by filtering and the cap check at
    // the bottom sees a plausible number: a tag matching 400k contacts resolves
    // to an arbitrary 100,001, the WhatsApp-only filter cuts that to ~22k, the
    // guard passes, and the operator gets a campaign that silently reaches 22k
    // of their 90k WhatsApp audience while reporting success. Before the limit
    // existed the resolve was unbounded and this correctly rejected.
    //
    // Checked against the RAW resolved set, so "more than the cap matched" is
    // answered by the same list the cap describes.
    if (recipientIds.length > MAX_RECIPIENTS_IN_PROCESS) {
      throw new BadRequestException({
        error: "audience_too_large",
        detail:
          `This audience matches more than ${MAX_RECIPIENTS_IN_PROCESS.toLocaleString()} contacts; ` +
          `the limit is ${MAX_RECIPIENTS_IN_PROCESS.toLocaleString()}. Narrow the tags or split it ` +
          `into smaller broadcasts.`,
      });
    }

    // Set when the audience was narrowed to the sending ACCOUNT and the operator
    // did NOT opt into reaching other accounts' contacts — used only to make the
    // "empty audience" message say which of the two filters emptied it.
    let droppedByAccount = 0;
    if (hadAnyBeforeFilter) {
      const rows = await this.db.contact.findMany({
        where: {
          workspaceId,
          id: { in: recipientIds },
          identityChannel: filterChannel,
          deletedAt: null,
        },
        select: { id: true },
      });
      recipientIds = rows.map((c) => c.id);
    }

    // ── Account scoping ───────────────────────────────────────────────────
    // A workspace can hold several accounts on one channel (WhatsApp numbers
    // under a portfolio, Pages, IG handles). Broadcasting from account B to a
    // contact who has only ever talked to account A shows them a sender they
    // don't recognise — and when they reply, the thread MIGRATES to B.
    //
    // (It does NOT split in two, which an earlier version of this comment
    // claimed. `Conversation` is `@@unique([workspaceId, contactId])` and a
    // WhatsApp contact is unique per (workspace, phone), so one customer has
    // exactly one thread no matter which of our numbers they write to. The
    // reply lands on B, ingest re-stamps `channelConnectionId` to B, and from
    // then on the agent who owned that customer on A replies from B. History
    // stays unified; the OWNERSHIP moves, silently.)
    //
    // That migration is the real cost, and it is why the default audience is
    // the sending account's own contacts and reaching the rest is an explicit
    // opt-in (`includeOtherAccounts`) rather than a silent default.
    //
    // ALL OF THE ABOVE IS WHATSAPP REASONING, and it does not carry to the social
    // channels. A phone number is globally valid, so messaging a contact from a
    // second number WORKS — that is why the cost there is merely ownership
    // migration. An Instagram-scoped id is, in Meta's words, "specific to the
    // person and the Instagram account they are interacting with", and a
    // Messenger PSID is page-scoped identically. The id a customer has on account
    // A is not a resolvable recipient for account B.
    //
    // So on those channels the opt-in is not a tradeoff, it is an impossible
    // request: honouring it queues an entire audience of sends that CANNOT
    // succeed, burns the campaign, and reports opaque Meta errors that read like
    // a delivery fault rather than a mis-specified one. It is forced off, and the
    // caller is told rather than silently overridden.
    const identityIsAccountScoped = isAccountScopedIdentity(filterChannel);
    const crossAccountRequested = input.includeOtherAccounts === true;
    if (identityIsAccountScoped && crossAccountRequested) {
      throw new BadRequestException({
        error: "cross_account_not_possible",
        detail:
          `On ${filterChannel}, a contact's id only works for the account that received their message — ` +
          "Meta scopes it to that account. Sending from a different account can't reach them, so " +
          "this audience is always limited to the sending account's own contacts. Run one broadcast " +
          "per account to cover everyone.",
      });
    }
    if (sendingAccountId && recipientIds.length > 0 && (identityIsAccountScoped || !input.includeOtherAccounts)) {
      // Only contacts that BELONG TO ANOTHER account are dropped.
      //
      // A contact with no conversation at all has no account yet — imported
      // and manually-added contacts are exactly that, and they are the whole
      // point of a cold broadcast. Filtering to "has a conversation on THIS
      // account" would have removed every one of them and reported an empty
      // audience for the commonest campaign there is.
      //
      // A null `channelConnectionId` is the same story for a different reason:
      // conversations that predate multi-account carry no account, so they
      // belong to no one in particular and stay reachable.
      const elsewhere = await this.db.conversation.findMany({
        where: {
          workspaceId,
          contactId: { in: recipientIds },
          channelConnectionId: { not: null },
          NOT: { channelConnectionId: sendingAccountId },
        },
        select: { contactId: true },
      });
      const foreign = new Set(elsewhere.map((c) => c.contactId));
      droppedByAccount = foreign.size;
      if (foreign.size > 0) {
        recipientIds = recipientIds.filter((id) => !foreign.has(id));
      }
    }

    let recipientRows: Array<{ contactId: string; customerId: string | null }> =
      recipientIds.map((id) => ({ contactId: id, customerId: null }));

    if (recipientRows.length === 0) {
      throw new BadRequestException({
        error: "empty_audience",
        detail:
          droppedByAccount > 0
            ? `All ${droppedByAccount} selected contact${droppedByAccount === 1 ? "" : "s"} ` +
              `belong to another of your ${filterChannel} accounts. Switch the sending ` +
              // Never suggest an option this channel refuses: on an
              // account-scoped channel "include contacts from other accounts" is
              // rejected outright (cross_account_not_possible) and fan-out is the
              // only way to reach them.
              (identityIsAccountScoped
                ? `account, or pick "All accounts" so each of them is messaged from the ` +
                  `account they wrote to.`
                : `account, or turn on "include contacts from other accounts" to reach them ` +
                  `from this one.`)
            : hadAnyBeforeFilter
              ? `None of the selected contacts are on ${filterChannel}.`
              : appliedFieldFilters.length > 0
                ? "No contacts match this audience — your field filters may have excluded everyone."
                : "Pick at least one contact (or 'All contacts') to broadcast to.",
      });
    }

    // ── Marketing opt-out suppression ────────────────────────────────────────
    // Applied in exactly ONE place, AFTER every audience branch has resolved and
    // BEFORE the cap check — deliberately not inside the six resolution branches
    // above. A branch added later would otherwise silently skip suppression,
    // which is a compliance failure rather than a bug.
    //
    // Gated on template CATEGORY: only MARKETING sends suppress. A utility /
    // authentication message (order update, OTP) must still reach someone who
    // opted out of marketing — they asked for those, and blocking them would be
    // worse service, not better compliance.
    let suppressedCount = 0;
    const isMarketing =
      effectiveKind === "template" &&
      (template?.category ?? "MARKETING").toUpperCase() === "MARKETING";
    if (isMarketing && recipientRows.length > 0) {
      // INVERTED rather than chunked. Asking "which of these 100k opted out"
      // needs a 100k-parameter `in` list; asking "who on this team has opted
      // out" is one bounded, indexed query whose result we intersect in memory.
      // Opt-outs are a small fraction of a contact book, so this is both
      // parameter-safe and cheaper than ~100 chunked round-trips.
      const optedOut = await this.db.contact.findMany({
        where: { workspaceId, marketingOptOutAt: { not: null } },
        select: { id: true },
      });
      // Contacts who hit Meta's PER-USER marketing cap (131049) inside the last
      // 24 hours. Meta's instruction is to wait a full day before resending:
      // sooner just earns the same error again, and a WABA that repeatedly
      // retries capped users can have delivery to them cut off for up to 24h.
      // Skipping them also keeps the campaign report honest — they were never
      // reachable, so counting them as failures misreports the send.
      //
      // Separate from an opt-out and NOT sticky: the person made no choice about
      // us, and the cap clears on its own, so this is a rolling window rather
      // than a flag anyone has to clear.
      const cappedSince = new Date(Date.now() - PER_USER_MARKETING_CAP_COOLDOWN_MS);
      const capped = await this.db.contact.findMany({
        where: { workspaceId, marketingCapReachedAt: { gte: cappedSince } },
        select: { id: true },
      });
      if (optedOut.length > 0 || capped.length > 0) {
        // Same inverted-lookup reasoning as above: both sets are a small slice
        // of the contact book, so intersecting in memory beats a 100k-parameter
        // `in` list.
        const blocked = new Set([
          ...optedOut.map((c) => c.id),
          ...capped.map((c) => c.id),
        ]);
        const before = recipientRows.length;
        recipientRows = recipientRows.filter((r) => !blocked.has(r.contactId));
        suppressedCount = before - recipientRows.length;
      }
      if (recipientRows.length === 0) {
        throw new BadRequestException({
          error: "all_recipients_opted_out",
          detail:
            capped.length > 0 && optedOut.length === 0
              ? `All ${suppressedCount} selected contacts recently hit WhatsApp's per-user ` +
                `marketing limit. Try again in 24 hours — resending sooner is refused anyway.`
              : `All ${suppressedCount} selected contacts have opted out of marketing messages.`,
        });
      }
    }

    // ── Blocked-contact suppression ──────────────────────────────────────────
    // Same single-choke-point placement as the marketing suppression above, but
    // NOT gated on category: a provider-level block (Block Users API) stops ALL
    // messaging, so utility/auth templates and freeform sends skip them too —
    // Meta rejects every send to a blocked user anyway. Same inverted lookup
    // (the blocklist is a small slice of the contact book; Meta caps it at
    // 64,000 entries). The runner re-checks at fire time for the create→fire gap.
    if (recipientRows.length > 0) {
      const blockedContacts = await this.db.contact.findMany({
        where: { workspaceId, blockedAt: { not: null } },
        select: { id: true },
      });
      if (blockedContacts.length > 0) {
        const blockedIds = new Set(blockedContacts.map((c) => c.id));
        const before = recipientRows.length;
        recipientRows = recipientRows.filter((r) => !blockedIds.has(r.contactId));
        suppressedCount += before - recipientRows.length;
      }
      if (recipientRows.length === 0) {
        throw new BadRequestException({
          error: "all_recipients_blocked",
          detail: "All selected contacts are blocked. Unblock them to message them again.",
        });
      }
    }

    // Enforce the recipient ceiling HERE, before writing any rows. This is the
    // policy cap (BROADCAST_MAX_RECIPIENTS, default 100k) — bound a single team's
    // blast radius / Meta spend. Reaching it ALSO requires the number's messaging
    // tier to allow it (the eligibility gate, checked below), but the hard ceiling
    // is enforced regardless.
    if (recipientRows.length > MAX_RECIPIENTS_IN_PROCESS) {
      throw new BadRequestException({
        error: "audience_too_large",
        detail: `This audience has ${recipientRows.length} recipients; the limit is ${MAX_RECIPIENTS_IN_PROCESS}. Split it into smaller broadcasts.`,
      });
    }

    // Pre-send eligibility gate (WhatsApp template broadcasts only): refuse — with
    // an actionable message — an audience the number's messaging-limit TIER can't
    // deliver to in 24h, BEFORE any row is written or Meta call made. Advisory
    // only when we have no tier snapshot (null → ungated). Skipped for freeform
    // (social windows, not a WhatsApp 24h unique-recipient tier).
    if (effectiveKind === "template") {
      // Pass the ids, not just the size: recipients already messaged inside the
      // rolling window consume no additional Meta budget, and without the ids
      // the gate assumes all of them are new and refuses legitimate re-sends.
      const audienceContactIds = recipientRows.map((r) => r.contactId);
      // Gate against the account this campaign actually sends FROM. The 24h
      // budget belongs to that number's PORTFOLIO — passing the workspace alone
      // silently measured the channel default's portfolio instead, so a send
      // from a second number was checked against a budget it does not draw on.
      let gate = await checkBroadcastEligibility(
        workspaceId,
        recipientRows.length,
        audienceContactIds,
        sendingAccountId,
      );
      if (!gate.allowed) {
        // The cached tier may be stale (a missed quality webhook on a number Meta
        // already upgraded) — hard-blocking on it would refuse a send Meta would
        // accept. Re-poll Graph ONCE (only on the block path, so it's rare) and
        // re-check before failing. A poll failure falls back to the stale block.
        // Poll the SENDING account — the number this gate is measuring; a
        // workspace-only poll resolves the default (or no-ops with 2+ numbers).
        await fetchWhatsappHealthFromGraph(workspaceId, sendingAccountId).catch(
          () => undefined,
        );
        gate = await checkBroadcastEligibility(
          workspaceId,
          recipientRows.length,
          audienceContactIds,
          sendingAccountId,
        );
      }
      if (!gate.allowed) {
        throw new BadRequestException({
          error: "over_messaging_limit",
          detail: gate.reason,
        });
      }
    }

    // Fields shared by both the synchronous and asynchronous create paths.
    const commonData = {
      workspaceId,
      createdById: userId,
      name,
      // Rolls this send up with its siblings. Absent for an ad-hoc broadcast,
      // which stays the common case.
      ...(input.campaignName ? { campaignName: input.campaignName } : {}),
      scheduledAt: scheduledAtDate,
      kind: effectiveKind,
      targetMode: input.targetMode,
      channel: filterChannel,
      // The account this campaign sends from.
      channelConnectionId: sendingAccountId,
      templateId: template?.id ?? null,
      templateName: template?.name ?? null,
      templateLanguage: template?.language ?? null,
      bodyText: template ? null : input.bodyText,
      variables: variables as unknown as Prisma.InputJsonValue,
      audienceMode: audience.mode,
      audienceTagIds: validatedTagIds,
      // Audit snapshot, sibling of audienceTagIds — the predicates as APPLIED
      // (inline ones, or the group's stored set). Null when none.
      audienceFieldFilters:
        appliedFieldFilters.length > 0
          ? fieldFiltersToJson(appliedFieldFilters)
          : Prisma.JsonNull,
      audienceGroupId: resolvedGroupId,
      audienceGroupName: resolvedGroupName,
      totalCount: recipientRows.length,
      // Surfaced in the report ("targeted 10,000 · 47 suppressed · 9,953
      // queued"). Without it totalCount silently shrinks and the operator asks
      // why only some of their audience got the message.
      suppressedCount,
      templateCategory: template?.category ?? null,
      // Campaign assignment (see BroadcastAssignmentMode). Stored on the row so
      // the recipient draw — which happens where the recipient rows are built,
      // in BOTH the sync path below and the materialize worker — reads one
      // config, and so the campaign detail page can explain who owns the
      // replies long after the fact.
      assignmentMode: input.assignment?.mode ?? "none",
      assignmentUserId: input.assignment?.userId ?? null,
      assignmentPolicyId: input.assignment?.policyId ?? null,
      // Prisma's nullable-Json input needs the explicit DbNull sentinel — a
      // bare `null` is a type error, not "clear the column".
      assignmentSplit: (input.assignment?.split ??
        Prisma.DbNull) as Prisma.InputJsonValue,
      assignmentLeftover: input.assignment?.leftover ?? "leave_unassigned",
      assignmentTrigger: input.assignment?.trigger ?? "on_reply",
      assignmentOverwrite: input.assignment?.overwrite ?? false,
    };

    // LARGE audience → async materialization. Inserting tens of thousands of
    // recipient rows inside the create transaction blows Prisma's interactive-tx
    // budget (P2028) and rolls the whole broadcast back. Instead, stage the
    // resolved recipients on the row (locking the snapshot at creation) in status
    // `materializing`, and let the broadcast-materialize worker chunk-insert them
    // off the request path, then flip to `queued`/`scheduled` and fire. Only
    // all/by_tag/group audiences reach here (hand-picked lists are capped at 5k).
    if (recipientRows.length > SYNC_MATERIALIZE_MAX) {
      const created = await this.db.broadcast.create({
        data: {
          ...commonData,
          status: "materializing",
          materializeRecipients: recipientRows as unknown as Prisma.InputJsonValue,
        },
        select: { id: true, totalCount: true },
      });
      try {
        await enqueueBroadcastMaterialize(created.id);
      } catch (err) {
        // Redis briefly down — the row stays `materializing` and the
        // materialize-drift sweeper + boot reconciler re-enqueue it.
        this.logger.error(
          `failed to enqueue materialize job for broadcast ${created.id} — sweeper will retry`,
          err,
        );
      }
      await this.bus.publish({
        type: "broadcast.status_changed",
        workspaceId,
        broadcastId: created.id,
        status: "materializing",
      });
      return {
        broadcastId: created.id,
        totalCount: created.totalCount,
        scheduled: isFutureSchedule,
      };
    }

    // SMALL audience → synchronous path (unchanged): create the broadcast row +
    // recipients in ONE transaction via CHUNKED createMany (bounded, Postgres-
    // plannable; all-or-nothing so a mid-write crash can't leave totalCount
    // disagreeing with the recipient rows). ≤5k recipients = ≤5 bounded inserts.
    const RECIPIENT_CHUNK = 1_000;
    // Draw the campaign's assignees BEFORE opening the transaction — the plan
    // needs its own reads (roster, policy pool) and doing them inside would add
    // avoidable round-trips to a tx that already has a tight budget (P2028).
    const assignmentPlan = await buildBroadcastAssignmentPlan({
      db: this.db,
      workspaceId,
      total: recipientRows.length,
      config: {
        mode: commonData.assignmentMode,
        assignmentUserId: commonData.assignmentUserId,
        assignmentPolicyId: commonData.assignmentPolicyId,
        assignmentSplit: commonData.assignmentSplit,
        assignmentLeftover: commonData.assignmentLeftover,
      },
    }).catch((err: unknown) => {
      // Assignment is a convenience on top of the send — never block it.
      this.logger.error("broadcast assignment planning failed; sending unassigned", err);
      return { perRecipient: [] as (string | null)[], totals: [] };
    });

    // Resolved OUTSIDE the transaction: it is a pure read, and the tx below is
    // already close to Prisma's interactive-tx timeout at 5k recipients.
    const recipientAccounts = await resolveRecipientAccounts(
      workspaceId,
      filterChannel,
      recipientRows.map((r) => r.contactId),
    );

    const broadcast = await this.db.$transaction(async (tx) => {
      const created = await tx.broadcast.create({
        data: {
          ...commonData,
          // Scheduled → the delayed job flips it to queued + runs at time.
          // Otherwise queued → runs immediately below.
          status: isFutureSchedule ? "scheduled" : "queued",
        },
        select: { id: true, totalCount: true },
      });
      for (let i = 0; i < recipientRows.length; i += RECIPIENT_CHUNK) {
        const slice = recipientRows.slice(i, i + RECIPIENT_CHUNK);
        await tx.broadcastRecipient.createMany({
          data: slice.map((r, j) => ({
            broadcastId: created.id,
            contactId: r.contactId,
            customerId: r.customerId,
            assignedUserId: assignmentPlan.perRecipient[i + j] ?? null,
            // WHICH ACCOUNT this recipient is sent from. Social ids are
            // account-scoped, so the sending account is a per-recipient fact —
            // see resolve-recipient-accounts.ts. Empty map (and so null) on
            // WhatsApp, which is deliberate.
            channelConnectionId: recipientAccounts.get(r.contactId) ?? null,
          })),
          skipDuplicates: true,
        });
      }
      return created;
    }, {
      // Prisma's default interactive-tx timeout is 5s; at ≤5k this tx does 1
      // create + ≤5 sequential 1k-row createMany round-trips, but under pool
      // contention that can still exceed 5s and roll back the whole create
      // (P2028). 30s headroom + a longer maxWait for a pool slot.
      timeout: 30_000,
      maxWait: 5_000,
    });

    if (isFutureSchedule && scheduledAtDate) {
      // Enqueue the delayed fire. If Redis is briefly down the enqueue throws;
      // the row stays `scheduled` and the boot reconciler re-enqueues it.
      try {
        await enqueueScheduledBroadcast(
          broadcast.id,
          scheduledAtDate.getTime() - Date.now(),
        );
      } catch (err) {
        this.logger.error(
          `failed to enqueue scheduled broadcast ${broadcast.id} — reconciler will retry`,
          err,
        );
      }
    } else {
      // Fire-and-forget; startBroadcast schedules via setImmediate so the
      // response returns before any Meta sends happen.
      startBroadcast(broadcast.id);
    }

    // Publish a status frame for the create itself. The runner publishes
    // its own status_changed on the queued→running flip and again on
    // terminal states, but a scheduled broadcast sits at "scheduled" for
    // hours/days with NO bus event — every other open broadcasts-list tab
    // wouldn't know the row exists until the next nav. This event drives
    // `broadcasts-browser.tsx` to refetch and surface the new row live.
    await this.bus.publish({
      type: "broadcast.status_changed",
      workspaceId,
      broadcastId: broadcast.id,
      status: isFutureSchedule ? "scheduled" : "queued",
    });

    return {
      broadcastId: broadcast.id,
      totalCount: broadcast.totalCount,
      scheduled: isFutureSchedule,
    };
  }

  /**
   * Pre-send preflight for the composer. Resolves the SAME audience the create
   * body would, then runs the ACTUAL runtime binding resolution
   * (resolveBinding → resolveFieldTokens, identical to the broadcast runner)
   * over a bounded sample of recipients to count how many would resolve a
   * template variable to EMPTY — which WhatsApp rejects. Read-only: it never
   * creates rows or touches the create path, so it's safe to call live as the
   * agent builds the campaign.
   */
  async previewMissingFields(
    workspaceId: string,
    input: PreviewMissingFieldsInput,
  ): Promise<{
    total: number;
    sampled: boolean;
    affectedCount: number;
    missing: Array<{
      location: "body" | "header";
      /** 1-based body variable position; 0 for the header variable. */
      position: number;
      /** Human field label when the variable is bound to a contact field
       *  (e.g. "email"), else null (a manual variable left blank). */
      fieldLabel: string | null;
      missingCount: number;
    }>;
  }> {
    const empty = { total: 0, sampled: false, affectedCount: 0, missing: [] as [] };
    const { templateId, audience, variables } = input;

    const template = await this.db.messageTemplate.findFirst({
      where: { id: templateId, workspaceId },
      select: { variableBindings: true },
    });
    if (!template) return empty;
    const bindings = parseVariableBindings(template.variableBindings as never);

    // Bounded to keep the composer snappy even on a huge audience. The count is
    // exact up to the cap; past it we flag `sampled` so the UI says "at least".
    const SCAN_CAP = 3000;
    const scanIds = await this.previewRecipientIds(workspaceId, audience, SCAN_CAP + 1);
    if (scanIds.length === 0) return empty;
    const sampled = scanIds.length > SCAN_CAP;
    const ids = sampled ? scanIds.slice(0, SCAN_CAP) : scanIds;

    const contacts = await this.db.contact.findMany({
      where: { workspaceId, id: { in: ids } },
      select: {
        name: true,
        phoneNumber: true,
        email: true,
        location: true,
        customFields: true,
      },
    });

    const bodyMissing = variables.body.map(() => 0);
    let headerMissing = 0;
    let affected = 0;
    for (const c of contacts) {
      let recipientAffected = false;
      variables.body.forEach((literal, i) => {
        const v = resolveFieldTokens(resolveBinding(bindings.body[i], literal, c), c);
        if (v.trim().length === 0) {
          bodyMissing[i] = (bodyMissing[i] ?? 0) + 1;
          recipientAffected = true;
        }
      });
      if (variables.header !== undefined) {
        const hv = resolveFieldTokens(
          resolveBinding(bindings.header, variables.header, c),
          c,
        );
        if (hv.trim().length === 0) {
          headerMissing++;
          recipientAffected = true;
        }
      }
      if (recipientAffected) affected++;
    }

    const missing: Array<{
      location: "body" | "header";
      position: number;
      fieldLabel: string | null;
      missingCount: number;
    }> = [];
    bodyMissing.forEach((cnt, i) => {
      if (cnt > 0) {
        missing.push({
          location: "body",
          position: i + 1,
          fieldLabel: bindingFieldLabel(bindings.body[i]),
          missingCount: cnt,
        });
      }
    });
    if (headerMissing > 0) {
      missing.push({
        location: "header",
        position: 0,
        fieldLabel: bindingFieldLabel(bindings.header),
        missingCount: headerMissing,
      });
    }

    return { total: contacts.length, sampled, affectedCount: affected, missing };
  }

  /**
   * Read-only audience → recipient-id resolver for {@link previewMissingFields}.
   * Mirrors create's mode resolution but NEVER throws (returns [] on any invalid
   * / empty input) and bounds the result, so the preview stays a pure, safe
   * read. Deliberately separate from create's resolver so the highest-blast
   * -radius send path stays untouched.
   */
  private async previewRecipientIds(
    workspaceId: string,
    audience: AudienceInput,
    limit: number,
  ): Promise<string[]> {
    // Broadcasts send WhatsApp templates, so the preview counts only WhatsApp
    // contacts — matching what `create` actually sends (it drops social
    // contacts). Over-scan the raw resolver so the filter doesn't under-sample
    // the cap, then keep the first `limit` WhatsApp ids.
    const raw = await this.previewRecipientIdsRaw(workspaceId, audience, limit * 2);
    if (raw.length === 0) return [];
    const wa = await this.db.contact.findMany({
      where: { workspaceId, id: { in: raw }, identityChannel: "whatsapp", deletedAt: null },
      select: { id: true },
      take: limit,
    });
    return wa.map((c) => c.id);
  }

  private async previewRecipientIdsRaw(
    workspaceId: string,
    audience: AudienceInput,
    limit: number,
  ): Promise<string[]> {
    try {
      // Mirror `create`'s field-predicate narrowing so the preview warns
      // against the audience that will actually send.
      const inlineFieldAnd =
        (audience.mode === "all" ||
          audience.mode === "by_tag" ||
          audience.mode === "custom") &&
        audience.fieldFilters?.length
          ? { AND: contactFieldFilterClauses(audience.fieldFilters) }
          : {};
      if (audience.mode === "all") {
        return (
          await this.db.contact.findMany({
            where: { workspaceId, deletedAt: null, ...inlineFieldAnd },
            select: { id: true },
            take: limit,
          })
        ).map((c) => c.id);
      }
      if (audience.mode === "by_tag") {
        if (!audience.tagIds?.length) return [];
        const tagRows = await this.db.tag.findMany({
          where: { workspaceId, id: { in: audience.tagIds } },
          select: { id: true },
        });
        const validTagIds = tagRows.map((t) => t.id);
        if (validTagIds.length === 0) return [];
        return (
          await this.db.contact.findMany({
            where: {
              workspaceId,
              deletedAt: null,
              tags: { some: { id: { in: validTagIds } } },
              ...inlineFieldAnd,
            },
            select: { id: true },
            take: limit,
          })
        ).map((c) => c.id);
      }
      if (audience.mode === "group") {
        if (!audience.groupId) return [];
        const group = await this.db.audienceGroup.findFirst({
          where: { id: audience.groupId, workspaceId },
          include: { tags: { select: { id: true } }, contacts: { select: { id: true } } },
        });
        if (!group) return [];
        const ids = await resolveAudienceGroupMembers(workspaceId, {
          tagIds: group.tags.map((t) => t.id),
          manualContactIds: group.contacts.map((c) => c.id),
          fieldFilters: parseStoredFieldFilters(group.fieldFilters),
          limit,
        });
        return ids;
      }
      if (audience.mode === "custom") {
        const tagRows = audience.tagIds?.length
          ? await this.db.tag.findMany({
              where: { workspaceId, id: { in: audience.tagIds } },
              select: { id: true },
            })
          : [];
        const ids = await resolveAudienceGroupMembers(workspaceId, {
          tagIds: tagRows.map((t) => t.id),
          manualContactIds: audience.contactIds ?? [],
          fieldFilters: audience.fieldFilters ?? [],
          limit,
        });
        return ids;
      }
      // mode === "selected"
      return Array.from(
        new Set(
          (
            await this.db.contact.findMany({
              where: { workspaceId, deletedAt: null, id: { in: audience.contactIds ?? [] } },
              select: { id: true },
              take: limit,
            })
          ).map((c) => c.id),
        ),
      );
    } catch {
      // Preview must never break the composer — a bad/foreign id or a transient
      // read error just yields "no warning".
      return [];
    }
  }

  /**
   * Secret-free WhatsApp messaging-limit snapshot for the composer's pre-send
   * eligibility hint. The hard gate lives in create(); this is what lets the
   * composer warn BEFORE the operator builds a whole campaign.
   *
   * The composer must compare its audience against `remainingDailyBudget`, not
   * against `messagingDailyCap`: the cap is a rolling-24h budget shared by every
   * send from this number, so a 40k audience can fit the cap and still be
   * rejected because earlier campaigns already spent most of it. Comparing to
   * the raw cap would show "fits" and then have create() refuse — the exact
   * whiplash this endpoint exists to prevent.
   *
   * `hasSnapshot` is false when we've never polled the number's tier
   * (advisory-only, ungated).
   */
  /**
   * Secret-free messaging-health snapshot for the composer's pre-send hint.
   *
   * Delegates to the domain function so the composer, the WhatsApp settings
   * panel and `/v1` all read ONE implementation. The local copy this replaced
   * counted recent recipients WITHOUT the portfolio scope, so on a workspace
   * with more than one portfolio it disagreed with the gate that actually
   * refuses the send — the composer said there was budget and the runner said
   * there wasn't.
   */
  async getMessagingHealth(
    workspaceId: string,
    channelConnectionId?: string | null,
  ): Promise<MessagingHealthSummary> {
    return getMessagingHealthSummary(workspaceId, channelConnectionId);
  }

  /**
   * Re-pull this campaign's template analytics from Meta.
   *
   * Scoped to the campaign's OWN send window rather than a fixed lookback: the
   * whole point is the numbers for this campaign, and a wider window would
   * re-fetch (and re-store) days belonging to other campaigns on the same
   * template for no reason.
   */
  async refreshAnalytics(
    workspaceId: string,
    broadcastId: string,
  ): Promise<{ rows: number; costWithheld: boolean }> {
    const broadcast = await this.db.broadcast.findFirst({
      where: { id: broadcastId, workspaceId },
      select: {
        templateName: true,
        templateLanguage: true,
        channelConnectionId: true,
        startedAt: true,
        createdAt: true,
        completedAt: true,
      },
    });
    if (!broadcast) throw new NotFoundException({ error: "broadcast_not_found" });
    if (!broadcast.templateName) {
      // A freeform (non-template) campaign has nothing Meta reports on.
      throw new BadRequestException({ error: "broadcast_has_no_template" });
    }

    // Shared with the report's read: writing the rollup under a different
    // template row than the one the report reads is silent — both halves
    // succeed and the panel simply never moves. See resolveCampaignTemplate.
    const template = await resolveCampaignTemplate(workspaceId, broadcast);
    if (!template) {
      throw new BadRequestException({ error: "template_not_synced" });
    }

    return refreshTemplateAnalytics(workspaceId, {
      templateExternalIds: [template.externalId],
      start: broadcast.startedAt ?? broadcast.createdAt,
      // Through the engagement tail, not completedAt — reads/clicks land in
      // Meta's day buckets for days AFTER completion (see analyticsWindowEnd).
      end: analyticsWindowEnd(broadcast.completedAt),
      // Scope to the template's own WABA — see refreshTemplateAnalytics.
      wabaAccountId: template.wabaAccountId,
    });
  }

  async list(workspaceId: string, query?: BroadcastListQuery) {
    const where: Prisma.BroadcastWhereInput = { workspaceId };
    if (query?.channel === "people") {
      // Omnichannel campaigns carry an inert `channel`, so they are selected by
      // their TARGET MODE — matching on `channel` would misfile them under
      // whatever inert value was stored.
      where.targetMode = "customer";
    } else if (query?.channel) {
      where.channel = query.channel;
      // A per-channel view must not include the omnichannel campaigns that
      // merely happen to carry this channel as their inert default.
      where.targetMode = "contact";
    }
    if (query?.status && query.status !== "all") {
      where.status = query.status;
    }
    // Which number/Page the campaign SENT FROM. A column on Broadcast (unlike
    // tickets and calls, where the account lives on the conversation), because
    // a campaign's sender is fixed for its whole life.
    if (query?.accountId) {
      where.channelConnectionId = query.accountId;
    }
    if (query?.search) {
      // Search the operator name + the template name (the two human labels).
      where.OR = [
        { name: { contains: query.search, mode: "insensitive" } },
        { templateName: { contains: query.search, mode: "insensitive" } },
      ];
    }
    // Keyset pagination on (createdAt DESC, id DESC) by default. Numbered
    // (offset) mode kicks in when `page` is set — the list page uses it (25/page
    // + a numbered control), which also bounds the payload + the responsive
    // double-DOM render; keyset stays for any cursor caller.
    const pageMode = query?.page != null && query.page >= 1;
    const take = query?.take ?? (pageMode ? 25 : 100);
    const offset = pageMode ? (query!.page! - 1) * take : 0;
    const cursor = pageMode ? null : parseBroadcastCursor(query?.cursor);
    const cursorWhere: Prisma.BroadcastWhereInput | undefined = cursor
      ? {
          OR: [
            { createdAt: { lt: cursor.createdAt } },
            { createdAt: cursor.createdAt, id: { lt: cursor.id } },
          ],
        }
      : undefined;
    const rows = await this.db.broadcast.findMany({
      where: cursorWhere ? { AND: [where, cursorWhere] } : where,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: pageMode ? take : take + 1,
      ...(pageMode ? { skip: offset } : {}),
      include: {
        createdBy: { select: { id: true, name: true } },
        // The sender identity. With several numbers/Pages on a channel,
        // "which account did this go out from" is the first question about a
        // historical campaign — the id was persisted from day one but never
        // surfaced.
        channelConnection: {
          select: { label: true, externalAccountId: true, config: true },
        },
      },
    });
    const hasMore = pageMode ? false : rows.length > take;
    const page = hasMore ? rows.slice(0, take) : rows;
    const last = page.at(-1);
    const nextCursor =
      !pageMode && hasMore && last ? `${last.createdAt.getTime()}_${last.id}` : null;
    // Count shares `where` (filters, no cursor) so it matches the filtered set.
    const totalCount = pageMode
      ? await this.db.broadcast.count({ where })
      : undefined;
    return {
      broadcasts: page.map((b) => ({
        id: b.id,
        status: b.status,
        name: b.name,
        // The rollup's join key, so the list (and any /v1 consumer syncing it)
        // can group sends by campaign without a second per-row fetch.
        campaignName: b.campaignName,
        // kind/channel let the list build a title for freeform / People
        // broadcasts, which have no templateName (else the row title is blank).
        kind: b.kind,
        channel: b.channel,
        targetMode: b.targetMode,
        scheduledAt: b.scheduledAt?.toISOString() ?? null,
        templateName: b.templateName,
        templateLanguage: b.templateLanguage,
        audienceMode: b.audienceMode,
        totalCount: b.totalCount,
        sentCount: b.sentCount,
        failedCount: b.failedCount,
        createdById: b.createdById,
        createdByName: b.createdBy?.name ?? "Removed user",
        channelConnectionId: b.channelConnectionId,
        // Null = the number was since disconnected (SetNull FK) or the row
        // predates account stamping — the UI renders a "removed" fallback.
        accountName: this.accountDisplayName(b.channelConnection),
        createdAt: b.createdAt.toISOString(),
        startedAt: b.startedAt?.toISOString() ?? null,
        completedAt: b.completedAt?.toISOString() ?? null,
      })),
      nextCursor,
      totalCount,
    };
  }

  /**
   * Display name for the account a campaign was bound to — same precedence the
   * channel-accounts directory uses (label → display number → provider id).
   */
  private accountDisplayName(
    conn: {
      label: string | null;
      externalAccountId: string;
      config: Prisma.JsonValue;
    } | null,
  ): string | null {
    return channelAccountDisplayName(conn);
  }

  /**
   * Campaign report — funnel, rates, failure buckets, benchmark, diagnostics.
   * Thin passthrough: the computation lives in the domain layer so the UI, the
   * CSV export, and the /v1 endpoint all derive identical numbers.
   */
  async getReport(workspaceId: string, id: string) {
    const report = await getBroadcastReport(workspaceId, id);
    if (!report) throw new NotFoundException({ error: "not_found" });
    return report;
  }

  /**
   * Stream the recipient-level CSV for a campaign.
   *
   * STREAMED, not built in memory: a 100k-recipient export is ~25MB as one
   * string (and ~60MB of peak heap) on a box that is also serving the live
   * inbox. Keyset-paging 2,000 rows at a time and writing each chunk keeps peak
   * memory around 2MB, and the progressive bytes mean no proxy timeout.
   *
   * Deliberately NOT an async job staged to R2: that needs a queue, a job-status
   * model, presigned delivery, expiry cleanup, and a whole new failure mode
   * (job succeeded, operator never saw the toast) to avoid a ~12-second wait.
   * The escape hatch for genuinely programmatic pulls already exists and is
   * better — the /v1 recipients endpoint pages with no cap.
   */
  async exportRecipientsCsv(
    workspaceId: string,
    id: string,
    filter: { outcome?: string; errorCode?: string },
    res: {
      setHeader: (k: string, v: string) => void;
      write: (chunk: string) => boolean;
      end: () => void;
    },
  ): Promise<void> {
    const broadcast = await this.db.broadcast.findFirst({
      where: { id, workspaceId },
      select: { id: true, templateName: true, name: true },
    });
    if (!broadcast) throw new NotFoundException({ error: "not_found" });

    const columns = [
      "contact_name",
      "phone",
      "contact_id",
      "delivery_state",
      "send_status",
      "sent_at",
      "delivered_at",
      "read_at",
      "replied_at",
      "clicked_at",
      "seconds_to_delivered",
      "seconds_to_read",
      "seconds_to_replied",
      "clicked_option_id",
      "reply_attribution",
      "error_code",
      "meta_error_code",
      "error_message",
      "pricing_category",
      "billable",
      // Sits beside `billable` because it is the only thing that explains it: a
      // single utility campaign legitimately mixes TRUE and FALSE, and
      // `free_customer_service` is the reason why.
      "pricing_type",
      "opted_out_at",
      "conversation_id",
      "message_external_id",
    ];

    const slug = (broadcast.templateName ?? broadcast.name ?? "broadcast")
      .replace(/[^a-z0-9]+/gi, "-")
      .slice(0, 40);
    const stamp = new Date().toISOString().slice(0, 10);
    const suffix = filter.errorCode ?? filter.outcome ?? "all";
    res.setHeader("content-type", "text/csv; charset=utf-8");
    res.setHeader(
      "content-disposition",
      `attachment; filename="broadcast-${slug}-${suffix}-${stamp}.csv"`,
    );
    res.write(csvHeader(columns));

    const secs = (from: Date | null, to: Date | null): string =>
      from && to ? String(Math.max(0, Math.round((to.getTime() - from.getTime()) / 1000))) : "";
    const iso = (d: Date | null): string => (d ? d.toISOString() : "");

    const PAGE = 2_000;
    let cursor: string | undefined;
    for (;;) {
      const page = await this.db.broadcastRecipient.findMany({
        where: { broadcastId: id, ...recipientOutcomeWhere(filter) },
        orderBy: { id: "asc" },
        take: PAGE,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
        include: {
          contact: { select: { name: true, phoneNumber: true, marketingOptOutAt: true } },
        },
      });
      if (page.length === 0) break;
      res.write(
        csvRows(
          columns,
          page.map((r) => ({
            contact_name: r.contact.name,
            phone: r.contact.phoneNumber ?? "",
            contact_id: r.contactId,
            delivery_state: r.deliveryState,
            send_status: r.status,
            sent_at: iso(r.sentAt),
            delivered_at: iso(r.deliveredAt),
            read_at: iso(r.readAt),
            replied_at: iso(r.repliedAt),
            clicked_at: iso(r.clickedAt),
            // Pre-computed alongside the ISO timestamps: the deltas are what
            // anyone actually pivots on, and asking an operator to write a
            // datetime-diff formula in Excel is how reports go unused.
            seconds_to_delivered: secs(r.sentAt, r.deliveredAt),
            seconds_to_read: secs(r.sentAt, r.readAt),
            seconds_to_replied: secs(r.sentAt, r.repliedAt),
            clicked_option_id: r.clickedOptionId ?? "",
            reply_attribution: r.repliedAttribution ?? "",
            error_code: r.errorCode ?? "",
            meta_error_code: r.metaErrorCode != null ? String(r.metaErrorCode) : "",
            error_message: r.errorMessage ?? "",
            pricing_category: r.pricingCategory ?? "",
            billable: r.pricingBillable == null ? "" : r.pricingBillable ? "true" : "false",
            pricing_type: r.pricingType ?? "",
            opted_out_at: iso(r.optedOutAt ?? r.contact.marketingOptOutAt),
            conversation_id: r.conversationId ?? "",
            message_external_id: r.externalId ?? "",
          })),
        ),
      );
      if (page.length < PAGE) break;
      cursor = page[page.length - 1]!.id;
    }
    res.end();
  }

  async get(workspaceId: string, id: string) {
    // Hard cap on inlined recipients. A 10k-recipient broadcast detail page
    // was returning multi-MB of JSON + rendering 10k <tr> rows, freezing
    // the browser tab for 10-30s. Cap to the first 500 (status grouped:
    // failed first so the operator can triage immediately, then queued,
    // then sent — the recipients they care about are the ones that didn't
    // succeed). Caller paginates the rest via /recipients?status=&cursor=.
    const RECIPIENTS_INLINE_CAP = 500;
    const row = await this.db.broadcast.findFirst({
      where: { id, workspaceId },
      include: {
        createdBy: { select: { id: true, name: true } },
        channelConnection: {
          select: { label: true, externalAccountId: true, config: true },
        },
        recipients: {
          // Failures must sort FIRST so they're never truncated out of the
          // RECIPIENTS_INLINE_CAP (the operator triages failures first). NOTE:
          // BroadcastRecipientStatus is a Postgres ENUM (queued, sent, failed —
          // in DECLARATION order), so `ORDER BY status` uses that order, NOT
          // alphabetical (an earlier comment wrongly claimed alphabetical and
          // listed canceled/sending values that don't exist). `status: "asc"`
          // would therefore put failed LAST and truncate it away on a
          // many-recipient broadcast; DESC yields failed → sent → queued,
          // keeping the actionable rows at the top.
          orderBy: [{ status: "desc" }, { id: "asc" }],
          take: RECIPIENTS_INLINE_CAP + 1,
          include: {
            contact: { select: { id: true, name: true, phoneNumber: true } },
          },
        },
      },
    });
    if (!row) throw new NotFoundException({ error: "not_found" });

    const truncated = row.recipients.length > RECIPIENTS_INLINE_CAP;
    const recipients = truncated
      ? row.recipients.slice(0, RECIPIENTS_INLINE_CAP)
      : row.recipients;

    // Real (retryable) failures only — excludes recipients finalized by cancel()
    // (marked with CANCEL_RECIPIENT_MARKER), which retryFailed() also excludes.
    // Without this the detail page shows a "Retry N failed" button for a canceled
    // broadcast whose click 409s ("no failed recipients"). Cheap single-broadcast
    // count (indexed on broadcastId+status).
    const genuineFailedCount = await this.db.broadcastRecipient.count({
      where: {
        broadcastId: row.id,
        status: "failed",
        NOT: { errorMessage: CANCEL_RECIPIENT_MARKER },
      },
    });

    // The template's message text, so the snapshot card can show the message
    // as the customer saw it — a zero-variable campaign otherwise rendered a
    // blank card. From the catalog row (we snapshot the VARIABLES, not the
    // body), so the UI captions it as the catalog text rather than claiming
    // it's frozen. Tolerates a deleted template: the card falls back to
    // name + language.
    const template = row.templateId
      ? await this.db.messageTemplate.findFirst({
          where: { id: row.templateId, workspaceId },
          select: { bodyText: true },
        })
      : null;

    return {
      id: row.id,
      // Message identity — freeform / People (customer-mode) broadcasts have no
      // templateName, so the UI needs kind+channel to build a fallback title and
      // bodyText to actually show the message (both were previously omitted, so
      // those broadcasts rendered blank).
      kind: row.kind,
      channel: row.channel,
      targetMode: row.targetMode,
      bodyText: row.bodyText,
      genuineFailedCount,
      status: row.status,
      name: row.name,
      // The rollup's join key — the detail header's "Campaign: …" chip links
      // through it. This DTO is an explicit whitelist, so a new Broadcast
      // column is invisible to the UI until named here (which is exactly how
      // this one shipped hidden: the chip rendered from a field the endpoint
      // never sent, and only the e2e walking the LIVE page caught it).
      campaignName: row.campaignName,
      scheduledAt: row.scheduledAt?.toISOString() ?? null,
      templateId: row.templateId,
      templateName: row.templateName,
      templateLanguage: row.templateLanguage,
      templateBody: template?.bodyText || null,
      audienceMode: row.audienceMode,
      audienceTagIds: row.audienceTagIds,
      // The applied field predicates ([{ key, optionIds }]) — the audit answer
      // to "who was this sent to" alongside the tag ids. Empty when none.
      audienceFieldFilters: parseStoredFieldFilters(row.audienceFieldFilters),
      audienceGroupId: row.audienceGroupId,
      variables: row.variables,
      totalCount: row.totalCount,
      sentCount: row.sentCount,
      failedCount: row.failedCount,
      lastError: row.lastError,
      createdById: row.createdById,
      createdByName: row.createdBy?.name ?? "Removed user",
      channelConnectionId: row.channelConnectionId,
      accountName: this.accountDisplayName(row.channelConnection),
      createdAt: row.createdAt.toISOString(),
      startedAt: row.startedAt?.toISOString() ?? null,
      completedAt: row.completedAt?.toISOString() ?? null,
      recipientsTruncated: truncated,
      recipientsShown: recipients.length,
      recipients: recipients.map((r) => ({
        id: r.id,
        contactId: r.contactId,
        contactName: r.contact.name,
        contactPhone: r.contact.phoneNumber,
        conversationId: r.conversationId,
        status: r.status,
        externalId: r.externalId,
        errorMessage: r.errorMessage,
        sentAt: r.sentAt?.toISOString() ?? null,
        // Same engagement trail as listRecipients() — the two shapes must stay
        // identical or the table renders richer rows for paged results than
        // for the inline first-500.
        deliveryState: r.deliveryState,
        deliveredAt: r.deliveredAt?.toISOString() ?? null,
        readAt: r.readAt?.toISOString() ?? null,
        repliedAt: r.repliedAt?.toISOString() ?? null,
        clickedAt: r.clickedAt?.toISOString() ?? null,
        clickedOptionId: r.clickedOptionId,
        errorCode: r.errorCode,
      })),
    };
  }

  /**
   * Paginated recipient page. Cursor-based on `id` (status-grouped) so
   * "Load more" works without offset's "rows shift under you" problem.
   */
  async listRecipients(
    workspaceId: string,
    broadcastId: string,
    opts: {
      cursor?: string;
      status?: string;
      outcome?: string;
      errorCode?: string;
      take?: number;
    },
  ) {
    const take = Math.min(Math.max(opts.take ?? 200, 1), 500);
    const broadcast = await this.db.broadcast.findFirst({
      where: { id: broadcastId, workspaceId },
      select: { id: true },
    });
    if (!broadcast) throw new NotFoundException({ error: "not_found" });

    const where: Prisma.BroadcastRecipientWhereInput = {
      broadcastId,
      // The report's drill-down vocabulary (who read / replied / clicked …) —
      // the SAME clause the CSV export and /v1 use, so the table an operator
      // clicks into can never disagree with the file they download.
      ...recipientOutcomeWhere({ outcome: opts.outcome, errorCode: opts.errorCode }),
    };
    if (opts.status) {
      where.status = opts.status as Prisma.BroadcastRecipientWhereInput["status"];
    }
    const rows = await this.db.broadcastRecipient.findMany({
      where,
      // Plain id order in BOTH modes. The unfiltered branch used to sort
      // [{status desc}, {id asc}] with an id-only cursor — but `status`
      // MUTATES mid-send, so "Load more" during a live campaign skipped and
      // repeated rows as recipients moved between buckets (a keyset is only
      // stable over immutable sort keys — audit 2026-08-10). Filtered mode,
      // CSV and /v1 already page by id; the status lens is what the filter
      // buttons are for.
      orderBy: { id: "asc" },
      take: take + 1,
      ...(opts.cursor
        ? { cursor: { id: opts.cursor }, skip: 1 }
        : {}),
      include: { contact: { select: { id: true, name: true, phoneNumber: true } } },
    });
    const hasMore = rows.length > take;
    const page = hasMore ? rows.slice(0, take) : rows;
    return {
      recipients: page.map((r) => ({
        id: r.id,
        contactId: r.contactId,
        contactName: r.contact.name,
        contactPhone: r.contact.phoneNumber,
        conversationId: r.conversationId,
        status: r.status,
        externalId: r.externalId,
        errorMessage: r.errorMessage,
        sentAt: r.sentAt?.toISOString() ?? null,
        // The engagement trail — what "read 4,120" is MADE OF. Per-recipient
        // truth from status webhooks; the table renders these as the
        // read/replied/clicked columns of the drill-down.
        deliveryState: r.deliveryState,
        deliveredAt: r.deliveredAt?.toISOString() ?? null,
        readAt: r.readAt?.toISOString() ?? null,
        repliedAt: r.repliedAt?.toISOString() ?? null,
        clickedAt: r.clickedAt?.toISOString() ?? null,
        clickedOptionId: r.clickedOptionId,
        errorCode: r.errorCode,
      })),
      nextCursor: hasMore ? (page[page.length - 1]?.id ?? null) : null,
    };
  }

  /**
   * Return EVERY recipient contact id for a broadcast — used by the "Duplicate"
   * flow to reconstruct a hand-picked (`selected`/`custom`) audience, which only
   * lives on BroadcastRecipient rows (the parent stores tag/group refs, not the
   * resolved contact set). Lightweight: ids only, no contact join. Bounded by
   * MAX_RECIPIENTS_IN_PROCESS (10k), so a single query is fine.
   */
  async listRecipientContactIds(
    workspaceId: string,
    broadcastId: string,
  ): Promise<{ contactIds: string[] }> {
    const broadcast = await this.db.broadcast.findFirst({
      where: { id: broadcastId, workspaceId },
      select: { id: true },
    });
    if (!broadcast) throw new NotFoundException({ error: "not_found" });
    const rows = await this.db.broadcastRecipient.findMany({
      where: { broadcastId },
      select: { contactId: true },
    });
    return { contactIds: Array.from(new Set(rows.map((r) => r.contactId))) };
  }

  /**
   * Cancel a broadcast that's still scheduled, queued, running, or paused. The
   * runner checks the row's `status` between recipients and bails out the moment
   * it sees `canceled`. Already-sent recipients stay sent (Meta can't be
   * unsent); every recipient that never sent is finalized `queued` → `failed`
   * with the CANCEL_RECIPIENT_MARKER errorMessage so the terminal counters sum
   * to totalCount, while `retryFailed` explicitly EXCLUDES that marker so a
   * deliberately-canceled audience is never re-sent (billed Meta template sends
   * are irreversible). (Leaving them `queued` would be a trap: retryFailed
   * re-opens the broadcast and the runner's refill pulls EVERY `queued` row,
   * silently re-sending the recipients the operator deliberately stopped.) The
   * rows stay in the DB for audit — just terminal, with the cancel recorded as
   * their errorMessage.
   *
   * `paused` is cancelable too: a broadcast paused by graceful-shutdown OR by the
   * permanent-error breaker (dead Meta credential) has no live runner — the boot
   * reconciler is the only thing that would resume it, and it only matches rows
   * STILL `paused`, so flipping paused→canceled here is permanent (no
   * resurrection). The detail-page "Stop broadcast" button is shown for `paused`
   * precisely so an operator can abandon a credential-failed broadcast instead of
   * waiting for an auto-resume that would just re-fail.
   *
   * Compare-and-set on the previous status so two operators clicking
   * cancel at once (or cancel-while-already-canceled) don't double-emit.
   */
  /**
   * Explicit operator resume — the only path that may lift an `abuse_warning`
   * pause (see resumeBroadcastManually). Returns false when not paused.
   */
  async resume(workspaceId: string, id: string): Promise<boolean> {
    const row = await this.db.broadcast.findFirst({
      where: { id, workspaceId },
      select: { id: true },
    });
    if (!row) throw new NotFoundException({ error: "not_found" });
    return resumeBroadcastManually(workspaceId, id);
  }

  async cancel(workspaceId: string, id: string): Promise<void> {
    const row = await this.db.broadcast.findFirst({
      where: { id, workspaceId },
      select: { id: true, status: true },
    });
    if (!row) throw new NotFoundException({ error: "not_found" });
    if (
      row.status !== "scheduled" &&
      row.status !== "materializing" &&
      row.status !== "queued" &&
      row.status !== "running" &&
      row.status !== "paused"
    ) {
      throw new ConflictException({
        error: "broadcast_not_cancelable",
        detail: `Broadcast is already ${row.status}; cancel is only valid while scheduled, materializing, queued, running, or paused.`,
      });
    }
    const updated = await this.db.broadcast.updateMany({
      where: { id, status: { in: ["scheduled", "materializing", "queued", "running", "paused"] } },
      data: { status: "canceled" },
    });
    if (updated.count === 0) {
      // Another caller / the runner flipped the status between read and
      // write — surface idempotently as success rather than a 409 race.
      return;
    }
    // Finalize every recipient that never sent: flip `queued` → `failed` with a
    // clear reason. Leaving them `queued` is a trap — a later `retryFailed`
    // re-opens the broadcast and the runner's refill pulls EVERY `queued` row,
    // re-sending the recipients the operator deliberately stopped, not just the
    // failures. This also makes the terminal counters sum to totalCount. The
    // rows stay for audit; `{ increment }` is atomic so a lane still draining its
    // final send (whose own mark is CAS-gated on `queued`) can't double-count.
    //
    // EXCLUDE in-flight recipients: a recipient stays `queued` for the whole Meta
    // send round-trip (the runner flips `queued` → `sent` via a CAS only AFTER
    // Meta accepts), and the in-flight marker is an OutboundSendAttempt row
    // (`bc-recipient-<id>`) that has not definitively failed (failedAt=null).
    // Flipping such a row to `failed` here would lose the runner's post-send CAS
    // (matches 0 rows) — the customer received the template but we'd record it
    // `failed` with no inbox Message row, and re-send it on retry. We match on
    // failedAt=null ALONE (not completedAt=null too): an attempt whose Meta send
    // already landed (completedAt set) but crashed before the queued→sent CAS is
    // still recoverable by the boot reconciler, so it must also stay `queued`.
    // Leave all such rows `queued`; the runner/reconciler finalizes them to `sent`.
    //
    // ONE atomic statement (raw — Prisma's typed updateMany can't express a
    // correlated subquery): flip queued→failed for every recipient that does NOT
    // have an in-flight `bc-recipient-<id>` attempt. Folding the in-flight
    // exclusion into the WHERE via NOT EXISTS removes the previous read-then-
    // write gap (a separate findMany of queued ids + findMany of attempts + a
    // client-side prefix map, between which a lane could create its attempt row
    // and slip through the snapshot). $executeRaw returns the affected-row count,
    // which is the exact failedCount bump. CANCEL_RECIPIENT_MARKER is a
    // deliberate state-discriminator carried ON errorMessage (chosen over a
    // schema enum value to avoid a migration): the live + boot cancel-race
    // reconcile AND retryFailed all key on this exact string, so keep it stable.
    const finalizedCount = await this.db.$executeRaw`
      UPDATE "BroadcastRecipient" br
      SET "status" = 'failed'::"BroadcastRecipientStatus",
          "errorMessage" = ${CANCEL_RECIPIENT_MARKER}
      WHERE br."broadcastId" = ${id}
        AND br."status" = 'queued'::"BroadcastRecipientStatus"
        AND NOT EXISTS (
          SELECT 1 FROM "OutboundSendAttempt" osa
          WHERE osa."jobId" = 'bc-recipient-' || br."id"
            AND osa."failedAt" IS NULL
        )
    `;
    if (finalizedCount > 0) {
      await this.db.broadcast.update({
        where: { id },
        data: { failedCount: { increment: finalizedCount } },
      });
    }
    // Was it a scheduled broadcast? Pull its pending delayed job so it can't
    // fire later. The worker's CAS (scheduled→queued) already makes a late
    // fire on a now-`canceled` row a no-op, so this is belt-and-suspenders
    // that also keeps Redis tidy. Safe if the job already fired/is gone.
    if (row.status === "scheduled") {
      await removeScheduledBroadcast(id).catch((err) =>
        this.logger.warn(
          `removeScheduledBroadcast(${id}) failed: ${err instanceof Error ? err.message : err}`,
        ),
      );
    }
    // Cancel-while-materializing: pull the materialize job so a retry can't
    // resume inserting, and clear the (now-moot) staging blob to reclaim space.
    // The worker also checks the row status between chunks and stops on its own,
    // so any rows it already inserted were finalized queued→failed above.
    if (row.status === "materializing") {
      await removeBroadcastMaterialize(id).catch((err) =>
        this.logger.warn(
          `removeBroadcastMaterialize(${id}) failed: ${err instanceof Error ? err.message : err}`,
        ),
      );
      // `totalCount` was stamped as the FULL audience at create, but only the
      // rows inserted before the cancel exist — recount from reality so
      // sentCount + failedCount can sum to totalCount in the report. (The
      // materialize worker's own canceled-branch reconcile does the same, but
      // it only runs if a job attempt fires again; this path must not depend
      // on that.)
      const actualTotal = await this.db.broadcastRecipient.count({
        where: { broadcastId: id },
      });
      await this.db.broadcast
        .update({
          where: { id },
          data: { materializeRecipients: Prisma.DbNull, totalCount: actualTotal },
        })
        .catch(() => undefined);
    }
    // Announce the cancel. The runner's canceled-exit branch deliberately skips
    // its own emit ("cancel endpoint already published the status change"), so
    // THIS is the only path that tells other tabs — without it a teammate's
    // broadcasts list / detail page spins on the stale status until a hard
    // refresh. Mirrors the create-path status emit.
    await this.bus.publish({
      type: "broadcast.status_changed",
      workspaceId,
      broadcastId: id,
      status: "canceled",
    });
  }

  /**
   * Re-queue a finished broadcast's FAILED recipients and run it again. Only
   * valid on a terminal broadcast (completed/failed/canceled) that actually
   * has failures. Resets those recipient rows to `queued` + clears their
   * error, flips the broadcast back to `queued`, and fires the runner — whose
   * per-recipient CAS guarantees already-`sent` rows are never touched.
   */
  /**
   * Re-queue failed recipients and run them again.
   *
   * `errorCodes` narrows the retry to specific normalized failure reasons, which
   * is what makes the report's failure table actionable: "1,204 were rate
   * limited — retry just those" instead of blindly re-running every failure
   * including the permanently-invalid numbers (which would fail again and, on a
   * big campaign, waste real throughput against the number's quality rating).
   */
  async retryFailed(
    workspaceId: string,
    id: string,
    opts?: { errorCodes?: string[] },
  ): Promise<{ requeued: number }> {
    const row = await this.db.broadcast.findFirst({
      where: { id, workspaceId },
      select: { id: true, status: true, failedCount: true, templateId: true },
    });
    if (!row) throw new NotFoundException({ error: "not_found" });
    if (
      row.status === "running" ||
      row.status === "queued" ||
      row.status === "scheduled" ||
      row.status === "materializing"
    ) {
      throw new ConflictException({
        error: "broadcast_in_progress",
        detail: "Wait for the broadcast to finish before retrying failed recipients.",
      });
    }

    // The same per-user marketing-cap gate the CREATE path applies (see the
    // suppression above `all_recipients_opted_out`), because retry is the
    // likelier place to trip Meta's escalation: a campaign that just failed a
    // batch with 131049 shows a tempting "Retry N failed" button, and Meta is
    // explicit that resending to a capped user inside 24h earns the same error
    // again — and that a WABA which repeatedly retries capped users can have
    // delivery to them cut off for a further 24h. MARKETING templates only:
    // the cap does not apply to utility/auth sends, and a freeform broadcast
    // has no template at all. A deleted template row fails open — Meta
    // enforces the real cap, we just avoid poking it.
    let cappedContactIds: Set<string> | null = null;
    if (row.templateId) {
      const tpl = await this.db.messageTemplate.findFirst({
        where: { id: row.templateId, workspaceId },
        select: { category: true },
      });
      if (tpl?.category === "marketing") {
        const cappedSince = new Date(Date.now() - PER_USER_MARKETING_CAP_COOLDOWN_MS);
        const capped = await this.db.contact.findMany({
          where: { workspaceId, marketingCapReachedAt: { gte: cappedSince } },
          select: { id: true },
        });
        if (capped.length > 0) cappedContactIds = new Set(capped.map((c) => c.id));
      }
    }
    // Reset recipients + re-open the broadcast atomically in ONE transaction.
    // Two separate writes could leave recipients `queued` while the parent
    // still shows the old terminal status + failedCount if the process died
    // between them — the runner would then never pick it up (or double-count).
    // The parent update CAS-guards on the terminal-status set so a concurrent
    // runner flip / parallel retry can't race us. A throw inside the tx rolls
    // the whole thing back.
    const requeued = await this.db.$transaction(async (tx) => {
      // Grab the failed recipient ids up front so we can both reset them and
      // clear their OutboundSendAttempt rows (below) by id.
      // NOT the CANCEL_RECIPIENT_MARKER: recipients finalized by cancel() were
      // deliberately stopped by the operator, not genuine send failures.
      // Re-queuing them would re-send a billed Meta template to an audience the
      // operator explicitly canceled — irreversible. Retry re-sends ONLY the
      // recipients that actually failed at the provider.
      const failed = await tx.broadcastRecipient.findMany({
        where: {
          broadcastId: id,
          status: "failed",
          // The CANCEL marker exclusion is load-bearing and must survive any
          // narrowing: recipients finalized by cancel() were deliberately
          // stopped by the operator, and billed template sends are
          // irreversible. A bucketed retry must never become the hole that
          // re-sends a cancelled audience.
          NOT: { errorMessage: CANCEL_RECIPIENT_MARKER },
          ...(opts?.errorCodes?.length ? { errorCode: { in: opts.errorCodes } } : {}),
          // Still inside Meta's 24h per-user marketing cooldown — retrying them
          // now is refused by Meta anyway and risks the escalated cutoff.
          ...(cappedContactIds ? { contactId: { notIn: [...cappedContactIds] } } : {}),
        },
        select: { id: true },
        // Bounded so a 100k campaign that failed wholesale can't materialize an
        // unbounded id array inside a transaction (a heap guard, not a
        // bind-parameter one). Retrying the cap's worth is already the largest
        // legal broadcast; anything beyond it is re-queued by pressing Retry
        // again.
        take: MAX_RECIPIENTS_IN_PROCESS,
      });
      if (failed.length === 0) {
        // Distinguish "no failures at all" from "every failure is a contact
        // still inside the marketing-cap cooldown" — the second has a fix the
        // operator can actually apply (wait), and telling them there is
        // nothing to retry when the button showed a count reads as a bug.
        if (cappedContactIds) {
          const suppressed = await tx.broadcastRecipient.count({
            where: {
              broadcastId: id,
              status: "failed",
              NOT: { errorMessage: CANCEL_RECIPIENT_MARKER },
              ...(opts?.errorCodes?.length ? { errorCode: { in: opts.errorCodes } } : {}),
              contactId: { in: [...cappedContactIds] },
            },
          });
          if (suppressed > 0) {
            throw new ConflictException({
              error: "recipients_marketing_capped",
              detail:
                `All ${suppressed} retryable recipients recently hit WhatsApp's per-user ` +
                `marketing limit. Try again in 24 hours — Meta refuses earlier resends and ` +
                `may cut off delivery to these users entirely if retried repeatedly.`,
            });
          }
        }
        throw new ConflictException({
          error: "nothing_to_retry",
          detail: "This broadcast has no failed recipients.",
        });
      }
      const failedIds = failed.map((r) => r.id);
      // No marker re-filter here: `failedIds` came from the findMany above, which
      // already excluded CANCEL_RECIPIENT_MARKER inside this same tx — a second
      // filter would be dead. (The findMany's exclusion is the load-bearing one.)
      // `status: "failed"` is a CAS, not redundancy. `failedIds` was read earlier
      // in this interactive transaction under READ COMMITTED, but this UPDATE
      // re-reads at statement time. A lane still draining from a previous run
      // (parent already flipped terminal, lane not yet finished) can CAS a
      // recipient queued→sent in that gap — and without this predicate we would
      // flip it back to `queued` AND null its `sentAt`/`externalId`, then delete
      // its send-idempotency ledger row below. The runner would re-send a
      // template Meta has already accepted and billed.
      const reset = await tx.broadcastRecipient.updateMany({
        where: { id: { in: failedIds }, status: "failed" },
        // `errorCode` alongside `errorMessage`: the report's failure breakdown
        // buckets by CODE, so a recipient that later succeeded kept appearing
        // under its old failure reason. `deliveryState` returns to the
        // pending default for the same reason the counters do — this row is
        // about to be attempted again, and reporting reads deliveryState only.
        data: {
          status: "queued",
          deliveryState: "pending",
          errorMessage: null,
          errorCode: null,
          sentAt: null,
          externalId: null,
        },
      });

      // Delete the surviving OutboundSendAttempt rows (jobId `bc-recipient-<id>`)
      // for the recipients we're re-queuing. A recipient that failed via the
      // "attempt may have reached Meta" ABORT branch left its attempt row intact
      // with neither completedAt nor failedAt; without this delete the runner's
      // claim would P2002 → re-hit that abort → flip the recipient straight back
      // to failed, so the Retry button would be a permanent no-op (until the 7d
      // retention sweeper GC'd it). An EXPLICIT operator retry consciously accepts
      // the small double-send risk for a message that may never have landed, so
      // clearing the row to start a clean attempt is the right call.
      await tx.outboundSendAttempt.deleteMany({
        where: { jobId: { in: failedIds.map((rid) => `bc-recipient-${rid}`) } },
      });
      // Recompute counters off the reset and re-open the broadcast. failedCount
      // drops by the number we re-queued; the runner re-increments as it
      // re-processes. lastError cleared so the detail page banner goes away.
      // `failedCount` is clamped with GREATEST(0, …) rather than a plain
      // `{ decrement }` — if an earlier counter bump was lost to a transient DB
      // blip (see bumpCounters), the stored failedCount can be below reset.count
      // and a bare decrement would persist a NEGATIVE counter. The terminal-
      // status guard is kept inline so the affected-row count still drives the
      // concurrent-retry race check below. Raw because Prisma's typed update
      // can't express GREATEST.
      const flippedCount = await tx.$executeRaw`
        UPDATE "Broadcast"
        SET
          "status" = 'queued',
          "failedCount" = GREATEST(0, "failedCount" - ${reset.count}),
          "lastError" = NULL,
          "completedAt" = NULL
        WHERE "id" = ${id}
          AND "status" IN ('completed', 'failed', 'canceled')
      `;
      if (flippedCount === 0) {
        // A concurrent retry/runner already moved this broadcast out of a
        // terminal state — abort so we don't double-process.
        throw new ConflictException({
          error: "broadcast_in_progress",
          detail: "Another retry or run started for this broadcast.",
        });
      }
      return reset.count;
    },
    // Matches create(). The default is 5s, and a campaign that failed tens of
    // thousands of recipients has to updateMany + deleteMany across all of them
    // in here — comfortably past 5s, which made Retry (the one control that
    // matters after a partial failure) time out exactly when it was needed most.
    // This is a DURATION bound, not a parameter-count one: Prisma already
    // splits oversized `in` lists internally (see the bind-limit spec).
    { timeout: 30_000, maxWait: 5_000 },
    );
    startBroadcast(id);
    return { requeued };
  }

  /**
   * Delete broadcast + recipient rows. Refuses while runner is mid-loop —
   * the runner reads recipient rows by parent id and would error on a
   * missing parent. Real WhatsApp messages already sent stay in the inbox.
   */
  async remove(workspaceId: string, id: string): Promise<void> {
    const row = await this.db.broadcast.findFirst({
      where: { id, workspaceId },
      select: { id: true, status: true },
    });
    if (!row) throw new NotFoundException({ error: "not_found" });
    // `paused` is in-progress too — it's the state graceful shutdown / reboot
    // leaves a running broadcast in for the boot reconciler to resume. Deleting
    // it races that resume and orphans the recipient send-progress, so refuse
    // it alongside running/queued. The user should CANCEL (clean stop) instead.
    if (
      row.status === "running" ||
      row.status === "queued" ||
      row.status === "paused" ||
      row.status === "materializing"
    ) {
      throw new ConflictException({
        error: "broadcast_in_progress",
        detail: "Cancel the broadcast (or wait for it to finish) before deleting it.",
      });
    }
    await this.db.broadcast.delete({ where: { id } });
    // Tell other tabs the row is gone. There's no `deleted` status on the
    // broadcast.status_changed union, so re-emit the row's (terminal) status —
    // broadcasts-browser coalesces ANY broadcast:status frame into a list
    // refetch, which drops the now-404 row. A detail-page viewer of the deleted
    // broadcast refetches too and safely no-ops on the 404 (refreshRef skips
    // non-ok responses), keeping its stale terminal view instead of erroring.
    await this.bus.publish({
      type: "broadcast.status_changed",
      workspaceId,
      broadcastId: id,
      status: row.status,
    });
  }

  /**
   * Reject an oversized audience from a COUNT, before any id array is built.
   *
   * The same ceiling is re-checked after resolution (that check stays — it also
   * covers the group/custom modes and any race), but doing it from a count first
   * is what keeps a large-tenant broadcast from allocating the whole contact
   * table just to be told "too many". Takes the pending count so callers read as
   * one statement.
   */
  private async assertAudienceWithinCap(countPromise: Promise<number>): Promise<void> {
    const total = await countPromise;
    if (total > MAX_RECIPIENTS_IN_PROCESS) {
      throw new BadRequestException({
        error: "audience_too_large",
        detail: `This audience has ${total} recipients; the limit is ${MAX_RECIPIENTS_IN_PROCESS}. Split it into smaller broadcasts.`,
      });
    }
  }
}

/**
 * Decode a `<createdAtMs>_<id>` broadcast list cursor. Returns null on any
 * malformed input so a bad cursor degrades to "first page" rather than 500.
 */
function parseBroadcastCursor(
  raw: string | undefined,
): { createdAt: Date; id: string } | null {
  if (!raw) return null;
  const sep = raw.indexOf("_");
  if (sep <= 0) return null;
  const ms = Number(raw.slice(0, sep));
  const id = raw.slice(sep + 1);
  if (!Number.isFinite(ms) || !id) return null;
  return { createdAt: new Date(ms), id };
}
