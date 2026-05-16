import "server-only";

import { Prisma } from "@prisma/client";
import { NextResponse } from "next/server";

import { requireAdmin } from "@/lib/auth/helpers";
import { db } from "@/lib/db";
import { describeStep } from "@/lib/workflows/steps";
import { emitCatalogChange } from "@/lib/socket/server";
import {
  type WorkflowBody,
  parseWorkflowBody,
  redactGraph,
} from "./_shared";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const session = await requireAdmin();
  if (session instanceof NextResponse) return session;

  const rows = await db.workflow.findMany({
    where: { teamId: session.teamId },
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      name: true,
      enabled: true,
      published: true,
      trigger: true,
      graph: true,
      createdAt: true,
      updatedAt: true,
      _count: { select: { runs: true } },
    },
  });

  return NextResponse.json({
    workflows: rows.map((r) => {
      const graph = r.graph as { nodes?: Array<{ id: string; type: string; config: unknown }>; startNodeId?: string };
      const startNode = graph.nodes?.find((n) => n.id === graph.startNodeId);
      // Surface a short "first step" hint in the listing so admins can
      // skim a long list and see what each workflow does without opening it.
      const firstStepLabel = startNode
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        ? describeStep(startNode.type as any, startNode.config)
        : "(empty graph)";
      const stepCount = graph.nodes?.length ?? 0;
      return {
        id: r.id,
        name: r.name,
        enabled: r.enabled,
        published: r.published,
        trigger: r.trigger,
        stepCount,
        firstStepLabel,
        runCount: r._count.runs,
        createdAt: r.createdAt.toISOString(),
        updatedAt: r.updatedAt.toISOString(),
      };
    }),
  });
}

export async function POST(req: Request) {
  const session = await requireAdmin();
  if (session instanceof NextResponse) return session;

  let body: WorkflowBody;
  try {
    body = (await req.json()) as WorkflowBody;
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }

  // Create always uses SAVE-tier validation. Admin publishes via the
  // /publish endpoint once the canvas is complete.
  const parsed = parseWorkflowBody(body);
  if (parsed.errors.length > 0) {
    return NextResponse.json(
      { error: "validation failed", details: parsed.errors, stepErrors: parsed.stepErrors },
      { status: 400 },
    );
  }

  try {
    const created = await db.workflow.create({
      data: {
        teamId: session.teamId,
        name: parsed.name,
        enabled: parsed.enabled,
        published: false, // new workflows always start as drafts
        trigger: parsed.trigger,
        triggerConfig: parsed.triggerConfig as Prisma.InputJsonValue,
        triggerConditions: parsed.triggerConditions as Prisma.InputJsonValue,
        triggerOncePerContact: parsed.triggerOncePerContact,
        graph: parsed.graph as unknown as Prisma.InputJsonValue,
      },
    });
    emitCatalogChange(session.teamId, "workflows");
    return NextResponse.json({
      id: created.id,
      name: created.name,
      enabled: created.enabled,
      published: created.published,
      trigger: created.trigger,
      triggerConfig: created.triggerConfig,
      triggerConditions: created.triggerConditions,
      triggerOncePerContact: created.triggerOncePerContact,
      graph: redactGraph(created.graph as unknown as ReturnType<typeof redactGraph>),
      createdAt: created.createdAt.toISOString(),
      updatedAt: created.updatedAt.toISOString(),
    });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      return NextResponse.json(
        { error: "name already in use", details: [`A workflow named "${parsed.name}" already exists.`] },
        { status: 409 },
      );
    }
    throw err;
  }
}
