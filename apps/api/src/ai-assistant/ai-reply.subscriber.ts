import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from "@nestjs/common";

import type { DomainEventOf } from "@ccp/shared/events/types";

import { onHumanReply } from "@/lib/ai/conversation-state";
import { aiGloballyEnabled } from "@/lib/ai/models";
import { openaiConfigured } from "@/lib/ai/openai-client";
import { enqueueAiReply } from "@/lib/ai/queue";
import { ensureTranscription } from "@/lib/ai/voice-ingest";
import { subscribe, SubscriberPriority } from "@/lib/events/bus";

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
    this.offs.push(
      subscribe(
        "message.received",
        (e) => void this.onReceived(e).catch((err) => this.logError("received", err)),
        SubscriberPriority.DEFAULT,
      ),
    );
    this.offs.push(
      subscribe(
        "message.media_ready",
        (e) => void this.onMediaReady(e).catch((err) => this.logError("media_ready", err)),
        SubscriberPriority.DEFAULT,
      ),
    );
    this.offs.push(
      subscribe(
        "message.sent",
        (e) => void this.onSent(e).catch((err) => this.logError("sent", err)),
        SubscriberPriority.DEFAULT,
      ),
    );
  }

  onModuleDestroy(): void {
    for (const off of this.offs) off();
    this.offs = [];
  }

  private async onReceived(e: DomainEventOf<"message.received">): Promise<void> {
    if (!aiGloballyEnabled() || !openaiConfigured()) return;
    if (e.silent) return;
    const m = e.message;
    if (!m || m.direction !== "in") return;
    if (m.mediaPending) return; // wait for media_ready
    const text = (m.body ?? "").trim();
    if (!text) return; // voice notes have empty body → handled on media_ready
    await enqueueAiReply({
      teamId: e.teamId,
      conversationId: e.conversationId,
      inboundMessageId: m.id,
      text,
      isVoice: false,
    });
  }

  private async onMediaReady(e: DomainEventOf<"message.media_ready">): Promise<void> {
    if (!aiGloballyEnabled() || !openaiConfigured()) return;
    const kind = e.media?.kind;
    if (kind === "audio") {
      const transcript = await ensureTranscription(e.teamId, e.messageId);
      if (transcript) {
        await enqueueAiReply({
          teamId: e.teamId,
          conversationId: e.conversationId,
          inboundMessageId: e.messageId,
          text: transcript,
          isVoice: true,
        });
      }
      return;
    }
    const caption = (e.media?.caption ?? "").trim();
    if (caption) {
      await enqueueAiReply({
        teamId: e.teamId,
        conversationId: e.conversationId,
        inboundMessageId: e.messageId,
        text: caption,
        isVoice: false,
      });
    }
  }

  private async onSent(e: DomainEventOf<"message.sent">): Promise<void> {
    if (e.silent) return;
    if (!e.senderUserId) return; // system / automation / AI send → not a human takeover
    await onHumanReply(e.teamId, e.conversationId, e.senderUserId);
  }

  private logError(where: string, err: unknown): void {
    this.logger.error(`ai subscriber ${where} failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}
