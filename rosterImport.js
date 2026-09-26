// A school's whole transport roster in one file: the child, their Student ID, class,
// guardian, the parent's sign-in email, and the route and stop they ride from.
//
// The old import took four columns and stopped there. A school that imported 1,200
// children then had to link every parent and assign every stop by hand, and the roster
// looked complete while half the families could not sign in and half the children read
// "No bus assigned". This takes everything a child needs to be ready in one pass.
//
// Two rules make it safe to use on a real school:
//
//   - Nothing half-happens. `planRoster` reads and decides; nothing is written unless
//     every row is clean, and then all of it is written in one transaction. The same
//     plan answers a dry run, so what the office previews is exactly what will happen.
//
//   - Running the same file twice changes nothing. A row whose Student ID is already
//     in this school is that child: it fills what is missing (a parent, a stop, a
//     class) and never overwrites what is there. Anything that DISAGREES with the
//     record (another parent's email, another stop) is a correction for a person to
//     make on the student's page, never something an upload silently changes.
//
// No passwords come back. A new parent's account opens with a lock nobody knows; the
// school sends each family their own invite from the activation page (parentInvites.js).

const norm = (s) => String(s ?? '').trim().replace(/\s+/g, ' ').toLowerCase();
const blank = (s) => s == null || String(s).trim() === '';

// Where each row ends up, in the office's words. One state per row, so a 1,200-row
// result can be counted and filtered rather than read.
const STATES = {
  NEEDS_CORRECTION: 'NEEDS_CORRECTION', // an error; nothing in the file is imported
  INVITE_READY: 'INVITE_READY', //         new parent account made; send the invite
  EXISTING_PARENT_LINKED: 'EXISTING_PARENT_LINKED', // a parent already here (a sibling's)
  PARENT_LINKED: 'PARENT_LINKED', //       already linked before this file
  NO_PARENT: 'NO_PARENT', //               no parent email: the family cannot sign in
};

/**
 * Decide what importing `rows` into `schoolId` would do. Reads only.
 *
 * `db` is a Prisma client or transaction. Rows are already validated by
 * schemas.rosterRow (trimmed, emails lowercased, empty cells null).
 */
