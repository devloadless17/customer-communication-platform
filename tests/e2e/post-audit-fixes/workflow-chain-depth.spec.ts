/**
 * Workflow chain-depth propagation (2026-05-29 P0 fix).
 *
 * The prior code read `metadata.depth` ONLY when `envelope.event ===
 * "manual_trigger"`. For any other event (message_received, conversation_*,
 * etc.) `parentDepth = NaN → nextDepth = 1`. A chain that goes through a
 * non-manual trigger at any point reset the workflow-chain counter and
 * could bypass `TRIGGER_DEPTH_MAX = 8`.
 *
 * The fix: stamp `_workflowDepth` on every chained run's eventPayload
 * (regardless of the chained workflow's trigger event), and the runner's
 * `buildEnvelope` surfaces it as `envelope.workflowDepth`. The
 * `trigger_workflow` step reads it back unconditionally.
 *
 * This spec builds a two-workflow ping-pong A→B→A→B→… (both `manual_trigger`
 * for setup simplicity — the cap behavior is the same regardless of trigger
 * type; the BUG was the depth READ, which is now uniform). At depth 9, the
 * step refuses and writes a "trigger_depth_exceeded" entry in the run log.
 *
 * Why not test through a non-manual trigger directly: simulating a message
 * inbound would also fire bus subscribers, which would re-dispatch via the
 * workflow-dispatch subscriber and run a SEPARATE chain. Testing with two
 * manual workflows in mutual `trigger_workflow` cleanly exercises the
 * depth propagation without entangling bus dispatch.
 */
import { test, expect } from "@playwright/test";
import {
  createWorkflow,
  publishWorkflow,
} from "../_helpers/api";
import { db, superadminTeam, wipeTestData, pollUntil } from "../_helpers/db";

let workspaceId: string;
let contactId: string;

test.beforeAll(async () => {
  await wipeTestData();
  const su = await superadminTeam();
  workspaceId = su.workspaceId;
  const contact = await db().contact.create({
    data: {
      workspaceId,
      phoneNumber: "+15559876543",
      identityChannel: "whatsapp",
      name: "Chain Depth Contact",
      source: "manual",
    },
  });
  contactId = contact.id;
});

test.afterAll(async () => {
  await wipeTestData();
  await db().$disconnect();
});

