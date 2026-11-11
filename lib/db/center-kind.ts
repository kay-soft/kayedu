import type { Prisma } from "@prisma/client";

/**
 * **The one "is this a branch, not a teacher's workspace" filter** (W8a,
 * D-W20, D-W38, CLAUDE.md rule 13). A PERSONAL workspace is a tenant like any
 * branch — `center_id` isolation is unchanged — but it never appears on a
 * centre-wide surface: Explore, Discover, the teacher centre directory, the
 * hub and the switcher, the admin centre and organization lists, the platform
 * KPIs, the branch limit, the provisioning baseline and the seed-world checks.
 * Each of those spreads this (most of them through `ACCESSIBLE_CENTER` in
 * `./platform.ts`), so there is no second spelling of it and no per-screen
 * condition. **A new centre-wide surface spreads it too.**
 *
 * A leaf module (no imports beyond types) so that every reader — the public
 * catalogue, the relations resolver, the gates — can use it without pulling
 * `platform.ts`'s provisioning graph in.
 */
export const BRANCH_ONLY = { kind: "BRANCH" } satisfies Prisma.CenterWhereInput;

/** Its opposite, for the workspace module's own reads (`lib/db/workspaces.ts`). */
export const PERSONAL_ONLY = { kind: "PERSONAL" } satisfies Prisma.CenterWhereInput;
