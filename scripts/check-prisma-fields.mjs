#!/usr/bin/env node
/**
 * Static check: every Prisma `select` / `include` / `_count` / `where` /
 * `data` / `orderBy` key must exist on the model it is written against.
 *
 * WHY THIS EXISTS. Prisma's generated types are XOR unions, which defeat
 * TypeScript's excess-property checking — a key that does not exist on the
 * model COMPILES CLEAN and only fails when a request actually runs it, as a
 * 400 `invalid_request` or a P2022. `tsc` being green proves nothing about a
 * field rename. This has bitten this repo three times:
 *
 *   - `Conversation.lastAssignedUserId` missing from a migration  → prod inbox down
 *   - `Workspace._count.users` (renamed to `members`)             → platform page 500
 *   - `Workspace.statusReason` (moved to Organization)            → signup broke at /pending
 *
 * All three were invisible to typecheck and lint. This script catches the
 * second and third classes in about a second.
 *
 * HOW IT WORKS. Parses `prisma/schema.prisma` into model → field-set, then
 * walks every `db.<model>.<op>({ ... })` call, descending through nested
 * `select` / `include` blocks while tracking WHICH model each level refers to
 * (by following relation fields). A key that is not a field of the current
 * model is reported.
 *
 * FALSE-POSITIVE DISCIPLINE. It only judges keys whose enclosing model it is
 * certain of. Anything it cannot resolve — a spread, a computed key, an
 * unfamiliar operator — is SKIPPED rather than guessed at. A checker that
 * cries wolf gets ignored, and then it protects nothing.
 *
 * Usage:  node scripts/check-prisma-fields.mjs
 * Exit 0 = clean, 1 = stale field references found.
 */

import fs from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const SCHEMA = path.join(ROOT, "prisma", "schema.prisma");
// tests/, prisma/seeds and scripts/ scan too (2026-07-26): a fixture or seed
// written against a renamed field is exactly how a "green" suite silently
// stops testing reality — the meta harness carried a dropped column
// (`Workspace.ticketAutoOpen`) for a day and broke every meta spec at seed.
const SCAN_DIRS = ["apps/api/src", "apps/web/src", "tests", "prisma/seeds", "scripts"];

/** Prisma operators that may appear inside a select/include object. */
const PASSTHROUGH_KEYS = new Set([
  "select", "include", "where", "orderBy", "take", "skip", "cursor",
  "distinct", "by", "having", "_count", "_sum", "_avg", "_min", "_max", "_all",
  "omit", "relationLoadStrategy",
]);

// ---------------------------------------------------------------- schema ----

function parseSchema(text) {
  const models = new Map(); // name -> Map(field -> relatedModel|null)
  let current = null;
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    const open = /^model\s+(\w+)\s*\{/.exec(line);
    if (open) {
      current = new Map();
      models.set(open[1], current);
      continue;
    }
    if (current && line === "}") {
      current = null;
      continue;
    }
    if (current && (line.startsWith("@@unique") || line.startsWith("@@id"))) {
      // A compound `@@unique([userId, workspaceId])` generates a SYNTHETIC
      // `findUnique` key `userId_workspaceId` (or `name:` when given). It is a
      // legal `where` key but not a model field, so it must be registered or
      // every composite lookup in the repo reports as stale — the fastest way
      // to make a checker worth ignoring.
      const named = /name:\s*"([^"]+)"/.exec(line);
      const list = /\[([^\]]+)\]/.exec(line);
      if (list) {
        const parts = list[1].split(",").map((x) => x.trim()).filter(Boolean);
        if (parts.length > 1) current.set(named ? named[1] : parts.join("_"), null);
      }
      continue;
    }
    if (!current || line.startsWith("@@") || line.startsWith("//") || !line) continue;
    const field = /^(\w+)\s+(\w+)(\[\])?/.exec(line);
    if (!field) continue;
    const [, name, type] = field;
    current.set(name, type); // type may name another model; resolved lazily
  }
  return models;
}

const schemaText = fs.readFileSync(SCHEMA, "utf8");
const MODELS = parseSchema(schemaText);

