import { db } from "@/lib/db";
import type { Channel } from "@ccp/shared/types";

/**
 * The number's standing artifact policy — does this workspace want its calls
 * recorded / transcribed? Read fresh from the connection's config (OURS — the
 * provider stores no such setting; artifacts are produced in-app only, see
 * `CallsService.callArtifactPolicies` for the product history).
 *
 * Lives in the domain layer because TWO callers need one answer: the calls
 * service (arming the browser recorder per call) and the call-recordings
 * sweeper (finishing work for calls whose browser/API died mid-pipeline). A
 * second hand-rolled config read would be a second definition of the policy.
 */
export interface CallArtifactPolicies {
  recordingEnabled: boolean;
  transcriptionEnabled: boolean;
}

/**
 * How long the call-recordings sweeper keeps retrying a missing in-app
 * transcript. Also the honesty bound on the derived "Transcribing…" state
 * below: past this horizon nobody is coming, so pending would be a lie.
 */
export const INAPP_TRANSCRIPT_RETRY_HORIZON_MS = 24 * 60 * 60 * 1000;

/**
 * Derived `transcriptPending` for HYDRATION. The live `call:artifacts` frames
 * carry the flag explicitly, but a reload used to lose it (no serializer set
 * it), so the "Transcribing…" chip vanished mid-transcription and never came
 * back. True while: the number's policy wants a transcript, a stored
 * recording exists, the transcript hasn't landed, and the call ended recently
 * enough that the sweeper still retries. Reads the already-joined connection
 * config — no extra query.
 */
export function deriveTranscriptPending(row: {
  recordingKey: string | null;
  transcriptKey: string | null;
  endedAt: Date | null;
  channelConnectionConfig: unknown;
}): boolean {
  if (row.transcriptKey !== null || row.recordingKey === null) return false;
  if (!row.endedAt) return false;
  if (Date.now() - row.endedAt.getTime() > INAPP_TRANSCRIPT_RETRY_HORIZON_MS) {
    return false;
  }
  const config = row.channelConnectionConfig as {
    callTranscription?: { enabled?: boolean };
  } | null;
  return config?.callTranscription?.enabled === true;
}

export async function callArtifactPoliciesFor(
  workspaceId: string,
  channel: Channel,
  channelConnectionId: string | null,
): Promise<CallArtifactPolicies> {
  if (channel !== "whatsapp") {
    return { recordingEnabled: false, transcriptionEnabled: false };
  }
  const conn = await db.channelConnection.findFirst({
    where: channelConnectionId
      ? { id: channelConnectionId, workspaceId }
      : { workspaceId, channel, isDefault: true },
    select: { config: true },
  });
  const config = conn?.config as {
    callRecording?: { enabled?: boolean };
    callTranscription?: { enabled?: boolean };
  } | null;
  return {
    recordingEnabled: config?.callRecording?.enabled === true,
    transcriptionEnabled: config?.callTranscription?.enabled === true,
  };
}