async function planRoster(db, schoolId, rows) {
  const tags = [...new Set(rows.map((r) => r.rfidTag))];
  const emails = [...new Set(rows.map((r) => r.parentEmail).filter(Boolean))];
  const tokens = [...new Set(rows.map((r) => r.qrToken).filter(Boolean))];

  const [existingStudents, cardHolders, users, routes] = await Promise.all([
    db.student.findMany({
      where: { rfidTag: { in: tags } },
      select: {
        id: true, schoolId: true, rfidTag: true, name: true, grade: true, guardianPhone: true,
        parentId: true, qrToken: true, qrCodeImported: true,
        parent: { select: { email: true } },
        routeMappings: { select: { routeStopId: true, routeStop: { select: { name: true, routeId: true, route: { select: { name: true } } } } } },
      },
    }),
    tokens.length
      ? db.student.findMany({ where: { schoolId, qrToken: { in: tokens } }, select: { id: true, rfidTag: true, name: true, qrToken: true } })
      : [],
    // Case-insensitive: an account made as "Asha@x.com" is the same family as a row
    // that says "asha@x.com", and a second account for them would split the children.
    emails.length
      ? db.user.findMany({
          where: { OR: emails.map((email) => ({ email: { equals: email, mode: 'insensitive' } })) },
          select: { id: true, email: true, role: true, schoolId: true, phone: true },
        })
      : [],
    db.route.findMany({ where: { schoolId }, select: { id: true, name: true, stops: { select: { id: true, name: true } } } }),
  ]);

  const studentByTag = new Map(existingStudents.map((s) => [s.rfidTag, s]));
  const userByEmail = new Map(users.map((u) => [norm(u.email), u]));
  const cardByToken = new Map(cardHolders.map((s) => [s.qrToken, s]));
  const routesByName = new Map();
  for (const r of routes) {
    const key = norm(r.name);
    routesByName.set(key, [...(routesByName.get(key) || []), r]);
  }

  // Duplicates inside the file. Student IDs compare without case: "r042" and "R042" on
  // two rows are one card number typed twice far more often than two children.
  const count = (key) => {
    const m = new Map();
    for (const r of rows) {
      const k = key(r);
      if (k) m.set(k, (m.get(k) || 0) + 1);
    }
    return m;
  };
  const tagCounts = count((r) => norm(r.rfidTag));
  const tokenCounts = count((r) => r.qrToken);

  // Siblings share a parent: the first row with an email makes the account and the
  // rest link to it. Names disagreeing across those rows is worth saying, not failing.
  const firstRowFor = new Map();

  const planned = rows.map((r, i) => {
    const line = r.line ?? i + 1;
    const errors = [];
    const warnings = [];
    const changes = [];
    const existing = studentByTag.get(r.rfidTag);
    const mine = existing && existing.schoolId === schoolId ? existing : null;

    if (tagCounts.get(norm(r.rfidTag)) > 1) errors.push(`Student ID ${r.rfidTag} appears on more than one row.`);
    if (existing && !mine) errors.push(`Student ID ${r.rfidTag} is already in use. Each child needs their own Student ID.`);
    if (mine && norm(mine.name) !== norm(r.name)) {
      // The one check that stops a typo in an ID from attaching a parent to the wrong child.
      errors.push(`Student ID ${r.rfidTag} belongs to ${mine.name}, not ${r.name}. Check the ID.`);
    }

    // ── Card ────────────────────────────────────────────────
    let card = mine ? 'KEPT' : r.qrToken ? 'IMPORTED' : 'GENERATED';
    if (r.qrToken) {
      if (tokenCounts.get(r.qrToken) > 1) errors.push('This card code appears on more than one row.');
      const holder = cardByToken.get(r.qrToken);
      if (holder && holder.id !== mine?.id) errors.push(`Card code is already on ${holder.name}'s card (Student ID ${holder.rfidTag}).`);
      if (mine && mine.qrToken !== r.qrToken) {
        if (mine.qrCodeImported) errors.push(`${mine.name} already has a different card code. Change it on the student's page.`);
        else { card = 'ATTACH'; changes.push('card code added'); }
      }
    }

    // ── Parent ──────────────────────────────────────────────
    let parent = { action: 'NONE' };
    if (r.parentEmail) {
      const user = userByEmail.get(r.parentEmail);
      if (mine?.parentId) {
        if (norm(mine.parent?.email) === r.parentEmail) parent = { action: 'ALREADY', email: mine.parent.email, userId: mine.parentId };
        else errors.push(`${mine.name} is already linked to ${mine.parent?.email || 'another parent'}. Change the parent on the student's page.`);
      } else if (user) {
        if (user.role !== 'PARENT' || user.schoolId !== schoolId) {
          errors.push(`${r.parentEmail} belongs to another account and cannot be used as a parent email here.`);
        } else {
          parent = { action: 'LINK_EXISTING', email: user.email, userId: user.id };
          if (!user.phone && r.guardianPhone) parent.phone = r.guardianPhone;
          changes.push('parent linked');
        }
      } else {
        const first = firstRowFor.get(r.parentEmail);
        if (first) {
          parent = { action: 'LINK_NEW', email: r.parentEmail };
          if (r.parentName && first.parentName && norm(r.parentName) !== norm(first.parentName)) {
            warnings.push(`Row ${first.line} names this parent ${first.parentName}; that name is used.`);
          }
        } else {
          firstRowFor.set(r.parentEmail, { line, parentName: r.parentName });
          parent = { action: 'NEW', email: r.parentEmail, name: r.parentName || `Parent of ${r.name}`, phone: r.guardianPhone || null };
        }
        changes.push('parent account created');
      }
    } else if (mine?.parentId) {
      parent = { action: 'ALREADY', email: mine.parent?.email, userId: mine.parentId };
    } else if (r.parentName) {
      warnings.push('Guardian name is only kept with a parent email.');
    }

    // ── Stop ────────────────────────────────────────────────
    let stop = { action: 'NONE' };
    if (blank(r.route) !== blank(r.stop)) {
      errors.push(r.route ? 'A route needs a stop. Add the stop name.' : 'A stop needs its route. Add the route name.');
    } else if (r.route) {
      const matches = routesByName.get(norm(r.route)) || [];
      if (matches.length === 0) errors.push(`No route called "${r.route}". Use the route name exactly as it is on the Routes page.`);
      else if (matches.length > 1) errors.push(`More than one route is called "${r.route}". Rename one on the Routes page first.`);
      else {
        const route = matches[0];
        const stops = route.stops.filter((s) => norm(s.name) === norm(r.stop));
        if (stops.length === 0) errors.push(`Route ${route.name} has no stop called "${r.stop}".`);
        else if (stops.length > 1) errors.push(`Route ${route.name} has more than one stop called "${r.stop}". Rename one first.`);
        else {
          const target = stops[0];
          const held = mine?.routeMappings || [];
          if (held.some((m) => m.routeStopId === target.id)) {
            stop = { action: 'ALREADY', routeStopId: target.id, route: route.name, stop: target.name };
          } else if (held.length > 0) {
            const at = held.map((m) => `${m.routeStop.name} (${m.routeStop.route.name})`).join(', ');
            errors.push(`${mine.name} already rides from ${at}. Move the stop on the student's page.`);
          } else {
            stop = { action: 'ASSIGN', routeStopId: target.id, route: route.name, stop: target.name };
            changes.push('stop assigned');
          }
        }
      }
    } else if (mine?.routeMappings?.length) {
      const m = mine.routeMappings[0];
      stop = { action: 'ALREADY', routeStopId: m.routeStopId, route: m.routeStop.route.name, stop: m.routeStop.name };
    }

    // ── Plain fields: fill, never overwrite ─────────────────
    const fill = {};
    if (mine) {
      if (r.grade && (blank(mine.grade) || mine.grade === 'General') && r.grade !== mine.grade) { fill.grade = r.grade; changes.push('class added'); }
      if (r.guardianPhone && blank(mine.guardianPhone)) { fill.guardianPhone = r.guardianPhone; changes.push('guardian phone added'); }
    }

    const state = errors.length ? STATES.NEEDS_CORRECTION
      : parent.action === 'NEW' || parent.action === 'LINK_NEW' ? STATES.INVITE_READY
      : parent.action === 'LINK_EXISTING' ? STATES.EXISTING_PARENT_LINKED
      : parent.action === 'ALREADY' ? STATES.PARENT_LINKED
      : STATES.NO_PARENT;

    return {
      line, name: r.name, rfidTag: r.rfidTag,
      student: mine ? (changes.length ? 'UPDATE' : 'UNCHANGED') : 'NEW',
      state,
      parent: { action: parent.action, email: parent.email ?? null },
      stop: { action: stop.action, route: stop.route ?? null, stop: stop.stop ?? null },
      card,
      ready: !errors.length && parent.action !== 'NONE' && stop.action !== 'NONE',
      changes, errors, warnings,
      // Internal, for applyRoster. Stripped by publicPlan.
      _: { row: r, existingId: mine?.id ?? null, parent, stop, fill },
    };
  });

  return planned;
}