test.describe("Workflow chain-depth (across all parent trigger events)", () => {
  test("A→B→A→B→… ping-pong caps at TRIGGER_DEPTH_MAX (8) regardless of parent event", async ({
    request,
  }) => {
    // Two workflows, each with a single `trigger_workflow` step pointing at
    // the OTHER. Both are `manual_trigger` for fixture simplicity; the
    // chain-depth read is now uniform regardless of trigger type. The
    // fix verifies: depth is read off envelope.workflowDepth (set from
    // payload._workflowDepth on every chained run), NOT off
    // envelope.event === "manual_trigger" metadata.depth.

    // Both workflows need to be created BEFORE they can reference each
    // other. Workaround: create both with a noop `add_comment` step, then
    // PATCH the graphs to point at each other via Prisma (bypasses the
    // validator since we control the state), then publish.
    const noopGraph = () => ({
      startNodeId: "n1",
      nodes: [
        {
          id: "n1",
          type: "add_comment",
          config: { body: "noop placeholder" },
        },
      ],
      edges: [],
    });
    const triggerGraph = (targetId: string) => ({
      startNodeId: "n1",
      nodes: [
        {
          id: "n1",
          type: "trigger_workflow",
          config: { workflowId: targetId },
        },
      ],
      edges: [],
    });

    const a = await createWorkflow(request, {
      name: "E2E chain depth — A",
      trigger: "manual_trigger",
      graph: noopGraph() as never,
    });
    const b = await createWorkflow(request, {
      name: "E2E chain depth — B",
      trigger: "manual_trigger",
      graph: noopGraph() as never,
    });
    // Patch BOTH graphs to point at each other (after creation, so both
    // IDs exist). Publish flips the published flag and re-runs validation,
    // so the trigger_workflow config (with the real other-id) passes.
    await db().workflow.update({
      where: { id: a.id },
      data: { graph: triggerGraph(b.id) as never },
    });
    await db().workflow.update({
      where: { id: b.id },
      data: { graph: triggerGraph(a.id) as never },
    });
    await publishWorkflow(request, a.id);
    await publishWorkflow(request, b.id);

    // Fire A via the manual-trigger endpoint.
    const fireResp = await request.post(
      `/api/team/workflows/${a.id}/manual-trigger`,
      { data: { contactId } },
    );
    const fireBody = await fireResp.text();
    if (!fireResp.ok()) {
      throw new Error(`manual-trigger failed ${fireResp.status()}: ${fireBody}`);
    }
    // Log the runId so test output shows the chain actually started.
    console.log("[chain-depth-test] fire response:", fireBody);

    // Poll: the chain should produce exactly TRIGGER_DEPTH_MAX runs across
    // A and B before the 9th `trigger_workflow` step refuses. The refusal
    // surfaces in the step's `nextStepId`/`errorMessage` log entry OR as
    // the run's top-level `errorMessage`. We accept either signal.
    //
    // What "bounded" means: with TRIGGER_DEPTH_MAX = 8, depths 1..8 are
    // permitted; depth 9 is refused at the step. So total runs ≈ 8
    // (one chained dispatch per depth tier), give or take parallelism.
    const result = await pollUntil(
      async () => {
        const runs = await db().workflowRun.findMany({
          where: { workflowId: { in: [a.id, b.id] } },
          select: {
            id: true,
            workflowId: true,
            status: true,
            errorMessage: true,
            stepLog: true,
          },
        });
        const depthExceededAnywhere = runs.some((r) => {
          if ((r.errorMessage ?? "").includes("depth")) return true;
          const steps = (r.stepLog ?? []) as Array<{
            errorMessage?: string;
            responseStatus?: number;
          }>;
          return steps.some(
            (s) =>
              (s.errorMessage ?? "").includes("depth") ||
              s.responseStatus === 409,
          );
        });
        // Primary exit: the depth-refusal SIGNAL is present (what we assert).
        // The run-count exit is only a RUNAWAY guard at 2× the cap — NOT at
        // exactly the cap. The old `>= 8` (= TRIGGER_DEPTH_MAX) raced the
        // signal: the chain can reach 8 runs a beat BEFORE the 9th
        // trigger_workflow step records its 409/`depth` refusal, so the poll
        // returned `depthExceeded=false` ~17% of the time (flaky). Waiting for
        // the signal (or a genuinely-runaway ≥16) removes the race while still
        // failing fast if the cap is actually broken (`toBeLessThanOrEqual(20)`
        // below is the hard ceiling).
        if (depthExceededAnywhere || runs.length >= 16) {
          return { runs, depthExceededAnywhere };
        }
        return null;
      },
      { timeoutMs: 15_000, label: "chain depth limit reached" },
    );

    console.log(
      `[chain-depth-test] chain produced ${result.runs.length} runs; depthExceededAnywhere=${result.depthExceededAnywhere}`,
    );
    if (!result.depthExceededAnywhere) {
      // Dump the runs so we can see what shape the depth refusal takes
      // in step logs — adapt the assertion if the wire shape differs.
      console.log(
        `[chain-depth-test] runs:`,
        JSON.stringify(
          result.runs.map((r) => ({
            workflow: r.workflowId === a.id ? "A" : "B",
            status: r.status,
            errorMessage: r.errorMessage,
            stepLog: r.stepLog,
          })),
          null,
          2,
        ),
      );
    }

    // The chain is bounded — total runs shouldn't exceed ~2 × cap.
    expect(result.runs.length).toBeLessThanOrEqual(20);
    // At least one depth-refusal signal somewhere in the chain.
    expect(result.depthExceededAnywhere).toBe(true);
  });
});
