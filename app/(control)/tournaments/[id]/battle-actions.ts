"use server";

import { z } from "zod";
import { requireOrganizer } from "@/lib/auth";
import { organizerSheet, type MatchSheet } from "@/lib/battle-sheet";

/** A match's battle-by-battle score, read when the organizer opens it (null if it isn't theirs). */
export async function battleSheetAction(matchId: string): Promise<MatchSheet | null> {
  const organizer = await requireOrganizer();
  return organizerSheet(organizer.id, z.uuid().parse(matchId));
}