function totals(planned) {
  const t = {
    rows: planned.length, new: 0, updated: 0, unchanged: 0, needsCorrection: 0,
    parentsCreated: 0, parentsLinked: 0, noParent: 0, stopsAssigned: 0, noStop: 0, ready: 0,
  };
  const newParents = new Set();
  for (const p of planned) {
    if (p.state === STATES.NEEDS_CORRECTION) { t.needsCorrection++; continue; }
    if (p.student === 'NEW') t.new++; else if (p.student === 'UPDATE') t.updated++; else t.unchanged++;
    if (p.parent.action === 'NEW') newParents.add(p.parent.email);
    if (p.parent.action === 'LINK_EXISTING') t.parentsLinked++;
    if (p.parent.action === 'NONE') t.noParent++;
    if (p.stop.action === 'ASSIGN') t.stopsAssigned++;
    if (p.stop.action === 'NONE') t.noStop++;
    if (p.ready) t.ready++;
  }
  t.parentsCreated = newParents.size;
  return t;
}

const publicPlan = (planned) => planned.map(({ _, ...row }) => row);

/**
 * Write a clean plan. Call inside one transaction; the caller has checked there are no
 * errors. `lockedHash` is the password every new parent account opens with: a hash of a
 * random secret thrown away at once, so nobody can sign in until the school sends that
 * family its own invite.
 */
async function applyRoster(tx, schoolId, planned, { lockedHash, qrFieldsFor }) {
  const parentIds = new Map();
  let touched = 0;
  for (const p of planned) {
    const { row, existingId, parent, stop, fill } = p._;
    if (p.student === 'UNCHANGED') continue;

    let parentId = null;
    if (parent.action === 'NEW') {
      const user = await tx.user.create({
        data: {
          email: parent.email, name: parent.name, phone: parent.phone, role: 'PARENT', schoolId,
          password: lockedHash, mustResetPassword: true,
        },
        select: { id: true },
      });
      parentIds.set(parent.email, user.id);
      parentId = user.id;
    } else if (parent.action === 'LINK_NEW') {
      parentId = parentIds.get(parent.email);
    } else if (parent.action === 'LINK_EXISTING') {
      parentId = parent.userId;
      if (parent.phone) await tx.user.update({ where: { id: parent.userId }, data: { phone: parent.phone } });
    }

    let studentId = existingId;
    if (!existingId) {
      const created = await tx.student.create({
        data: {
          schoolId, rfidTag: row.rfidTag, name: row.name, grade: row.grade || 'General',
          guardianPhone: row.guardianPhone || null, parentId,
          ...qrFieldsFor(row.qrToken),
        },
        select: { id: true },
      });
      studentId = created.id;
    } else {
      const data = { ...fill };
      if (parentId && (parent.action === 'LINK_NEW' || parent.action === 'NEW' || parent.action === 'LINK_EXISTING')) data.parentId = parentId;
      if (p.card === 'ATTACH') Object.assign(data, qrFieldsFor(row.qrToken));
      if (Object.keys(data).length) await tx.student.update({ where: { id: existingId }, data });
    }

    if (stop.action === 'ASSIGN') {
      await tx.studentRouteMapping.create({ data: { studentId, routeStopId: stop.routeStopId, direction: null } });
    }
    touched++;
  }
  return touched;
}

module.exports = { planRoster, applyRoster, totals, publicPlan, STATES };
