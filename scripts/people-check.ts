/**
 * People check — the M3 acceptance gate:
 * "a student can be registered once and connected to the center; a printable
 *  QR ID card generates; a teacher can block-list a student; a duplicate
 *  phone/email triggers the match workflow instead of a duplicate person."
 *
 * Run with:  npm run check:people
 *
 * `check:isolation` proves the scoping primitives; `check:config` proves the
 * configuration surface. This one covers the paths M3 added — teachers,
 * students, blocks, identity matching and Storage — using the same predicates,
 * schemas and renderers the Server Actions use, so a cross-center leak on a
 * *new* path is caught rather than assumed.
 *
 * It needs a reachable database and cleans up after itself.
 */
import { PrismaClient, type BlockScope, type Role } from "@prisma/client";
import {
  MissingCenterScopeError,
  scopedFindById,
  scopedWhere,
} from "../lib/db/tenant-scope.ts";
import {
  canEditGlobalProfile,
  contactMatchWhere,
  matchedFields,
  normalizePhone,
} from "../lib/identity.ts";
import {
  StoragePathError,
  assertPathInCenter,
  centerObjectPath,
  isPathInCenter,
  photoExtensionFor,
  studentIdCardPath,
  studentPhotoPath,
} from "../lib/storage-paths.ts";
import {
  CARD_HEIGHT,
  CARD_WIDTH,
  parseStudentQrPayload,
  renderIdCardSvg,
  resolveCardLayout,
  studentQrPayload,
} from "../lib/id-card.ts";
import {
  blockCreateSchema,
  gradePromotionSchema,
  studentCreateSchema,
  teacherCreateSchema,
} from "../lib/validation/people.ts";

const prisma = new PrismaClient();

// Typed so a spread into a Prisma `where` keeps the enum, not `string`.
const TEACHER_ROLE: Role = "TEACHER";
const TEACHER_SCOPE: BlockScope = "TEACHER";

const SLUG_A = "people-check-a";
const SLUG_B = "people-check-b";
const SHARED_EMAIL = "people-check-shared@kayedu.test";
const SHARED_PHONE = "01012345678";
const TEACHER_EMAIL = "people-check-teacher@kayedu.test";
const LOCAL_EMAIL = "people-check-local@kayedu.test";

let failures = 0;