// ---------------------------------------------------------- tenancy gate ----
//
// "workspaceId on every table" (CLAUDE.md §7) has EXPLICIT exceptions, each
// annotated with a TENANCY EXCEPTION note in schema.prisma: tenant-root /
// auth tables, and child tables reachable only through a workspace-carrying
// parent (parent-first query pattern). This gate turns that convention into
// a tripwire — a NEW model without workspaceId fails CI until it's either
// given the column or deliberately allowlisted here WITH the schema note.
const TENANTLESS_ALLOWLIST = new Set([
  // Tenant roots + org-scoped directory
  "Organization", "Workspace", "User",
  // Better Auth-owned tables (Session.activeWorkspaceId is candidate data,
  // validated on every read — see resolveActiveWorkspaceId)
  "Session", "Account", "Verification",
  // Deliberately platform-level (pre-tenant, keyed by email)
  "LoginAttempt",
  // Parent-scoped children (see each model's TENANCY EXCEPTION note)
  "BroadcastRecipient", "OutboundWebhookDelivery",
  "TeamChannelMember", "TeamChannelMention", "TeamChannelReaction",
  "TeamChannelPin", "TeamChannelReadReceipt",
  // Cross-workspace bridge: deliberately spans TWO workspaces (source+target
  // columns, no single workspaceId); reached only through a workspace-scoped
  // query on one of its two tickets (see its TENANCY EXCEPTION note)
  "TicketEscalation",
]);
{
  const missing = [];
  for (const [name, fields] of MODELS) {
    if (!fields.has("workspaceId") && !TENANTLESS_ALLOWLIST.has(name)) {
      missing.push(name);
    }
  }
  const stale = [...TENANTLESS_ALLOWLIST].filter(
    (name) => MODELS.has(name) && MODELS.get(name).has("workspaceId"),
  );
  if (missing.length > 0 || stale.length > 0) {
    for (const name of missing) {
      console.error(
        `✖ tenancy gate: model \`${name}\` has no workspaceId and is not in ` +
          "the TENANTLESS_ALLOWLIST (scripts/check-prisma-fields.mjs). Give it " +
          "the column, or allowlist it WITH a TENANCY EXCEPTION note in schema.prisma.",
      );
    }
    for (const name of stale) {
      console.error(
        `✖ tenancy gate: \`${name}\` is allowlisted but HAS workspaceId — remove it from TENANTLESS_ALLOWLIST.`,
      );
    }
    process.exit(1);
  }
}

/** `db.workspace` -> `Workspace`. Prisma lowercases the first letter. */
const BY_DELEGATE = new Map();
for (const name of MODELS.keys()) {
  BY_DELEGATE.set(name[0].toLowerCase() + name.slice(1), name);
}

/** Model reached by following `field` from `model`, or null if scalar. */
function relationTarget(model, field) {
  const fields = MODELS.get(model);
  if (!fields) return null;
  const type = fields.get(field);
  return type && MODELS.has(type) ? type : null;
}

/**
 * Blank out comments and string/template literals, preserving length and line
 * breaks so reported line numbers stay accurate.
 *
 * Without this the brace/colon scanner reads prose as code: a comment
 * containing "... assign it anyway: the row" yields a phantom key `anyway`,
 * and a nearby function name lands as a field. Those false alarms are exactly
 * what makes a checker get ignored.
 */
function scrub(src) {
  const out = src.split("");
  let i = 0;
  const blank = (a, b) => {
    for (let k = a; k < b && k < out.length; k++) if (out[k] !== "\n") out[k] = " ";
  };
  while (i < src.length) {
    const two = src.slice(i, i + 2);
    if (two === "//") {
      const end = src.indexOf("\n", i);
      blank(i, end === -1 ? src.length : end);
      i = end === -1 ? src.length : end;
    } else if (two === "/*") {
      const end = src.indexOf("*/", i + 2);
      blank(i, end === -1 ? src.length : end + 2);
      i = end === -1 ? src.length : end + 2;
    } else if (src[i] === '"' || src[i] === "'" || src[i] === "`") {
      const q = src[i];
      let j = i + 1;
      while (j < src.length && src[j] !== q) {
        if (src[j] === "\\") j++;
        j++;
      }
      blank(i + 1, j);
      i = j + 1;
    } else {
      i++;
    }
  }
  return out.join("");
}

// ------------------------------------------------------------- scanning ----

function walkFiles(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) walkFiles(p, out);
    else if (/\.tsx?$/.test(entry.name)) out.push(p);
  }
  return out;
}

