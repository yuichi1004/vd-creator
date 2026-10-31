// The proposals the agent made, kept in memory only. Nothing here is written to the project: a
// proposal reaches scenario.yaml only when the user tries it and keeps the take.

import type { Proposal } from "./answer.js";

/** The most proposals kept at once, and for how long. The oldest is dropped first. */
export const MAX_PROPOSALS = 20;
export const PROPOSAL_TTL_MS = 30 * 60 * 1000;

export type StoredProposal = Proposal & {
  /** The ID of the instruction that asked for it, which is also its ID. */
  id: string;
  itemId: string;
  createdAt: number;
};

export class ProposalStore {
  private readonly items = new Map<string, StoredProposal>();

  constructor(private readonly now: () => number = Date.now) {}

  add(id: string, itemId: string, proposal: Proposal): StoredProposal {
    this.prune();
    this.items.delete(id);
    while (this.items.size >= MAX_PROPOSALS) {
      const oldest = this.items.keys().next().value;
      if (oldest === undefined) break;
      this.items.delete(oldest);
    }
    const stored: StoredProposal = { ...proposal, id, itemId, createdAt: this.now() };
    this.items.set(id, stored);
    return stored;
  }

  get(id: string): StoredProposal | undefined {
    this.prune();
    return this.items.get(id);
  }

  /** True if the proposal was kept and is now removed. */
  delete(id: string): boolean {
    this.prune();
    return this.items.delete(id);
  }

  private prune(): void {
    const limit = this.now() - PROPOSAL_TTL_MS;
    for (const [id, stored] of this.items) {
      if (stored.createdAt <= limit) this.items.delete(id);
    }
  }
}
