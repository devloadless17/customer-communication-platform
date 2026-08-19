# UI interaction inventory (code-derived, 2026-08-19)

Every interactive element per route, with its action and any role/state gate.
Drives the every-button walkthrough. DESTRUCTIVE actions are marked.


## Slice: Team chat (/team, /team/[channelId]), Workflows (/workflows, /new, /[id] builder), Reports (/reports, /team, /campaigns, /campaigns/[name]), Platform (/platform, /organizations, /organizations/[id]), auth routes (login, register, verify, pending, forgot-password, invite/[token], logout), /docs/api + /docs/webchat-install, and the persistent app shell (rail, mobile drawer, notification bell, availability picker, workspace switcher, user menu)

### (persistent app shell — desktop rail, mounted by app/(app)/layout.tsx on every /inbox /team /contacts /flags /tickets /broadcasts /reports /workflows /settings /account /organization page)
- **Roles:** Every signed-in, email-verified member of an org whose status is 'active'. superAdmin NOT in operator mode is redirected to /platform; org status != active redirects to /pending. Rail is hidden below md (mobile drawer instead).
- **States:** Realtime connect dot on the workspace badge (aria-label 'Realtime connected'/'Realtime disconnected'); badge counts seed via fetch then debounce-refetch on socket events; no explicit empty/error state — segment error boundaries live per-section.