function check(name: string, passed: boolean, detail = "") {
  if (passed) {
    console.log(`  PASS  ${name}`);
  } else {
    failures += 1;
    console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

/** Parses like a Server Action does, and shouts if the fixture is wrong. */
function parse<T>(
  schema: { safeParse: (input: unknown) => { success: boolean; data?: T; error?: unknown } },
  input: Record<string, string>,
  label: string,
): T {
  const result = schema.safeParse(input);
  if (!result.success || result.data === undefined) {
    throw new Error(`${label} failed validation: ${JSON.stringify(result.error)}`);
  }
  return result.data;
}

async function cleanup() {
  await prisma.center.deleteMany({ where: { slug: { in: [SLUG_A, SLUG_B] } } });
  await prisma.user.deleteMany({
    where: {
      OR: [
        { email: { in: [SHARED_EMAIL, TEACHER_EMAIL, LOCAL_EMAIL] } },
        { phone: SHARED_PHONE },
      ],
    },
  });
}

/**
 * Registers a student the way `createStudentAction` does: parse the form,
 * match on verified contact, then either link the existing person or create
 * one. Takes a centerId and nothing else — same "zero code changes for a
 * second center" claim the M2 gate makes.
 */
async function registerStudent(
  centerId: string,
  form: Record<string, string>,
): Promise<{ userId: string; profileId: string; linked: boolean }> {
  const input = parse(studentCreateSchema, form, "studentCreate");

  const where = contactMatchWhere({ email: input.email, phone: input.phone });
  const existing = where ? await prisma.user.findFirst({ where }) : null;

  const userId =
    existing?.id ??
    (
      await prisma.user.create({
        data: {
          firstName: input.firstName,
          lastName: input.lastName,
          email: input.email,
          phone: input.phone,
          locale: input.locale,
        },
      })
    ).id;

  const profile = await prisma.studentProfile.create({
    data: {
      centerId,
      userId,
      studentCode: input.studentCode ?? "1001",
      parentFirstName: input.parentFirstName,
      parentPhone: input.parentPhone,
    },
  });

  return { userId, profileId: profile.id, linked: existing !== null };
}

async function main() {
  await cleanup();

  const centerA = await prisma.center.create({
    data: { slug: SLUG_A, name: "People A", themeColor: "#2563eb" },
  });
  const centerB = await prisma.center.create({
    data: { slug: SLUG_B, name: "People B", themeColor: "#16a34a" },
  });

  const gradeA1 = await prisma.grade.create({
    data: { centerId: centerA.id, name: "Grade 10" },
  });
  const gradeA2 = await prisma.grade.create({
    data: { centerId: centerA.id, name: "Grade 11" },
  });
  const gradeB1 = await prisma.grade.create({
    data: { centerId: centerB.id, name: "Grade 10" },
  });

  console.log("People check (M3 — teachers, students, blocks, identity, storage)");

  // ── 1. One person, registered at two centers ───────────────────────────
  const sharedForm = {
    locale: "en",
    firstName: "Mona",
    lastName: "Hassan",
    email: SHARED_EMAIL,
    phone: SHARED_PHONE,
    studentCode: "1001",
    parentFirstName: "Hassan",
    parentPhone: "01112345678",
  };

  const inA = await registerStudent(centerA.id, sharedForm);
  check(
    "A student registers once and is connected to the center",
    inA.linked === false && Boolean(inA.profileId),
  );

  // The same human walks into the second center. Typed with a +20 prefix and
  // a capitalised email — the same identity either way.
  const inB = await registerStudent(centerB.id, {
    ...sharedForm,
    email: SHARED_EMAIL.toUpperCase(),
    phone: "+201012345678",
  });

  check(
    "A duplicate phone/email matches the existing person instead of creating one",
    inB.linked === true && inB.userId === inA.userId,
    `A=${inA.userId} B=${inB.userId}`,
  );
  check(
    "One identity, two center profiles (no duplicate person)",
    (await prisma.user.count({ where: { email: SHARED_EMAIL } })) === 1 &&
      (await prisma.studentProfile.count({ where: { userId: inA.userId } })) === 2,
  );
  check(
    "The match reports which contact field matched",
    matchedFields(
      { email: SHARED_EMAIL, phone: "+201012345678" },
      { email: SHARED_EMAIL, phone: SHARED_PHONE },
    ).join(",") === "email,phone",
  );
  check(
    "Nothing matchable means no match at all (a blank form matches nobody)",
    contactMatchWhere({ email: null, phone: null }) === null,
  );

  // ── 2. Student codes are a center's own numbering ──────────────────────
  check(
    "The same student code may exist in a second center",
    (await prisma.studentProfile.count({ where: { studentCode: "1001" } })) === 2,
  );

  const local = await registerStudent(centerA.id, {
    locale: "en",
    firstName: "Youssef",
    lastName: "Adel",
    email: LOCAL_EMAIL,
    studentCode: "1002",
  });

  let duplicateCodeRejected = false;
  try {
    await prisma.studentProfile.create({
      data: { centerId: centerA.id, userId: local.userId, studentCode: "1002" },
    });
  } catch {
    duplicateCodeRejected = true;
  }
  check(
    "A duplicate student code inside one center is refused",
    duplicateCodeRejected,
  );

  // ── 3. Cross-center reads on every path M3 added ───────────────────────
  const teacher = await prisma.user.create({
    data: { firstName: "Sara", lastName: "Nabil", email: TEACHER_EMAIL },
  });
  const teacherInA = await prisma.membership.create({
    data: { userId: teacher.id, centerId: centerA.id, role: "TEACHER" },
  });
  const teacherInB = await prisma.membership.create({
    data: { userId: teacher.id, centerId: centerB.id, role: "TEACHER" },
  });

  const blockInA = await prisma.studentBlock.create({
    data: {
      centerId: centerA.id,
      scope: "TEACHER",
      refId: teacher.id,
      blockedUserId: inA.userId,
      reason: "check",
    },
  });

  const leaks: [string, unknown][] = [
    [
      "StudentProfile",
      await scopedFindById(prisma.studentProfile, centerA.id, inB.profileId),
    ],
    [
      "teacher Membership",
      await scopedFindById(prisma.membership, centerA.id, teacherInB.id),
    ],
    [
      "StudentBlock",
      await scopedFindById(prisma.studentBlock, centerB.id, blockInA.id),
    ],
  ];
  for (const [label, leaked] of leaks) {
    check(`Center A cannot read Center B's ${label} by id`, leaked === null);
  }

  const studentsInA = await prisma.studentProfile.findMany({
    where: scopedWhere(centerA.id),
  });
  check(
    "A scoped student list contains only the active center's rows",
    studentsInA.length === 2 &&
      studentsInA.every((row) => row.centerId === centerA.id),
    `got ${studentsInA.length}`,
  );

  const teachersInB = await prisma.membership.findMany({
    where: scopedWhere(centerB.id, { role: TEACHER_ROLE }),
  });
  check(
    "A scoped teacher list excludes the other center's membership",
    teachersInB.length === 1 && teachersInB[0].id === teacherInB.id,
  );

  // ── 4. Blocking is per center, for a teacher shared by two ─────────────
  // The flagship risk on this path: the same teacher and the same student
  // exist in both centers, so a block must not follow them across.
  const blockedInA = await prisma.studentBlock.count({
    where: scopedWhere(centerA.id, {
      scope: TEACHER_SCOPE,
      refId: teacher.id,
      blockedUserId: inA.userId,
    }),
  });
  const blockedInB = await prisma.studentBlock.count({
    where: scopedWhere(centerB.id, {
      scope: TEACHER_SCOPE,
      refId: teacher.id,
      blockedUserId: inA.userId,
    }),
  });
  check("A block applies in the center that made it", blockedInA === 1);
  check(
    "A shared teacher's block does NOT follow the student to another center",
    blockedInB === 0,
  );

  let duplicateBlockRejected = false;
  try {
    await prisma.studentBlock.create({
      data: {
        centerId: centerA.id,
        scope: "TEACHER",
        refId: teacher.id,
        blockedUserId: inA.userId,
      },
    });
  } catch {
    duplicateBlockRejected = true;
  }
  check("The same student cannot be blocked twice", duplicateBlockRejected);

  const blockForm = parse(
    blockCreateSchema,
    {
      locale: "en",
      teacherUserId: teacher.id,
      studentProfileId: inA.profileId,
      reason: "Repeated disruption",
    },
    "blockCreate",
  );
  check(
    "The block schema keeps the teacher and student ids it was given",
    blockForm.teacherUserId === teacher.id &&
      blockForm.studentProfileId === inA.profileId,
  );

  // ── 5. Grade promotion stays inside its center ─────────────────────────
  await prisma.studentProfile.updateMany({
    where: scopedWhere(centerA.id),
    data: { gradeId: gradeA1.id },
  });
  await prisma.studentProfile.updateMany({
    where: scopedWhere(centerB.id),
    data: { gradeId: gradeB1.id },
  });

  const promotion = parse(
    gradePromotionSchema,
    { locale: "en", fromGradeId: gradeA1.id, toGradeId: gradeA2.id },
    "gradePromotion",
  );
  const promoted = await prisma.studentProfile.updateMany({
    where: scopedWhere(centerA.id, {
      gradeId: promotion.fromGradeId,
      active: true,
    }),
    data: { gradeId: promotion.toGradeId },
  });

  check("Promotion moves this center's students", promoted.count === 2);
  check(
    "Promotion leaves the other center's students where they were",
    (await prisma.studentProfile.count({
      where: scopedWhere(centerB.id, { gradeId: gradeB1.id }),
    })) === 1,
  );
  check(
    "Promoting into the same grade is rejected",
    !gradePromotionSchema.safeParse({
      locale: "en",
      fromGradeId: gradeA1.id,
      toGradeId: gradeA1.id,
    }).success,
  );

  // ── 6. Storage paths are the tenant boundary for files ─────────────────
  const photoPath = studentPhotoPath(centerA.id, inA.profileId, "png", "abc");
  const cardPath = studentIdCardPath(centerA.id, inA.profileId);

  check(
    "Every object path is namespaced by centerId",
    photoPath.startsWith(`${centerA.id}/`) &&
      cardPath === `${centerA.id}/${inA.profileId}.svg`,
    photoPath,
  );
  check(
    "The filename stem stays the profile id, so the read policy still matches",
    photoPath.split("/")[1].split(".")[0] === inA.profileId,
  );
  check(
    "A path built for one center is refused by another",
    !isPathInCenter(centerB.id, cardPath),
  );

  let assertRejected = false;
  try {
    assertPathInCenter(centerB.id, cardPath);
  } catch (error) {
    assertRejected = error instanceof StoragePathError;
  }
  check("assertPathInCenter throws across centers", assertRejected);

  let unscopedPathRejected = false;
  try {
    centerObjectPath("", "anything.png");
  } catch (error) {
    unscopedPathRejected = error instanceof StoragePathError;
  }
  check(
    "A storage path cannot be built without a centerId",
    unscopedPathRejected,
  );

  let traversalRejected = false;
  try {
    centerObjectPath(centerA.id, "../../etc/passwd");
  } catch (error) {
    traversalRejected = error instanceof StoragePathError;
  }
  check("A traversal segment is refused", traversalRejected);
  check(
    "A prefix collision is not a match (centerA vs centerA-extra)",
    !isPathInCenter(centerA.id, `${centerA.id}-extra/${inA.profileId}.svg`),
  );
  check(
    "Only the allowed image types get an extension",
    photoExtensionFor("image/png") === "png" &&
      photoExtensionFor("image/svg+xml") === null,
  );

  // The query primitive and the storage primitive fail the same way.
  let unscopedWhereRejected = false;
  try {
    scopedWhere("", { id: inB.profileId });
  } catch (error) {
    unscopedWhereRejected = error instanceof MissingCenterScopeError;
  }
  check(
    "scopedWhere still refuses to build an unscoped where",
    unscopedWhereRejected,
  );

  // ── 7. The ID card ─────────────────────────────────────────────────────
  const layout = resolveCardLayout({
    version: 1,
    elements: { qr: { x: 70, width: 22 } },
  });
  check(
    "A center's card layout merges over the built-in one",
    layout.elements.qr.x === 70 &&
      layout.elements.qr.width === 22 &&
      layout.elements.studentName.x === 36,
  );
  check(
    "A malformed layout falls back to the built-in one",
    resolveCardLayout("not json at all").elements.qr.x === 74,
  );

  const payload = studentQrPayload(centerA.id, "1001");
  const parsedPayload = parseStudentQrPayload(payload);
  check(
    "The QR payload round-trips to the center and the student code",
    parsedPayload?.centerId === centerA.id && parsedPayload.studentCode === "1001",
  );
  check(
    "A foreign QR payload does not parse as a student card",
    parseStudentQrPayload("1001") === null,
  );

  const svg = renderIdCardSvg({
    centerName: 'Center "A" & Co',
    brandColor: centerA.themeColor,
    studentName: "Mona Hassan",
    gradeName: "Grade 11",
    studentCode: "1001",
    qrPayload: payload,
    labels: { code: "Student code" },
    dir: "ltr",
    layout,
  });

  check(
    "A printable card renders with the student's name, code and a QR block",
    svg.startsWith("<svg") &&
      svg.includes("Mona Hassan") &&
      svg.includes(">1001<") &&
      /<path d="M\d/.test(svg),
  );
  check(
    "The card is landscape credit-card sized for print",
    svg.includes('width="85.6mm"') && svg.includes('height="54mm"'),
  );
  check(
    "Card text is escaped, so a name can never inject markup",
    svg.includes("Center &quot;A&quot; &amp; Co") && !svg.includes('"A" & Co'),
  );

  // The built-in layout must lay out cleanly on its own: an element that falls
  // off the face, or a logo that sits on top of the photo, is a card a center
  // prints and throws away.
  const defaultSvg = renderIdCardSvg({
    centerName: "Al-Noor",
    brandColor: "#2563eb",
    studentName: "Mona Hassan",
    gradeName: "Grade 11",
    studentCode: "1001",
    qrPayload: payload,
    labels: { code: "Student code" },
    dir: "ltr",
    layout: resolveCardLayout(null),
  });

  const boxes = [
    ...defaultSvg.matchAll(/<rect x="([\d.]+)" y="([\d.]+)" width="([\d.]+)" height="([\d.]+)"/g),
  ]
    .map((match) => match.slice(1, 5).map(Number) as [number, number, number, number])
    // Drop the full-bleed background and the bottom brand band.
    .filter(([, , width]) => width < CARD_WIDTH);

  const outOfBounds = boxes.filter(
    ([x, y, width, height]) =>
      x < 0 || y < 0 || x + width > CARD_WIDTH || y + height > CARD_HEIGHT,
  );
  let overlapping = 0;
  for (let i = 0; i < boxes.length; i += 1) {
    for (let j = i + 1; j < boxes.length; j += 1) {
      const [ax, ay, aw, ah] = boxes[i];
      const [bx, by, bw, bh] = boxes[j];
      if (ax < bx + bw && bx < ax + aw && ay < by + bh && by < ay + ah) {
        overlapping += 1;
      }
    }
  }
  check(
    "Every card element stays on the card face",
    outOfBounds.length === 0,
    JSON.stringify(outOfBounds),
  );
  check(
    "No two card elements overlap in the built-in layout",
    overlapping === 0,
    `${overlapping} overlapping pair(s)`,
  );

  const rtl = renderIdCardSvg({
    centerName: "مركز",
    brandColor: centerA.themeColor,
    studentName: "منى حسن",
    studentCode: "1001",
    qrPayload: payload,
    labels: { code: "كود الطالب" },
    dir: "rtl",
    layout,
  });
  check(
    "An Arabic card mirrors the layout and sets its direction",
    rtl.includes('direction="rtl"') &&
      rtl.includes('text-anchor="end"') &&
      rtl !== svg,
  );

  // ── 8. Identity ownership ──────────────────────────────────────────────
  check(
    "A center may edit a person it created who exists nowhere else",
    canEditGlobalProfile({ authId: null, otherCenterRelations: 0 }),
  );
  check(
    "A center may NOT rewrite a person shared with another center",
    !canEditGlobalProfile({ authId: null, otherCenterRelations: 1 }),
  );
  check(
    "A center may NOT rewrite a person who owns their own account",
    !canEditGlobalProfile({ authId: "auth-uid", otherCenterRelations: 0 }),
  );

  // ── 9. The schemas reject what the UI must not store ───────────────────
  check(
    "A phone is normalized to one canonical form",
    normalizePhone("+20 101 234 5678") === SHARED_PHONE &&
      normalizePhone("00201012345678") === SHARED_PHONE,
  );
  check(
    "A non-Egyptian mobile is rejected",
    !studentCreateSchema.safeParse({
      locale: "en",
      firstName: "A",
      lastName: "B",
      phone: "12345",
    }).success,
  );
  check(
    "A blank name is rejected",
    !studentCreateSchema.safeParse({
      locale: "en",
      firstName: "  ",
      lastName: "B",
    }).success,
  );
  check(
    "A student code with punctuation is rejected",
    !studentCreateSchema.safeParse({
      locale: "en",
      firstName: "A",
      lastName: "B",
      studentCode: "10/01",
    }).success,
  );
  check(
    "A student may be registered with no contact details at all (a minor)",
    studentCreateSchema.safeParse({
      locale: "en",
      firstName: "A",
      lastName: "B",
    }).success,
  );
  check(
    "A teacher without a phone or an email is rejected",
    !teacherCreateSchema.safeParse({
      locale: "en",
      firstName: "A",
      lastName: "B",
    }).success,
  );
  check(
    "A teacher with only an email is accepted",
    teacherCreateSchema.safeParse({
      locale: "en",
      firstName: "A",
      lastName: "B",
      email: TEACHER_EMAIL,
    }).success,
  );

  // Deleting the center takes its memberships with it; the person does not.
  await prisma.center.delete({ where: { id: centerA.id } });
  check(
    "Removing a center removes its memberships, never the person",
    (await prisma.membership.count({ where: { id: teacherInA.id } })) === 0 &&
      (await prisma.user.count({ where: { id: teacher.id } })) === 1,
  );
}

main()
  .catch((error) => {
    console.error(error);
    failures += 1;
  })
  .finally(async () => {
    await cleanup();
    await prisma.$disconnect();
    if (failures > 0) {
      console.error(`\n${failures} people check(s) failed.`);
      process.exit(1);
    }
    console.log("\nAll people checks passed.");
  });
