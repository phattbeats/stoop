/**
 * Stoop — the cross-channel delist.
 *
 * A sale ends every other listing. That is local truth and it is atomic
 * enough: the ledger marks the listings ended in the same transaction as the
 * sale. Ending them *on the other marketplace* is a network call to somebody
 * else's API, and that call can fail, be slow, or be rate limited.
 *
 * So it is not promised, it is queued:
 *
 *   1. the sale is recorded, and the other listings are ended locally;
 *   2. each ended listing with a remote id becomes a queued action;
 *   3. the action is attempted once, right away;
 *   4. if it fails, the action stays visible for a human — and only a human.
 *
 * The failure mode this avoids: telling Emily the item is sold everywhere,
 * and finding out three days later that the eBay listing is still up and
 * bought by somebody else.
 */

import type { MarketplaceAdapter } from './adapter.ts';
import type { Marketplace } from './ledger.ts';
import type { RemoteAction, RemoteActionStore } from './etsy-store.ts';

export interface DelistTarget {
  listingId: string;
  itemId: string;
  marketplace: Marketplace;
  /** Null for the Facebook paste card: there is nothing to end remotely. */
  remoteId: string | null;
}

export interface DelistOutcome {
  succeeded: number;
  failed: number;
  needsHuman: number;
  actions: RemoteAction[];
}

export class DelistRunner {
  private readonly queue: RemoteActionStore;
  private readonly adapters: Partial<Record<Marketplace, MarketplaceAdapter>>;

  constructor(queue: RemoteActionStore, adapters: Partial<Record<Marketplace, MarketplaceAdapter>> = {}) {
    this.queue = queue;
    this.adapters = adapters;
  }

  /**
   * End every one of these listings on its own marketplace.
   *
   * Never throws: a failed remote delist is a queued action for a human, not
   * an exception that rolls back a sale that really happened.
   */
  async delist(targets: DelistTarget[]): Promise<DelistOutcome> {
    const outcome: DelistOutcome = { succeeded: 0, failed: 0, needsHuman: 0, actions: [] };

    for (const target of targets) {
      // The Facebook paste card has no remote id: Emily's post is hers.
      if (!target.remoteId) continue;

      const adapter = this.adapters[target.marketplace];
      if (!adapter) {
        const action = await this.queue.enqueue({
          itemId: target.itemId,
          listingId: target.listingId,
          marketplace: target.marketplace,
          action: 'delist',
          remoteId: target.remoteId,
          state: 'needs_human',
          needsHuman: true,
          lastError: `there is no ${target.marketplace} adapter yet; the listing has to be ended by hand`,
        });
        outcome.actions.push(action);
        outcome.needsHuman += 1;
        continue;
      }

      const action = await this.queue.enqueue({
        itemId: target.itemId,
        listingId: target.listingId,
        marketplace: target.marketplace,
        action: 'delist',
        remoteId: target.remoteId,
      });

      try {
        const result = await adapter.end(target.remoteId);
        await this.queue.markSucceeded(action.id, { alreadyGone: result.alreadyGone === true });
        outcome.succeeded += 1;
      } catch (error) {
        const message = String((error as Error).message ?? error);
        await this.queue.markFailed(action.id, message);
        outcome.failed += 1;
        outcome.needsHuman += 1;
      }
    }

    return outcome;
  }

  /** Queue something a human has to look at (a sale we cannot place, for example). */
  async needsReview(input: {
    itemId?: string;
    marketplace: Marketplace;
    remoteId?: string;
    reason: string;
    detail?: Record<string, unknown>;
  }): Promise<RemoteAction> {
    return this.queue.enqueue({
      itemId: input.itemId,
      marketplace: input.marketplace,
      action: 'review',
      remoteId: input.remoteId,
      state: 'needs_human',
      needsHuman: true,
      lastError: input.reason,
      detail: input.detail ?? {},
    });
  }
}
