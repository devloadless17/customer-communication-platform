-- Ticket workflow triggers.
--
-- Until now `ticket.changed` drove no automation at all: "SLA breached → tell a
-- manager", "urgent → route to the on-call queue", "escalated to Billing →
-- notify their channel" were all impossible, which is the core of what a
-- helpdesk automates. Tickets get their OWN trigger family rather than reusing
-- the conversation ones, because a ticket has its own lifecycle (many per
-- thread), its own SLA promise, and its own cross-department escalation.
--
-- PostgreSQL 12+ allows ADD VALUE inside the migration transaction as long as
-- the value is not USED in the same transaction.
ALTER TYPE "WorkflowTriggerEvent" ADD VALUE 'ticket_created';
ALTER TYPE "WorkflowTriggerEvent" ADD VALUE 'ticket_status_changed';
ALTER TYPE "WorkflowTriggerEvent" ADD VALUE 'ticket_priority_changed';
ALTER TYPE "WorkflowTriggerEvent" ADD VALUE 'ticket_assigned';
ALTER TYPE "WorkflowTriggerEvent" ADD VALUE 'ticket_sla_breached';
ALTER TYPE "WorkflowTriggerEvent" ADD VALUE 'ticket_escalated';
