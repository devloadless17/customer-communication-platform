import { db, appAdmin } from "./db";

/**
 * A fully-populated SECOND workspace, used to prove tenant isolation.
 *
 * The org → workspace restructure moved the isolation boundary under ~58
 * tables at once. The failure mode that matters is not "a query throws" — it is
 * a query that quietly forgets `workspaceId` and returns, or mutates, another
 * workspace's row. That is invisible to a typecheck (Prisma's `where` is an XOR
 * union, so a missing key compiles), invisible to a single-workspace test suite,
 * and invisible in the UI until two tenants exist.
 *
 * So: this seeds a second workspace in the SAME organization, populated across
 * every domain, and the specs then drive the app while active in workspace A and
 * assert B is unreachable in all of them.
 *
 * Same org on purpose. A different org would also be blocked by the org check in
 * `resolveSession`, which would mask a missing `workspaceId` in the query below
 * it. Same-org is the strictly harder case and the one the product actually has.
 */

export interface OtherWorkspace {
  workspaceId: string;
  organizationId: string;
  stageId: string;
  tagId: string;
  contactFieldId: string;
  contactId: string;
  conversationId: string;
  ticketId: string;
  inboxViewId: string;
  workflowId: string;
  assignmentPolicyId: string;
  messageFlagDefinitionId: string;
  snippetId: string;
  audienceGroupId: string;
  teamChannelId: string;
}

export const OTHER_WORKSPACE_NAME = "E2E Isolation Target";

/** Everything below is prefixed so a leaked row is obvious in a failure message. */
const P = "ISO-";

export async function seedOtherWorkspace(): Promise<OtherWorkspace> {
  const d = db();
  const { workspaceId: homeId, userId } = await appAdmin();
  const home = await d.workspace.findUniqueOrThrow({
    where: { id: homeId },
    select: { organizationId: true },
  });
  const organizationId = home.organizationId;

  const existing = await d.workspace.findFirst({
    where: { organizationId, name: OTHER_WORKSPACE_NAME },
    select: { id: true },
  });
  const workspaceId =
    existing?.id ??
    (await d.workspace.create({ data: { name: OTHER_WORKSPACE_NAME, organizationId } })).id;

  // The admin is deliberately a MEMBER of it. An isolation test against a
  // workspace you cannot reach at all proves nothing about query scoping — it
  // only proves the membership check works. Being a member means the ONLY thing
  // standing between the session and these rows is `workspaceId` in the where.
  await d.workspaceMember.upsert({
    where: { userId_workspaceId: { userId, workspaceId } },
    create: { userId, workspaceId, role: "admin" },
    update: { role: "admin" },
  });

  const stage = await d.contactStage.create({
    data: { workspaceId, name: `${P}Stage`, color: "blue", position: 0 },
  });
  const tag = await d.tag.create({
    data: { workspaceId, name: `${P}Tag`, color: "rose" },
  });
  const contactField = await d.contactFieldDefinition.create({
    data: { workspaceId, key: "iso_field", label: `${P}Field`, order: 0 },
  });
  const contact = await d.contact.create({
    data: {
      workspaceId,
      name: `${P}Contact`,
      phoneNumber: "999000111222",
      identityChannel: "whatsapp",
      stageId: stage.id,
    },
  });
  const conversation = await d.conversation.create({
    data: {
      workspaceId,
      contactId: contact.id,
      channel: "whatsapp",
      status: "open",
      lastMessagePreview: `${P}preview`,
    },
  });
  await d.message.create({
    data: {
      workspaceId,
      conversationId: conversation.id,
      channel: "whatsapp",
      direction: "in",
      externalId: `${P}wamid-1`,
      body: `${P}message-body`,
      timestamp: new Date(),
    },
  });

  await d.ticketNumberCounter.upsert({
    where: { workspaceId },
    create: { workspaceId, next: 2 },
    update: {},
  });
  const ticket = await d.ticket.create({
    data: {
      workspaceId,
      number: 1,
      conversationId: conversation.id,
      contactId: contact.id,
      channel: "whatsapp",
      subject: `${P}Ticket`,
      status: "open",
      priority: "normal",
    },
  });

  const inboxView = await d.inboxView.create({
    data: {
      workspaceId,
      name: `${P}View`,
      color: "blue",
      icon: "inbox",
      visibility: "shared",
      createdById: userId,
      filters: {},
      position: 0,
    },
  });

  const workflow = await d.workflow.create({
    data: {
      workspaceId,
      name: `${P}Workflow`,
      trigger: "conversation_opened",
      graph: { nodes: [], edges: [] },
    },
  });

  const assignmentPolicy = await d.team.create({
    data: { workspaceId, name: `${P}Policy` },
  });

  const messageFlagDefinition = await d.messageFlagDefinition.create({
    data: { workspaceId, name: `${P}Flag`, color: "amber" },
  });

  const snippet = await d.snippet.create({
    data: { workspaceId, name: `${P}Snippet`, label: `${P}Snippet`, body: "iso", createdById: userId },
  });

  const audienceGroup = await d.audienceGroup.create({
    data: { workspaceId, name: `${P}Audience`, createdById: userId },
  });

  const teamChannel = await d.teamChannel.create({
    data: { workspaceId, name: `${P}channel`, kind: "channel", createdById: userId },
  });

  return {
    workspaceId,
    organizationId,
    stageId: stage.id,
    tagId: tag.id,
    contactFieldId: contactField.id,
    contactId: contact.id,
    conversationId: conversation.id,
    ticketId: ticket.id,
    inboxViewId: inboxView.id,
    workflowId: workflow.id,
    assignmentPolicyId: assignmentPolicy.id,
    messageFlagDefinitionId: messageFlagDefinition.id,
    snippetId: snippet.id,
    audienceGroupId: audienceGroup.id,
    teamChannelId: teamChannel.id,
  };
}

/**
 * Remove the isolation workspace and everything under it.
 *
 * Deletes the Workspace row and lets the schema's cascades do the rest — which
 * is itself worth exercising: if a relation were ever declared without a cascade
 * this throws a foreign-key error and the suite tells us, rather than leaving
 * orphans that quietly break the next run.
 */
export async function dropOtherWorkspace(workspaceId: string): Promise<void> {
  const d = db();
  // Sessions may have been parked here by a switch test; move them home first
  // so a later spec doesn't boot into a deleted workspace.
  const { workspaceId: homeId } = await appAdmin();
  await d.session.updateMany({
    where: { activeWorkspaceId: workspaceId },
    data: { activeWorkspaceId: homeId },
  });
  await d.workspace.deleteMany({ where: { id: workspaceId } });
}