| Element | Does | Gate | ⚠ |
|---|---|---|---|
| Workspace badge button (aria-label 'Switch workspace') | opens WorkspaceSwitcher dropdown | always rendered, even with 1 workspace |  |
| Dropdown item: organization name row (Building2 + Settings icon) | Link → /organization | hidden as a LINK in operator mode (renders as inert text — /organization is the operator's own org) |  |
| Dropdown items: one row per workspace (name + Check on active) | POST /api/workspaces/active {workspaceId} then window.location.assign('/inbox') (hard nav, never router.push — socket room must re-join) | only workspaces the user is a member of; superAdmin/operator sees the entered tenant |  |
| Dropdown item 'New workspace' | Link → /organization (deliberately not an inline create) | hidden in operator mode |  |
| Dropdown item 'Back to platform' | Link → /platform | operator mode ONLY |  |
| Rail nav link 'Inbox' | → /inbox; carries team-wide unread badge | all roles |  |
| Rail nav link 'Team chat' | → /team; badge = unread mention count | all roles |  |
| Rail nav link 'Contacts' | → /contacts | all roles |  |
| Rail nav link 'Flagged' | → /flags | all roles |  |
| Rail nav link 'Tickets' | → /tickets; badge = new tickets, dot = new replies | all roles |  |
| Rail nav link 'Broadcasts' | → /broadcasts (also active on /templates, /broadcasts/groups) | HIDDEN for restricted-viewer (controller @DenyRestrictedViewer would 403) |  |
| Rail nav link 'Reports' | → /reports | requires capability teamActivity:view (default off for agent) |  |
| Rail nav link 'Workflows' | → /workflows | admin only (canManageUsers) |  |
| Rail nav link 'Settings' | → /settings | all roles |  |
| Notification bell (aria-label 'Notifications' / 'Notifications (N unread)') | opens portal panel; GET /api/notifications?limit=30 on open; unread count from GET /api/notifications/unread-count | all roles; Escape or outside-click closes |  |
| 'Mark all read' (in bell panel) | POST /api/notifications/read {} — optimistic zero | shown only when unread > 0 |  |
| Notification row link | → /tickets/<ticketId> (or /tickets), closes panel; rows GROUPED by ticket at render | empty state: 'Nothing yet. Assignments and replies land here.'; loading state: 'Loading…' |  |
| Collapse/expand rail button (aria-label 'Collapse sidebar'/'Expand sidebar') | toggles rail width; persists cookie app-rail-collapsed (server reads it to avoid SSR flash) | desktop only |  |
| Avatar button (aria-label 'Open account menu') | opens UserMenu dropdown | all roles |  |
| Availability rows: Available / Busy / Away / Appear offline (aria-pressed) | PATCH /api/users/me/availability {status} | DISABLED (opacity-60, cursor-not-allowed) without capability availability:manage; server @RequireCapability is the real gate |  |
| 'Follow schedule' link (in availability block) | PATCH /api/users/me/availability — clears manual override, returns to working-hours schedule | only when an `until` override exists and picker not disabled |  |
| Status-note text input ('Add a status note (optional)', maxLength 100) | PATCH /api/users/me/availability {message}; Save button appears when dirty; autosaves on menu close | same availability:manage gate |  |
| User-menu item 'Personal settings' | Link → /account | all roles |  |
| User-menu item 'Workspace settings' | Link → /settings | all roles |  |
| User-menu item 'Organization' | Link → /organization | HIDDEN in operator mode |  |
| User-menu item 'Sign out' | useSignOutOverlay → broadcasts cross-tab signout then navigates /logout | all roles |  |
| NOTE: no command palette / global search exists | no Cmd-K handler anywhere in apps/web; the only global keydown listener is components/ui/popover.tsx (Escape). Team-chat has its own workspace search dialog; there is no app-wide one. | n/a |  |
| NOTE: no theme toggle in the shell | appearance mode lives at /account (appearance-mode.tsx), not in the rail or drawer | n/a |  |

### (persistent app shell — mobile chrome, MobileShellChrome, rendered by SectionShell below md)
- **Roles:** Same as the desktop rail; visible only below md.
- **States:** Sticky top bar with derived section title; drawer is a Sheet (focus trap, Escape closes).

| Element | Does | Gate | ⚠ |
|---|---|---|---|
| Hamburger (aria-label 'Open navigation', aria-controls mobile-nav-drawer) | opens left Sheet drawer; also invoked programmatically by openMobileNav() from the team-chat channel header | mobile only |  |
| Top-bar h1 (section title derived from pathname) | static; overridable via `title` prop | n/a |  |
| Top-bar right slot | per-section actions (used by contacts); NOT used by team/workflows/reports — no notification bell on mobile | n/a |  |
| Drawer nav links (Inbox / Team chat / Contacts / Flagged / Tickets / Broadcasts / Reports / Workflows / Settings) | same hrefs + same gates as the desktop rail | identical role/capability filtering |  |
| Drawer sub-sidebar slot | renders the section's sub-sidebar in drawer mode (for /team this is the full channel + DM list) | section-dependent |  |
| Drawer AvailabilityPicker | same PATCH /api/users/me/availability | availability:manage |  |
| Drawer link 'Account' | → /account | all roles |  |
| Drawer button 'Sign out' | signOut() → /logout | all roles |  |

### /team
- **Roles:** Any signed-in workspace member (no role gate).
- **States:** Server-redirects to the default channel (#general). If NO channels exist: empty state 'No channels yet' + CTA. error.tsx → SegmentError 'Team chat failed to load' (with stale-chunk auto-reload). loading.tsx exists on [channelId].

| Element | Does | Gate | ⚠ |
|---|---|---|---|
| (auto) redirect | getDefaultChannel() → redirect /team/<id> | only when a default channel exists |  |
| Button 'Create channel' (empty state, Plus icon) | opens the same NewChannelDialog as the sidebar '+' | no role gate — anyone can create a PUBLIC channel |  |

### /team/[channelId] — LEFT SIDEBAR (TeamChannelSidebar, mounted at layout level, also the mobile drawer content)
- **Roles:** Members of the channel. Non-member on a PUBLIC channel gets the JoinChannelCard; private channel / DM / missing → 404 (existence undisclosed).
- **States:** 'N online' presence count; channel filter empty state 'No matches.' / 'No channels yet.'; DM empty state 'No direct messages yet.'; virtualized channel list (32px rows).

| Element | Does | Gate | ⚠ |
|---|---|---|---|
| Icon button aria-label 'Search messages across every channel' (Search) | opens WorkspaceSearchDialog (dynamic import) | all members |  |
| Icon button aria-label 'Browse public channels' (Compass) | opens BrowseChannelsDialog (dynamic import) | all members |  |
| Icon button aria-label 'Create channel' (Plus) | opens NewChannelDialog | all members (private option gated inside) |  |
| Input aria-label 'Filter channels' | client-side substring filter (useDeferredValue); does NOT filter DMs | n/a |  |
| Button aria-label 'Clear filter' (X) | clears the filter input | shown only when query non-empty |  |
| Channel row link (# or 🔒 + name, unread bold / mention badge / dot) | Link → /team/<id> with optimistic selection | only channels you're a member of; Lock icon aria-label 'Private channel' |  |
| 'Direct messages' section header + button aria-label 'New direct message' (Plus) | opens NewDmDialog | all members |  |
| DM row link (avatar + presence dot + name, '(you)' for self) | Link → /team/<dmId> | no presence dot for self-notes or hard-deleted peer; deactivated peer rendered italic/dimmed |  |

### /team/[channelId] — DIALOGS opened from the sidebar
- **Roles:** Any workspace member.
- **States:** Browse: 'Loading…' / error text (apiErrorMessage) / 'No public channels yet.' / 'No public channels match that search.'; NewDm: 'No teammates match that search.'

| Element | Does | Gate | ⚠ |
|---|---|---|---|
| Create channel dialog — Input 'Name' (placeholder 'sales', autoFocus, Enter submits) | normalizes to #slug; inline hint names the exact reason on invalid (reserved / double-dash / >32 chars / charset) | Create button disabled while invalid |  |
| Create channel — radio 'Public' | visibility=public | always selectable |  |
| Create channel — radio 'Private' | visibility=private | DISABLED for agent (admin/manager only, canCreateChannel); hint says so |  |
| Create channel — Textarea 'Description (optional)' | sent as description | n/a |  |
| Create channel — Button 'Create channel' | POST /api/team-chat/channels {name, description, visibility} → router.push /team/<newId> | disabled while invalid or busy |  |
| Create channel — Button 'Cancel' | closes dialog | n/a |  |
| Browse channels — Input aria-label 'Search channels' (autoFocus, 200ms debounce) | GET /api/team-chat/channels/browse?q=… (metadata only, never message previews) | PUBLIC channels only |  |
| Browse channels — Button 'Join' / 'Joining…' | POST /api/team-chat/channels/:id/join → close → router.push /team/:id + router.refresh | disabled while any join in flight |  |
| Browse channels — Button 'Open' | router.push /team/:id | shown when already joined |  |
| New DM — Input aria-label 'Search teammates' (autoFocus) | client filter over the roster by name/email | deactivated teammates excluded; self sorts last as 'Notes to self' |  |
| New DM — teammate row button | POST /api/team-chat/channels/dm {userId} (idempotent on (workspaceId,dmKey)) → router.push /team/<dmId> + refresh | disabled while any open in flight |  |
| Workspace search — Input aria-label 'Search team chat' (autoFocus, 200ms debounce, min 2 chars) | GET /api/team-chat/channels/search?q=… | private channels you're not in are excluded server-side |  |
| Workspace search — result row | router.push /team/<channelId>?jumpTo=<msgId>&q=<query>&n=<nonce> (nonce keeps repeat jumps distinct) | n/a |  |
| Workspace search — button aria-label 'Close search' (X) / Escape | closes overlay | n/a |  |
| Join-channel card — Button 'Join channel' | POST /api/team-chat/channels/:id/join → window.location.reload() (full reload so subscribe:channel runs with membership committed) | public channels only |  |
| Join-channel card — Button 'Back to team chat' | router.push /team | n/a |  |

### /team/[channelId] — CHANNEL HEADER + workspace chrome
- **Roles:** Channel members.
- **States:** Description or 'No description'; 'default' pill on #general; DM header shows peer / 'Notes to self' / 'Deactivated account'.

| Element | Does | Gate | ⚠ |
|---|---|---|---|
| Mobile button aria-label 'Browse channels' (PanelLeft) | openMobileNav() — opens the drawer carrying the channel list | below md only |  |
| Icon button aria-label 'Search this channel' (Search) | opens the inline ChannelSearch bar | all members |  |
| Button aria-label 'Channel members' (Users + count) | opens ChannelMembersDialog | HIDDEN on a DM |  |
| Icon button aria-label 'Channel settings' (Settings) | opens dropdown | rendered only if canEdit \|\| canDelete \|\| canLeave — so hidden entirely on a DM |  |
| Menu item 'Edit channel' (Pencil) | opens EditChannelDialog | admin/manager, not a DM |  |
| Menu item 'Leave channel' (LogOut) | DELETE /api/team-chat/channels/:id/members/<me> → toast → window.location.assign('/team') | any role, NOT the default channel, NOT a DM | **DESTRUCTIVE** |
| Menu item 'Delete channel' (Trash2, destructive styling) | confirm dialog 'Delete this channel? All its messages will be lost.' → DELETE /api/team-chat/channels/:id → router.push /team | admin only, NOT default channel, NOT a DM | **DESTRUCTIVE** |
| Edit dialog — Input 'Name' | PATCH /api/team-chat/channels/:id {name, description, visibility?} | DISABLED on the default channel ('The default channel can't be renamed.') |  |
| Edit dialog — radios Public / Private | sets visibility on the PATCH | only rendered when admin/manager AND !isDefault |  |
| Edit dialog — Textarea 'Description' + Buttons 'Save changes' / 'Cancel' | same PATCH; toast 'Saved #name' + softRefresh | Save disabled while name invalid or busy |  |
| Inline channel search — Input aria-label 'Search this channel' (autoFocus, min 2 chars, debounced) | GET /api/team-chat/channels/:id/messages/search?q=… | error text on failure ('Search didn't run.' / network message) |  |
| Inline channel search — result row | jumpToMessage() — anchors the feed at that message and highlights matches | n/a |  |
| Inline channel search — button aria-label 'Close search' / Escape | closes bar and clears highlight query | n/a |  |
| 'Clear' button in the highlight banner | clears the search-landing <mark> highlight | shown only when a jump highlight is active and the search bar is closed |  |

### /team/[channelId] — PINNED BAR
- **Roles:** Channel members.
- **States:** Renders nothing with 0 pins; auto-collapsed once >1 pin; keyed by channel id so the collapse default re-derives per channel.

| Element | Does | Gate | ⚠ |
|---|---|---|---|
| Header toggle 'N pinned message(s)' (aria-expanded) | expands/collapses the pin list | n/a |  |
| Row button aria-label 'Unpin message' (X, appears on hover/focus) | optimistic remove + DELETE /api/team-chat/channels/:id/messages/:msgId/pin; rolls back + toast on failure | canPinInChannel — admin/manager in a channel, EITHER party in a DM | **DESTRUCTIVE** |

### /team/[channelId] — MESSAGE FEED + BUBBLE ACTIONS (ChannelThread / ChannelMessage)
- **Roles:** Channel members.
- **States:** 'New messages' divider frozen at open-time lastReadAt; date separators; auto-load older on top sentinel and newer on bottom sentinel (anchored mode); failed-optimistic rows tinted destructive.

| Element | Does | Gate | ⚠ |
|---|---|---|---|
| Hover toolbar button aria-label 'Add reaction' (SmilePlus) | opens ReactionPicker (6 quick emoji + 'More reactions' full picker) | hidden while editing / pending / failed |  |
| ReactionPicker quick emoji buttons (aria-label 'React with <emoji>') | optimistic frame + POST /api/team-chat/channels/:id/messages/:msgId/reactions {emoji}; rolls back on !ok | anyone |  |
| ReactionPicker button aria-label 'More reactions' | opens the shared inbox EmojiPopover (search/categories/recents), closes after one pick | anyone |  |
| Existing reaction chip (emoji + count, tooltip lists reactors) | toggles your reaction — same POST endpoint | anyone |  |
| Hover toolbar button aria-label 'Reply in thread' (MessageSquareText) | opens the ThreadPanel for this message | hidden on a message that IS a thread reply (threads don't nest) |  |
| Thread summary button ('N replies') | opens the ThreadPanel | shown when threadReplyCount > 0 and not itself a reply |  |
| Hover toolbar button aria-label 'More actions' (MoreHorizontal) | opens the bubble dropdown | n/a |  |
| Menu item 'Pin to channel' / 'Unpin from channel' | optimistic pin frame + POST or DELETE /api/team-chat/channels/:id/messages/:msgId/pin | canPinInChannel (admin/manager in channel; either party in a DM) AND not a thread reply |  |
| Menu item 'Edit message' (Edit3) | inline Textarea edit; ⌘/Ctrl+Enter or 'Save' → PATCH …/messages/:msgId {body}; Esc or 'Cancel' aborts | AUTHOR ONLY and within the 24h EDIT_WINDOW_MS — admins deliberately cannot edit others |  |
| Menu item 'Delete message' (Trash2, destructive) | confirm 'Delete this message?' → optimistic splice + DELETE …/messages/:msgId; error toast on failure (no rollback) | author OR admin (canDeleteMessage) | **DESTRUCTIVE** |
| Failed-row link 'Retry' | re-POSTs the same body + clientTempId | hidden for failed MEDIA sends (bytes are gone — hasOptimisticMedia flag) |  |
| Failed-row link 'Dismiss' | removes the optimistic row locally | any failed optimistic row |  |
| Media attachment (image/sticker → <a target=_blank>, video/audio → native controls, document → download link) | opens the R2-presigned same-origin URL in a new tab | n/a |  |
| Mention chip inside a message body | highlighted when it mentions YOU (BodyRenderer highlightUserId); not a link | n/a |  |
| Floating pill 'Jump to live' / 'Jump to live · N new' | refetches the tail and clears the pending queue | shown only in anchored (history) mode |  |
| Floating pill '↓ N new messages' | scrolls to bottom | shown in live mode while reading history |  |

### /team/[channelId] — COMPOSER (also reused inside the thread panel)
- **Roles:** Channel members (send is open to anyone signed in).
- **States:** TypingIndicator above the composer (filters out the viewer); pending-file chip; sends chain in submit order and the button never greys out mid-flight.

| Element | Does | Gate | ⚠ |
|---|---|---|---|
| Textarea (aria-label = composer prompt, e.g. 'Message #general') | Enter sends (Shift+Enter newline; suppressed during IME composition); emits typing:channel:start/stop or typing:thread:start/stop | role='combobox' only while the @-mention popup is open |  |
| @-mention popup (role='listbox', options aria-label 'Teammates') | typing '@' opens it; ArrowUp/ArrowDown move, Enter picks, Escape closes; unmatched query lets Enter send as typed | roster = active workspace members |  |
| Button aria-label 'Attach file' (Paperclip) | opens the hidden file input; picked file becomes a staged chip | any member |  |
| Pending-file chip button aria-label 'Remove attachment' (X) | discards the staged file before send | shown only while a file is staged |  |
| Button aria-label 'Insert emoji' (SmilePlus, aria-expanded) | opens EmojiPopover; deliberately STAYS OPEN after a pick for multi-insert | any member |  |
| Button aria-label 'Send message' (SendHorizontal) | text → POST /api/team-chat/channels/:id/messages {body, clientTempId}; thread → POST …/messages/:rootId/thread; file → POST …/media (multipart file+body+clientTempId+threadRootId) | DISABLED only when there is neither text nor a staged file |  |

### /team/[channelId] — THREAD PANEL
- **Roles:** Channel members.
- **States:** 'Loading replies…' while first page loads; 'N reply/replies' divider; overlay below xl, in-flow 24rem column at xl+; auto-closes on channel switch.

| Element | Does | Gate | ⚠ |
|---|---|---|---|
| Button aria-label 'Close thread' (X) | closes the panel | n/a |  |
| Root message bubble | full ChannelMessage with thread actions hidden | canPin passed through; canDelete = author-or-admin |  |
| Button 'Load more replies' / 'Loading…' | pages older replies | shown only when hasMore; disabled while loading |  |
| Thread composer | same ChannelComposer bound to threadRootId | any member |  |

### /team/[channelId] — CHANNEL MEMBERS DIALOG
- **Roles:** Any channel member can open it (Users button in the header).
- **States:** Spinner row while members===null; 'No members match that filter.'; 'The default channel — everyone in the team is automatically a member.'; inline error banner on failed add/remove.

| Element | Does | Gate | ⚠ |
|---|---|---|---|
| Button 'Add people' (UserPlus) | reveals the add picker | admin/manager (canManageChannel) AND !isDefault |  |
| Input aria-label 'Filter teammates…' (autoFocus) | filters addable roster (active, non-member) | inside the add picker |  |
| Roster checkbox rows (checkbox square + avatar + name + role) | toggles selection into selectedToAdd | empty case: 'Everyone matching is already in this channel.' |  |
| Button 'Add N' | POST /api/team-chat/channels/:id/members {userIds[]} → optimistic append + members_changed frame | disabled while busy or nothing selected |  |
| Button 'Cancel' (add picker) | closes the picker, clears selection/filter | n/a |  |
| Input aria-label 'Filter members…' | client filter over current members by name/email | n/a |  |
| Row button aria-label 'Remove <name>' / 'Leave channel' (Trash2) | DELETE /api/team-chat/channels/:id/members/:userId | shown when !isDefault AND (admin/manager OR it's your own row) | **DESTRUCTIVE** |
| Button 'Close' | closes the dialog | n/a |  |

### /workflows
- **Roles:** ADMIN ONLY — non-admins are server-redirected to /inbox (GET /api/workspace/workflows is @RequireRole('admin')); rail entry is hidden for them.
- **States:** Empty state 'No workflows yet' + 'Create your first workflow'; error.tsx → SegmentError 'Workflows failed to load'; force-dynamic RSC (no loading skeleton).

| Element | Does | Gate | ⚠ |
|---|---|---|---|
| Button 'New workflow' (Plus, header) | Link → /workflows/new | admin |  |
| Workflow row link (name + Live/Draft pill + trigger label + step count + run count) | Link → /workflows/<id> | admin |  |
| Button 'Create your first workflow' (empty state) | Link → /workflows/new | admin |  |

### /workflows/new  and  /workflows/[id]  (WorkflowBuilder — same component, mode=create|edit)
- **Roles:** ADMIN ONLY (both pages redirect non-admins to /workflows). /workflows/[id] 404s an unknown id.
- **States:** Top error banner (list, step[<id>] prefixes humanized to step names), separate testError banner, amber non-blocking warnings banner. Edit mode AUTOSAVES ~1.5s after any edit (silent PATCH) plus a keepalive PATCH on unmount/beforeunload; create mode prompts beforeunload when dirty.

| Element | Does | Gate | ⚠ |
|---|---|---|---|
| Input placeholder 'Workflow name' | sets name; feeds the debounced autosave / Save | n/a |  |
| Live/Draft toggle button (Power icon, title explains both directions) | going Live: persist then POST /api/workspace/workflows/:id/publish {publish:true} (strict publish validation); going Draft: same endpoint with publish:false | DISABLED in create mode and while toggling |  |
| Button 'Test' (PlayCircle) | persists the on-screen canvas then POST /api/workspace/workflows/:id/test {} → opens TestRunDrawer polling GET …/runs/:runId | edit mode only; disabled while testing |  |
| Button 'Create' / 'Save' (type=submit) | POST /api/workspace/workflows (create) or PATCH /api/workspace/workflows/:id (edit) | disabled while pending |  |
| Button aria-label 'Delete workflow' (Trash2, destructive) | confirm 'Delete this workflow?' → DELETE /api/workspace/workflows/:id → router.push /workflows | edit mode only; disabled while deleting | **DESTRUCTIVE** |
| Button 'Exit' (ArrowUpRight) | flushes a pending save, then navigates back to /workflows | disabled while exiting |  |
| Canvas: trigger node (click) | opens TriggerEditorDrawer | trigger node is never deletable |  |
| Canvas: step node (click) | opens StepEditorDrawer for that node | n/a |  |
| Canvas: pane click | deselects (closes the step drawer) | n/a |  |
| Canvas keyboard: Escape | closes the step picker, else deselects the step/trigger | ignored while focus is in an INPUT/TEXTAREA/contentEditable |  |
| Canvas keyboard: Delete / Backspace | deletes the selected step (through the confirm dialog); with no step selected, removes selected edges (never the synthetic trigger→start edge) | React Flow's own deleteKeyCode is disabled so the confirm governs | **DESTRUCTIVE** |
| Edge button aria-label 'Insert step' (+ on a connection) | opens the floating step picker anchored on that edge; picking splices the new node in | n/a |  |
| Edge button aria-label 'Delete connection' (X, on hover/selected) | removes that edge | hidden on the synthetic trigger edge | **DESTRUCTIVE** |
| Node toolbar button aria-label 'Add step below' (trailing +) | opens the step picker anchored under a leaf node | leaf nodes only |  |
| Branch node buttons aria-label 'Add step on the true path' / '…false path' | opens the picker bound to that handle | shown per-handle only when that output has no child |  |
| ask_question node buttons aria-label 'Add step on the "<option>" path' / '…answered path' / '…timeout path' | same, per option/answered/timeout handle | shown per handle with no child |  |
| Node toolbar button aria-label 'Duplicate step' (Copy) | duplicateStep() then auto-selects the copy | n/a |  |
| Node toolbar button aria-label 'Delete step' (Trash2) | confirm then removeStep() | n/a | **DESTRUCTIVE** |
| Step picker (role='dialog', aria-label 'Add step') — Input aria-label 'Search steps' | filters ~22 step types grouped by category; Escape closes | contact-acting steps show a warning pill when the trigger carries no contact |  |
| Canvas Panel button 'Rearrange' (title 'Rearrange layout') | opt-in auto-layout of the graph | disabled when graph has 0 steps |  |
| React Flow <Controls /> + <MiniMap pannable> | zoom in/out, fit view, lock; minimap click pans | minZoom 0.25 / maxZoom 1.5 |  |

### /workflows/[id] — TRIGGER EDITOR DRAWER
- **Roles:** Admin (drawer inside the builder).
- **States:** Grouped radio list: Inbox events / Contact events / Ticket events / External & on-demand.

| Element | Does | Gate | ⚠ |
|---|---|---|---|
| Radio list 'Trigger event' (17 options: message_received, conversation_created/opened/closed/assigned, conversation_status_changed, ticket_created/status_changed/priority_changed/assigned/sla_breached/escalated, contact_ | sets trigger and RESETS trigger conditions to an empty AND group | n/a |  |
| Input 'Signing secret' | triggerConfig.secret — HMAC-SHA256 for X-Workflow-Signature | incoming_webhook trigger only; required |  |
| Select 'Listen for' (Any change / Tag added / Tag removed) | triggerConfig.kind | contact_tag_updated trigger only |  |
| Select 'To stage (optional)' (Any stage + workspace stages) | triggerConfig.toStageId | contact_lifecycle_updated trigger only |  |
| Condition group editor (AND / OR pills, 'Condition' + 'Group' add buttons, per-row field/op/value selects, aria-label 'Remove condition' / 'Remove group') | builds triggerConditions; removing a non-empty group asks for confirmation | contact filters unavailable (warning banner) on triggers with no contact; nesting depth capped |  |
| Checkbox 'Trigger once per contact' | triggerOncePerContact (race-safe ledger server-side) | n/a |  |
| Button aria-label 'Close' (X) | closes the drawer | n/a |  |

### /workflows/[id] — STEP EDITOR DRAWER (per step type) + TEST RUN DRAWER
- **Roles:** Admin.
- **States:** Per-step server validation error banner (stepErrors[nodeId]); step description strip; TestRunDrawer polls every ~1.2s until terminal, shows 'No steps ran…' / 'Couldn't load run (status)'.

| Element | Does | Gate | ⚠ |
|---|---|---|---|
| Input aria-label 'Rename step' (placeholder 'Step <id6>', maxLength 80) | sets node.name; empty falls back to the step type label | n/a |  |
| send_message editor: 'Message' token textarea + 'Insert variable' picker + target radios (Contact from the trigger / The person's best channel / Custom phone number) + 'When this starts a new conversation, send from' acc | config.body/target/accountId | account picker HIDDEN when the workspace has <2 accounts; free-form needs an open 24h window (hint says use a template for cold reachout) |  |
| send_template editor: 'Template' select + per-placeholder {{n}} variable inputs (count derived from the body) | config.templateId + variables | templates list comes from the catalog; parameterFormat is authoritative server-side |  |
| add_comment editor: 'Note' token textarea | config.body — internal note | n/a |  |
| assign_to editor: 'Mode' radios (specific user / assignment policy / round-robin) + user select + policy select + 'only if unassigned' checkbox | config.mode/userId/policyId | automated assignment always passes onlyIfUnassigned downstream |  |
| set_status editor: 'Target status' select (Open / Pending / Closed) | config.status | n/a |  |
| open_conversation editor | no config | n/a |  |
| close_conversation editor: 'Category' + 'Summary' inputs | config.category / summary (shown in close history) | both optional |  |
| add_tag / remove_tag editor: 'Tag' select | config.tagId | workspace tag catalog |  |
| update_field editor: 'Field' select + 'Option' select or 'Value' input | config.fieldKey + value; select-type fields render an option picker | custom field definitions from Settings → Contact Fields |  |
| update_lifecycle editor: 'Stage' select | config.stageId | n/a |  |
| branch editor: 'Check' select + per-check value control (tag / stage / custom field / 'Equals' / 'Substring' + case-insensitive checkbox) inside a nested condition group | config.conditions; wires true/false handles | field set scoped to the workflow's TRIGGER |  |
| wait editor: duration number + unit select (seconds/minutes/hours/days) | config.duration — resume scheduled via BullMQ | n/a |  |
| jump_to_step editor: 'Target step' select + 'Max jumps (optional)' | config.targetStepId / maxJumps | global ceiling is 200 steps per run regardless |  |
| ask_question editor: 'Question' token textarea, 'Answer type' (buttons / list / number / date / free text), per-option id+title+description inputs (aria-label 'Option N id/title/description'), aria-label 'Remove option N | config for the interactive prompt; option rename/removal atomically reconciles the wired per-option edges | button title max 20 chars, list title max 24; unparseable/out-of-range replies route to the timeout edge |  |
| http_request editor: 'URL', 'Bearer token (optional)' (placeholder '•••••••• (saved)' when a token is already set), 'Custom headers (optional)', 'Timeout (ms, max 60000)' | config.url/bearerToken/headers/timeoutMs; SSRF-safe fetch server-side | existing token is redacted to bearerTokenSet server-side before reaching the client |  |
| send_conversions_event editor: 'Conversion event' select, 'Value (optional)', 'Currency (optional)', 'Test event code (optional)' | config for the Meta CAPI step | value+currency must be set together or neither |  |
| trigger_workflow editor: 'Workflow' select | config.workflowId — chain-depth guarded | n/a |  |
| create_ticket editor: 'Subject', 'Priority' select (Low/Normal/High/Urgent), assignee checkbox | config for the ticket family | empty subject falls back to the contact's name |  |
| set_ticket_status editor: 'Target status' + 'Resolution code' input | config.status / resolutionCode | resolution code optional |  |
| set_ticket_priority editor: 'Priority' select | config.priority | n/a |  |
| assign_ticket editor: 'Mode' radios + user select + policy select ('Let the routing rules decide') + only-if-unassigned checkboxes | config.mode/userId/policyId | n/a |  |
| DataInspector — expandable Input/Output trees, leaf button aria-label 'Copy variable' | navigator.clipboard.writeText($var.previousStep.* / $var.steps.<id>.*) + toast 'Copied <token>' | read-only in some contexts (no copy label) |  |
| Drawer footer button 'Delete step' (destructive) | removes the selected node (same confirm path) | n/a | **DESTRUCTIVE** |
| Drawer button aria-label 'Close' (X) | closes the step drawer | n/a |  |
| TestRunDrawer: button aria-label 'Close test result' (X) + per-step expandable rows | closes drawer / expands a step's detail payload | drawer is mutually exclusive with the editor drawers |  |

### /reports
- **Roles:** Requires capability teamActivity:view (admin/manager by default, agents off) — otherwise server-redirects to /inbox. Rail entry hidden without it.
- **States:** Client-fetched (browser-timezone daily buckets). Loading = StatTile nulls + PanelSkeleton rows. Error = 'Couldn't load the report. Switch the range or reload to retry.' Panel empty states per chart ('No agent activity in this range.').

| Element | Does | Gate | ⚠ |
|---|---|---|---|
| ReportsNav pills 'Overview' / 'Team' / 'Campaigns' (nav aria-label 'Reports sections', aria-current) | Links → /reports, /reports/team, /reports/campaigns | all three need teamActivity:view |  |
| Select aria-label 'Scope the report to one account' ('All accounts' + per-account) | adds accountId to GET /api/reports/overview | HIDDEN unless some channel actually has >1 account |  |
| Range radiogroup (role='radiogroup' aria-label 'Report range') — preset buttons + 'Custom' | recomputes from/to and refetches GET /api/reports/overview?from&to&tz[&accountId] | n/a |  |
| Date inputs aria-label 'Report start date' / 'Report end date' | sets a custom range (an incomplete/inverted pair simply doesn't fire) | rendered only in Custom mode |  |
| Link 'View full team report' (Agents panel action) | → /reports/team | n/a |  |
| Card link 'Campaigns' (Megaphone) | → /reports/campaigns | rendered unconditionally, even with zero campaigns |  |
| WhatsApp spend panel | GET /api/reports/whatsapp-analytics?… (Meta-side billing, its own request) | rendered ONLY when the workspace has an active WhatsApp account; not filtered by the account picker (WABA-scoped) |  |
| Acquisition panel | GET /api/reports/acquisition — where customers came from (ctwa/ad ids) | not channel-filtered by design |  |
| Charts (Recharts): daily volume, response times, SLA, AI share | read-only; tooltips/legends only | n/a |  |

### /reports/team
- **Roles:** teamActivity:view (else redirect /inbox).
- **States:** Roster + 'now' strip seeded from RSC; ranged report fetched client-side. Loading = skeleton panels; error = same 'couldn't load' banner; leaderboard empty = 'No agent activity in this range yet.'

| Element | Does | Gate | ⚠ |
|---|---|---|---|
| ReportsNav pills (Overview / Team / Campaigns) | section navigation | teamActivity:view |  |
| ReportControls (account select + range radiogroup + custom dates) | GET /api/reports/team?from&to&tz[&accountId] | account select hidden with <2 accounts |  |
| Select aria-label 'Leaderboard metric' | re-sorts the leaderboard bar chart client-side | n/a |  |
| Team-now strip rows (live presence + open-assigned counts, aria-label 'N open chats') | GET /api/reports/team/live (polled) | n/a |  |
| Agents table column header buttons (aria-sort on th) | toggles sort key/direction client-side | n/a |  |
| Agents table row / agent-name button | opens AgentDetailSheet → GET /api/reports/team/agents/:userId?from&to&tz[&accountId] (LRU-cached per key) | deactivated agents show a 'deactivated' pill |  |
| AgentDetailSheet close (Sheet onOpenChange / Escape / scrim) | closes the drill-down | n/a |  |
| Button 'Export CSV' (Download) | client-side CSV of the agents table (no endpoint) | rendered only when the report loaded with ≥1 agent |  |
| Team heatmap cells | read-only; every cell carries an aria-label + native title (never color-alone) | n/a |  |

### /reports/campaigns
- **Roles:** teamActivity:view (else redirect /inbox).
- **States:** Loading spinner 'Loading…'; failure 'Couldn't load campaigns.'; empty 'No campaigns yet' explaining that naming a broadcast creates one.

| Element | Does | Gate | ⚠ |
|---|---|---|---|
| ReportsNav pills | section navigation | teamActivity:view |  |
| Campaign row link (name + N sends + last sent date) | → /reports/campaigns/<encodeURIComponent(name)>; list from GET /api/reports/campaigns | n/a |  |

### /reports/campaigns/[name]
- **Roles:** teamActivity:view (else redirect /inbox).
- **States:** Loading 'Loading…'; 404 → 'No campaign by that name. It may have been renamed, or its broadcasts deleted.'; other failure → 'Couldn't load this campaign.' Name segment is decodeURIComponent'd tolerantly (spaces / bare %).

| Element | Does | Gate | ⚠ |
|---|---|---|---|
| Back link 'Campaigns' (ArrowLeft) | → /reports/campaigns | n/a |  |
| Stat tiles (Sent to / Reached / Read / Replied / Clicked / Failed with opt-out sub-line) | read-only; GET /api/reports/campaigns/:name | n/a |  |
| 'By send' table row link (broadcast name) | → /broadcasts/<id> | n/a |  |
| 'By sending account' panel | read-only per-account funnel | rendered only when accounts.length > 0 |  |

### /platform
- **Roles:** SUPER-ADMIN ONLY — (platform)/layout.tsx redirects non-superAdmins to /inbox; the (app) layout reciprocally redirects superAdmins here. Its own PlatformRail (no inbox/contacts/broadcasts).
- **States:** getPlatformOps() is guarded (.catch(null)) so a failed ops probe doesn't blank the approval queue; per-queue 'probe failed' cell; 'All health thresholds within range' vs a Degraded banner; error.tsx = 'Something went wrong' + 'Try again' (reset).

| Element | Does | Gate | ⚠ |
|---|---|---|---|
| PlatformRail link 'Overview' | → /platform | superAdmin |  |
| PlatformRail link 'Organizations' | → /platform/organizations | superAdmin |  |
| PlatformRail link aria-label 'Sign out' (x2 — header + footer) | → /logout | superAdmin |  |
| Stat card link 'Pending' (hint 'Review →') | → /platform/organizations | n/a |  |
| Link 'View all N →' | → /platform/organizations | shown when pending count exceeds the inline queue |  |
| Pending-queue org name link | → /platform/organizations/<orgId> | n/a |  |
| Button 'Approve' (QuickApproveButton, CheckCircle2) | PATCH /api/admin/organizations/:organizationId/status {status:'active'} → router.refresh | superAdmin; inline error text under the button on failure |  |
| Link aria-label 'Open organization' (ChevronRight) | → /platform/organizations (org-keyed list; the detail route is workspace-keyed) | n/a |  |
| Ops queue table | read-only durable BullMQ counts (failed 7d / waiting / delayed / active) | n/a |  |

### /platform/organizations
- **Roles:** SUPER-ADMIN ONLY.
- **States:** Empty state 'No organizations yet'; pending orgs sorted to the top (oldest-waiting first) with an 'N awaiting approval' pill; per-org 'No workspaces yet.' row.

| Element | Does | Gate | ⚠ |
|---|---|---|---|
| Org row (name + id, status badge, workspace cap 'N / max') | read-only summary; workspaces nest beneath as indented rows | n/a |  |
| Button 'Approve' (QuickApproveButton) | PATCH /api/admin/organizations/:id/status {status:'active'} | shown only when org.status === 'pending' |  |
| DeleteOrgButton (org row) | confirm (no type-to-confirm — nothing to lose) → DELETE /api/admin/organizations/:id | rendered ONLY for orgs with ZERO workspaces (orgs with workspaces are deleted from their detail page) | **DESTRUCTIVE** |
| Workspace name link / ChevronRight (aria-label 'Open workspace <name>') | → /platform/organizations/<workspaceId> (route is WORKSPACE-keyed) | n/a |  |

### /platform/organizations/[id]  (id = a WORKSPACE id)
- **Roles:** SUPER-ADMIN ONLY.
- **States:** Members empty 'No members yet.'; org-wide roster distinguishes 'Org <role> · no workspace access' (dashed pill) from a workspace role; deactivated pill; operator-access log rendered on the same page as the button that writes it; each control renders its own role='alert' error box on failure.

| Element | Does | Gate | ⚠ |
|---|---|---|---|
| Back link 'All organizations' (ArrowLeft) | → /platform/organizations | n/a |  |
| Button 'Enter workspace' (LogIn) | confirm (explains stealth viewing + that it is logged) → POST /api/admin/operator-access {workspaceId} → window.location.assign('/inbox') (FULL nav so the socket re-joins the tenant room) | HIDDEN when the workspace belongs to the operator's OWN org (isOwnOrg) |  |
| Button 'Delete organization' (destructive outline) | confirm with requireText = the exact org NAME → DELETE /api/admin/organizations/:organizationId → router.replace + router.refresh /platform/organizations | HIDDEN when isOwnOrg; wipes the entire tenant, no undo | **DESTRUCTIVE** |
| LimitControl 'Workspaces' (pencil button, header) | reveals a number input (1..100) → PATCH /api/admin/workspaces/:id/max-workspaces {maxWorkspaces} | superAdmin; warns when the new value would strand existing rows |  |
| LimitControl 'Limit' (member seats, Members panel header) | PATCH /api/admin/workspaces/:id/max-members {maxMembers} | superAdmin; seat count excludes superAdmins and non-members of this workspace |  |
| LimitControl inputs: aria-label 'Maximum <noun>s', buttons aria-label 'Save <noun> limit' / 'Cancel' | commits or aborts the edit | validation: whole number 1..hardMax |  |
| Button 'Approve organization' (OrgStatusControls) | PATCH /api/admin/organizations/:id/status {status:'active'} | status === 'pending'; whole block replaced by 'This is your own organization.' when isOwnOrg |  |
| Button 'Suspend access' (ShieldX) | reveals a reason textarea (maxLength 500, shown to the org on its gate screen) | status === 'active' | **DESTRUCTIVE** |
| Suspend panel — Button 'Suspend' / 'Cancel' | PATCH …/status {status:'suspended', reason?} → router.refresh | n/a | **DESTRUCTIVE** |
| Button 'Reactivate' (RotateCcw) | PATCH …/status {status:'active'} | status === 'suspended' |  |
| Operator-access log table | read-only, append-only, newest first (listOperatorAccess by organizationId) | it is a LOG, not a gate — a superAdmin who hand-sets ccp.ws gets in without a row |  |

### /login
- **Roles:** Unauthenticated only — an existing session redirects to '/' (role router: superAdmin → /platform, pending org → /pending, else /inbox).
- **States:** role='alert' box for form errors and for OAuth ?error=<code> (account_not_linked rendered as a sentence); role='status' green box after ?reset=1 ('Password updated…'); submit button shows a spinner while pending; ?bc=1 fires a cross-tab signout broadcast then strips itself from the URL.

| Element | Does | Gate | ⚠ |
|---|---|---|---|
| Button 'Continue with Google' (form action startGoogleSignIn, hidden inputs next + intent=login) | Better Auth Google OAuth | rendered only when googleSignInEnabled() |  |
| Input #email (name=email, type=email, required, autoFocus, placeholder 'you@company.com') | part of the loginAction server action | n/a |  |
| Input #password (name=password, type=password, required) | same form | n/a |  |
| Hidden input name=next | post-login destination, sanitized server-side (must start with '/', not '//', not '/') | n/a |  |
| Link 'Forgot password?' | → /forgot-password | n/a |  |
| Button type=submit 'Sign in' | loginAction → server redirect to `next` | disabled while pending |  |
| Link 'Create a workspace' | → /register | n/a |  |

### /register
- **Roles:** Unauthenticated only — an existing session redirects to '/'.
- **States:** Inline field/summary errors from registerAction; success path lands on /verify (or /verify?send=failed when the first code send threw).

| Element | Does | Gate | ⚠ |
|---|---|---|---|
| Button 'Continue with Google' (intent=signup, next=/inbox) | OAuth signup | only when googleSignInEnabled() |  |
| Input #orgName (required, placeholder 'Acme Co.') | creates the Organization | n/a |  |
| Input #name (required, placeholder 'Ada Lovelace') | user display name | n/a |  |
| Input #email (type=email, required) | account email | n/a |  |
| Password field (name=password, placeholder '<MIN>+ characters') + button aria-label 'Show password'/'Hide password' | toggles input type | n/a |  |
| Confirm-password field (name=confirmPassword) + its own show/hide button | must match | n/a |  |
| Button type=submit | registerAction → provisions org+workspace → redirect /verify | disabled while pending |  |
| Link 'Sign in' | → /login | n/a |  |

### /verify
- **Roles:** Signed-in but unverified users only. No session → /login; already verified or superAdmin → /pending; missing user row → /logout. Deliberately does NOT call getSession() (that helper redirects here — loop).
- **States:** Heading flips to "We couldn't send your code" on ?send=failed; resend error text; 'Resend in Ns' cooldown.

| Element | Does | Gate | ⚠ |
|---|---|---|---|
| Input name=code (aria-label '6-digit verification code', inputMode=numeric, maxLength 6, placeholder '000000') | verifyCodeAction | n/a |  |
| Button type=submit | verifyCodeAction → on success continue to /pending | disabled while pending |  |
| Button 'Resend code' / 'Resend in Ns' | resendCodeAction() | disabled while resending or during the cooldown window |  |
| Link '/logout' (sign out) | ends the session and returns to /login | n/a |  |

### /pending
- **Roles:** Signed-in members of a 'pending' or 'suspended' org. superAdmin → /platform; org already 'active' → /settings/whatsapp. Lives OUTSIDE the (app) group so a locked-out org can reach it.
- **States:** Two variants — 'awaiting approval' (Clock, amber) vs 'suspended' (ShieldAlert, destructive) with the org's statusReason when set; auto-refreshes the RSC every 25s so approval lets the user in without a manual reload.

| Element | Does | Gate | ⚠ |
|---|---|---|---|
| Button 'Check now' (RefreshCw) | router.refresh() — re-runs the server component, which redirects on approval | disabled ~1.2s while spinning |  |
| Button/link 'Sign out' (LogOut) | → /logout | n/a |  |

### /forgot-password
- **Roles:** Anyone (unauthenticated by design). Deliberately reveals nothing about whether an address has an account.
- **States:** Two steps in one component (email carries into step 2); generic Google-account advice shown unconditionally so it can't act as an enumeration oracle.

| Element | Does | Gate | ⚠ |
|---|---|---|---|
| Step 1 — Input name=email (type=email, placeholder 'you@company.com') | requestResetAction → emails a 6-digit code | n/a |  |
| Step 1 — Button type=submit | sends the code, advances to step 2 | disabled while pending |  |
| Step 2 — hidden input name=email (carried) + Input name=code (placeholder '000000') | resetPasswordAction | n/a |  |
| Step 2 — Input name=password + Input name=confirmPassword | new password, must match | n/a |  |
| Step 2 — Button type=submit | resetPasswordAction → redirect /login?reset=1 | disabled while pending |  |
| Link 'Back to sign in' (both steps) | → /login | n/a |  |

### /invite/[token]
- **Roles:** Anyone with the token (unauthenticated).
- **States:** Four terminal shells — 'Invalid link', 'Already accepted', 'Invite expired' (each with a 'Go to sign in' link) — plus the accept form. A just-accepted browser is detected via a short-lived cookie keyed to the token and rendered as RedirectToInbox instead of the 'Already accepted' dead end.

| Element | Does | Gate | ⚠ |
|---|---|---|---|
| Read-only Email row | shows the invited address (not editable) | n/a |  |
| Input #name (name=name, required, placeholder 'Ada Lovelace') | acceptInviteAction | n/a |  |
| Password field 'Choose a password' + show/hide button (aria-label 'Show password'/'Hide password') | sets the account password | min length enforced |  |
| Password field 'Confirm password' + its own show/hide button | must match | n/a |  |
| Hidden input name=token | the invite token | n/a |  |
| Button type=submit | acceptInviteAction → creates the member + session → /inbox | disabled while pending |  |
| Link 'Go to sign in' (terminal shells) | → /login | n/a |  |

### /logout  (route handler, GET + POST)
- **Roles:** Anyone; a cross-origin GET/POST is refused 403 via the Sec-Fetch-Site guard (CSRF-logout vector).
- **States:** No UI. Always redirects to /login (with ?next=<safe> when supplied and ?bc=1 when a real session was ended, which makes the login page broadcast a cross-tab signout).

| Element | Does | Gate | ⚠ |
|---|---|---|---|
| Navigation to /logout (rail 'Sign out', mobile drawer 'Sign out', /pending and /verify links, platform rail x2, 401 redirect chains) | auth.api.signOut + an explicit Session.deleteMany by sessionId + clears every owned cookie + fires session-invalidated to NestJS (drops sockets/session cache) → 302 /login | n/a | **DESTRUCTIVE** |

### /docs/api
- **Roles:** Deliberately PUBLIC — no session check, no layout gate (partners may read it before signing up).
- **States:** Fully static server component. No loading/empty/error states. Kept in lockstep with the /v1 surface by scripts/check-v1-docs.mjs.

| Element | Does | Gate | ⚠ |
|---|---|---|---|
| Link 'Back to Integrations' (ArrowLeft) | → /settings/integrations | n/a |  |
| Inline link 'Settings → Integrations' | → /settings/integrations | n/a |  |
| Inline link to outbound webhooks | → /settings/integrations/webhooks | n/a |  |
| Per-endpoint button 'curl' (title 'Copy curl with $CCP_TOKEN placeholder') — one on EVERY documented /api/external/v1 endpoint | navigator.clipboard.writeText of a curl with origin + method + headers + JSON body; toast 'curl copied' or 'Couldn't access clipboard'; check icon for ~1.5s | n/a |  |

### /docs/webchat-install
- **Roles:** Public (no session check).
- **States:** Static server component; no interactive state.

| Element | Does | Gate | ⚠ |
|---|---|---|---|
| Link → /settings/webchatwidget | back to the widget settings page | n/a |  |
| Code blocks (<Pre>) incl. the `CCPWebchat.open()` snippet | read-only — NOT copy-buttoned (unlike /docs/api) | n/a |  |

## Slice: /contacts (+ detail drawer, import wizard, export dialog, segments, bulk actions), /tickets + /tickets/[id], /broadcasts (+ /new, /[id], /groups, /groups/new, /groups/[id]), /templates (+ /new, /library, /authentication, /[id]/edit), /flags

### /contacts
- **Roles:** Any workspace member (admin / manager / agent) + superAdmin in operator mode. No redirect guard. A 'restricted viewer' (role=agent AND workspace.agentConversationVisibility='assigned') can open it but Export is hidden. URL seeds: ?stage=<id|none>, ?channel=<liveChannel>, ?reach=any|phone|email (default reach=phone = the directory).
- **States:** loading.tsx skeleton (aria-busy, 10 row shells, sr-only 'Loading contacts…'); error.tsx = SegmentError segmentLabel='Contacts'; list error banner role=alert; empty 'No contacts yet' (with New contact CTA) vs filtered 'No contacts match your filters'; refetch dims the list (opacity-60 + pointer-events-none); ContactRowsSkeleton on first load.

| Element | Does | Gate | ⚠ |
|---|---|---|---|
| aria-label 'More contact actions' (icon button, top-right) | Opens the secondary DropdownMenu | none |  |
| menu item 'Manage fields' | Link → /settings/contact-fields | permission contactFields:manage (agent=false by default) |  |
| menu item 'Export contacts' | Opens the Export dialog | permission contacts:export AND NOT restricted viewer |  |
| menu item 'Import contacts' | Opens the Import wizard | none in UI (server gates contacts:import) |  |
| menu item 'Imports & exports' | Opens the Transfer history sheet (GET /api/contacts/transfers?limit=20) | none |  |
| button 'New contact' (also in empty state) | Opens the New contact dialog | none |  |
| search input, placeholder+aria-label 'Search name, phone, email, or any field…', attr data-contacts-search | GET /api/contacts?search= (debounced, page resets to 1) | none |  |
| aria-label 'Clear search' (× inside search) | Clears search term | only when search is non-empty |  |
| keyboard '/' | Focuses the contacts search input | ignored while typing in an input/textarea/contentEditable |  |
| filter button 'Stage' (aria-expanded) | Popover StageFilterMenu → sets stageId filter (incl. 'none') | hidden when the workspace has no stages |  |
| filter button 'Tags' (count badge) | Popover TagFilterList → tagIds filter | hidden when the workspace has no tags |  |
| filter button 'More' | Popover MoreFilterMenu (source / reach / channel / account / 24h window / custom fields) | none |  |
| radio rows 'Everyone' / 'Messaged me' / 'Added by me' (More menu → Source) | source=all\|inbound\|manual | none |  |
| radio rows 'Any' / 'Has phone number' / 'Has email address' (More → Reachable by) | reach=any\|phone\|email | none |  |
| radio rows 'Any channel' + one per LIVE_CHANNELS (More → Channel) | channel filter | hidden when the page was opened inside a channel segment (?channel=…) — the sub-sidebar owns that choice |  |
| radio rows 'Any account' + one per connected account (More → Account) | accountId filter | hidden in 'Group by person' mode, and hidden when <2 accounts on the selected channel |  |
| radio rows 'Any' / 'Open' / 'Closed' (More → 24-hour window) | window filter | none |  |
| select-field option rows + text inputs aria-label 'Filter by <field label>' (More → Custom fields) | fieldKey/fieldValue/fieldMode filter (equals for select, contains for text); one field filter at a time | hidden when the workspace has no contact field definitions |  |
| chip × aria-label 'Remove filter' / link 'Clear all' (ActiveFilterChips) | Clears that one filter / clears every filter + search | only rendered when a filter is active |  |
| toggle 'Group by person' (aria-pressed, title 'Show one row per person instead of per channel-contact') | Rolls the list up to one row per Customer; drops channel+account filters from the query | none |  |
| checkbox aria-label 'Select all visible' | Replaces the selection with the visible page's ids | none |  |
| checkbox aria-label 'Select {name or phone}' (per row) | Adds/removes that contact from the selection | none |  |
| row body / name button (per row) | Opens the Contact detail drawer | none |  |
| TagAddButton (+ icon, per row, hover-revealed) | Opens TagMultiPicker → PUT /api/contacts/{id}/tags (optimistic, rolls back on failure) | none |  |
| stage pill (per row, @md+) | PATCH /api/contacts/{id} { stageId } | disabled with title 'No stages yet…' when no stages; canManage=stages:manage controls the 'Manage stages' footer link |  |
| select-field pill lanes (per row, @2xl+) | PATCH /api/contacts/{id} { customFields: { key: optionId\|null } } | only for select-type field definitions; footer link to /settings/contact-fields gated on contactFields:manage |  |
| link 'Open chat' (per row, @4xl+, title 'Open chat') | → /inbox/{activeConversationId} | only when the contact has an active conversation |  |
| link 'Select all N matching' | Escalates non-destructive bulk ops (tag add/remove) to server-side filter mode | only when every loaded row is selected AND totalCount > loaded |  |
| link 'Clear selection' (all-matching banner) | Drops the escalation + selection | all-matching mode only |  |
| Pagination (prev/next/page numbers, 25/page) | GET /api/contacts?page=N&take=25 | hidden while loading or when the list is empty |  |

### /contacts — bulk action bar (fixed bottom, appears with ≥1 selected)
- **Roles:** Same as /contacts; the Delete button is additionally permission-gated.
- **States:** Hidden at 0 selected; pill shows 'N selected' or 'N matching'; toasts on failure ("Couldn't add tag" / "Couldn't delete contacts"); warning toast 'Applied to the first N contacts' when the server caps a filter-mode op.

| Element | Does | Gate | ⚠ |
|---|---|---|---|
| button aria-label 'Send template' | router.push /broadcasts/new?contactIds=… (ALWAYS the loaded selection, never filter mode — title says so in all-matching mode) | no-op with 0 loaded ids |  |
| button aria-label 'Add tag' | Opens BulkTagMenu (add) → POST /api/contacts/bulk {action:'tag-add'} with contactIds or {mode:'filter', filter} | none |  |
| button aria-label 'Remove tag' | Opens BulkTagMenu (remove) → POST /api/contacts/bulk {action:'tag-remove'} | none |  |
| button aria-label 'Delete selected' | Confirm → POST /api/contacts/bulk {action:'delete', contactIds}. Soft delete. >25 ids requires typing DELETE. NEVER enters filter mode (title states this). | permission contacts:delete | **DESTRUCTIVE** |
| button aria-label 'Clear selection' (×) | Clears selection + all-matching escalation | none |  |
| BulkTagMenu search input, placeholder 'Search or create a tag…' / 'Search tags…' | Filters the tag list; Enter creates when in add mode with a non-matching name | create only in 'tag-add' mode |  |
| BulkTagMenu tag rows (TagChip buttons) | Applies that tag to the bulk; menu stays open for repeats | none |  |
| BulkTagMenu 'Create & apply' + color swatches aria-label '{color} color' | POST /api/workspace/tags then applies it | add mode, non-empty query, no exact match |  |
| BulkTagMenu 'Cancel' | Closes the menu (also closes on outside mousedown) | none |  |

### /contacts — contact detail drawer (Sheet, side=right, labelledBy contact-drawer-name)
- **Roles:** Anyone who can open /contacts; Delete gated.
- **States:** Inline error banner under the header (add-field failures); a start-chat failure renders just above the footer buttons; each editable field saves optimistically and rolls back with a toast.

| Element | Does | Gate | ⚠ |
|---|---|---|---|
| EditableHeading (contact name, id contact-drawer-name) | PATCH /api/contacts/{id} { name } | none |  |
| Stage picker (Section 'Stage') | PATCH /api/contacts/{id} { stageId } | canManage = stages:manage (controls the settings link only) |  |
| EditableField rows: First name, Last name, Email, Location, Language, Country (placeholder '—') | PATCH /api/contacts/{id} with the built-in field | each rendered only when the corresponding `builtins.<field>` is enabled |  |
| Custom-field rows — select fields render ContactFieldSelectPicker, text fields render EditableField | PATCH /api/contacts/{id} { customFields: { key: value\|null } } | only definitions with isVisible |  |
| per-contact ad-hoc field rows + their delete affordance | PATCH with { customFields: { key: null } } to remove | none |  |
| 'Add field' button → inline form (placeholder 'Field name (e.g. Order ID)', chips 'Just this contact' / 'All contacts', Cancel, Add) | Per-contact: PATCH customFields. Team-wide: POST /api/workspace/contact-fields { label } | the 'All contacts' scope chip only with contactFields:manage |  |
| Tags section: TagChip × (remove) + TagAddButton → TagMultiPicker | PUT /api/contacts/{id}/tags { tagIds } | none |  |
| button 'Open chat' | Link → /inbox/{activeConversationId} | only when a conversation exists |  |
| select aria-label 'Which number to start the chat from' | Chooses channelConnectionId for the new thread | only when >1 active account on the contact's identityChannel |  |
| button 'Start chat' | POST /api/conversations/start { contactId, channelConnectionId? } → router.push /inbox/{id} | only when the contact has NO active conversation |  |
| button 'Template' | Link → /broadcasts/new?contactIds={id} | only when no active conversation |  |
| button 'Delete' (destructive styling) | Confirm 'Delete contact?' → DELETE /api/contacts/{id}; removes the row and closes the drawer | permission contacts:delete | **DESTRUCTIVE** |

### /contacts — New contact dialog (labelledBy new-contact-title)
- **Roles:** Anyone who can open /contacts.
- **States:** role=alert error box; submit spinner; Create disabled while phone has no digits or while submitting.

| Element | Does | Gate | ⚠ |
|---|---|---|---|
| aria-label 'Close' (×) / button 'Cancel' | Closes the dialog | Cancel disabled while submitting |  |
| CountryCodePicker + phone input (placeholder '70 921 116', inputMode=tel, required) | Concatenated to +{dial}{local} on submit | required |  |
| inputs: Name (placeholder 'Defaults to phone number'), First name, Last name, Email, Location, Language (placeholder 'en, ar…'), Country (for records) (placeholder 'ISO (US, LB…)', maxLength 2) | Body fields of POST /api/contacts | none |  |
| Custom-field controls — <Select> per select-type definition (option '—' + options), text Input per other definition | customFields on POST /api/contacts | select disabled with helper 'No options yet — add some in Settings → Contact fields.' when a definition has no options |  |
| per-contact field × aria-label 'Remove {field}' | Drops the ad-hoc key from the draft | none |  |
| 'Add field' row (same as drawer: 'Just this contact' / 'All contacts') | Local key, or POST /api/workspace/contact-fields | team-wide scope needs contactFields:manage |  |
| submit button 'Create contact' (type=submit) | POST /api/contacts | disabled while submitting or with no phone digits |  |

### /contacts — Import contacts wizard (labelledBy import-contacts-title; steps file → map → options → run)
- **Roles:** Anyone who can open /contacts (server enforces contacts:import).
- **States:** Upload spinner 'Reading your file…'; error paragraph; per-step footer hint 'Map one column to the phone number to continue.'; run step shows TransferProgress with live counts, failure and cancel states.

| Element | Does | Gate | ⚠ |
|---|---|---|---|
| dropzone button 'Choose a CSV or Excel file' | Opens the hidden file input (.csv/.xlsx, size-checked against TRANSFER_MAX_UPLOAD_BYTES) → POST /api/contacts/import/preview (multipart) | disabled while busy |  |
| link 'CSV template' | GET /api/contacts/transfer-template?format=csv (download) | none |  |
| link 'Excel template' | GET /api/contacts/transfer-template?format=xlsx (download) | none |  |
| per-header select aria-label 'Import "{header}" as' (options: Don't import, builtins, field:{key}) | Builds the column mapping | step 'map' |  |
| buttons 'Back' / 'Next' (map step) | map → file / map → options | Next disabled until one column maps to phone_number |  |
| select aria-label 'What to do with contacts that already exist' (Skip / Update and add / Only update) | options.mode | step 'options' |  |
| select aria-label 'How to apply tags' (Add to existing / Replace existing) | options.tagMode | step 'options' |  |
| select aria-label 'Country for local-format phone numbers' | options.defaultCountry (omitted when blank) | step 'options' |  |
| Switch 'Trigger automations' | options.fireAutomations; forced off server-side above IMPORT_EVENT_FANOUT_CAP rows | step 'options' |  |
| buttons 'Back' / 'Import' (options step) | POST /api/contacts/import { uploadKey, filename, format, options } → jobId → run step | Import disabled while busy |  |
| button 'Cancel' inside TransferProgress | POST /api/contacts/transfers/{jobId}/cancel | only while the job is pending/running | **DESTRUCTIVE** |
| link 'Download' / errors download in TransferProgress | GET /api/contacts/transfers/{id}/download, GET /api/contacts/transfers/{id}/errors | completed jobs with an artifact / with failed rows |  |
| button 'Done' / 'Close' (run step) | Closes the wizard (list already refetched once on completion) | label flips to 'Done' at a terminal status |  |

### /contacts — Export contacts dialog (labelledBy export-contacts-title)
- **Roles:** permission contacts:export AND NOT restricted viewer (the menu item is hidden otherwise).
- **States:** Error paragraph; TransferProgress after start; the browser download auto-fires once the artifact exists (window.location → /download).

| Element | Does | Gate | ⚠ |
|---|---|---|---|
| select aria-label 'Export format' (CSV / Excel (.xlsx)) | format on POST /api/contacts/export | none |  |
| select aria-label 'Contacts to include' (Selected (N) / Current filters (N) / All contacts (N)) | scope → ids \| filters \| nothing; 'All' count from GET /api/contacts/count-all | 'Selected' only with a selection; 'Current filters' only when a filter is active |  |
| button 'Export' | POST /api/contacts/export → jobId → progress panel | disabled while busy |  |
| button 'Cancel' (before start) / 'Close' / 'Done' (after) | Closes the dialog | none |  |
| TransferProgress 'Cancel' button | POST /api/contacts/transfers/{jobId}/cancel | running jobs only | **DESTRUCTIVE** |

### /contacts — Imports & exports history sheet (labelledBy transfer-history-title)
- **Roles:** Anyone who can open /contacts.
- **States:** Spinner while loading; per-row status Badge (Done / Failed / Canceled / running spinner); failed rows show the error string.

| Element | Does | Gate | ⚠ |
|---|---|---|---|
| link 'Download' per completed row | GET /api/contacts/transfers/{id}/download | completed + has artifact |  |
| link errors download per row | GET /api/contacts/transfers/{id}/errors | rows with failed records |  |
| sheet close | Closes the history sheet | none |  |

### /contacts — sub-sidebar (segments; rendered by contacts/layout.tsx)
- **Roles:** Anyone who can open /contacts.
- **States:** Segment counts soft-fail (GET /api/contacts/segment-counts) — on failure the whole Channels group simply doesn't render; stage/segment groups omitted when empty.

| Element | Does | Gate | ⚠ |
|---|---|---|---|
| 'All contacts' (+ count badge) | → /contacts (the phone directory) | none |  |
| Channels group: one item per LIVE_CHANNEL with >0 contacts (+ count) | → /contacts?channel={ch}&reach=any (lifts the phone gate) | only channels the workspace actually has contacts on |  |
| Lifecycle group: one item per ContactStage | → /contacts?stage={id} | hidden with no stages |  |
| Segments group: one item per audience group (+ memberCount) | → /broadcasts/groups/{id} | hidden with no audience groups |  |

### /tickets (board)
- **Roles:** Any workspace member. 'Ticket settings' in the sub-sidebar is admin-only (every /api/workspace/tickets route is @RequireRole('admin')). URL views: ?view=mine|unassigned|unread|shared|breached, ?status=<TicketStatus>, ?viewId=<savedViewId>.
- **States:** Full-pane spinner on first load; EmptyBoard when nothing matches; per-card busy spinner; 409 → toast 'Someone else just changed this ticket — refreshing' + reload; live via ticket:changed / ticket:thread:message / ticket:thread:read + reconnect re-seed; board-wide 'Load more' with '{n} loaded — more match this filter'.

| Element | Does | Gate | ⚠ |
|---|---|---|---|
| search input type=search, aria-label 'Search tickets', placeholder 'Search #number, subject, cause, customer or comments…' | Debounced query → GET /api/tickets?…&query= | none |  |
| button 'Clear' (next to search) | Clears the query | only with an active debounced search |  |
| button 'Save as view' | window.prompt for a name + window.confirm shared/personal → POST /api/tickets/views { name, visibility, filters }; 409 toast on duplicate name; page reloads so the sidebar picks it up | hidden while a saved view is open (?viewId) and hidden unless priority/team/assignee/breached/shared/search is active; the 'replied to you' narrow is deliberately NOT saveable |  |
| checkbox aria-label 'Select ticket #{number}' (per card) | Adds the ticket to the bulk selection | disabled while that card is busy |  |
| select aria-label 'Set status for selected tickets' | Sequential PATCH /api/tickets/{id} { status, expectedVersion } per selected id | bulk bar only appears with ≥1 selected |  |
| select aria-label 'Set priority for selected tickets' | PATCH { priority, expectedVersion } per id | selection required |  |
| select aria-label 'Assign selected tickets' (Unassigned + roster) | PATCH { assignedUserId } | selection required |  |
| select aria-label 'Hand selected tickets to a team' (No team + policies) | PATCH { assignedTeamId } | selection required AND the workspace has AssignmentPolicy teams |  |
| button 'Clear selection' (bulk bar) | Empties the selection | selection required |  |
| priority FilterChips 'low' 'normal' 'high' 'urgent' (aria-pressed) | Toggles the priority filter (client state, re-queries) | none |  |
| team FilterChips (one per policy) + 'No team' | Toggles teamFilter | rendered only when the workspace has teams |  |
| ticket card title link | → /tickets/{id} | none |  |
| card quick-transition buttons ('Open'/'Pending'/'Solved'/'Reopen'/'Closed' — from nextSteps(status)) | PATCH /api/tickets/{id} { status, expectedVersion } | hidden while the card is busy; 'Reopen' is the ONLY reopen path (nothing auto-reopens) |  |
| card drag handle (whole card is draggable, MIME application/x-ccp-ticket) | Drop on a column → same version-pinned PATCH { status } | draggable only when not busy |  |
| button 'Load more' (under the board) | Keyset page via GET /api/tickets?cursor={activityAt,id} | only when nextCursor is non-null |  |

### /tickets — sub-sidebar (views)
- **Roles:** Any workspace member; the 'Ticket settings' entry is admin-only.
- **States:** Badges from GET /api/tickets/counts, refreshed (400ms coalesced) on ticket:changed / ticket:thread:read / connect and on ticket:thread:message only when notifiedUserIds includes the viewer; a failed counts fetch silently keeps the last badges.

| Element | Does | Gate | ⚠ |
|---|---|---|---|
| 'All open' (+ totalActive) | → /tickets | none |  |
| 'Assigned to me' (+ mineActive) | → /tickets?view=mine | none |  |
| 'Unassigned' | → /tickets?view=unassigned | none |  |
| 'Replied to you' (+ unreadReplies) | → /tickets?view=unread | rendered only when counts.unreadReplies > 0 (per-user) |  |
| 'Shared with us' (+ sharedWithUs) | → /tickets?view=shared | rendered only when the workspace holds a TicketShare as guest |  |
| Saved views (one item per view, Filter icon) | → /tickets?viewId={id} (GET /api/tickets/views on mount) | rendered only when views exist |  |
| 'Past due' (+ breached, red badge) | → /tickets?view=breached | none |  |
| Status section: New / Open / Pending / On hold / Solved / Closed (+ byStatus counts) | → /tickets?status={s} | none |  |
| 'Ticket settings' | → /settings/tickets | workspace role admin only |  |

### /tickets/[id] (detail: thread, fields, handoff, escalation, files, tags, notes, history)
- **Roles:** Any member of the OWNING workspace, or of a workspace holding a TicketShare (ticketAccessWhere). If unreachable here but reachable elsewhere in the org, the page renders TicketElsewhere with a switch button; otherwise notFound(). Delete needs role admin|manager AND NOT guest side.
- **States:** SSR-seeded then socket-patched; TicketElsewhere fallback; not-found page with 'All tickets' link; toasts on every failed mutation; PATCH is version-pinned (409 = someone else changed it); thread rows show optimistic + 'Retry'; notes capped at TICKET_NOTES_CAP with an italic notice; history capped at TICKET_EVENTS_CAP with the same notice.

| Element | Does | Gate | ⚠ |
|---|---|---|---|
| link 'All tickets' | → /tickets | none |  |
| button 'Delete' (Trash icon, header right) | Confirm 'Delete ticket #N?' → DELETE /api/tickets/{id} → router.replace /tickets | role admin\|manager AND ticket.sharing?.role !== 'guest' (owner-only by design) | **DESTRUCTIVE** |
| subject Input (form, submit on Enter, placeholder "{contact}'s request", maxLength 200) | PATCH /api/tickets/{id} { subject } | none |  |
| link 'Open the conversation' | → /inbox?c={conversationId} | only when the ticket has a bound conversation (an escalated-in ticket has none until 'Message the customer') |  |
| textarea id 'ticket-cause' (placeholder 'Why does this need work?…', saves on blur, maxLength 5000) | PATCH { description } | WRITE-ONCE — replaced by read-only text once set (cause_immutable) |  |
| thread composer textarea aria-label 'Reply on this ticket' (Enter sends, Shift+Enter newline, maxLength 5000) | POST /api/tickets/{id}/thread (multipart body + files) | disabled while busy |  |
| composer 'Attach' file label (multiple, max 5 files) | Queues files onto the next thread message | disabled while busy or at 5 files |  |
| composer queued-file × aria-label 'Remove {filename}' | Drops the file from the queue | none |  |
| composer 'Send' button | Posts the thread message (clears the box before the await) | disabled with empty body and no files, or while busy |  |
| thread row 'Retry' button | Re-posts that failed message with its clientTempId | only on rows that failed to send |  |
| select 'Status' (all TICKET_STATUSES) | PATCH { status, expectedVersion } | disabled while busy |  |
| select 'Priority' | PATCH { priority } | disabled while busy |  |
| select assignee (label is 'Assignee' / your side's label; Unassigned + roster) | PATCH { assignedUserId } — on a guest side this writes TicketShare.assignedUserId | disabled while busy |  |
| select aria-label 'Team to hand this ticket to' + textarea aria-label 'Reason for the handoff' + button 'Hand over' | PATCH { assignedTeamId, handoffReason } | OWNER side only (guests get teams_owner_only); hidden entirely when the workspace has no teams (copy points at Settings → Teams & routing); 'Hand over' disabled with no team chosen |  |
| button 'Take out of the queue' | PATCH { assignedTeamId: null } | only when the ticket currently has a team |  |
| link 'Remove access' (per guest workspace row) | Confirm → DELETE /api/tickets/{id}/shares/{guestWorkspaceId} | owner may remove anyone; a guest may remove only itself | **DESTRUCTIVE** |
| button 'Message the customer' | POST /api/tickets/{id}/escalation/message-customer → router.push /inbox?c={conversationId} | guest side, no conversation yet, and the contact snapshot carries a phone number |  |
| details 'Bring in another workspace' → select aria-label 'Workspace to bring in' + textarea aria-label 'Why this workspace is being brought in' + button 'Give them access' | POST /api/tickets/{id}/escalate { workspaceId, cause } | shared tickets only; the list excludes the owner and existing guests; button disabled without a target AND a non-empty cause |  |
| select aria-label 'Workspace to escalate this ticket to' + textarea aria-label 'Reason for the escalation' + button 'Escalate' | POST /api/tickets/{id}/escalate | unshared tickets only, and only when listEscalationTargets() returned sibling workspaces; cause required |  |
| Files section rows — thumbnail link, filename link, 'Download' link | Opens attachment.url / attachment.url?download=1 | read-only gallery (no uploader here — files ride thread messages) |  |
| attachment × aria-label 'Remove {filename}' | DELETE /api/tickets/{id}/attachments/{attachmentId} then reload | the API still refuses another workspace's upload | **DESTRUCTIVE** |
| tag toggle buttons (one per workspace tag) | PATCH { tagIds: [...] } (replaces the whole set) | OWNER side only — a guest sees read-only chips |  |
| textarea aria-label 'Internal note' + button 'Add note' | POST /api/tickets/{id}/notes { body } — private to this workspace | 'Add note' disabled on empty body or while busy |  |
| details 'History' (collapsed by default) | Reveals the TicketEvent audit log | none |  |

### /tickets/[id] — ticket-elsewhere fallback
- **Roles:** Anyone who lands on a ticket id owned by a sibling workspace they can reach.
- **States:** Renders instead of a 404; button shows a spinner while switching.

| Element | Does | Gate | ⚠ |
|---|---|---|---|
| button 'Switch to {workspace} and open it' | POST /api/workspaces/active then opens the ticket in that workspace | disabled while busy |  |

### /broadcasts (list; ?channel=whatsapp|messenger|instagram)
- **Roles:** Any member EXCEPT a restricted viewer (agent + agentConversationVisibility='assigned') — the page redirects them to /inbox and the rail entry is hidden. Create/duplicate/retry/delete additionally need permission broadcasts:manage.
- **States:** SSR-seeded page 1 (25/page) from cookies (status/search/view); genuine empty state 'No broadcasts yet' (with CTA) vs in-browser 'No broadcasts match this filter.'; refetch dims the table; socket-driven live status; reconnect refetch (jittered).

| Element | Does | Gate | ⚠ |
|---|---|---|---|
| button 'New broadcast' (header) | → /broadcasts/new | permission broadcasts:manage |  |
| status filter chips: All / Scheduled / Preparing / Queued / In progress / Paused / Completed / Failed / Canceled | GET /api/broadcasts?status=… (persisted in the broadcasts-status cookie) | none |  |
| search input aria-label 'Search broadcasts by name or template' | GET /api/broadcasts?search= (persisted in broadcasts-search cookie) | none |  |
| view toggle aria-label 'Table view' / aria-label 'Calendar view' | Switches list vs month calendar (persisted in broadcasts-view cookie) | none |  |
| calendar aria-label 'Previous month' / 'Today' / aria-label 'Next month' | Moves the month grid; day cells link to /broadcasts/{id} | calendar view only |  |
| broadcast title link (row/card/calendar chip) | → /broadcasts/{id} | none |  |
| icon link aria-label 'Duplicate broadcast' (title 'Duplicate') | → /broadcasts/new?from={id} | permission broadcasts:manage |  |
| icon button aria-label 'Retry N failed recipient(s)' | POST /api/broadcasts/{id}/retry | broadcasts:manage AND failedCount>0 AND status ∈ completed\|failed\|canceled |  |
| icon button aria-label 'Delete broadcast' | Confirm → DELETE /api/broadcasts/{id}; row removed + soft refresh | broadcasts:manage; DISABLED (title 'Wait for the broadcast to finish') while status is running or queued | **DESTRUCTIVE** |
| Pagination (25/page) | GET /api/broadcasts?page=N | none |  |

### /broadcasts/new (composer; ?contactIds= ?tagIds= ?groupId= ?from= ?channel=)
- **Roles:** permission broadcasts:manage (otherwise redirect → /broadcasts). Additionally redirects to /settings/{channel}?from=broadcasts when the requested channel has no active account.
- **States:** Step cards show a done check + summary; sticky footer shows either 'Ready to send to N recipients' or the next gate hint; role=alert send error; eligibility warning (over-tier = error, RED quality = advisory); missing-variable pre-send warning (advisory, Send stays enabled); template list can fail soft with a Refresh button.

| Element | Does | Gate | ⚠ |
|---|---|---|---|
| Step 1 channel buttons (WhatsApp / Messenger / Instagram) | Sets the campaign channel; resets template + account choices | rendered only when >1 channel is connected |  |
| Step 1 select 'Send from' (accounts; plus 'All accounts — reach everyone') | Binds channelConnectionId; clears the selected template | rendered only with >1 account on the channel; the 'All accounts' fan-out option only on account-scoped identities (Messenger/Instagram), never WhatsApp |  |
| Step 1 checkbox 'Also include contacts from your other {channel} accounts' | includeOtherAccounts on the audience count + send | WhatsApp-style global identity only (hidden for Messenger/Instagram); needs >1 account |  |
| Step 2 audience mode buttons 'Everyone' / 'Saved group' / 'Custom' | Switches AudiencePicker mode | none |  |
| Step 2 saved-group rows | Selects/deselects the audience group (toggle) | 'Saved group' mode; empty state links to /broadcasts/groups |  |
| Step 2 link 'Manage groups →' | → /broadcasts/groups | none |  |
| Step 2 (Custom) tag control 'Search & add tags' | tagIds on the audience | hidden when the workspace has no tags |  |
| Step 2 (Custom) ContactMultiSelectField → contact-select dialog (search, filters, 'Select all visible', 'Clear all', 'Cancel', confirm button) | Hand-picked contactIds | confirm disabled at 0 selected (title 'Tick at least one contact first') |  |
| Step 2 (Custom) 'By field value' option chips (aria-pressed) | fieldFilters — narrows the whole audience | only for select-type contact fields |  |
| Step 2 'Preview' button + 'Preview recipients' button (footer) | Opens RecipientsPreviewDialog → POST /api/contacts/preview | only when the resolved count > 0 |  |
| Step 2 link 'Save this audience as a reusable group' → name Input aria-label 'Group name' + 'Save' + 'Cancel' | POST /api/workspace/audience-groups | custom mode |  |
| Step 3 (free-form) message Textarea, placeholder 'Type your message… (sent only to contacts inside their window)' | bodyText; char/byte counter enforces the channel cap | Messenger/Instagram only (WhatsApp forces template mode) |  |
| Step 3 (template) search input aria-label 'Search templates' + 'Refresh' button + label filter chips + template cards | Refresh = POST /api/workspace/whatsapp/templates (sync); card click selects the template | WhatsApp; empty state links to /settings/whatsapp |  |
| Step 4 header media field (file picker + 'Remove media') | POST /api/messages/template-header-media | only for IMAGE/VIDEO/DOCUMENT header templates |  |
| Step 4 carousel card fields (per-card media upload + body/button values) | Card values on the send; card COUNT is frozen at approval | carousel templates only |  |
| Step 4 map header PinFields: Latitude / Longitude / Place name / Address | Location header parameters | LOCATION-header templates only |  |
| Step 4 input id 'broadcast-lto-expiry' type=datetime-local | Limited-time-offer expiry; error 'Pick a time in the future…' when past | limited-time-offer templates only |  |
| Step 4 button-value inputs id 'broadcast-btn-{index}:{subType}' (coupon code ≤15/20 chars, URL suffix) | Campaign-level button parameters | templates with COPY_CODE / dynamic-URL buttons |  |
| Step 4 VarFields 'Header {{…}}' / 'Body {{n\|name}}' | Literal text or $var.contact.field tokens resolved per recipient | only when the template has variables |  |
| Assignment block: mode Select (No one / One person / Split by exact counts / Split by percentage / Use an assignment policy), teammate Select, policy Select, split rows (member Select + number Input + 'Remove'), '+ Add m | assignment payload on POST /api/broadcasts | the whole block renders only when teamMembers.length > 1 |  |
| input 'Broadcast name (optional)' (max 120) | name on create | none |  |
| input 'Campaign (optional)' with datalist 'known-campaigns' (GET /api/reports/campaigns) | campaignName — the rollup join key | none |  |
| toggle 'Send now' / 'Schedule' + input type=datetime-local (min = now) | scheduledAt on create | the datetime input only in 'later' mode; a past time is refused at submit |  |
| button 'Send broadcast' / 'Schedule broadcast' | POST /api/broadcasts | disabled until every step gate passes (channel + audience + message/template + variables) or while sending |  |

### /broadcasts/[id] (detail + report + recipients)
- **Roles:** Any member except a restricted viewer (redirect → /inbox). notFound() for an unknown id.
- **States:** Live via broadcast:status socket echo; retry/cancel show inline errors and toasts; recipients table empty copy per filter; 'Load more' with error line; Meta analytics panel says 'Nothing fetched yet' until Fetch.

| Element | Does | Gate | ⚠ |
|---|---|---|---|
| link 'Back to broadcasts' | → /broadcasts?channel={channel} (legacy customer-mode rows → /broadcasts) | none |  |
| chip link 'Campaign: {name}' | → /reports/campaigns/{name} | only when the broadcast carries a campaignName |  |
| button 'Stop broadcast' | Confirm 'Stop this broadcast?' → POST /api/broadcasts/{id}/cancel | status ∈ scheduled\|materializing\|queued\|running\|paused | **DESTRUCTIVE** |
| button 'Retry {n} failed' | POST /api/broadcasts/{id}/retry | genuineFailedCount>0 AND status ∈ completed\|failed\|canceled |  |
| funnel / summary tiles + error-code rows in BroadcastReport (clickable) | Sets the recipients filter (outcome=replied / clicked / never_received / errorCode=…) | report data present |  |
| recipient outcome tabs (All / Sent / Delivered / Read / Replied / Clicked / Failed … with counts) | GET /api/broadcasts/{id}/recipients?outcome=… | none |  |
| chip 'Error: {code} ×' (title 'Clear this error filter') | Resets to the 'all' filter | only while an errorCode filter is applied |  |
| link 'Export CSV' (download) | GET the recipients export for the CURRENT filter | none |  |
| recipient row link 'Open chat' | → /inbox/{conversationId} | only when the recipient has a conversation |  |
| button 'Load more' (recipients) | Cursor page of GET /api/broadcasts/{id}/recipients | only with a next cursor |  |
| Meta analytics panel button 'Fetch' | Pulls the campaign's figures from Meta (template_analytics on the sending WABA) | WhatsApp template campaigns; disabled while pending |  |
| Meta analytics dismissible hint (button, 'Tap to dismiss') | Hides the template-scope caveat | until dismissed |  |
| Template insights range chips '7d/30d/90d' (aria-pressed) + 'Fetch' | Re-fetches the template's insight window | hidden with 'Meta hasn't approved this template yet…' for unapproved templates |  |

### /broadcasts/groups (audience groups list)
- **Roles:** Any member except a restricted viewer (redirect → /inbox). 'New group' needs permission audienceGroups:manage.
- **States:** Empty state 'No groups yet' (+ CTA when canManage); table scrolls sideways on phones.

| Element | Does | Gate | ⚠ |
|---|---|---|---|
| button 'New group' (header) / 'Create your first group' (empty state) | → /broadcasts/groups/new | permission audienceGroups:manage |  |
| group row (whole <tr> clickable) / group name link | → /broadcasts/groups/{id} | none |  |

### /broadcasts/groups/new and /broadcasts/groups/[id] (GroupForm)
- **Roles:** permission audienceGroups:manage (otherwise redirect → /broadcasts/groups). Edit page notFound()s an unknown id.
- **States:** Inline error box (uses the API's own sentence); sticky footer; dirty-state confirm before leaving to the composer; toasts on save/delete.

| Element | Does | Gate | ⚠ |
|---|---|---|---|
| link 'Back to groups' / 'Cancel' | → /broadcasts/groups | none |  |
| input Name (required, max 80, autofocus) | name on POST/PATCH /api/workspace/audience-groups | Save disabled while blank |  |
| textarea Description (max 500) | description | none |  |
| AudienceBuilder 'By tag (dynamic)' tag control | tagIds (union membership) | empty hint when the workspace has no tags |  |
| AudienceBuilder 'Hand-picked contacts' → contact select dialog | contactIds | none |  |
| AudienceBuilder 'By field value' chips (aria-pressed) | fieldFilters — AND-narrows the whole group | select-type contact fields only |  |
| button 'Preview' (resolved-count card) | RecipientsPreviewDialog → POST /api/contacts/preview | count > 0 |  |
| button 'Create group' / 'Save changes' | POST /api/workspace/audience-groups or PATCH /api/workspace/audience-groups/{id} | disabled while submitting or with an empty name |  |
| button 'Send broadcast' (shows '• unsaved' when dirty) | → /broadcasts/new?groupId={id}; when dirty, confirms 'Save & continue' first | edit mode only |  |
| button 'Delete group' | Confirm 'Delete group "{name}"?' → DELETE /api/workspace/audience-groups/{id} → /broadcasts/groups | edit mode only | **DESTRUCTIVE** |

### /templates (catalogue + detail drawer)
- **Roles:** Any workspace member can view. Create / delete / unpause / edit / labels / link-tracking need permission templates:manage. Sync + create also need a connected WhatsApp account with a WABA (connected && hasWabaId).
- **States:** Cookie-persisted status filter + search (SSR-seeded); banner when not connected / no WABA (links to /settings/whatsapp?expand=advanced); syncError / reloadError / deleteError / unpauseError boxes; empty state 'No templates yet' (+ CTA); status tabs hide zero-count buckets.

| Element | Does | Gate | ⚠ |
|---|---|---|---|
| search input, placeholder 'Search by name, body or language…' | Client filter over name/body/language/labels (cookie-persisted) | none |  |
| select aria-label "Which number's templates to show" | Scopes the catalogue to that account's WABA (accountId query on every templates call) | rendered only with >1 WhatsApp account |  |
| select aria-label 'Filter by label' (All labels + vocabulary) | Client label filter | hidden until some template carries a label |  |
| status tabs: All / Approved / Pending / Rejected / Paused / Disabled / Archived (with counts) | Client status filter (cookie-persisted) | a non-active tab with 0 items is not rendered |  |
| button 'Refresh from Meta' | POST /api/workspace/whatsapp/templates{?accountId} (authoritative sync for that WABA only) | disabled unless connected && hasWabaId |  |
| button 'Browse library' | → /templates/library{?accountId} | templates:manage && connected && hasWabaId |  |
| button 'Authentication' | → /templates/authentication{?accountId} | templates:manage && connected && hasWabaId |  |
| button 'New template' (disabled variant titled 'Connect WhatsApp first') | → /templates/new{?accountId} | templates:manage; rendered disabled when !connected \|\| !hasWabaId |  |
| template card (list row) | Opens the right-side detail drawer | none |  |
| drawer aria-label 'Close' (×) | Closes the drawer (backdrop click also closes) | none |  |
| drawer external link 'WhatsApp Manager' | Opens business.facebook.com WhatsApp Manager (unarchive path) | shown for archived templates (28-day deletion window) |  |
| drawer VariableBindingsEditor: per-slot label input (aria-label '{slot} label'), source chips (Manual / contact field / custom field), default input '(optional)', 'Save' button | PATCH /api/workspace/whatsapp/templates/{id} { variableBindings } | only for templates with variables |  |
| drawer label chips × aria-label 'Remove label {label}' + input aria-label 'Add a label' (datalist typeahead, Enter adds) + button 'Add' | PATCH /api/workspace/whatsapp/templates/{id} { labels } (max 20, 40 chars, case-insensitive dedupe) | editing only with templates:manage (read-only chips otherwise) |  |
| drawer Switch aria-label 'Button-click tracking' | POST /api/workspace/whatsapp/templates/{id}/link-tracking { enabled } | disabled without templates:manage or while saving |  |
| drawer button 'Reload' | GET /api/workspace/whatsapp/templates{?accountId} | disabled while reloading |  |
| drawer button 'Unpause' | POST /api/workspace/whatsapp/templates/{id}/unpause | templates:manage AND status === 'paused' |  |
| drawer button 'Delete' (destructive) | Confirm (warns that an APPROVED name is locked by Meta for 30 days) → DELETE /api/workspace/whatsapp/templates/{id} | permission templates:manage | **DESTRUCTIVE** |
| drawer button 'Edit' | → /templates/{id}/edit{?accountId} | templates:manage AND status ∈ approved\|rejected\|paused (the only states Meta accepts an edit from) |  |

### /templates/new and /templates/[id]/edit (TemplateForm)
- **Roles:** permission templates:manage (else redirect → /templates); redirects to /settings/whatsapp?from=templates (and &missing=waba) when not connected / no WABA. Edit additionally notFound()s an unknown id and redirects when status is not approved|rejected|paused.
- **States:** Numbered Section cards with done ticks; per-section validation issues in destructive text; submitError box; live preview bubble on the right; submit label flips to 'Save and resubmit' in edit mode.

| Element | Does | Gate | ⚠ |
|---|---|---|---|
| input 'Name' (placeholder 'order_confirmation', lowercased) | name on POST /api/workspace/whatsapp/templates/create | DISABLED when editing (Meta has no name field on the edit endpoint) |  |
| select 'Language' | language on create | DISABLED when editing |  |
| category pills 'marketing' / 'utility' (+ authentication path elsewhere) | category | locked (categoryLocked) on an APPROVED template — the value is then not even sent |  |
| input 'Time-to-live (optional)' | messageSendTtlSeconds (per-category min/max from TEMPLATE_TTL_RULES) | omitted when blank so Meta's default applies |  |
| header kind pills: none / TEXT / IMAGE / VIDEO / DOCUMENT / LOCATION | Header component kind | none |  |
| input 'Header text' (placeholder 'Order #{{1}} update') | Header TEXT body | TEXT header only |  |
| variable-format toggle 'positional' / 'named' | parameterFormat (the single authority — never re-derived from a regex) | none |  |
| button 'Insert variable' + body Textarea + example inputs | Body component + example values | none |  |
| input footer (placeholder 'Reply STOP to opt out') | Footer component | none |  |
| checkbox 'Limited-time offer' + input (placeholder 'Expiring offer!') | limited_time_offer component | marketing templates only |  |
| ButtonsEditor: kind pills (QUICK_REPLY / URL / PHONE_NUMBER / COPY_CODE), text/url/phone/example inputs, aria-label 'Remove button', '+ Quick reply' / '+ URL' / '+ Phone' / '+ Copy code' | Buttons component array | warns past TEMPLATE_LIMITS.buttonsBeforeSeeAllOptions |  |
| CarouselEditor: 'IMAGE'/'VIDEO' header pills, 'body' toggle, per-card file picker, card body input, per-card button rows, aria-label 'Remove card {n}', aria-label 'Remove button {n}', 'Add card' | Carousel cards (uploads via /api/workspace/whatsapp/templates/upload-media) | marketing templates only; card COUNT + each card's component signature are frozen at approval |  |
| VariableBindingsEditor (labels, sources, defaults) | variableBindings on create | only when the template has body/header variables |  |
| button 'Cancel' | → /templates | none |  |
| button 'Submit for review' / 'Save and resubmit' | POST /api/workspace/whatsapp/templates/create{?accountId} or POST /api/workspace/whatsapp/templates/{id}/edit → router.push /templates | disabled until the form validates or while submitting; on edit a Library template's components are NOT sent (Meta owns the copy) |  |

### /templates/library (Meta Template Library + instantiate dialog)
- **Roles:** permission templates:manage; redirects to /settings/whatsapp when not connected or no WABA.
- **States:** Debounced (350ms) search; 'Loading Meta's library…' spinner; 'No library templates match those filters.'; destructive error box; instantiate dialog has its own error box.

| Element | Does | Gate | ⚠ |
|---|---|---|---|
| link 'Back to templates' | → /templates | none |  |
| search input (placeholder 'payments, delivery, refund…') | GET /api/workspace/whatsapp/templates/library?search=… | none |  |
| selects 'Topic' / 'Use case' / 'Industry' (each with 'Any') and 'Language' | Library query filters (re-run immediately) | none |  |
| library card button (name / body preview; 'Form' badge for FLOW buttons) | Opens the Instantiate dialog | none |  |
| dialog input 'Your name for it' (lowercased, placeholder 'order_delivery_update') | The new template's name | must be lowercase letters/digits/underscores |  |
| dialog per-button inputs ('Phone number for "…"' / 'URL for "…"') + example-suffix input | Button values for the instantiation | only for buttons Meta requires values for; the suffix input appears when the URL contains {{n}} |  |
| dialog button 'Cancel' (and backdrop click) | Closes without creating | none |  |
| dialog button 'Create template' | POST /api/workspace/whatsapp/templates/library/create{?accountId} → /templates (unchanged blueprints are approved immediately) | disabled until the name is valid and every required button value is filled |  |

### /templates/authentication (AuthTemplateForm)
- **Roles:** permission templates:manage; redirects to /settings/whatsapp when not connected or no WABA.
- **States:** Live preview from GET /api/workspace/whatsapp/templates/auth/preview; inline validation ('Must be between 1 and 90.', TTL error); destructive error box; submit label counts the languages.

| Element | Does | Gate | ⚠ |
|---|---|---|---|
| link 'Back to templates' / button 'Cancel' | → /templates | none |  |
| input 'Name' (lowercased, placeholder 'verification_code') | Template name (one template per selected language, same name) | lowercase/digits/underscores |  |
| language checkbox grid (one per TEMPLATE_LANGUAGES entry) | Creates one template per checked language | at least one required |  |
| checkbox 'Add the security line' | addSecurityRecommendation | none |  |
| input 'Code expiry in minutes (1–90, optional)' | codeExpirationMinutes | 1–90 or blank |  |
| input 'Delivery time-to-live in seconds (30–900, optional)' | messageSendTtlSeconds | 30–900 or blank |  |
| OTP type radios (name='otpType'): COPY_CODE / ONE_TAP / ZERO_TAP | otpType on upsert | none |  |
| app rows: package-name input (placeholder 'com.example.myapp'), signing-hash input (placeholder 'Signing key hash (11 characters)'), aria-label 'Remove app', button 'Add app' | supportedApps for the OTP button | required for ONE_TAP and ZERO_TAP only |  |
| checkbox 'Zero-tap terms' | zeroTapTermsAccepted (Meta refuses zero-tap creation without it) | ZERO_TAP only; blocks submit until ticked |  |
| button 'Create N template(s)' | POST /api/workspace/whatsapp/templates/auth/upsert{?accountId} | disabled until name + ≥1 language + (zero-tap terms if applicable) + valid expiry/TTL |  |

### /flags (triage queue; ?status=resolved, ?definitionId=, ?assignee=me)
- **Roles:** Any workspace member — raising and resolving flags is deliberately ungated. Only the sidebar's 'Flag types' link leads to an admin/permission-gated surface (messageFlags:manage governs the catalog).
- **States:** Spinner while loading; three empty states — 'No message flags configured yet' (no definitions), 'Nothing needs follow-up' / 'Nothing matches this filter' (open tab), 'Nothing has been handled yet.' (resolved tab); live-patched by the message:flag socket frame; toast on a failed PATCH; error.tsx segment boundary.

| Element | Does | Gate | ⚠ |
|---|---|---|---|
| search input type=search, aria-label 'Search flagged messages', placeholder 'Search the message, the contact, or a flag note…' | Debounced (250ms) GET /api/message-flags?q=… (stays local — no history entry per keystroke) | none |  |
| row body button (title 'Open this message in the inbox') | router.push /inbox?c={conversationId}&m={messageId}&n={nonce} — anchors on the exact flagged message | none |  |
| icon button aria-label 'Open in inbox' | Same deep-link jump | revealed on hover / always on touch |  |
| icon button aria-label 'Mark resolved' | PATCH /api/message-flags/{id} { status: 'resolved' } | open flags only |  |
| icon button aria-label 'Dismiss' (title "Dismiss — this wasn't one") | PATCH /api/message-flags/{id} { status: 'dismissed' } | open flags only |  |
| icon button aria-label 'Reopen' | PATCH /api/message-flags/{id} { status: 'open' } | resolved/dismissed flags only |  |
| button 'Load more' | Keyset page of GET /api/message-flags?cursor= | only with a next cursor |  |
| sub-sidebar 'Open' / 'Assigned to me' / 'Handled' | → /flags, /flags?assignee=me, /flags?status=resolved (URL-owned view state; 'Handled' shows resolved+dismissed) | none |  |
| sub-sidebar 'All flags' + one item per MessageFlagDefinition | → /flags?definitionId={id} | none |  |
| sub-sidebar 'Flag types' (Configure section) | → /settings/message-flags | settings surface is gated by messageFlags:manage |  |

## Slice: Settings (21 routes) + /organization (+members, +workspaces) + /account (+notifications) — code-derived interactive-element inventory. Sources: apps/web/src/app/(app)/settings/**, apps/web/src/app/(app)/organization/**, apps/web/src/app/(app)/account/**, apps/web/src/features/settings/**, apps/web/src/features/organization/components/**, apps/web/src/features/channels/components/**, apps/web/src/components/layouts/{settings,organization,account}-sub-sidebar.tsx. Gate vocabulary: "admin" = workspace role admin (canManageUsers === role==="admin"); "capability" = admin-editable per-role capability from /api/workspace/permissions; "org owner/admin" = User.orgRole (isOrgManager: superAdmin || owner || admin). All settings pages sit inside SectionShell + a role-aware sub-sidebar; /settings/error.tsx, /account/error.tsx, /organization/error.tsx are SegmentError boundaries; only /settings/channels has a loading.tsx skeleton.

### /settings (landing + shared settings sub-sidebar, present on every /settings/* route)
- **Roles:** any signed-in member (agent/manager/admin). Card + sidebar contents differ by role/capability.
- **States:** No loading.tsx; force-dynamic RSC. error.tsx = SegmentError('Settings'). No empty state (cards always render at least People & teams). Groups with zero cards are filtered out.

| Element | Does | Gate | ⚠ |
|---|---|---|---|
| Appearance radiogroup — role=radiogroup aria-label='Color mode'; radios 'Light' / 'Dark' / 'System' | client only: next-themes setTheme(value); persists per device | none |  |
| Card link 'Organization' | navigate /organization | none |  |
| Card link 'Personal settings' | navigate /account | none |  |
| Card link 'Members' | navigate /settings/members | none (description text differs for admin) |  |
| Card link 'Role permissions' | navigate /settings/permissions | admin only |  |
| Card link 'Team activity' | navigate /reports/team | capability teamActivity:view |  |
| Card link 'Channels' | navigate /settings/channels | admin only |  |
| Card link 'Integrations' | navigate /settings/integrations | admin only |  |
| Card link 'Snippets' | navigate /settings/snippets | capability snippets:manage |  |
| Card link 'Tags' | navigate /settings/tags | capability tags:manage |  |
| Card link 'Stages' | navigate /settings/stages | capability stages:manage |  |
| Card link 'Contact fields' | navigate /settings/contact-fields | capability contactFields:manage |  |
| Card link 'Tickets' | navigate /settings/tickets | admin only (role, not capability) |  |
| Sub-sidebar item 'Members' | navigate /settings/members | none |  |
| Sub-sidebar item 'Role permissions' | navigate /settings/permissions | admin |  |
| Sub-sidebar item 'Teams & routing' | navigate /settings/assignment | admin |  |
| Sub-sidebar item 'Channels' | navigate /settings/channels (active also for /settings/meta\|whatsapp\|messenger\|instagram) | admin |  |
| Sub-sidebar item 'Integrations' | navigate /settings/integrations | admin |  |
| Sub-sidebar item 'AI Assistant' | navigate /settings/ai-assistant | capability aiAssistant:manage |  |
| Sub-sidebar item 'Snippets' | navigate /settings/snippets | capability snippets:manage |  |
| Sub-sidebar item 'Tags' | navigate /settings/tags | capability tags:manage |  |
| Sub-sidebar item 'Message flags' | navigate /settings/message-flags | capability messageFlags:manage |  |
| Sub-sidebar item 'Stages' | navigate /settings/stages | capability stages:manage |  |
| Sub-sidebar item 'Contact fields' | navigate /settings/contact-fields | capability contactFields:manage |  |
| Sub-sidebar item 'Ticket settings' | navigate /settings/tickets | admin |  |
| NOTE: /settings/webchatwidget has NO sidebar item | reachable only via the Channels catalog card 'Website chat' | admin |  |

### /settings/activity
- **Roles:** anyone; server redirect() to /reports/team (no permission check here — /reports/team gates on teamActivity:view)
- **States:** none (redirect-only page)

| Element | Does | Gate | ⚠ |
|---|---|---|---|
| (no UI) | server redirect → /reports/team | none |  |

### /settings/workspace
- **Roles:** anyone; server redirect() to /settings
- **States:** none

| Element | Does | Gate | ⚠ |
|---|---|---|---|
| (no UI) | server redirect → /settings | none |  |

### /settings/team
- **Roles:** anyone; permanentRedirect() to /settings/members
- **States:** none

| Element | Does | Gate | ⚠ |
|---|---|---|---|
| (no UI) | 308 permanent redirect → /settings/members | none |  |

### /settings/members
- **Roles:** any signed-in member. Non-admins get a read-only roster ('Read-only view. Only admins can invite users or change roles.'). No redirect.
- **States:** No loading.tsx. Page-level error banner role='alert' (red) from every failed mutation. Pending-invites card is collapsed when 0 invites. Full-screen role='status' aria-live overlay 'Deleting {org}…' during org delete. Presence dots depend on socket.

| Element | Does | Gate | ⚠ |
|---|---|---|---|
| Input aria-label='Workspace name' + Button 'Save' (submit, in 'Workspace name' card) | PATCH /api/workspace {name} + optimistic local socket 'team:renamed'; rolls back on failure | admin (canManage). Disabled unless dirty. |  |
| Switch aria-label='Enable org working hours' | OFF→ PUT /api/workspace/work-hours {workHours:null} immediately; ON→ only reveals the grid (no save) | admin |  |
| Working-hours grid: Select aria-label='Schedule timezone' | local draft | admin; grid visible only when the switch is on |  |
| Button 'Copy Monday to Tue–Fri' | local draft copy | admin; disabled when Monday has no window |  |
| Switch aria-label='{Day} working' (7×) | local draft open/close a day | admin |  |
| Input aria-label='{Day} start' / '{Day} end' (time) | local draft | admin; only when day is on |  |
| Button 'Split shift' / button aria-label='Remove {Day} window {n}' | local draft add/remove window (cap MAX_WINDOWS_PER_DAY) | admin |  |
| Button 'Save working hours' | PUT /api/workspace/work-hours {workHours}; server re-resolves everyone's availability, then soft refresh | admin |  |
| Invite form: Input aria-label='Teammate email' (type=email, required) | form field | admin |  |
| Invite form: Select aria-label='Teammate role' | form field; options limited by assignableRoles(actor) | admin |  |
| Button 'Generate link' (type=submit) | POST /api/invites {email,role} → reveals Invite-ready card; errors surface seat cap / already_in_organization | admin |  |
| Invite-ready card: readonly Input (invite URL) + Button 'Copy' | clipboard write + toast | admin, after a successful invite |  |
| Invite-ready card: button 'Dismiss' | clears the card locally | same |  |
| Pending invites row: Button 'Revoke' (title='Revoke this invite link') | confirm dialog 'Revoke invite for {email}?' → DELETE /api/invites/{id} | admin; card only renders when ≥1 pending invite | **DESTRUCTIVE** |
| Member row: Select aria-label='Role for {name\|email}' | confirm 'Change {name}'s role to {role}?' → PATCH /api/users/{id} {role} | admin AND canModifyUser(actor,target) AND not self; otherwise a static role Badge |  |
| Member row: Button aria-label='Set {name}'s availability' (clock icon) | opens availability dropdown | capability availability:manageOthers AND target not deactivated |  |
| Dropdown item 'Available' / 'Busy' / 'Away' / 'Offline' (ALL_AVAILABILITY_STATUSES) | PATCH /api/users/{id}/availability {status} | same |  |
| Dropdown item 'Follow their schedule' | PATCH /api/users/{id}/availability {followSchedule:true} | same |  |
| Dropdown item 'Working hours…' | opens dialog ariaLabel='Working hours for {name}' | same |  |
| Member work-hours dialog: Select aria-label='Working hours mode' (inherit / custom / off) | local; loads GET /api/users/{id}/work-hours on open | same |  |
| Member work-hours dialog: WorkHoursEditor (same controls as org grid) | local draft | mode=custom |  |
| Member work-hours dialog: Button 'Save' / 'Cancel' | PUT /api/users/{id}/work-hours | same |  |
| Member row: Button aria-label='More actions for {name\|email}' (⋯) | opens overflow menu | rendered when manageAccount \|\| canDelete |  |
| Menu item 'Disable sign-in' / 'Re-enable account' | disable path confirms 'Disable {name}?' first → PATCH /api/users/{id} {deactivated}; re-enable is unconfirmed | canModifyUserAccount (org owner/admin or superAdmin); disabled for self | **DESTRUCTIVE** |
| Menu item 'Reset password' | opens ResetPasswordDialog targeting POST /api/users/{id}/reset-password | canModifyUserAccount AND not self | **DESTRUCTIVE** |
| Menu item 'Delete permanently' (text-destructive) | confirm 'Delete {name}?' → DELETE /api/users/{id} | canDeleteMember AND not self | **DESTRUCTIVE** |
| ResetPasswordDialog: Input id='{titleId}-pw' (label 'New password'), Enter submits | form field, min MIN_PASSWORD_LENGTH | dialog open |  |
| ResetPasswordDialog: eye toggle button (title 'Show'/'Hide', tabIndex -1) | reveal/hide password | same |  |
| ResetPasswordDialog: Button 'Generate' (title='Generate a strong password') | fills a generated password + reveals | same |  |
| ResetPasswordDialog: Button 'Set password' | POST {endpoint} {newPassword}; on success shows the reveal-once state (target signed out everywhere) | disabled until length ok | **DESTRUCTIVE** |
| ResetPasswordDialog: readonly Input aria-label='New password' + Button 'Copy' + Button 'Done' | clipboard / close | post-success state |  |
| Danger zone: Button 'Delete organization' | confirm with requireText = exact ORGANIZATION name (falls back to literal 'DELETE') → broadcastSignout() + closeClientSocket() then DELETE /api/workspace → hard nav /logout | admin AND orgRole==='owner' (canDeleteOrg). Hidden otherwise — the handler tears the socket down before the request. | **DESTRUCTIVE** |

### /settings/permissions
- **Roles:** admin only; non-admin server-redirects to /settings/members
- **States:** loading: 'Loading permissions…' spinner while GET runs. error: 'Couldn't load permissions. Refresh to retry.' Saving indicator in PageHeader action. No empty state (matrix is static).

| Element | Does | Gate | ⚠ |
|---|---|---|---|
| Switch aria-label='{CAPABILITY_LABEL} for Manager' / '… for Agent' — 20 capability rows × 2 editable roles = 40 switches | optimistic toggle then PATCH /api/workspace/permissions with the FULL {manager,agent} matrix; PATCHes are serialized on a promise chain; failure re-fetches and toasts 'Couldn't save — reverted' | admin (page-level) |  |
| Admin column cell — static span title='Admins always have full access' (shield icon, NOT interactive) | no action | n/a |  |
| Capability rows (ALL_CAPABILITIES order) | conversations:delete, contacts:delete, contacts:export, contacts:import, broadcasts:manage, templates:manage, audienceGroups:manage, stages:manage, contactFields:manage, tags:manage, messageFlags:manage, inboxViews:manag | n/a |  |

### /settings/assignment (Teams & routing)
- **Roles:** admin only; non-admin server-redirects to /settings/members
- **States:** loading: 'Loading…' spinner (single GET /api/workspace/assignment). error: 'Couldn't load assignment settings. Refresh to retry.' Rules tab empty state: 'No rules yet. Every conversation uses {default team}.' Every mutation re-fetches the whole overview.

| Element | Does | Gate | ⚠ |
|---|---|---|---|
| Tablist aria-label='Assignment settings sections' → role=tab 'Teams' / 'Routing rules' / 'When it runs' | client tab switch | none within page |  |
| Button 'New team' (PageHeader action) | POST /api/workspace/assignment/policies {name:'New team'} | only shown on the Teams tab |  |
| Policy card header button (chevron + policy name, aria-expanded) | expand/collapse the card | none |  |
| Policy card: Button title='Make this the fallback team' (star icon) | POST /api/workspace/assignment/policies/{id}/default | hidden on the current default policy |  |
| Policy card: Button title='Archive this team' (trash icon) | DELETE /api/workspace/assignment/policies/{id} | hidden on default policy; requires policyCount > 1 | **DESTRUCTIVE** |
| Field 'Name' Input (max 80) | local draft | card expanded |  |
| Select 'How to pick someone' (ASSIGNMENT_STRATEGIES: manual / round_robin / least_open / weighted / fixed) | local draft; drives which fields below render | card expanded |  |
| Select 'Assign everything to' (options: 'Choose a teammate…' + members) | local draft fixedUserId | strategy === fixed |  |
| Select 'Who is eligible' (ASSIGNMENT_ELIGIBILITIES) | local draft | strategy !== manual |  |
| Switch 'Send returning customers back to the same person' | local draft preferPreviousAgent | strategy not manual/fixed |  |
| Input 'Remember the relationship for' (number 1–365, suffix 'days') | local draft previousAgentWindowDays | preferPreviousAgent on and strategy not manual/fixed |  |
| Input 'Default limit per person' (number, placeholder 'No limit') | local draft defaultMaxOpen | strategy not manual/fixed (showCapacity) |  |
| Select 'When everyone is at their limit' (ASSIGNMENT_OVERFLOWS) | local draft overflow | showCapacity |  |
| Select 'Fallback person' | local draft fallbackUserId | overflow === fallback_user |  |
| Switch 'Only specific people' | local draft includeAllMembers = !v | showCapacity |  |
| Member table row: Input 'Share' (weight, number) | local draft per-member weight | strategy === weighted |  |
| Member table row: Input 'Limit' (number, placeholder '—') | local draft per-member maxOpen | showCapacity |  |
| Member table row: Switch (column 'In') | local draft per-member enabled | showCapacity |  |
| Button 'Save policy' | PUT /api/workspace/assignment/policies/{id} with expectedVersion; 409 → 'Someone else changed this team — reloading their version' | card expanded |  |
| Button 'Reset' | resets draft to server policy (client only) | card expanded |  |
| Preview box 'Try it' → Button 'Run' | POST /api/workspace/assignment/preview {source:'inbound',policyId} — read-only, does not advance the round-robin cursor | card expanded |  |
| Rules tab: Input (rule name, per rule, commits onBlur) | PATCH /api/workspace/assignment/rules/{id} {name} | admin |  |
| Rules tab: Switch (per rule, enabled) | PATCH /api/workspace/assignment/rules/{id} {enabled} | admin |  |
| Rules tab: Button title='Move up' / title='Move down' | reorder → PUT/PATCH rules order endpoint | disabled at first/last |  |
| Rules tab: Button title='Delete rule' (trash) | DELETE /api/workspace/assignment/rules/{id} — NO confirm dialog | admin | **DESTRUCTIVE** |
| Rules tab: multi-Select 'When the channel is' (LIVE_CHANNELS) | PATCH rule conditions.channels; nothing selected = any channel | admin |  |
| Rules tab: multi-Select 'When the account is' | PATCH rule conditions.channelAccountIds | rendered ONLY when some channel holds >1 account |  |
| Rules tab: Input 'When the message contains' (comma-separated, commits onBlur) | PATCH rule conditions.keywords | admin |  |
| Rules tab: Select 'Then route with' | PATCH rule {policyId} | admin |  |
| Rules tab: Button 'Add rule' | POST /api/workspace/assignment/rules | admin |  |
| Automation tab: Toggle 'Assign new conversations automatically' | PATCH /api/workspace/assignment/settings {autoAssignOnNewConversation} | admin |  |
| Automation tab: Toggle 'Let the AI handle it first' | PATCH … {skipWhenAiHandling} | shown only when autoAssignOnNewConversation is on |  |
| Automation tab: Toggle 'Assign when an unassigned conversation gets a new message' | PATCH … {autoAssignOnReopen} | admin |  |
| Automation tab: Select agent visibility ('Agents see every conversation' / 'Agents see only conversations assigned to them') | PATCH … {agentConversationVisibility} | admin |  |
| Automation tab: Select AI handoff team ('Use my routing rules (default)' + policies) | PATCH … {aiHandoffPolicyId} | admin |  |
| Automation tab: Toggle 'Reassign when an agent goes offline' | PATCH … {reassignOnOffline} | admin |  |
| Automation tab: Input 'Wait … minutes before moving anything' (number 1–1440, commits onBlur) | PATCH … {reassignOfflineAfterMinutes} | reassignOnOffline on |  |
| Automation tab: Toggle 'Only move conversations nobody has replied to yet' | PATCH … {reassignOfflineOnlyPending} | reassignOnOffline on |  |
| Automation tab: Toggle 'Reassign when a teammate is deactivated' | PATCH … {reassignOnDeactivate} | admin |  |

### /settings/channels (catalog)
- **Roles:** any signed-in member; NON-admins see every card as non-clickable (clickable = canManage && !comingSoon) and the Meta App + Website chat cards read status pill 'Admins only'.
- **States:** loading.tsx skeleton (header + 5 row shells, aria-busy). Each config read is wrapped in soft() so one unreachable channel degrades that card only. Status pills: Connected / Not connected / Admins only / Coming soon.

| Element | Does | Gate | ⚠ |
|---|---|---|---|
| Banner link 'Set up your Meta App first' → 'Set up →' | navigate /settings/meta | admin AND Meta app not configured |  |
| Card 'Meta App' (CTA 'Manage'/'Connect') | navigate /settings/meta | admin |  |
| Card 'WhatsApp' | navigate /settings/whatsapp | admin |  |
| Card 'Facebook Messenger' | navigate /settings/messenger | admin |  |
| Card 'Instagram' | navigate /settings/instagram | admin |  |
| Card 'Website chat' | navigate /settings/webchatwidget | admin |  |
| Cards 'Telegram' / 'Email' / 'SMS' (pill 'Coming soon') | no action — rendered as a dashed non-link div | always inert |  |

### /settings/meta (Meta App)
- **Roles:** any signed-in member (no redirect); non-admin sees an empty read-only status card only — webhook block, credentials form and accounts panel are all canManage-gated.
- **States:** No loading/skeleton. Credentials form shows 'Stored credentials could not be decrypted. Re-paste them from Meta.' when credentialsUndecryptable. Save toasts success + up to N warning toasts (12s) from debug_token advisories. Account lists degrade to [] via soft().

| Element | Does | Gate | ⚠ |
|---|---|---|---|
| Copy button aria-label='Copy Callback URL' / 'Callback URL copied' | clipboard write of {proto}://{host}/webhooks/meta/{workspaceId} | admin |  |
| Copy button aria-label='Copy Verify token' | clipboard write | admin |  |
| <details> summary 'Which webhook fields to subscribe' (field list) | expand/collapse static reference | admin |  |
| Input label='App secret' (secret, required) | form field | admin |  |
| Input label='System-user access token' (secret, required) | form field | admin |  |
| <details> summary 'How to generate this token (avoids the “error 200” trap)' | expand/collapse static instructions | admin |  |
| Input label='App ID (optional)' | form field | admin |  |
| Button 'Save' (type=submit) | POST /api/workspace/meta {appSecret,systemUserToken,appId} → toast 'Meta App saved · refreshed {channels}' + soft refresh | admin |  |
| MetaAppAccounts panel: link per account → 'Manage' (href /settings/{channel}) | navigate to that channel's settings | admin |  |
| MetaAppAccounts: link '/settings/channels' | navigate to the catalog | admin |  |

### /settings/whatsapp
- **Roles:** any signed-in member (no redirect). Non-admin gets a read-only summary from the members-open templates endpoint plus 'Only admins can change the WhatsApp connection.'; all forms, accounts panel and sub-panels are admin-gated.
- **States:** Two layouts: DISCONNECTED (status card + Step-1/Step-2 manual form + Embedded-Signup 'Coming soon' card) and CONNECTED (status card, accounts panel, per-account chips, health/profile/username/QR/calling panels, Update credentials / Disconnect). Warning banners: warnings[] from save (role='status'), 'Registration incomplete'/'Not registered' when registrationStatus !== CONNECTED, credentialsUndecry

| Element | Does | Gate | ⚠ |
|---|---|---|---|
| ChannelAccountsPanel: Button 'Add another number' | reveals + scrolls to #whatsapp-connect-form in add mode | admin, connected |  |
| Account row: name button (click to rename) → Input placeholder='e.g. Sales line' + Button sr-only 'Save name' | PATCH /api/workspace/channels/whatsapp/accounts/{id} {label} | admin |  |
| Account row: Button 'Make default' (star) | POST /api/workspace/channels/whatsapp/accounts/{id}/default | admin; hidden on the current default |  |
| Account row: Button sr-only 'Disconnect {name}' (trash, text-destructive) | fetches removal impact, then confirm 'Disconnect {name}?' naming conversation/open/scheduled-broadcast counts → DELETE /api/workspace/channels/whatsapp/accounts/{id} | admin | **DESTRUCTIVE** |
| Account scope chips (one per account, '{label} · default') | client: repoints health/profile/username/QR panels at that account | rendered only when accounts.length > 1 |  |
| Messaging health: Button 'Refresh' | POST /api/broadcasts/messaging-health/resync (per account) | admin |  |
| Messaging health: Button 'Try again' | re-runs GET /api/broadcasts/messaging-health | shown only in the load-failed state |  |
| Business profile: section header button (aria-expanded) | expand/collapse; loads GET /api/workspace/whatsapp/profile | connected |  |
| Business profile: Field 'About' / Textarea 'Description' / 'Address' / 'Email' / 'Website' / 'Second website (optional)' | local draft | inputs disabled when !canManage |  |
| Business profile: select id='wa-vertical' (label 'Industry') | local draft vertical | admin |  |
| Business profile: Button 'Save profile' / Button 'Cancel' | POST /api/workspace/whatsapp/profile | admin |  |
| Username panel: header button (aria-expanded) | expand/collapse; loads GET /api/workspace/whatsapp/username | connected |  |
| Username panel: Input id='wa-username' (placeholder 'my.business') | local draft; live rule feedback | disabled unless admin |  |
| Username panel: suggestion chips '@{suggestion}' | sets the draft | admin, when suggestions exist |  |
| Username panel: Button 'Set username' / 'Change username' | POST /api/workspace/whatsapp/username; on 409 username_transfer_required shows confirm 'Move this username here?' → re-POST with force_transfer (takes the handle off a sibling number) | admin; disabled unless dirty+valid | **DESTRUCTIVE** |
| Username panel: Button 'Remove' | confirm 'Remove this username?' → DELETE /api/workspace/whatsapp/username | admin; only when a username exists | **DESTRUCTIVE** |
| QR codes panel: header button (aria-expanded) | expand/collapse; loads GET /api/workspace/whatsapp/qr-codes | connected |  |
| QR codes: Input (prefilled message) + Button 'Create' | POST /api/workspace/whatsapp/qr-codes {prefilledMessage}; the returned image URL is shown ONCE | admin |  |
| QR codes: Button 'Copy' (per code) | clipboard write of deepLinkUrl + toast | any viewer of the panel |  |
| QR codes: link 'Save image' (download, target=_blank) | downloads the one-time QR PNG | only while qrImageUrl is in memory (create-call only) |  |
| QR codes: button aria-label='Delete QR code' | confirm 'Delete this QR code?' (printed codes stop working) → DELETE /api/workspace/whatsapp/qr-codes/{code} | admin | **DESTRUCTIVE** |
| Calling: ToggleRow aria-label='Calling enabled' | PATCH /api/calls/admin/settings {enabled} | admin AND connected |  |
| Calling: ToggleRow aria-label='Show the call button to customers' | PATCH … {callIconVisible} | disabled unless calling enabled |  |
| Calling: Input aria-label='Call button countries' + Button 'Save' | PATCH … {callIconCountries} | callIconVisible on; disabled unless calling enabled |  |
| Calling: ToggleRow aria-label='Allow callbacks automatically' | PATCH … {callbackPermissionEnabled} | disabled unless calling enabled |  |
| Calling hours: radio 'Any time' / radio 'Set hours' | local mode | disabled unless calling enabled |  |
| Calling hours: Select timezone; per-day checkbox; Input aria-label='{Day} opening time'/'{Day} closing time' | local draft | mode = Set hours |  |
| Calling hours: Button 'Save hours' | PATCH /api/calls/admin/settings {hours} | admin |  |
| Voicemail: Switch aria-label='Voicemail' | local; persisted by 'Save voicemail' | disabled unless calling enabled |  |
| Voicemail: Switch aria-label='Record when nobody answers in time' + Input aria-label='Seconds of ringing before voicemail' (0–30) | local TIMEOUT trigger | voicemail on |  |
| Voicemail: Switch aria-label='Record when an agent declines the call' | local REJECT trigger | voicemail on |  |
| Voicemail: file input aria-label='Upload voicemail announcement' (accept audio/ogg,.ogg,.opus) | POST multipart to /api/calls/admin/voicemail-announcement | voicemail on; disabled while uploading |  |
| Voicemail: Button 'Save voicemail' | PATCH /api/calls/admin/voicemail-policy | admin |  |
| Recording: Switch + Button 'Save recording' | PATCH /api/calls/admin/recording-policy | admin, calling enabled |  |
| Transcription: Switch + Button 'Save transcription' | PATCH /api/calls/admin/transcription-policy | admin, calling enabled |  |
| Call link box: readonly Input (https://wa.me/call/{digits}) + Button 'Copy' | clipboard write | rendered only when displayNumber is known |  |
| Button 'Update credentials' | reveals ManualForm in edit mode (prefilled from the default number) | admin, connected, form hidden |  |
| Button 'Disconnect' (Unplug icon) | fetchChannelRemovalImpact('whatsapp') then confirm naming number/conversation/broadcast counts → DELETE /api/workspace/whatsapp?confirmAll=1 (drops EVERY number on the channel) | admin, connected | **DESTRUCTIVE** |
| ManualForm #whatsapp-connect-form: Field 'Phone number ID' (required) | form field | admin |  |
| ManualForm: Field 'WhatsApp Business Account ID' (required, mono) | form field | admin |  |
| ManualForm: <details> 'Advanced (optional)' → 'Access token (override, optional)' / 'App secret (different Meta app, optional)' / 'App ID (different Meta app, optional)' | form fields; open by default when current.appId is set | admin |  |
| ManualForm: Button 'Validate & save' (type=submit) | POST /api/workspace/whatsapp (validates against Meta before storing; nothing stored if validation fails) | admin |  |
| ManualForm: Button 'Cancel' | hides the form / leaves add mode | admin, connected |  |
| Embedded-signup card: Button 'Coming soon' (disabled, title='Available once Meta approves the Tech Provider application') | nothing | always disabled |  |

### /settings/messenger
- **Roles:** any signed-in member (no redirect); non-admin sees only a connected/not-connected card (connectedness from the member-open account directory; Page id withheld).
- **States:** Status card flips to success styling when connected. Warning banners: needsReconnect ('Access token expired'), webhookRejection (bad_signature / no stored credentials), PageSubscriptionWarning, PageIntegrityWarning (renders nothing when healthy AND nothing when unreadable). Connect form collapsed once connected.

| Element | Does | Gate | ⚠ |
|---|---|---|---|
| ChannelAccountsPanel: Button 'Add another Page' | clears pageId, reveals + scrolls to #messenger-connect-form | admin |  |
| Account row rename / 'Make default' / sr-only 'Disconnect {name}' | PATCH\|POST default\|DELETE /api/workspace/channels/messenger/accounts/{id}; disconnect confirms with the impact counts first | admin | **DESTRUCTIVE** |
| Button 'Edit' / 'Cancel' | toggles the connect form (restores the default Page id) | admin AND connected |  |
| Button 'Disconnect' (text-destructive, Unplug) | impact fetch → confirm 'Disconnect Messenger?' → DELETE /api/workspace/messenger?confirmAll=1 (every Page) | admin AND connected | **DESTRUCTIVE** |
| Calling card: Button 'Enable calling' | POST /api/calls/admin/enable?channel=messenger | admin AND connected AND CHANNEL_CAPABILITIES.messenger.calling (currently OFF — card not rendered) |  |
| Welcome screen panel: Switch aria-label='Show the Get Started button' | local draft getStartedPayload | admin, connected, capability flag welcomeScreen |  |
| Welcome screen: Input aria-label='Get Started payload' | local draft | Get Started on |  |
| Welcome screen: Textarea aria-label='Greeting text' | local draft (empty clears it on Meta) | same |  |
| Welcome screen: Button 'Add' (commands, ≤MAX_COMMANDS) + Input aria-label='Command {n} name' / 'Command {n} description' + Button aria-label='Remove command {n}' | local draft | same |  |
| Welcome screen: Button 'Save to Messenger' | POST /api/workspace/messenger/welcome (emptying a field clears it on Meta) | same |  |
| Welcome screen: Button 'Try again' | re-runs GET /api/workspace/messenger/welcome | load-failed state only — the editor is deliberately NOT shown so an empty save can't erase live config |  |
| Entry points panel: Button 'Add' (ice breakers) + Input aria-label='Ice breaker {n} question' / '… payload' + Button aria-label='Remove ice breaker {n}' | local draft | admin, connected, capability flag entryPoints |  |
| Entry points: Button 'Button' / Button 'Link' (persistent menu) + Input aria-label='Menu item {n} label' / '… URL\|payload' + Button aria-label='Remove menu item {n}' | local draft | same; disabled at MAX_MENU_ITEMS |  |
| Entry points: Button 'Save to Messenger' | POST the profile endpoint; 'Removing every row clears that section' | same |  |
| Entry points: Button 'Try again' | re-read from Meta | load-failed state only |  |
| Connect form #messenger-connect-form: Field 'Page ID' (required) | form field | admin |  |
| Connect form: 'Page access token (optional)' / 'App secret (different Meta app, optional)' / 'App ID (different Meta app, optional)' | form fields | admin |  |
| Connect form: Button (type=submit) | POST /api/workspace/messenger | admin |  |
| Link '/settings/meta' inside the form hint | navigate to Meta App settings | admin |  |

### /settings/instagram
- **Roles:** any signed-in member (no redirect); non-admin sees connected/not-connected only (handle and ids withheld).
- **States:** Same warning family as Messenger: needsReconnect, webhookRejection, PageSubscriptionWarning. Inbox-sources panel renders nothing when availableInboxSources is empty. Inbox-source toggles are optimistic with rollback + toast.

| Element | Does | Gate | ⚠ |
|---|---|---|---|
| ChannelAccountsPanel: Button 'Add another account' + rename / 'Make default' / sr-only 'Disconnect {name}' | …/api/workspace/channels/instagram/accounts/{id} (PATCH / POST default / DELETE after an impact-quantified confirm) | admin | **DESTRUCTIVE** |
| Inbox sources: static row 'Direct messages — Always on' | no action (deliberately not a toggle) | n/a |  |
| Checkbox 'Comments on your posts' | POST /api/workspace/instagram/inbox-sources {sources:[…]} (full desired set, not a delta) | admin; only for sources present in availableInboxSources |  |
| EntryPointsPanel (ice breakers + persistent menu, same controls as Messenger) + Button 'Save to Instagram' | read/write the IG messaging profile | admin AND connected |  |
| Button 'Edit' / 'Cancel' | toggles the connect form | admin AND connected |  |
| Button 'Disconnect' | impact fetch → confirm 'Disconnect Instagram?' → DELETE /api/workspace/instagram?confirmAll=1 | admin AND connected | **DESTRUCTIVE** |
| Connect form: Field 'Facebook Page ID' (required) + 'Page access token (optional)' + 'App secret (different Meta app, optional)' + 'App ID (different Meta app, optional)' + submit Button | POST /api/workspace/instagram | admin |  |

### /settings/webchatwidget (Website chat)
- **Roles:** admin only in effect — non-admin renders just PageHeader 'Website chat / Admins only.' (no redirect; the widget GET is @RequireRole('admin') and is skipped for non-admins).
- **States:** Empty state: 'No widgets yet. Create one to get an embed snippet for your website.' Page-level red error strip + a duplicate error next to Save (the Install tab is long). Save button label cycles 'Save changes' → 'Saving…' → 'Saved ✓'. Widget tabs render only when >1 widget. Amber 'open to any site' chip on unlocked widgets.

| Element | Does | Gate | ⚠ |
|---|---|---|---|
| Button 'New widget' (PageHeader action) | POST /api/workspace/webchatwidget | admin |  |
| Widget chips (one per widget, shows name + conversationCount + 'off' + 'open to any site') | client-select the widget being edited | rendered only when widgets.length > 1 |  |
| Editor tab bar (role=tab): 'Content' / 'Appearance' / 'Behavior' / 'Install' | client tab switch; live preview stays visible | a widget is selected |  |
| Content: input 'Widget name' (max 80) | local draft | admin |  |
| Content: input 'Header title' / 'Header subtitle' / 'Welcome message' / 'Away message' | local draft config | admin |  |
| Content: textarea 'Suggested questions' (one per line, up to 6) | local draft suggestedQuestions | admin |  |
| Appearance: ColorField 'Primary' / 'Launcher' / 'Your bubble' (type=color) | local draft theme | admin |  |
| Appearance: select 'Font' (System/Rounded/Serif) and select 'Theme' (Light/Dark/Auto (system)) | local draft | admin |  |
| Appearance: ImageUpload 'Logo' (≤64KB) / 'Agent avatar' (≤40KB) — label 'Upload' + hidden file input + 'Remove' | downscales client-side to a data: URL stored in the widget config (no server upload) | admin |  |
| Behavior: select 'Deploy mode' (Floating bubble / Hidden (open from a link) / Inline (inside your page)) | local draft launcher; changes the install snippet, not the live widget | admin |  |
| Behavior: select 'Position' (Bottom right / Bottom left) | local draft | hidden when Deploy mode = inline |  |
| Behavior: input 'Bubble label' | local draft launcherLabel | hidden when inline |  |
| Behavior: Toggle 'Show chat header' | local draft showHeader | only when Deploy mode = inline |  |
| Behavior: pre-chat editor — input aria-label='Question', checkbox 'Required', button aria-label='Remove question', select aria-label='Where the answer is saved' (identity targets, built-in fields, custom fields, '+ New c | local draft preChatFields | admin; '+ New contact field…' option only when capability contactFields:manage |  |
| Pre-chat: input aria-label='New contact field name' + Button 'Create' + 'Cancel' | POST /api/workspace/contact-fields then binds the question to the new key | capability contactFields:manage |  |
| Pre-chat: button '+ Add question' | appends a question row | hidden at 6 fields |  |
| Behavior: input 'Phone dial code' (numeric, ≤4 digits) | local draft phoneDialCode | shown only when a pre-chat field of type phone exists |  |
| Behavior: Toggle 'AI auto-reply' | local draft aiEnabled (off by default) | admin |  |
| Behavior: Toggle 'Play a chime on new messages' / 'Show agent name to visitors' / 'Show “Powered by” footer' | local draft | admin |  |
| Behavior: attachment policy toggles (image / video / audio / document) | local draft allowedMediaKinds; all off = text-only chat | admin |  |
| Behavior: Toggle 'Active' | local draft isActive — turning it off disables the widget on the site completely, existing conversations included | admin | **DESTRUCTIVE** |
| Install: Button 'Lock to {firstSeenOrigin}' | sets allowedOrigins to that single origin (local draft) | shown only when allowedOrigins is empty AND a firstSeenOrigin was observed |  |
| Install: origin chips with button aria-label='Remove {origin}' | removes an allowed origin (an EMPTY list allows ANY site) | admin | **DESTRUCTIVE** |
| Install: input aria-label='Add an allowed origin' (commits on Enter AND on blur) | appends to allowedOrigins | admin |  |
| Install: CopyBox 'Copy' buttons (snippet variants per deploy mode, plus the CSP block) | clipboard write | admin |  |
| Install: link 'Test this widget on a sample page' (target=_blank) | opens /webchat/test.html?key={publicKey} | admin |  |
| Install: link 'full installation guide' | opens /docs/webchat-install | admin |  |
| Button 'Save changes' | PATCH /api/workspace/webchatwidget/{id} with name + isActive + allowedOrigins + config | admin |  |
| Button 'Delete' (destructive-outlined, trash) | native window.confirm (NOT the app confirm dialog) — extra warning when it is the only active widget — then DELETE /api/workspace/webchatwidget/{id} | admin | **DESTRUCTIVE** |

### /settings/integrations
- **Roles:** admin only; non-admin server-redirects to /account
- **States:** force-dynamic; one listApiKeys() read drives both the n8n tile status and the connect panel. API-keys empty state 'No keys yet'. Reveal-once banner for a new/rotated token (auto-copied to clipboard, cleared only by 'I've saved my key').

| Element | Does | Gate | ⚠ |
|---|---|---|---|
| Tile 'Webhooks' (CTA 'Manage') | navigate /settings/integrations/webhooks | admin |  |
| Tile 'n8n' (CTA 'Connect' / 'Connected') | anchor scroll to #n8n on this page | admin |  |
| Tiles 'Make' / 'Zapier' / 'Google Sheets' (CTA 'Coming soon') | inert dashed cards, no link | always disabled |  |
| API keys: Input 'Key name' (placeholder 'Organization', max 80) | form field | admin |  |
| API keys: Switch aria-label='Full access' | toggles between scopes ['*'] and the granular picker | admin |  |
| API keys: Switch aria-label='{scope label}' — one per granular scope (read/write contacts, conversations, messages, notes, flags, catalog, broadcasts, calls, reports, users, workflows, tickets, channels, admin:settings) | toggles that scope into the create payload; error 'Pick at least one scope.' when empty | shown only when Full access is off |  |
| API keys: Button 'Create key' | POST /api/workspace/api-keys {name,scopes} → reveal-once token, auto-copied | admin; disabled without a name / with zero scopes |  |
| Reveal banner: Button 'Copy' and Button 'I've saved my key' | clipboard write / dismiss the banner | after create or rotate |  |
| Key row: button 'Rotate' (title='Revoke this key and mint a replacement with the same name + scopes') | confirm 'Rotate the "{name}" key?' → POST /api/workspace/api-keys/{id}/rotate — old key stops working immediately | admin | **DESTRUCTIVE** |
| Key row: button 'Revoke' (title='Permanently revoke this key') | confirm 'Revoke the "{name}" key?' → DELETE /api/workspace/api-keys/{id} — any system using it gets 401s | admin | **DESTRUCTIVE** |
| n8n connect panel (#n8n): Button 'Generate API key' | POST /api/workspace/api-keys with N8N_PRESET name + least-privilege scopes | admin; shown only when no active key named 'n8n' |  |
| n8n panel: button 'Rotate key' (title='Lost your key? Rotate creates a new one and revokes the old.') | POST /api/workspace/api-keys/{id}/rotate — no confirm dialog on this one | admin; shown only when already connected | **DESTRUCTIVE** |
| n8n panel: Button 'Copy' / Button 'I've saved my key' | clipboard / dismiss reveal | after generate/rotate |  |
| n8n panel: per-curl-example Button 'Copy' | clipboard write of the curl starter (token substituted when revealed, else $CCP_TOKEN) | admin |  |
| Link 'Full endpoint reference' | navigate /docs/api | admin |  |

### /settings/integrations/webhooks
- **Roles:** admin only; non-admin server-redirects to /account
- **States:** EmptyState 'No webhooks yet' + Button 'Create your first webhook'. Per-row status dot with title + pings when healthy; badges 'auto-disabled' (tripped) / 'disabled'. Deliveries sheet: loading spinner, 'HTTP {status}' error strip, 'No deliveries yet. Fire a test or wait for a subscribed event.', keyset 'Load older'.

| Element | Does | Gate | ⚠ |
|---|---|---|---|
| Link 'Back to Integrations' | navigate /settings/integrations | admin |  |
| Button 'New webhook' / 'Create your first webhook' | opens the inline create form | admin |  |
| Create/edit form: Input label='Name' (required, max 80) | form field | admin |  |
| Create/edit form: Input label='URL' (type=url, required) | form field | admin |  |
| Create/edit form: event checkboxes grouped by PUBLIC_EVENT_GROUPS (label + event type + description per row) | toggles eventTypes | admin |  |
| Button 'Create webhook' / 'Save changes' (type=submit) | POST /api/workspace/outbound-webhooks or PATCH /api/workspace/outbound-webhooks/{id}; create reveals the signing secret ONCE | admin |  |
| Button 'Cancel' | closes the form | admin |  |
| Secret reveal box: Button 'Copy' + button 'Dismiss' | clipboard write / clear | after create or rotate |  |
| Webhook row (role=button, Enter/Space activates, title='View deliveries') | opens the right-side Deliveries sheet | admin |  |
| Row overflow Button aria-label='Webhook actions' (⋯) | opens the menu (click is stopPropagation'd so the row doesn't open) | admin |  |
| Menu item 'View deliveries' | opens the sheet | admin |  |
| Menu item 'Edit' | loads the row into the inline form | admin |  |
| Menu item 'Send test' | POST /api/workspace/outbound-webhooks/{id}/test → toast 'Test delivery queued' | admin |  |
| Menu item 'Rotate secret' | confirm 'Rotate secret for "{name}"?' → POST …/rotate-secret; old secret stops verifying on the next attempt | admin | **DESTRUCTIVE** |
| Menu item 'Disable' / 'Enable' | PATCH /api/workspace/outbound-webhooks/{id} {enabled:!enabled} | admin | **DESTRUCTIVE** |
| Menu item 'Delete' (text-destructive) | confirm 'Delete "{name}"?' (deliveries dropped immediately, delivery history removed) → DELETE /api/workspace/outbound-webhooks/{id} | admin | **DESTRUCTIVE** |
| Deliveries sheet: Button 'Refresh' | GET /api/workspace/outbound-webhooks/{id}/deliveries?limit=25 | sheet open |  |
| Deliveries sheet: delivery row expander button (chevron) | expands payload / response panes | sheet open |  |
| Deliveries sheet: Button 'Copy' (payload) | clipboard write of the JSON payload | row expanded |  |
| Deliveries sheet: Button 'Load older' | GET …/deliveries?cursor={nextCursor} and appends | shown only when nextCursor exists |  |
| Signature guide <details>: Button 'Node.js' / 'Python' / 'Copy' | switches the sample language / copies it | admin |  |

### /settings/ai-assistant
- **Roles:** capability aiAssistant:manage; otherwise server-redirects to /account
- **States:** RSC-loaded config + documents (no client loading state for the initial read). Knowledge tab: 'No knowledge files yet.' Per-document StatusBadge (ready/failed/disabled/processing) + error text. Voice preview toasts 'Voice preview failed'. Save toasts 'AI Assistant settings saved'.

| Element | Does | Gate | ⚠ |
|---|---|---|---|
| Switch labelled 'Enabled' (PageHeader action) | local draft config.enabled — only persisted by 'Save' | capability |  |
| Button 'Save' (PageHeader action) | PUT /api/workspace/ai-assistant with the whole config (+ configVersion) | capability |  |
| Tablist (role=tab): 'Company Identity' / 'Business Details' / 'Opening Hours' / 'Languages & Dialect' / 'Tone & Reply Behavior' / 'Voice' / 'Knowledge Files' | client tab switch | capability |  |
| Identity tab: 'Company name' / 'Industry' / 'Website' / 'Phone' inputs; 'Short description' / 'Full description' textareas; 'Service areas (comma-separated)'; 'Locations' list editor | local draft | capability |  |
| Business tab: 'Products' / 'Services' / 'Pricing notes' textareas; 'Payment methods' / 'Delivery policy' / 'Return policy' / 'Booking rules' inputs; 'Restrictions' / 'Human escalation instructions' textareas; 'FAQs' list | local draft | capability |  |
| Hours tab: Select 'Timezone'; textarea 'After-hours behavior'; 'Weekly schedule' with Inputs aria-label='{Day} — opening time' / '… closing time'; 'Holidays' and 'Exceptions' list editors | local draft | capability |  |
| Languages tab: multi-select 'Supported languages (pick up to 12)'; Select 'Default language'; Select 'Language policy' (Match customer / Always default / Specific language); Select 'Specific language' (only when policy=s | local draft | capability |  |
| Languages tab: SwitchRows 'Lebanese dialect' / 'Allow Arabizi (Latin-script Lebanese)' / 'Code-switching (mix AR/FR/EN)'; textarea 'Lebanese style guidance' | local draft | capability |  |
| Tone tab: Select 'Tone'; Select 'Reply length'; Select 'Auto-reply mode' (Auto-send / Draft for approval / Hybrid); Number 'Confidence threshold (0–1)'; Number 'Max auto-replies per conversation'; Number 'Wait for custom | local draft | capability |  |
| Tone tab: SwitchRows 'Match customer tone' / 'Ask new customers for their email (once)'; textarea 'Custom instructions' | local draft | capability |  |
| Voice tab: SwitchRows 'Transcribe incoming voice notes' / 'Save transcript text' / 'Fall back to text on any voice failure'; Select 'Reply channel mode'; Select 'Voice'; Select 'Voice language'; Select 'Voice speed'; Num | local draft | capability |  |
| Voice tab: Button '▶ Preview' | POST /api/workspace/ai-assistant/voice-preview and plays the returned audio | capability |  |
| Knowledge tab: label 'Click to upload a knowledge file (PDF, DOCX, TXT, MD, CSV, JSON — max 10 MB)' wrapping a hidden file input | POST multipart /api/workspace/ai-assistant/documents → toast 'Uploaded — processing…' | capability |  |
| Knowledge tab: per-document Switch | PATCH /api/workspace/ai-assistant/documents/{id} {enabled:!enabled} | capability |  |
| Knowledge tab: Button 'Reprocess' | POST /api/workspace/ai-assistant/documents/{id}/reprocess | capability |  |
| Knowledge tab: Button 'Delete' | DELETE /api/workspace/ai-assistant/documents/{id} — NO confirm dialog | capability | **DESTRUCTIVE** |

### /settings/snippets
- **Roles:** capability snippets:manage; otherwise server-redirects to /account
- **States:** EmptyState with 'New snippet' CTA when zero. Search no-match line. Editor dialog error strip. Delete confirm stacks over the editor dialog (z-60).

| Element | Does | Gate | ⚠ |
|---|---|---|---|
| Button 'New snippet' (PageHeader action, also in the empty state) | opens the editor dialog in create mode | capability |  |
| Input aria-label='Search snippets…' + button aria-label='Clear search' | client filter | shown only when ≥1 snippet |  |
| Snippet row body button (label + /name, pencil on hover) | opens the editor dialog for that snippet | capability |  |
| Row button aria-label='Delete /{name}' | confirm 'Delete /{name}?' → DELETE /api/workspace/snippets/{id} + soft refresh (clears it from the inbox /menu) | capability | **DESTRUCTIVE** |
| Editor dialog (ariaLabel 'New snippet' / 'Edit snippet'): button aria-label='Close' | closes without saving | dialog open |  |
| Editor: Input 'Trigger' (prefixed '/', lowercased, max 64, validated) | form field | dialog open |  |
| Editor: Input 'Label' (max 80) | form field | dialog open |  |
| Editor: TokenHighlightTextarea 'Body' (max 4500, live unknown-token warning) + FieldTokenPicker (inserts $var.contact.* / $var.agent.* at the caret) | form field + token insertion | dialog open |  |
| Editor: Button 'Create snippet' / 'Save' | POST /api/workspace/snippets or PATCH /api/workspace/snippets/{id} {name,label,body} | disabled until valid |  |
| Editor: Button 'Cancel' | closes the dialog | dialog open |  |
| Editor footer: Button 'Delete' (text-destructive) | same confirm + DELETE as the row action | edit mode only | **DESTRUCTIVE** |

### /settings/tags
- **Roles:** capability tags:manage; otherwise server-redirects to /account
- **States:** EmptyState 'No tags yet' with 'Add tag'. Search no-match line 'No tags match “{q}”.'. Red error strip on failed mutations. Per-row spinner while busy. Footer count line + total contact-tag links.

| Element | Does | Gate | ⚠ |
|---|---|---|---|
| Button 'Add tag' (PageHeader action, and in the empty state) | reveals the inline create row (autofocused) | capability |  |
| Input aria-label='Search tags' + button aria-label='Clear search' | client filter | shown only when ≥1 tag |  |
| Sort DropdownMenu trigger ({current sort label}) → DropdownMenuCheckboxItems 'Newest first' / 'Oldest first' / 'Name (A–Z)' / 'Name (Z–A)' / 'Most used' / 'Least used' | client sort, persisted to localStorage key 'tags-settings:sort' | shown only when ≥1 tag |  |
| Create row: Input aria-label='New tag name' (Enter creates, Escape cancels) + Button (create) + Button 'Cancel' | POST /api/workspace/tags {name,color} | capability |  |
| Tag row: ColorSwatchPicker (label 'tag colour') | PATCH /api/workspace/tags/{id} {color} | capability |  |
| Tag row: name button (click to edit) → Input (Enter/blur commits, Escape cancels, max 40) | PATCH /api/workspace/tags/{id} {name} | capability |  |
| Tag row: contact-count link (title='View contacts tagged "{name}"') | navigate /contacts?tag={id} | capability |  |
| Tag row: button aria-label='Delete {name}' | confirm naming the affected contact count AND how many saved views filter on it → DELETE /api/workspace/tags/{id} | capability | **DESTRUCTIVE** |

### /settings/message-flags
- **Roles:** capability messageFlags:manage; otherwise server-redirects to /account
- **States:** Archived flags render in a separate dimmed 'Archived' section. Definitions that have ever been raised cannot be deleted — the UI swaps Delete for Archive and the server enforces it. Per-row usage counts ('{n} raised · {n} open'). Error text under the create row.

| Element | Does | Gate | ⚠ |
|---|---|---|---|
| Button 'New flag' (PageHeader action; also in the empty state) | reveals the inline create block (autofocused) | capability |  |
| Create block: Input placeholder='Flag name (e.g. Complaint)' + Input placeholder='What does this flag mean? …' + color picker | local draft | capability |  |
| Create block: Button (create) + Button 'Cancel' | POST /api/workspace/message-flags {name,color,description} | capability |  |
| Definition row: ColorSwatchPicker (label 'flag colour') | PATCH /api/workspace/message-flags/{id} {color} | capability |  |
| Definition row: Input aria-label='Flag name' (commits onBlur, max 40) | PATCH … {name} | capability |  |
| Definition row: Input aria-label='Flag description' (commits onBlur, max 200) | PATCH … {description} | capability |  |
| Definition row: Button aria-label='Delete' (trash, text-destructive) | confirm 'Delete “{name}”?' ('This flag has never been raised, so nothing is lost.') → DELETE /api/workspace/message-flags/{id} | ONLY when totalCount === 0 | **DESTRUCTIVE** |
| Definition row: Button aria-label='Archive' (title='Archive — hides it from the picker, keeps the history') | confirm 'Archive “{name}”?' → PATCH … {archived:true} | shown instead of Delete when totalCount > 0 | **DESTRUCTIVE** |
| Archived section: Button 'Un-archive' | PATCH … {archived:false} | capability; section renders only when ≥1 archived |  |

### /settings/stages
- **Roles:** capability stages:manage; otherwise server-redirects to /account
- **States:** EmptyState 'No stages yet' + 'Add stage'. Red error strip. Footer: total contacts across N stages + an 'unassigned' link to /contacts?stage=none. Delete is blocked (informational confirm with 'OK') when the stage holds contacts or is the default while others exist.

| Element | Does | Gate | ⚠ |
|---|---|---|---|
| Button 'Add stage' (PageHeader action; also in the empty state) | reveals the inline create row (autofocused) | capability |  |
| Create row: Input aria-label='New stage name' (Enter creates, Escape cancels) + Button (create) + Button 'Cancel' | POST /api/workspace/stages | capability |  |
| Stage row: button aria-label='Move up' / aria-label='Move down' (reorder is buttons, NOT drag-and-drop) | PATCH /api/workspace/stages/reorder | disabled at first/last |  |
| Stage row: ColorSwatches | PATCH /api/workspace/stages/{id} {color} | capability |  |
| Stage row: name button → Input (Enter/blur commits, Escape cancels) | PATCH /api/workspace/stages/{id} {name} | capability |  |
| Stage row: button 'Set default' (title='Make this the default stage') | PATCH /api/workspace/stages/{id} {isDefault:true} | hidden on the current default (which shows a static 'Default' pill) |  |
| Stage row: contact-count link (title='View contacts in "{name}"') | navigate /contacts?stage={id} | capability |  |
| Stage row: button aria-label='Delete {name}' | confirm 'Delete "{name}"?' → DELETE /api/workspace/stages/{id}; refused with an informational dialog when the stage still holds contacts, or when it is the default and other stages exist | capability | **DESTRUCTIVE** |

### /settings/contact-fields
- **Roles:** capability contactFields:manage; otherwise server-redirects to /account
- **States:** Amber banner listing custom fields that shadow built-in contact columns. Inline role='alert' when a new/renamed label collides with a reserved key (submit disabled). EmptyState 'No custom fields yet'. Footer '{n} fields · max 50 per team'. Options editor has its own error strip + 'No options yet — add the first one below.'

| Element | Does | Gate | ⚠ |
|---|---|---|---|
| Button 'Add field' (PageHeader action; also in the empty state) | reveals the inline create row | capability |  |
| Built-in section: 7 visibility toggles — 'First name', 'Last name', 'Email', 'Location', 'Language', 'Country', 'First contacted' (button aria-label='Hide {label}' / 'Show {label}') | PATCH /api/workspace/contact-fields/builtins | capability (phone + name are always shown, no control) |  |
| Create row: Input aria-label='New field name' (Enter creates, Escape cancels) | form field; aria-invalid on a reserved key | capability |  |
| Create row: radiogroup aria-label='Field type' → role=radio 'Text' / 'Dropdown' | sets the new field's type | capability |  |
| Create row: Button 'Create' + Button 'Cancel' | POST /api/workspace/contact-fields {label,type} | disabled on blank or reserved label |  |
| Field row: button aria-label='Move up' / 'Move down' | PATCH /api/workspace/contact-fields/reorder | disabled at first/last |  |
| Field row: label button → Input (Enter/blur commits, Escape cancels) | PATCH /api/workspace/contact-fields/{id} {label} | capability; blocked with role='alert' on a reserved name |  |
| Field row: badge button 'Dropdown · {n} options' (aria-expanded) | expands the inline OptionsEditor | type === select only |  |
| Field row: button aria-label='Hide {label}' / 'Show {label}' (eye) | PATCH /api/workspace/contact-fields/{id} {isVisible} | capability |  |
| Field row: button aria-label='Delete {label}' | confirm 'Delete "{label}"?' (clears the value on EVERY contact) → DELETE /api/workspace/contact-fields/{id} | capability | **DESTRUCTIVE** |
| Options editor: ColorSwatchPicker (label 'colour for "{option}"') | PATCH /api/workspace/contact-fields/{fieldId}/options/{id} {color} | select-type field, expanded |  |
| Options editor: option name inline rename | PATCH …/options/{id} {name} | same |  |
| Options editor: button aria-label='Move {option} up' / 'Move {option} down' | PATCH …/options reorder | disabled at first/last |  |
| Options editor: button aria-label='Delete {option}' | confirm naming how many contacts carry it (confirmLabel 'Clear & delete' when used) → DELETE …/options/{id} with {moveToOptionId:null} — clears the value on every carrying contact | capability | **DESTRUCTIVE** |
| Options editor: Input aria-label='Add option to {label}' (Enter adds) + Button (add) | POST /api/workspace/contact-fields/{fieldId}/options | capability |  |

### /settings/tickets
- **Roles:** role admin ONLY (user.role !== 'admin' → server redirect to /tickets); every /api/workspace/tickets route is @RequireRole('admin')
- **States:** Spinner in the PageHeader action while any save is in flight. Toast on failure. 'No ticket fields yet.' when the field list is empty. SLA rows validate 'Enter a whole number of minutes, or leave it empty for no promise'.

| Element | Does | Gate | ⚠ |
|---|---|---|---|
| Switch aria-label='Close the conversation when its last ticket is solved' | PATCH /api/workspace/tickets/settings {ticketCloseConversationOnLastSolved} | admin |  |
| SLA row per priority (TICKET_PRIORITIES): Input 'First reply … min' + Input 'Resolution … min' (placeholder '—' = no promise) | form fields | admin |  |
| SLA row: Button 'Save' (type=submit, one per priority row) | POST /api/workspace/tickets/sla {priority,firstResponseMins,resolutionMins} | admin |  |
| Ticket fields: Input aria-label='Ticket field name' (max 80) + Button 'Add field' (submit) | POST /api/workspace/tickets/fields {label} | admin |  |
| Ticket field row: Button sr-only 'Remove {label}' (trash, text-destructive) | confirm 'Remove “{label}”?' (values already saved on tickets are kept as history) → DELETE /api/workspace/tickets/fields/{id} | admin | **DESTRUCTIVE** |

### /organization (Account info)
- **Roles:** any signed-in member (the org name is not a secret). Rename is gated on overview.canManage = isOrgManager (superAdmin || orgRole owner/admin) — non-managers see the field read-only plus 'Only an organization owner or admin can rename it.'
- **States:** error.tsx = SegmentError('Organization'). No loading.tsx. Save button appears only when the name is dirty; spinner while saving; toast on failure. Stats: Organization ID / Plan (+ status badge when not active) / Workspaces / People.

| Element | Does | Gate | ⚠ |
|---|---|---|---|
| Input aria-label='Organization name' (max 80) | local draft | disabled unless overview.canManage |  |
| Button 'Save' (type=submit) | PATCH /api/workspaces/organization {name} then soft refresh | canManage AND name dirty |  |
| Org sub-sidebar: 'Account info' / 'Admin settings' / 'Workspaces' | navigate /organization, /organization/members, /organization/workspaces | ungated links (target pages gate their own actions) |  |

### /organization/members (Admin settings)
- **Roles:** any signed-in member — the roster renders for everyone; 'Add user' and the per-person 'Workspace access' button require overview.canManage (superAdmin || orgRole owner/admin). Server refuses with error 'org_admin_required'.
- **States:** No loading.tsx. Search no-match row 'Nobody matches “{q}”.' Badges: 'Org {orgRole}' (non-member) and 'Deactivated'. Busy spinner inside the workspace-access dialog. Toasts on failure.

| Element | Does | Gate | ⚠ |
|---|---|---|---|
| Button 'Add user' | opens Dialog ariaLabel='Add user' | overview.canManage |  |
| Input placeholder='Search people' | client filter over name + email | none |  |
| Member row: Button 'Workspace access' | opens Dialog ariaLabel='Workspace access' | overview.canManage |  |
| Add-user dialog: Input 'Email address' (type=email, required, autofocus) | form field | canManage |  |
| Add-user dialog: select 'Workspace' (all org workspaces) | form field | canManage |  |
| Add-user dialog: select 'Role in that workspace' (Agent / Manager / Admin) | form field | canManage |  |
| Add-user dialog: Button 'Send invite' (submit) / Button 'Cancel' | POST /api/invites {email,role,workspaceId} → toast 'Invite sent to {email}' + soft refresh | disabled without an email |  |
| Workspace-access dialog: per-workspace select — 'No access' / 'Agent' / 'Manager' / 'Admin' | POST /api/workspaces/{workspaceId}/members {userId, role\|null}; '' sends explicit null = REMOVE that person from that workspace | canManage | **DESTRUCTIVE** |
| Workspace-access dialog: Button 'Done' | closes the dialog (changes already saved per select) | dialog open |  |

### /organization/workspaces
- **Roles:** any signed-in member — every org workspace is listed (ones you're not in carry a 'No access' badge and their name button is disabled). 'Add workspace', 'Rename' and 'Delete' need overview.canManage (superAdmin || orgRole owner/admin).
- **States:** No loading.tsx. Search no-match row 'No workspaces match “{q}”.' Per-row spinner while switching. Toast on failure. Table columns: Name / Members / Conversations / Channels / Created.

| Element | Does | Gate | ⚠ |
|---|---|---|---|
| Button 'Add workspace' | opens Dialog ariaLabel='Add workspace' | overview.canManage |  |
| Input placeholder='Search workspaces' | client filter | none |  |
| Row: workspace-name button | POST /api/workspaces/active {workspaceId} then FULL page nav window.location.assign('/inbox') (a soft refresh would leave the socket in the old ws: room) | disabled unless w.joined |  |
| Row: Button sr-only 'Actions for {name}' (⋯) | opens the row menu | always rendered |  |
| Menu item 'Open workspace' | same switch-and-hard-nav as the name button | w.joined only |  |
| Menu item 'Rename' | opens Dialog ariaLabel='Rename workspace' | overview.canManage |  |
| Menu item 'Delete' (text-destructive) | confirm 'Delete “{name}”?' with requireText = the exact workspace name and a description naming {conversationCount} conversations + {channelAccountCount} channel accounts → DELETE /api/workspaces/{id} | overview.canManage AND overview.workspaces.length > 1 | **DESTRUCTIVE** |
| Add dialog: Input 'Workspace name' (autofocus, max 60) + Button 'Create' (submit) + Button 'Cancel' | POST /api/workspaces {name} | canManage; Create disabled while blank |  |
| Rename dialog: Input aria-label='Workspace name' (autofocus, max 60) + Button 'Save' (submit) + Button 'Cancel' | PATCH /api/workspaces/{id} {name} | canManage |  |

### /account (Profile & password)
- **Roles:** every signed-in user — personal, ungated by design. Email + role are read-only ('Managed by your admin').
- **States:** error.tsx = SegmentError('Account'). No loading.tsx. Name field shows an 'Unsaved' dot when dirty. Password form shows a role='alert' error box on failure and toasts 'Password updated.' on success. Avatar upload validates ≤2 MiB and PNG/JPEG/WEBP client-side.

| Element | Does | Gate | ⚠ |
|---|---|---|---|
| Button aria-label='Upload new avatar' (camera badge on the avatar) + hidden file input (accept image/png,image/jpeg,image/webp) | POST multipart /api/users/me/avatar → publishes user.profile_updated; router.refresh() | self only |  |
| Button 'Remove' (trash, under the avatar) | PATCH /api/users/me {avatarUrl:null} — no confirm dialog | shown only when an avatar exists | **DESTRUCTIVE** |
| Input id='profile-name' (label 'Display name', max 80) | local draft | self only |  |
| Button 'Save' (next to the name field) | PATCH /api/users/me {name} → toast 'Name updated.' + router.refresh() | disabled unless the trimmed name changed |  |
| Password form: Input name='currentPassword' (label 'Current password', required, autocomplete current-password) | form field | self only |  |
| Password form: Input name='newPassword' (label 'New password', required, minLength MIN_PASSWORD_LENGTH) | form field | self only |  |
| Button 'Update password' (type=submit) | POST /api/auth/change-password {currentPassword,newPassword} (routed to NestJS by Caddy in prod, direct :4000 in dev); resets the form + toast on success | self only |  |
| Account sub-sidebar: 'Profile & password' / 'Notifications' | navigate /account, /account/notifications | ungated by design |  |

### /account/notifications
- **Roles:** every signed-in user — no capability gate, nothing fetched server-side; all state is per-device localStorage via NotificationSoundProvider (cross-tab synced)
- **States:** No loading/empty/error states (pure client prefs). Amber line 'You won't be notified of incoming calls on this device.' appears when 'Receive calls on this device' is off.

| Element | Does | Gate | ⚠ |
|---|---|---|---|
| Switch aria-label='New messages sound' | client: setPref('messages', v) in localStorage; turning ON plays a preview (also unlocks browser autoplay) | none |  |
| Switch aria-label='Calls sound' | client: setPref('calls', v); ON plays a ringtone preview | none |  |
| Switch aria-label='Receive calls on this device' | client: setReceiveCalls(v) — when off, incoming WhatsApp calls neither pop up nor ring on this device (teammates still get them) | none |  |

## Slice: Inbox — /inbox and /inbox/[conversationId] (apps/web/src/features/inbox/**, plus the layout-level inbox sub-sidebar at apps/web/src/components/layouts/inbox-sub-sidebar.tsx, which only renders on these routes)

### /inbox/[conversationId]
- **Roles:** Any authenticated workspace member (admin/manager/agent) + platform superAdmin in operator mode. Legacy URL only.
- **States:** No UI of its own. Server component that immediately redirect("/inbox?c=<id>") — Next default 307 (302 for non-GET). Loading/error come from the /inbox segment boundaries.

| Element | Does | Gate | ⚠ |
|---|---|---|---|
| (no interactive elements — pure server redirect) | redirect() to /inbox?c=<encoded conversationId>; apps/web/src/app/(app)/inbox/[conversationId]/page.tsx | none |  |

### /inbox (single-page workspace; ?c=<conversationId> selects the thread, ?m=<messageId> deep-links a message, ?n=<nonce> re-fires the same jump)
- **Roles:** Any authenticated workspace member — admin, manager, agent — plus a platform superAdmin entering as operator (isSuperAdmin with no WorkspaceMember row; operator mode suppresses mark-read, typing, presence and viewer registration). Agents in a workspace with agentConversationVisibility="assigned" see only their own threads (restrictedToOwnConversations); a live reassignment away from them clears the pane with a "This conversation was reassigned to a teammate" toast. Per-element gates come from resolvePermissions(role, team.rolePermissions): conversations:delete, conversations:assignOthers, stages:manage, contactFields:manage, calls:make, inboxViews:manageShared. Agents default FALSE for assignOthers / stages:manage / contactFields:manage / inboxViews:manageShared; admin+manager default TRUE for everything.
- **States:** LOADING: route loading.tsx skeleton (8-row list column + thread placeholder, aria-busy, sr-only "Loading inbox…"); delay-gated per-thread top bar [data-thread-loading-bar] (only reveals after 180ms); ChatSkeleton with the target contact's name on a cold cache miss; 7-row list skeleton while listRefetching; thread reveal-gate loader [data-thread-loader]; "Loading older messages…" pill; "Loading mor

| Element | Does | Gate | ⚠ |
|---|---|---|---|
| Sub-sidebar preset rows: "Active" / "All" / "Mine" / "Unassigned" / "Closed" / "Flagged" (button, aria-pressed) | setFilter({kind:'preset',id}) → persisted to INBOX_FILTER_COOKIE; list refetches that bucket. Muted total + green unread pill from useConversationCounts. | none |  |
| Sub-sidebar "Calls" row (button, aria-pressed, Phone icon, live-call count badge) | setFilter({kind:'calls'}) → replaces list+thread panes with the team-wide CallsHistory inside the inbox | none (Call-back buttons inside are gated on calls:make) |  |
| "VIEWS" section header chevron (button, aria-expanded) | collapse/expand the saved-views list (client state) | none |  |
| "New view" (+ icon, aria-label="New view") / "Save a filter as a view →" empty-state button | opens ViewBuilderDialog in create mode | none — personal views are ungated; only the Share toggle inside needs inboxViews:manageShared |  |
| Saved-view row (button, aria-pressed, title="<name> — <filter summary>") | setFilter({kind:'view',viewId}) → server evaluates the saved filter document; total + unread badges from the views-count endpoint | a deleted/un-shared view id is dropped by the layout on next load |  |
| Saved-view "⋯" (DropdownMenuTrigger, aria-label="Actions for <name>") → "Edit" | opens ViewBuilderDialog in edit mode → PATCH /api/inbox-views/:id | only when view.isEditable (own personal view, or shared + inboxViews:manageShared); trigger is opacity-0 until hover/focus |  |
| Saved-view "⋯" → "Delete" | confirm ("Delete “<name>”?", confirmLabel "Delete view") → DELETE /api/inbox-views/:id; falls back to the Active preset if it was the current filter | view.isEditable | **DESTRUCTIVE** |
| View builder: "Name" input (#view-name, autoFocus, maxLength INBOX_VIEW_NAME_MAX) | local state, submitted with the view document | Create/Save disabled while empty |  |
| View builder: Icon swatches (aria-label=<icon key>) and Colour swatches (aria-label=<color>) | set view.icon / view.color | none |  |
| View builder: Status chips "Open" / "Pending" / "Closed" | toggle filters.statuses (none selected = any status) | none |  |
| View builder: Assigned-to chips "Anyone" / "Me" / "Unassigned" / "Specific people" + per-teammate chips | set filters.assignment mode and assignedUserIds | none |  |
| View builder: Channel chips, Account chips, Stage chips, Tag chips + "any"/"all" tag-match toggle, select-field option chips | compose the saved filter document (server owns evaluation via lib/inbox-views/where.ts) | Account group only when the workspace has >1 account; select-field groups only for defined select fields |  |
| View builder: "Only flagged conversations" / "Only unread conversations" switches (Switch, aria-label = row label) | filters.hasOpenFlags / filters.unreadOnly | none |  |
| View builder: "Share with the whole workspace" switch | sets visibility = shared | only rendered with inboxViews:manageShared (agents FALSE by default) |  |
| View builder footer: "Cancel" / "Create view"\|"Save" | POST /api/inbox-views or PATCH /api/inbox-views/:id; on create, switches the filter to the new view | Save disabled while !name.trim() or saving |  |
| "ACCOUNTS" header chevron (button, aria-expanded); "All accounts" row; per-account rows (button, title="<name> · <providerName>", ChannelBadge) | setAccountId(null\|id) — a SECOND orthogonal narrow composing with preset/stage/view; feeds accountId into list + search + counts | the whole section renders NOTHING unless some channel has >1 account (hasMultipleFor); disconnected accounts show at 60% opacity with a "disconnected" tag but stay clickable; never persisted across sessions by design |  |
| "STAGES" header (button, aria-expanded) + per-stage rows (button, aria-pressed, title="<name> · default for new contacts") | setFilter({kind:'stage',stageId}) — filters by contact stage, includes closed threads; count from serverCounts.byStage | none; "No stages yet." when empty |  |
| "TEAMMATES" header (button, aria-expanded) | collapse/expand the roster; the rows themselves are NON-interactive (avatar + presence dot + availability note) | only when at least one active teammate exists |  |
| List header title + "<n> conversations" subtitle | read-only; authoritative server bucket total (falls back to "N+" of the loaded slice) | none |  |
| "Select multiple" toggle (button, aria-label/title "Select multiple" ↔ "Exit selection mode", aria-pressed, CheckSquare) | enters list selection mode — rows become <label>+checkbox instead of open-buttons | hidden entirely without conversations:delete |  |
| Sort toggle (button, aria-label="Toggle sort order", aria-pressed; title "Sorted by latest activity — click for longest waiting" ↔ inverse) | client-side re-sort of the LOADED slice by lastInboundAt asc; persisted to localStorage `inbox:sort` | none |  |
| List search input (placeholder "Search contacts, messages, comments…", aria-label "Search contacts, messages, and comments") | ≥2 chars swaps the live list for InboxSearchPanel → GET /api/inbox/search?scope=…&q=…(&accountId), debounced | 1 char keeps the live list |  |
| "Clear search" X (button, aria-label="Clear search") | clears the query, restores the live list | only when search.length > 0 |  |
| Search scope tabs "Contacts" / "Messages" / "Comments" (role=tab, aria-selected) | switch scope; messages+notes fire only after their tab is first opened and only at ≥2 chars | "Keep typing…" below 2 chars for the heavy scopes |  |
| Search contact hit: name-area button + per-channel ChannelBadge buttons (aria-label="Open <Channel> chat") | openConversation(id), or onStartContactChat → POST /api/conversations/start then open, when the contact has no thread ("no chat" chip) | none |  |
| Search message hit row (button) | opens the conversation AND jumps/flashes that message; may fetch GET /api/conversations/:id/messages/context?messageId=… | none |  |
| Search comment/note hit row (button) | opens the conversation (no message anchor) | none |  |
| Conversation row (button, aria-current="page" when open) | openConversation(id) — client-only state swap + history.replaceState("/inbox?c=<id>"); hover (150ms debounce) and focus prefetch GET /api/inbox/conversation/:id into the LRU | in selection mode the row becomes a <label> wrapping a checkbox (aria-label="Select <contact name>") |  |
| List keyboard nav: j / ArrowDown, k / ArrowUp, Enter | roving highlight over loaded rows (virtualizer scrollToIndex + prefetch); Enter opens the highlighted row | no-op while typing in input/textarea/contenteditable, in selection mode, or with the search panel open; ignores alt/ctrl/meta |  |
| "Load older conversations" (button, list footer) | keyset-paginated next page; also auto-fires when the virtualizer is within 5 rows of the end | only when hasMore; shows "Loading more…" instead while in flight |  |
| Selection toolbar "Delete" (Button, destructive styling, Trash2) | confirm "Delete N chats?" ("Removes all messages and notes from these threads. The contacts stay. This can't be undone.") → POST /api/conversations/bulk | conversations:delete; disabled while deleting | **DESTRUCTIVE** |
| Selection toolbar "Cancel" X (button, aria-label="Cancel") | exits selection mode, clears selectedIds | only shown with ≥1 row selected |  |
| Conversation-list resize handle (role=separator, aria-orientation=vertical, aria-label="Resize conversation list", aria-valuemin 260 / max 560, tabIndex 0) | pointer drag or arrow keys resize the list column; width persisted to INBOX_LIST_WIDTH_COOKIE and SSR'd; clamped so the thread keeps ≥560px | lg+ only |  |
| Thread "Back to conversations" (button, aria-label="Back to conversations", ChevronLeft) | clears the active thread and strips ?c= via replaceState (single-pane mobile mode) | lg:hidden — below lg only |  |
| Thread header stage pill (ContactStagePicker, size sm) | PATCH /api/contacts/:id {stageId} with optimistic contact:updated + a `ccp:contact-stage-delta` window event for the sidebar badges | hidden below @[740px] of header width; the picker's manage-stages entries need stages:manage |  |
| "Search this conversation" (Button icon, aria-label="Search this conversation", title "… (⌘F)") | opens the in-thread MessageSearch bar | none |  |
| Keyboard ⌘F / Ctrl+F | opens in-thread search instead of the browser find | ignored while focus is in an input/textarea/contenteditable |  |
| In-thread search input (aria-label="Search messages in this conversation", placeholder "Search messages…") | GET /api/conversations/:id/messages/search; shows "<n> of <total>" | none |  |
| In-thread search nav: Enter (older) / Shift+Enter (newer) / ArrowUp / ArrowDown; "Older match" and "Newer match" buttons; "Clear search" X; "Close search" X; Escape | walk matches (wraps), scroll+flash the active one, loading a context window when the match isn't in the loaded slice; Escape/X closes and clears | nav buttons disabled at 0/1 matches |  |
| "Call on WhatsApp" / "Call on Messenger" (Button icon, aria-label="Start a <Channel> call with this contact") | initiateOutbound via the app-wide CallProvider; 4xx reasons surface as toasts (permission_required, bic_blocked_region, calling_restricted, daily_cap_reached, provider_not_configured, …) | calls:make AND the channel's `calling` capability (WhatsApp/Messenger, NOT Instagram) AND team.outboundCallingAvailable !== false AND callPermissionRevokedUntil not in the future; DISABLED while any call is live |  |
| AI state pill (button, title="AI Assistant state", label "AI Active"/"Human Active"/"AI Paused") → "Pause AI" / "Take over" / "Return to AI" / "Resume AI" | GET /api/ai-assistant/conversations/:id/overview for state; POST /api/ai-assistant/conversations/:id/state to act | renders nothing when the assistant was never enabled; the offered actions depend on current state |  |
| Assignment dropdown trigger (Button outline, aria-label/title "Assigned to <name>" \| "Unassigned — assign this conversation" \| "Handled by the AI Agent — assign to a teammate") | opens the "Assign to…" menu | disabled while a PATCH is in flight; name collapses to avatar-only below @2xl of header width |  |
| Assignment menu → "Unassigned" | POST /api/conversations/:id/assign {assignedUserId:null}, optimistic conversation:assigned + activity frames with rollback | shown only with conversations:assignOthers OR when the thread is assigned to YOU (self-release) |  |
| Assignment menu → teammate rows (grouped "Available" then "Offline", live presence) | POST /api/conversations/:id/assign {assignedUserId}; may also flip status open (optimistic conversation:status frame) | without conversations:assignOthers the roster is filtered to just YOU (claim-only) |  |
| Status dropdown trigger (Button outline, aria-label="Status: <label> — change conversation status") → "Open" / "Pending" / "Closed" | POST /api/conversations/:id/status; closing also UNASSIGNS server-side, mirrored optimistically. No confirm by design (reversible) | disabled while pending; label hidden below @2xl (coloured dot only) |  |
| Conversation "⋯" (Button icon, aria-label="Conversation actions") → "Block contact" / "Unblock contact" | confirm on block ("Block “<name>”?", confirmLabel "Block contact") → POST /api/contacts/:id/block\|unblock; typed errors mapped (reengagement_required, blocklist_full, rate_limited); state flips via the contact.updated f | only when the channel declares the blockUsers capability (WhatsApp today) | **DESTRUCTIVE** |
| Conversation "⋯" → "Delete chat" | confirm ("Delete this chat with \"<name>\"? … This can't be undone.", confirmLabel "Delete chat") → DELETE /api/conversations/:id → router.push("/inbox") | conversations:delete | **DESTRUCTIVE** |
| "Contact details" (Button icon, aria-label="Contact details", Info) | opens the ContactPanel in a right-side Sheet (variant="sheet") | lg:hidden — only below lg where the desktop rail is hidden |  |
| Thread-header viewers eye (Eye glyph + count; tooltip "Viewing now" listing teammates) | read-only presence from the workspace-wide ConversationViewersProvider; the same eye rides each list row | renders nothing with no other viewers; operator-mode viewers are never registered |  |
| "<n> new messages" pill (motion.button, ArrowDown) | scrollToBottom() and clears the unread-below counter | only when unreadBelow > 0 and the viewport isn't stuck to the bottom |  |
| Bubble hover: "React to this message" (Button icon, aria-label/title="React to this message", aria-expanded) → emoji bar (role=menu) 👍 ❤️ 😆 😮 😢 😠 | POST /api/messages/reaction {conversationId,messageId,emoji}; re-tapping your own emoji posts "" to clear it; pill renders from message.reaction_changed | needs message.externalId, not deleted, and the channel's sendReaction capability; Instagram is coerced to a single ❤️; closes on pick / outside pointerdown / Escape |  |
| Bubble hover: "Reply to this message" (Button icon, aria-label="Reply to this message", CornerUpLeft) | sets the composer's reply target (quoted pill above the textarea) | hidden on pending and failed rows |  |
| Bubble hover: "More actions" (Button icon, aria-label="More actions", MoreHorizontal) | opens the per-bubble dropdown | hidden when nothing inside is available |  |
| Bubble menu → "Reply publicly" | swaps the action bar for an inline PublicReplyComposer (textarea aria-label="Public reply text", placeholder "Reply on the post…"; Enter sends, Shift+Enter newline, Escape cancels) → POST /api/messages/:id/comment-reply; | only on INBOUND messages whose structured.kind === "comment" |  |
| Bubble menu → "Copy" | navigator.clipboard.writeText(message.body) + "Copied" toast | only when the body is non-empty |  |
| Bubble menu → "Flag as" submenu → one item per flag definition (coloured dot + name) | raises a message flag via MessageFlagsContext (POST /api/message-flags) | needs a real (non-pending/non-failed) message and ≥1 definition not already applied to it |  |
| Bubble menu → "Forward" | opens ForwardDialog (ContactSelectDialog, title "Forward to…", confirmLabel "Forward") → POST /api/messages/forward {messageIds,contactIds,clientTempId} | live messages only (needs a real wamid) |  |
| Bubble menu → "Select messages" | enters thread multi-select — rows become role=button/aria-pressed with a checkbox, composer is replaced by SelectionBar | live messages only; pending/failed rows render aria-disabled and can't be ticked |  |
| SelectionBar "Forward" / "Cancel"; Escape key | Forward opens ForwardDialog with the frozen selected ids; Cancel/Escape leaves selection mode | Forward disabled at 0 selected (title "Tick at least one message first"); Escape yields to a deeper modal that already handled it |  |
| Failed-send recovery: "Retry" / "Dismiss" (text buttons under the bubble) | Retry re-submits (media retries reuse the File cached by clientTempId); Dismiss drops the optimistic bubble | Dismiss only for still-optimistic rows carrying a clientTempId; a server-rejected persisted row offers Retry only |  |
| Quoted-reply block inside a bubble (button, disabled without a target) | jumpToOriginal(replyId) — scrolls and flashes the quoted message | disabled when the original isn't addressable |  |
| Image / video thumbnail in a bubble (button) | opens MediaLightbox at that item | falls back to a MediaUnavailable block on decode error |  |
| Audio/voice bubble: play/pause (button, aria-label "Play voice message"/"Play voicemail"/"Play audio"/"Pause"), seek bar (role=slider, aria-label "Seek"/"Audio position", ←/→ ±5s, Home/End), speed cycle (button, aria-lab | local <audio> playback; no server call | none |  |
| Document bubble (button, filename row) | PDF → openAttachment() in a new tab (probe-aware, toast on missing blob); everything else → downloadAttachment() in place with the real filename | none |  |
| Location bubble (anchor over the map preview) | opens Google Maps ?api=1&query=lat,lon in a new tab | none |  |
| Story bubble "Open story" (anchor) | opens structured.url in a new tab | only when the story carries a url |  |
| Contact-card bubble: "Message" / "Save contact" (buttons) | POST /api/conversations/start (then open) / POST /api/contacts | both disabled when the shared vCard has no phone, or while another action is busy |  |
| Instagram customer-reaction badge (button, aria-label "<who> reacted <emoji> — click to dismiss…") | clears a stale customer reaction locally (IG never sends a removal webhook) | Instagram customer reactions only |  |
| Call bubble: "Play recording" (button, aria-pressed) and "Transcript" (button, aria-label="Show transcript", aria-pressed) | toggles the inline RecordingPlayer / TranscriptPanel under the pill | call.hasRecording / call.hasTranscript (either can flip false live via call:artifacts); a "Transcribing…" aria-live spinner shows while pending |  |
| Inbound-audio bubble AI transcript toggle → "Save" / "Cancel" while editing | GET /api/ai-assistant/transcriptions/:messageId; PATCH the corrected text | inbound audio only; requires the assistant |  |
| Internal-note bubble "Delete note" (button, aria-label="Delete note", title "Delete this note", Trash2) | confirm ("Delete this internal note?") → DELETE /api/notes/:id with an optimistic note:deleted dispatch | hover/focus-revealed; always visible on touch | **DESTRUCTIVE** |
| AI suggestion bar: editable Textarea + "Send"/"Edit & Send" / "Send as Voice" / "Send as Text" / "Regenerate" / "Reject" / "Take over" / "Used N company knowledge sources" toggle / inline <audio> | POST /api/ai-assistant/suggestions/:id/decision (accept text\|voice or reject), /regenerate, and /conversations/:id/state for Take over | only when the assistant is enabled and a suggestion exists; send disabled while busy or empty; the voice variants only for voice suggestions |  |
| Composer mode toggle: "Reply" / "Note" (ToggleButton pair) | switches between the customer reply and the internal note; each mode keeps its OWN localStorage draft (`inbox:<ws>:draft:<mode>:<convId>`) | none |  |
| Window badge ("Open"/"Closing soon"/"Closed"/"Never" + remaining time) or the "Private reply · one per comment" pill | read-only; derived from lastInboundAt + the channel's send-window capability | hidden in Note mode; the comment pill replaces it on a comment-only thread with an answerable comment |  |
| "Send template" (Button, composer header top-right, Sparkles) | opens the TemplatePicker | only when the window is CLOSED and the channel has the templates capability (WhatsApp) |  |
| Composer textarea (aria-label="Reply message" / "Internal note"; placeholders "Reply on <Channel>…", "Leave an internal note for your teammates…", "Free-form replies blocked — send a pre-approved template to re-engage.", | draft state + typing pings (socket typing:start/stop and POST /api/conversations/:id/typing); maxLength = the channel's messageTextMaxChars (byte-capped channels use the counter + disabled Send instead) | DISABLED when !isNote && (windowClosed \|\| the staged file sends alone) |  |
| Composer keys: Enter (send), Shift+Enter (newline), ⌘/Ctrl+Enter (force send), "/" (snippet picker), IME composition guard | submit() → POST /api/messages (or /api/notes) with clientTempId + optional replyToMessageId; a caret sitting on a /query opens the snippet popup instead of sending | while the snippet popup is open it owns Enter/Tab/↑/↓ |  |
| Snippet popup (typing "/"): rows (button per snippet), ↑/↓ to move, Enter/Tab to insert, Escape/blur to close | splices the snippet body into the draft at the caret | shows "No snippets match /q." when nothing matches |  |
| Paste-to-attach and drag-and-drop onto the composer card | acceptFile() — same path as the file input (per-channel kind gate + Meta size caps enforced client-side) | no-op in Note mode or with the window closed |  |
| "Attach file" (Button icon, aria-label="Attach file", Paperclip) + hidden <input type=file> (accept image/*, video/*, audio/*, pdf, doc/docx, xls/xlsx, text/plain) | opens the picker; sending goes to POST /api/messages/media (multipart: conversationId, file, caption, clientTempId, replyToMessageId, voice) | disabled in Note mode (title "Notes can't have attachments") and with the window closed |  |
| Attachment preview "Remove attachment" (Button icon, aria-label="Remove attachment") | clears the staged file and resets the file input | only while a file is staged |  |
| Reply-target pill "Cancel reply" (button, aria-label="Cancel reply") | drops the quoted reply target | only while a reply target is set |  |
| "Send a template" toolbar button (Button icon, aria-label="Send a template", Sparkles) | opens the TemplatePicker (loads GET /api/workspace/whatsapp/templates?accountId=…) | channel templates capability; disabled in Note mode (title "Templates can only be sent in Reply mode") |  |
| TemplatePicker: scrim click / "Close template picker" X (aria-label) / Escape / focus trap | closes the panel | none |  |
| TemplatePicker: search input (aria-label="Search templates", placeholder "Search by name, label, language, or body…"), label filter chips, "Recently used" row, template rows | narrows the catalog; a row selects the template and swaps to the fill view | un-sendable templates (wrong status/category) aren't clickable |  |
| TemplatePicker: "Refresh" (Button, title "Re-fetch the latest templates from Meta") | template sync against Meta; success toast "Loaded N templates" / "Templates up to date" | disabled while syncing or when the WABA is missing (title "Add your WABA id in Settings → WhatsApp first"); WabaMissingState replaces the list with a Settings link |  |
| TemplatePicker fill view: "Back to templates list" (button, aria-label) | returns to the list | only when a template is selected |  |
| TemplatePicker fill view fields: header/body var inputs ("Header {{1}}", "Body {{n}}" or the named {{var}}), $var token pickers, header-media upload + Clear, Map-header "Latitude"/"Longitude"/"Place name (optional)"/"Add | compose the template send payload; the PreviewBubble renders RESOLVED values | fields appear only for the components Meta requires; parameterFormat (positional vs named) drives the labels; carousel card count/signature is frozen at approval |  |
| TemplatePicker fill view: "Send template" (Button type=submit) | POST /api/messages/template | disabled until every required placeholder is filled, or while sending |  |
| "Send buttons" (Button icon, aria-label="Send buttons", MousePointerClick) → InteractivePopover (role=dialog, aria-modal) | opens the interactive composer | channel `interactive` capability; disabled in Note mode and with the window closed |  |
| InteractivePopover kind radiogroup (role=radiogroup, aria-label="Interactive message kind"): "Buttons" / "Location" / "Contact info" / "Link button" / "Cards" | switches the payload shape | each option gated on its own capability — locationRequest, requestContactInfo, ctaUrlButton, genericTemplate; "Buttons" always present |  |
| InteractivePopover fields: body prompt (placeholder "Want a callback?"); per-button id + "Title (max 20)" (aria-label "Button N id"/"Button N title") with "Remove button N" and "Add button" (1–3); "Link button label"/"Li | POST /api/messages/interactive on Send; clears the composer draft on success | Send disabled on duplicate button ids/titles or an incomplete row; a validation hint renders inline |  |
| InteractivePopover "Cancel" / "Send" | close / POST /api/messages/interactive | Send disabled while busy or invalid |  |
| "Send location" (Button icon, aria-label="Send location", MapPin) → LocationComposer (role=dialog, aria-modal, aria-label="Send a location") | click-the-map to pin, "Zoom in"/"Zoom out" (aria-labels), "My location" (geolocation), "Place name (optional)" / "Address (optional)" inputs, "Send location" → POST /api/messages/location | channel `sendLocation` capability; disabled in Note mode / closed window; Send disabled until a pin is dropped |  |
| "Send a sticker" (Button icon, aria-label="Send a sticker", Sticker) → StickerPicker (role=dialog, aria-label="Sticker picker") | GET /api/workspace/messenger/stickers (packs + search, aria-label "Search stickers"), "← All packs", pack tiles, sticker tiles (aria-label "Send <name>") → POST /api/messages/sticker | channel `stickers` capability; disabled in Note mode, closed window, or while a sticker send is in flight; falls back to the 👍 sticker when Meta's catalog is unavailable |  |
| "Send a contact" (Button icon, aria-label="Send a contact", UserRound) → ContactComposer (role=dialog, aria-label="Send a contact") | search input "Search your contacts…" (≥2 chars) → contact rows → POST /api/messages/contact | channel `sendContacts` capability; disabled in Note mode / closed window |  |
| "Insert emoji" (Button icon, aria-label="Insert emoji", Smile) → EmojiPopover | search (aria-label="Search emoji"), category buttons (aria-label per category), Recent row, emoji buttons (aria-label "Insert <emoji>") → splices into the draft at the caret; Escape / outside click closes | disabled only when !isNote && windowClosed (emoji are always legal in a note) |  |
| "Record voice message" (MicButton, aria-label="Record voice message") | starts MediaRecorder; the toolbar row is replaced by RecordingBar | disabled in Note mode and with the window closed; needs mic permission |  |
| RecordingBar "Discard recording" / "Send voice message" (Button icons, aria-labels) | cancel tears the recording down; send collects the blob and POSTs /api/messages/media with voice=true (server transcodes to ogg/opus) | Send re-checks the window FIRST and refuses with a toast rather than losing the audio; auto-stops at the duration cap |  |
| "Translate this message" (Button icon, aria-label="Translate this message", Languages) → TranslatePopover | language rows → POST /api/messages/translate; preview + "Cancel" / "Apply" (replaces the draft) / "Undo" | "Type a message first." when the draft is empty; rows disabled while pending |  |
| "Refine with AI" (Button icon, aria-label="Refine with AI", Wand2) → RefinePopover | mode rows (Formalise / Friendly / Shorten / Fix grammar) → POST /api/messages/refine; preview + "Cancel" / "Apply" / "Undo" | "Type a message first." when empty; rows disabled while pending |  |
| Send button (Button, aria-label/title "Send" \| "Send media" \| "Save note") | submit() → POST /api/messages \| /api/notes \| /api/messages/media; optimistic bubble with clientTempId, 30s (90s media) abort timeout, same-content dedupe | disabled unless (attachment \|\| non-empty text) && (isNote \|\| window open) && not over the text cap; collapses to a round icon-only button below @26rem |  |
| Character counter "<n>/<max>" | read-only; turns destructive at/over the channel cap | shown only in reply mode past 85% of the cap |  |
| Blocked-contact notice (replaces the entire composer) | static text pointing at the ⋮ menu to unblock | rendered instead of the composer whenever contact.blockedAt is set |  |
| Contact-panel collapse (button, aria-label="Collapse contact panel", PanelRightClose) / expand (button, aria-label="Expand contact panel", ChevronLeft) | toggles the rail; persisted to the `contact-panel-collapsed` cookie and SSR'd | lg+ desktop rail only; the Sheet variant has no collapse |  |
| Contact-panel resize handle (role=separator, aria-label="Resize contact details panel", aria-valuemin 260 / max 520, tabIndex 0) | drag / arrow-key resize; persisted to the details-width cookie | lg+ and expanded only |  |
| Panel tabs (role=tablist, aria-label="Contact panel view"): "Details" / "Files" / "Notes" / "Flags" / "Calls" (role=tab, aria-selected; aria-label carries the count, e.g. "Notes (3)") | swaps the panel body; counts are live (notes, open flags) | labels collapse to icon-only below @21rem of panel width — select on the aria-label, not visible text |  |
| Stale-edit banner: "Reload" / "Keep mine" (buttons) | accept the remote contact update, or keep the local draft (last-write-wins via the version CAS) | Details tab only, when a teammate's contact.updated frame lands mid-edit |  |
| Contact name heading (EditableHeading — click to edit, Enter saves, Escape cancels) | PATCH /api/contacts/:id {name} with optimistic rollback | none |  |
| "Send template" (Button outline, full-width, Sparkles) inside the panel | emits the open-template-picker signal for this conversation → opens the COMPOSER's picker (no duplicated flow) | only when the channel has the templates capability (WhatsApp) |  |
| "Raise a ticket" (button, TicketPlus) | opens RaiseTicketDialog (aria-label="Raise a ticket") | none — this is the ONLY way a ticket opens on a conversation |  |
| RaiseTicketDialog fields: "Subject" (#rt-subject, autoFocus, max 200), "Cause" (#rt-cause textarea, max 5000), "Priority" (#rt-priority select), "Send to" (#rt-team select, optgroups "Teams here" / "Escalate to workspace | POST /api/tickets, then /api/tickets/:id/thread for attachments and /api/tickets/:id/escalate for a cross-workspace share; reads GET /api/workspace/assignment-policies, /api/users, /api/tickets/escalation-targets, and th | selects disabled when their list is empty; an amber banner lists tickets already open on this thread (informational, not blocking); the CAUSE is write-once after save |  |
| RaiseTicketDialog footer: "Cancel" / "Raise ticket" (submit); success state "Done" / "Open the ticket" (Link to /tickets/:id) | submit or close; success links into the created ticket | submit disabled while busy; backdrop dismiss disabled while busy |  |
| "Same person" suggestions: "Link" and "Not them" (aria-label="Dismiss <name>") per row | POST /api/customers/:profileId/link, or dismiss locally; suggestions from GET /api/customers/by-contact/:id/suggestions (exact phone / self-asserted email only) | only when another contact shares a strong key; buttons disabled while busy |  |
| "Link a channel" (+ button) → search input "Search a contact to link…" → contact rows; close X | GET /api/contacts?search=… then POST /api/customers/:profileId/link | only when a customer profile exists |  |
| Linked channel row: "Open" (Link to /inbox?c=<id>), "Here" marker, "Unlink this channel" X (aria-label, title "Not the same person — split off") | navigate to the sibling thread; POST /api/customers/:profileId/unlink (reversible split — never deletes a contact or its messages) | unlink hidden for the currently-open channel; hover-revealed; disabled while busy | **DESTRUCTIVE** |
| Person-name rename (button, title="Rename this person") → Input + "Save name" (aria-label) | PATCH /api/customers/:id {name}; Enter saves, Escape cancels | only when the person has >1 linked channel |  |
| "Refresh profile from <Channel>" (button, aria-label + title, RefreshCw) | POST /api/contacts/:id/sync-profile | only for channels whose profile can be re-fetched; disabled while syncing |  |
| Read-only rows: "Phone", "Username" (@handle), "Instagram" (verified/followers/follow-back), "Messenger" (gender·language·local time), "First contacted", acquisition row | display only; the acquisition row does GET /api/contacts/:id/acquisition and renders nothing for an organic contact | each row appears only when its data exists; phone is deliberately NOT editable (it is the WhatsApp identity) |  |
| Editable rows "First name", "Last name", "Email" (+ a mailto: action icon, aria-label "Email <address>"), "Location", "Language", "Country" (EditableField — click the value, Enter commits, Escape cancels, blur commits) | PATCH /api/contacts/:id with the single changed field, optimistic with rollback | each row renders only when its builtin is enabled for the workspace |  |
| Team-wide custom fields: select-type → ContactFieldSelectPicker; text-type → EditableField | PATCH /api/contacts/:id {customFields:{key:value\|null}} | admin-hidden definitions (isVisible false) never paint; the picker's manage-options entries need contactFields:manage |  |
| Per-contact one-off field rows: value edit + "Remove <label>" (button, aria-label, Trash2) | confirm ("Remove <label>?" / "This clears the field from this contact.") then PATCH sets the key to null | hover-revealed | **DESTRUCTIVE** |
| "Add field" (dashed button) → name Input (placeholder "Field name (e.g. Order ID)") + scope chips "Just this contact" / "All contacts" + "Cancel" / "Add" | per-contact scope writes the key onto this contact only; team scope POSTs /api/workspace/contact-fields then refreshes | the scope chips render only with contactFields:manage (without it, everything is per-contact); Add disabled until the label is non-empty |  |
| Tags section: per-tag TagChip remove X, "+" TagAddButton → TagMultiPicker (search + create) | POST /api/contacts/:id/tags with the full id list; creating a tag adds it to the catalog and applies it | creating/deleting catalog tags needs tags:manage (agents default true) | **DESTRUCTIVE** |
| AI panel "AI Customer Understanding": per-memory "Confirm" (title="Confirm") and "Remove" (title="Remove") | PATCH /api/ai-assistant/memory/:id (confirm) and DELETE /api/ai-assistant/memory/:id | whole panel hidden when the assistant is disabled for the workspace | **DESTRUCTIVE** |
| AI panel "Summary for a date range": From/To date inputs (aria-label "From date"/"To date") + "View summary" | GET /api/ai-assistant/conversations/:id/summary?from&to | button disabled until both dates are set / while loading |  |
| AI panel "Latest Session Summary" and "AI Reliability" (hallucination rate + flagged list) | read-only, from the shared /overview fetch (AiOverviewProvider — one request per thread, also feeding the per-bubble hallucination badge) | Reliability section only when scoredCount > 0 |  |
| Files tab: kind filter chips (All / Images / Videos / Audio / Documents) | narrows the gallery; GET /api/conversations/:id/attachments with infinite scroll | none |  |
| Files tab: media tile (button, title = caption/filename/date) | opens MediaLightbox at that item | images/videos only |  |
| Files tab: file row "Open" / "Jump" (title="Jump to message") | openAttachment() in a new tab / jump the thread to the source bubble | documents + audio rows |  |
| MediaLightbox (role=dialog, aria-label="Attachment preview"): "Zoom in"/"Zoom out", "Download" (anchor to <url>?download=1 — server sets Content-Disposition), "Go to message", "Close", "Previous"/"Next", backdrop click,  | navigate/zoom/download; "Go to message" closes the lightbox and scroll-flashes the bubble | zoom only for images; prev/next only with >1 item |  |
| Notes tab: note card (button, title="Jump to this note in the chat") | dispatches `ccp:jump-to-note` → the thread scrolls to that note | empty state "No internal notes yet" |  |
| Flags tab: flag row body (button, title="Jump to this message") | onGoToMessage(flag.messageId) | list from GET /api/message-flags?conversationId=… |  |
| Flags tab row actions: "Mark resolved" / "Dismiss — this wasn't one" / "Reopen" (IconAction buttons, aria-label = the label) | PATCH /api/message-flags/:id {status: resolved\|dismissed\|open} | raising/resolving flags is deliberately ungated for every role; hover-revealed on pointer devices, always shown on touch |  |
| Calls tab: per-row "Call back", plus "Load older calls" and "Try again" | initiateOutbound for that call's channel+account; keyset-paginated call history for this conversation | Call-back only with calls:make; disabled while a call is being placed |  |
| Contact-details Sheet (mobile/tablet) — the same ContactPanel content with the Sheet's own close X | opened by the header "Contact details" button; "Go to message" closes the sheet first | below lg only; unmounted when closed so the panel's live listeners don't double-run |  |
| Dev tools floating panel (button, aria-label="Toggle dev tools", Wrench) + fake-event ActionButtons | POST /api/dev/emit to fire fake realtime events | returns null in production; also needs ENABLE_DEV_TOOLS=1 plus a server-side session check |  |
| AiToggle (message-thread/ai-toggle.tsx → POST /api/conversations/:id/ai) | DEAD CODE — the per-conversation AI Autopilot switch was removed from the thread header and the component is no longer imported anywhere. Not reachable in a browser. | n/a |  |
| reorderViews (contexts/inbox-views-context.tsx → POST /api/inbox-views/reorder) | NO UI — there is no drag handle for saved views; the context method is called by nothing. | n/a |  |
