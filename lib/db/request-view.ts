// No imports on purpose: `lib/db/scoped.ts` and the gates use it.

/**
 * What every centre-facing and teacher-facing read of a request carries (D-W37
 * item 10): the row without the assistant's id — only whether an assistant
 * filed it. `scoped(ctx).changeRequests.list` maps every row through this, so
 * the approvals queue never holds the assistant's id at all.
 */
export function withoutAssistantId<T extends { viaAssistantUserId: string | null }>(
  row: T,
): Omit<T, "viaAssistantUserId"> & { viaAssistant: boolean } {
  const { viaAssistantUserId, ...rest } = row;
  return { ...rest, viaAssistant: viaAssistantUserId !== null };
}
