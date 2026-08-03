import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from "@nestjs/common";

import type { DomainEventOf } from "@ccp/shared/events/types";

import { onHumanReply } from "@/lib/ai/conversation-state";
import { aiGloballyEnabled, aiTextEngineConfigured } from "@/lib/ai/models";
import { openaiConfigured } from "@/lib/ai/openai-client";
import { enqueueAiMemoryOnClose, enqueueAiReply } from "@/lib/ai/queue";
import { configEnabled, loadAiConfig } from "@/lib/ai/runtime-config";
import { ensureTranscription } from "@/lib/ai/voice-ingest";
import { subscribe, SubscriberPriority } from "@/lib/events/bus";
import { webchatwidgetAiAllowed } from "@/lib/providers/webchatwidget-config";

/**
 * Bridges domain events to the AI reply queue (DEFAULT tier — this never sits on
 * the realtime/audit/workflow critical path).
 *
 *  - message.received : TEXT messages enqueue a reply immediately. Voice / any
 *    pending-media message is skipped here and handled on media_ready
 *    (correction #5). A voice note has an empty body, so the text guard already
 *    filters it out even if its media somehow arrived non-pending.
 *  - message.media_ready : AUDIO → transcribe (once) → enqueue a voice reply;
 *    other media → enqueue a text reply from the now-ready caption. jobId is
 *    keyed by inboundMessageId, so received + media_ready can't double-process.
 *  - message.sent : a HUMAN reply (senderUserId != null) cancels the pending AI
 *    turn and yields (auto-resumes on the next customer inbound). AI sends
 *    (senderUserId null) never trigger this — the assistant can't cancel itself.
 */
@Injectable()
export class AiReplySubscriber implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(AiReplySubscriber.name);
  private offs: Array<() => void> = [];
  private registered = false;

  onModuleInit(): void {
    if (this.registered) return;
    this.registered = true;
    // Handlers are AWAITED (2026-07-27): the previous `void …` shape resolved
    // synchronously, so these ran outside the per-subscriber timeout, outside
    // the outbox `lastError` sink, and outside the at-least-once lease — a
    // crash mid-enqueue marked the row done and lost the AI turn. try/catch
    // preserves "never throw into the bus".
    this.offs.push(
      subscribe(
        "message.received",
        async (e) => {
          try {
            await this.onReceived(e);
          } catch (err) {
            this.logError("received", err);
          }
        },
        SubscriberPriority.DEFAULT,
      ),
    );
    this.offs.push(
      subscribe(
        "message.media_ready",
        async (e) => {
          try {
            await this.onMediaReady(e);
          } catch (err) {
            this.logError("media_ready", err);
          }
        },
        SubscriberPriority.DEFAULT,
      ),
    );
    this.offs.push(
      subscribe(
        "message.sent",
        async (e) => {
          try {
            await this.onSent(e);
          } catch (err) {
            this.logError("sent", err);
          }
        },
        SubscriberPriority.DEFAULT,
      ),
    );
    this.offs.push(
      subscribe(
        "conversation.status_changed",
        async (e) => {
          try {
            await this.onStatusChanged(e);
          } catch (err) {
            this.logError("status_changed", err);
          }
        },
        SubscriberPriority.DEFAULT,
      ),
    );
  }

  onModuleDestroy(): void {
    for (const off of this.offs) off();
    this.offs = [];
  }

  private async onReceived(e: DomainEventOf<"message.received">): Promise<void> {
    if (!aiTextEngineConfigured()) return;
    if (e.silent) return;
    const m = e.message;
    if (!m || m.direction !== "in") return;
    if (m.mediaPending) return; // wait for media_ready
    const text = (m.body ?? "").trim();
    if (!text) return; // voice notes have empty body → handled on media_ready
    const config = await loadAiConfig(e.workspaceId);
    if (!configEnabled(config)) return;
    // Per-widget switch: the website widget defaults to AI OFF (see
    // webchatwidgetAiAllowed). Only pay the lookup for a widget message.
    if (m.channel === "webchatwidget" && !(await webchatwidgetAiAllowed(e.conversationId))) return;
    await enqueueAiReply({
      workspaceId: e.workspaceId,
      conversationId: e.conversationId,
      inboundMessageId: m.id,
      text,
      isVoice: false,
      waitSeconds: config.replyWaitSeconds,
    });
  }

  private async onMediaReady(e: DomainEventOf<"message.media_ready">): Promise<void> {
    if (!aiGloballyEnabled()) return;
    const kind = e.media?.kind;
    // media_ready carries no channel — the helper is a no-op (returns true) for
    // non-widget conversations, and gates widget ones on their per-widget switch.
    if (!(await webchatwidgetAiAllowed(e.conversationId))) return;
    if (kind === "audio") {
      // Audio needs STT before there is any text to reply to, so this branch
      // gates on the transcription engine specifically rather than on
      // `aiTextEngineConfigured()` like the text branches below.
      if (!openaiConfigured()) return;
      const transcript = await ensureTranscription(e.workspaceId, e.messageId);
      if (transcript) {
        const config = await loadAiConfig(e.workspaceId);
        await enqueueAiReply({
          workspaceId: e.workspaceId,
          conversationId: e.conversationId,
          inboundMessageId: e.messageId,
          text: transcript,
          isVoice: true,
          waitSeconds: config?.replyWaitSeconds ?? 0,
        });
      }
      return;
    }
    if (!aiTextEngineConfigured()) return;
    const caption = (e.media?.caption ?? "").trim();
    if (caption) {
      const config = await loadAiConfig(e.workspaceId);
      // Gate on configEnabled like every other entry point. The audio branch
      // above re-checks it inside `ensureTranscription`; this one didn't, so an
      // AI-disabled workspace paid a queue round-trip per captioned media just
      // for `runAiReply` to bail. Not an unauthorized model call — a wasted one.
      if (!config?.enabled) return;
      await enqueueAiReply({
        workspaceId: e.workspaceId,
        conversationId: e.conversationId,
        inboundMessageId: e.messageId,
        text: caption,
        isVoice: false,
        waitSeconds: config?.replyWaitSeconds ?? 0,
      });
    }
  }

  private async onSent(e: DomainEventOf<"message.sent">): Promise<void> {
    if (e.silent) return;
    if (!e.senderUserId) return; // system / automation / AI send → not a human takeover
    await onHumanReply(e.workspaceId, e.conversationId, e.senderUserId);
  }

  /**
   * Session end. When a chat is CLOSED, run a final durable-memory pass so the
   * person's interests/preferences from this session are consolidated and
   * (being person-level) seed FUTURE conversations' prompts. Gated on the team
   * actually using the assistant so we never spend tokens for teams that don't.
   */
  private async onStatusChanged(e: DomainEventOf<"conversation.status_changed">): Promise<void> {
    if (e.newStatus !== "closed") return;
    if (!aiGloballyEnabled() || !openaiConfigured()) return;
    const config = await loadAiConfig(e.workspaceId);
    if (!configEnabled(config)) return;
    await enqueueAiMemoryOnClose(e.conversationId);
  }

  private logError(where: string, err: unknown): void {
    this.logger.error(`ai subscriber ${where} failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}