/** Balanced-brace slice starting at the `{` at `start`. */
function block(src, start) {
  let depth = 0;
  for (let i = start; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") {
      depth--;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  return null;
}

/**
 * Top-level `key: value` pairs of an object literal. Returns the key, and the
 * index of its value's `{` when the value is an object literal.
 */
function topLevelEntries(objSrc, { shorthand = false } = {}) {
  const out = [];
  let depth = 0;
  for (let i = 0; i < objSrc.length; i++) {
    const c = objSrc[i];
    if (c === "{" || c === "[" || c === "(") depth++;
    else if (c === "}" || c === "]" || c === ")") {
      depth--;
      // Shorthand property just before a closing brace: `{ workspaceId }`.
      if (shorthand && depth === 0 && c === "}") collectShorthand(objSrc, i, out);
    } else if (shorthand && c === "," && depth === 1) {
      // Shorthand property just before a comma: `{ workspaceId, x: 1 }`.
      collectShorthand(objSrc, i, out);
    } else if (c === ":" && depth === 1) {
      // Walk back to the key.
      let j = i - 1;
      while (j >= 0 && /\s/.test(objSrc[j])) j--;
      let end = j + 1;
      while (j >= 0 && /[\w$]/.test(objSrc[j])) j--;
      const key = objSrc.slice(j + 1, end);
      // Identifiers only. A bare number or an empty capture means we drifted
      // out of an object literal (ternaries, types, labels) — skip rather than
      // report something we are not sure about.
      if (!key || !/^[A-Za-z_$][\w$]*$/.test(key)) continue;
      // A REAL key is preceded by `{`, `,` or nothing. Anything else means the
      // colon belongs to a ternary (`cond ? null : x`, `y as const : z`) or a
      // type annotation — the exact shapes that made the data-walker report
      // `null` / `const` / `never` as fields. Skip, don't guess.
      let p = j;
      while (p >= 0 && /\s/.test(objSrc[p])) p--;
      if (p >= 0 && objSrc[p] !== "{" && objSrc[p] !== ",") continue;
      // Walk forward to the value.
      let k = i + 1;
      while (k < objSrc.length && /\s/.test(objSrc[k])) k++;
      out.push({ key, valueStart: objSrc[k] === "{" ? k : -1 });
    }
  }
  return out;
}

/**
 * A shorthand property is an identifier terminated by `,` or `}` with no colon
 * — `where: { workspaceId, deletedAt: null }`. The colon-driven scanner above
 * cannot see it, which is precisely how a `User.workspaceId` filter survived a
 * tenancy rename: the failing key was the one written in shorthand.
 */
function collectShorthand(objSrc, endIdx, out) {
  let j = endIdx - 1;
  while (j >= 0 && /\s/.test(objSrc[j])) j--;
  const end = j + 1;
  while (j >= 0 && /[\w$]/.test(objSrc[j])) j--;
  const key = objSrc.slice(j + 1, end);
  if (!key || !/^[A-Za-z_$][\w$]*$/.test(key)) return;
  // A genuine shorthand key is preceded by `{` or `,` (or nothing). Anything
  // else — `:` `.` `?` of a value expression, but also the `|` of `x || null`,
  // the `+` of `a + index`, the `s` of `as const` — means this identifier is
  // the TAIL OF A VALUE, not a key. That class produced phantom `null` /
  // `index` / `const` fields on the first data-walker run. Skip, don't guess.
  let k = j;
  while (k >= 0 && /\s/.test(objSrc[k])) k--;
  if (k >= 0 && objSrc[k] !== "{" && objSrc[k] !== ",") return;
  out.push({ key, valueStart: -1 });
}

const problems = [];

/** Validate an object literal whose keys are fields of `model`. */
function checkObject(file, src, absOffset, objSrc, model, ctx) {
  if (!MODELS.has(model)) return;
  for (const { key, valueStart } of topLevelEntries(objSrc)) {
    if (PASSTHROUGH_KEYS.has(key)) {
      // Descend, staying on the same model (select/include/_count of it).
      if (valueStart !== -1) {
        const inner = block(objSrc, valueStart);
        if (inner) checkObject(file, src, absOffset + valueStart, inner, model, ctx);
      }
      continue;
    }
    const fields = MODELS.get(model);
    if (!fields.has(key)) {
      const line = src.slice(0, absOffset).split("\n").length;
      problems.push({ file, line, model, key, ctx });
      continue;
    }
    // Known relation → descend into it with the RELATED model.
    if (valueStart !== -1) {
      const target = relationTarget(model, key);
      const inner = block(objSrc, valueStart);
      if (target && inner) checkObject(file, src, absOffset + valueStart, inner, target, ctx);
    }
  }
}

/**
 * Logical combinators that hold another WHERE at the SAME model.
 */
const WHERE_LOGICAL = new Set(["AND", "OR", "NOT"]);

/**
 * Relation-filter operators that hold a WHERE at the RELATED model.
 */
const RELATION_FILTERS = new Set(["some", "every", "none", "is", "isNot"]);

/**
 * Validate the TOP-LEVEL keys of a `where` object against the model's fields.
 *
 * Deliberately shallower than the select/include walker. A `where` value can be
 * a scalar, a filter object (`{ in: [...] }`, `{ not: null }`, `{ contains: … }`),
 * or a relation filter, and modelling every operator would produce false alarms
 * — which is how a checker earns its way into being ignored. So: judge the KEYS,
 * follow only the constructs whose meaning is unambiguous (AND/OR/NOT, and
 * some/every/none/is/isNot on a known relation), and skip everything else.
 *
 * That is enough to catch the class this exists for: a field that was RENAMED
 * or MOVED, filtered on by name. `User.workspaceId` survived the Team →
 * Workspace tenancy rename in the realtime gateway and only surfaced as a
 * runtime PrismaClientValidationError on every socket connect.
 *
 * (`data` has its own walker now — see checkData — after the blind spot bit
 * twice: the `User.role` nested-write prod crash, and the e2e harness seeding
 * a dropped `Workspace.ticketAutoOpen` for a day.)
 */
function checkWhere(file, src, absOffset, objSrc, model, ctx) {
  if (!MODELS.has(model)) return;
  const fields = MODELS.get(model);
  for (const { key, valueStart } of topLevelEntries(objSrc, { shorthand: true })) {
    if (WHERE_LOGICAL.has(key)) {
      // `AND: { … }` or `AND: [ { … }, { … } ]` — same model either way.
      if (valueStart !== -1) {
        const inner = block(objSrc, valueStart);
        if (inner) checkWhere(file, src, absOffset + valueStart, inner, model, ctx);
      } else {
        for (const b of arrayObjects(objSrc, key)) {
          checkWhere(file, src, absOffset + b.at, b.src, model, ctx);
        }
      }
      continue;
    }
    if (!fields.has(key)) {
      const line = src.slice(0, absOffset).split("\n").length;
      problems.push({ file, line, model, key, ctx: `${ctx} where` });
      continue;
    }
    // A relation filter descends with the RELATED model.
    const target = relationTarget(model, key);
    if (target && valueStart !== -1) {
      const inner = block(objSrc, valueStart);
      if (!inner) continue;
      for (const { key: op, valueStart: opStart } of topLevelEntries(inner)) {
        if (!RELATION_FILTERS.has(op) || opStart === -1) continue;
        const nested = block(inner, opStart);
        if (nested) checkWhere(file, src, absOffset + valueStart + opStart, nested, target, ctx);
      }
    }
  }
}

/**
 * Nested-write operators that may appear under a RELATION field inside `data`,
 * mapped to how their payload is routed. Anything not listed is SKIPPED (the
 * file's false-positive discipline): `connect`/`disconnect`/`set` take
 * where-unique shapes already covered by checkWhere's key registry.
 */
const NESTED_WRITE_OPS = new Set([
  "create", "createMany", "connectOrCreate", "update", "updateMany",
  "upsert", "delete", "deleteMany", "connect", "disconnect", "set",
]);

/**
 * Validate a `data` object's keys against the model's fields, descending into
 * nested writes on relation fields.
 *
 * WHY (2026-07-26): `data` was the checker's last blind spot, and it bit twice
 * — a `User.role` nested write crashed every role change in prod, and the e2e
 * meta harness kept seeding a DROPPED column (`Workspace.ticketAutoOpen`),
 * which compiled clean and failed only when the suite ran. Same XOR-union
 * story as select/where: tsc proves nothing here.
 *
 * Discipline: judge the KEYS; never judge values. A scalar field's value may
 * be an operator object (`{ increment: 1 }`, `{ set: [...] }`) — the key was
 * already validated, so we do NOT descend into it. Only a RELATION field's
 * value is entered, and only through the unambiguous operator routes below.
 */
function checkData(file, src, absOffset, objSrc, model, ctx) {
  if (!MODELS.has(model)) return;
  const fields = MODELS.get(model);
  for (const { key, valueStart } of topLevelEntries(objSrc, { shorthand: true })) {
    if (!fields.has(key)) {
      const line = src.slice(0, absOffset).split("\n").length;
      problems.push({ file, line, model, key, ctx: `${ctx} data` });
      continue;
    }
    const target = relationTarget(model, key);
    if (!target || valueStart === -1) continue; // scalar (or non-object value) — done
    const inner = block(objSrc, valueStart);
    if (!inner) continue;
    for (const { key: op, valueStart: opStart } of topLevelEntries(inner)) {
      if (!NESTED_WRITE_OPS.has(op)) continue;
      const route = (payloadAt, payloadSrc) =>
        routeNestedWrite(file, src, payloadAt, payloadSrc, target, op, ctx);
      if (opStart !== -1) {
        const payload = block(inner, opStart);
        if (payload) route(absOffset + valueStart + opStart, payload);
      } else {
        // Array form: `create: [ {…}, {…} ]`, `connect: [ {…} ]`, …
        for (const b of arrayObjects(inner, op)) {
          route(absOffset + valueStart + b.at, b.src);
        }
      }
    }
  }
}

/** Route one nested-write payload object to data/where checking on `model`. */
function routeNestedWrite(file, src, absOffset, objSrc, model, op, ctx) {
  const entries = topLevelEntries(objSrc, { shorthand: true });
  const keys = new Set(entries.map((e) => e.key));
  const sub = (name, fn) => {
    for (const e of entries) {
      if (e.key !== name || e.valueStart === -1) continue;
      const inner = block(objSrc, e.valueStart);
      if (inner) fn(absOffset + e.valueStart, inner);
    }
  };
  switch (op) {
    case "create":
      return checkData(file, src, absOffset, objSrc, model, ctx);
    case "createMany":
      // `{ data: {…} | [{…}] }`
      sub("data", (at, inner) => checkData(file, src, at, inner, model, ctx));
      for (const b of arrayObjects(objSrc, "data")) {
        checkData(file, src, absOffset + b.at, b.src, model, ctx);
      }
      return;
    case "connectOrCreate":
    case "upsert":
      sub("where", (at, inner) => checkWhere(file, src, at, inner, model, ctx));
      sub("create", (at, inner) => checkData(file, src, at, inner, model, ctx));
      sub("update", (at, inner) => checkData(file, src, at, inner, model, ctx));
      return;
    case "updateMany":
      sub("where", (at, inner) => checkWhere(file, src, at, inner, model, ctx));
      sub("data", (at, inner) => checkData(file, src, at, inner, model, ctx));
      return;
    case "update":
      // To-many: `{ where, data }`. To-one: the object IS the data.
      if (keys.has("where") || keys.has("data")) {
        sub("where", (at, inner) => checkWhere(file, src, at, inner, model, ctx));
        sub("data", (at, inner) => checkData(file, src, at, inner, model, ctx));
        return;
      }
      return checkData(file, src, absOffset, objSrc, model, ctx);
    case "connect":
    case "disconnect":
    case "set":
    case "delete":
    case "deleteMany":
      // Where(-unique) shapes; composite keys are registered as synthetic
      // fields, so checkWhere judges them correctly.
      return checkWhere(file, src, absOffset, objSrc, model, ctx);
  }
}

/**
 * Validate `orderBy` keys. Shapes: `{ field: "asc" }`, `{ relation: { field:
 * "desc" } }`, `{ field: { sort: "asc", nulls: "last" } }`, `{ _count: … }`,
 * or an array of these. Judge the keys; descend only into relations.
 */
function checkOrderBy(file, src, absOffset, objSrc, model, ctx) {
  if (!MODELS.has(model)) return;
  const fields = MODELS.get(model);
  for (const { key, valueStart } of topLevelEntries(objSrc)) {
    if (key === "_count" || key === "_relevance") continue;
    if (!fields.has(key)) {
      const line = src.slice(0, absOffset).split("\n").length;
      problems.push({ file, line, model, key, ctx: `${ctx} orderBy` });
      continue;
    }
    const target = relationTarget(model, key);
    if (target && valueStart !== -1) {
      const inner = block(objSrc, valueStart);
      if (inner) checkOrderBy(file, src, absOffset + valueStart, inner, target, ctx);
    }
    // Scalar with an object value = `{ sort, nulls }` — key already judged.
  }
}

/** Object literals inside `key: [ {…}, {…} ]` at the top level of `objSrc`. */
function arrayObjects(objSrc, key) {
  const out = [];
  const re = new RegExp(`\\b${key}\\s*:\\s*\\[`, "g");
  const m = re.exec(objSrc);
  if (!m) return out;
  let depth = 0;
  for (let i = m.index + m[0].length - 1; i < objSrc.length; i++) {
    const c = objSrc[i];
    if (c === "[") depth++;
    else if (c === "]") {
      depth--;
      if (depth === 0) break;
    } else if (c === "{" && depth === 1) {
      const b = block(objSrc, i);
      if (b) {
        out.push({ at: i, src: b });
        i += b.length - 1;
      }
    }
  }
  return out;
}

const OPS = "findMany|findFirst|findFirstOrThrow|findUnique|findUniqueOrThrow|update|updateMany|upsert|create|createMany|delete|deleteMany|count|aggregate|groupBy";
// Whitespace around the dot is REQUIRED, not cosmetic: prettier breaks a long
// chain as `this.db.user\n  .findMany({`, and a dot-must-be-adjacent regex
// skipped exactly that shape — which is where the `User.workspaceId` filter
// that broke every socket connect was hiding.
const CALL = new RegExp(`\\b(\\w+)\\s*\\.\\s*(${OPS})\\s*\\(\\s*\\{`, "g");

for (const dir of SCAN_DIRS) {
  for (const file of walkFiles(path.join(ROOT, dir))) {
    const src = scrub(fs.readFileSync(file, "utf8"));
    for (const m of src.matchAll(CALL)) {
      const model = BY_DELEGATE.get(m[1]);
      if (!model) continue; // not a Prisma delegate we recognise — skip, don't guess
      const braceAt = m.index + m[0].length - 1;
      const args = block(src, braceAt);
      if (!args) continue;
      // `select` / `include` / `_count` name model fields directly; `where`
      // names them too, but its values are a filter grammar — see checkWhere;
      // `data` is the write grammar — see checkData; `orderBy` the sort one.
      // In an `upsert`, the top-level `create` and `update` args are data.
      for (const { key, valueStart } of topLevelEntries(args)) {
        const rel = path.relative(ROOT, file);
        const ctx = `${m[1]}.${m[2]}`;
        if (valueStart === -1) {
          // Array-valued args: `data: [ {…} ]` (createMany), `orderBy: [ {…} ]`.
          if (key === "data") {
            for (const b of arrayObjects(args, "data")) {
              checkData(rel, src, braceAt + b.at, b.src, model, ctx);
            }
          } else if (key === "orderBy") {
            for (const b of arrayObjects(args, "orderBy")) {
              checkOrderBy(rel, src, braceAt + b.at, b.src, model, ctx);
            }
          }
          continue;
        }
        const inner = block(args, valueStart);
        if (!inner) continue;
        if (key === "select" || key === "include") {
          checkObject(rel, src, braceAt + valueStart, inner, model, ctx);
        } else if (key === "where") {
          checkWhere(rel, src, braceAt + valueStart, inner, model, ctx);
        } else if (key === "data" || (m[2] === "upsert" && (key === "create" || key === "update"))) {
          checkData(rel, src, braceAt + valueStart, inner, model, ctx);
        } else if (key === "orderBy") {
          checkOrderBy(rel, src, braceAt + valueStart, inner, model, ctx);
        }
      }
    }
  }
}

if (problems.length === 0) {
  console.log("✔ prisma field check: no stale select/include/where keys");
  process.exit(0);
}

console.error("✖ prisma field check — these compile clean but fail at RUNTIME:\n");
for (const p of problems) {
  console.error(`  ${p.file}:${p.line}`);
  console.error(`     ${p.ctx} → \`${p.key}\` is not a field of model \`${p.model}\``);
}
console.error(`\n${problems.length} stale field reference(s).`);
process.exit(1);
