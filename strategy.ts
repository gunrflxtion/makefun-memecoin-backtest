// The reordered settings retain the tuned entry and exit thresholds.
import type { Batch as ReplayBatch, BotState as ReplayState, OrderInput as ReplayOrder } from './vendor/makefun-bot.ts';

export interface StrategyOptions {
  ageBeforeBuy: number;
  buyCount: number;
  requiredFlow: bigint;
  minimumPriceAdvanceBps: bigint;
  latestTradeMustBuy: boolean;
  reserveFloor: bigint;
  reserveCeiling: bigint;
  stakeLimit: bigint;
  minimumOrder: bigint;
  buySlippage: number;
  profitBps: bigint;
  stopBps: bigint;
  pullbackBps: bigint;
  holdingSlotLimit: number;
}

export const DEFAULT_PARAMS: StrategyOptions = {
  holdingSlotLimit: 900,
  profitBps: 800n,
  stopBps: 1800n,
  pullbackBps: 2200n,
  ageBeforeBuy: 180,
  buyCount: 4,
  requiredFlow: 250_000_000n,
  latestTradeMustBuy: true,
  minimumPriceAdvanceBps: 0n,
  reserveFloor: 19_000_000_000n,
  reserveCeiling: 80_000_000_000n,
  stakeLimit: 500_000_000n,
  minimumOrder: 30_000_000n,
  buySlippage: 1800,
};

type TradeSnapshot = {
  slotSeen: number;
  wasBuy: boolean;
  quoteMoved: bigint;
  virtualQuote: bigint;
  virtualTokens: bigint;
};

export function createStrategy(settings: StrategyOptions = DEFAULT_PARAMS) {
  const tapeByMint = new Map<string, TradeSnapshot[]>();
  const alreadyTried = new Set<string>();
  const openedAtSlot = new Map<string, number>();
  const liquidationHigh = new Map<string, bigint>();
  const closedMints = new Set<string>();

  return function decide(state: ReplayState, batch: ReplayBatch): ReplayOrder[] {
    const currentSlot = batch.slot;

    for (const fill of batch.fills) {
      const mintKey = fill.mint;
      const openingFailed = fill.side === 'buy' && fill.status !== 'filled' && !state.positions.has(mintKey);
      const openingSucceeded = fill.side === 'buy' && fill.status === 'filled';
      const closingSucceeded = fill.side === 'sell' && !state.positions.has(mintKey);
      if (openingFailed) alreadyTried.delete(mintKey);
      else if (openingSucceeded) alreadyTried.add(mintKey);
      else if (closingSucceeded) closedMints.add(mintKey);
    }

    for (const observation of batch.events) {
      if (observation.event !== 'TradeEvent') continue;
      const samples = tapeByMint.get(observation.mint) ?? [];
      const snapshot: TradeSnapshot = {
        slotSeen: currentSlot,
        wasBuy: observation.is_buy,
        quoteMoved: BigInt(observation.sol_amount),
        virtualQuote: BigInt(observation.virtual_quote_reserves),
        virtualTokens: BigInt(observation.virtual_token_reserves),
      };
      samples.push(snapshot);
      if (samples.length > 12) samples.splice(0, samples.length - 12);
      tapeByMint.set(observation.mint, samples);
    }

    const currentMarks = new Map(batch.marks.map((mark) => [mark.mint, mark]));
    const inFlightMints = new Set([...state.pending.values()].map((pendingOrder) => pendingOrder.order.mint));
    const orders: ReplayOrder[] = [];

    for (const mintKey of Array.from(state.positions.keys()).sort()) {
      if (inFlightMints.has(mintKey)) continue;
      const position = state.positions.get(mintKey)!;
      const mark = currentMarks.get(mintKey);
      const curve = state.curves.get(mintKey);
      if (mark === undefined || curve === undefined || curve.complete) continue;

      const virtualTokens = BigInt(mark.virtual_token_reserves);
      const virtualQuote = BigInt(mark.virtual_quote_reserves);
      const availableQuote = BigInt(mark.real_quote_reserves);
      const tokenCount = position.token_amount;
      const denominator = virtualTokens + tokenCount;
      const rawQuote = denominator > 0n ? tokenCount * virtualQuote / denominator : 0n;
      const cappedQuote = rawQuote < availableQuote ? rawQuote : availableQuote;
      const feeAdjustedValue =
        (cappedQuote / 10000n) * 9875n +
        ((cappedQuote % 10000n) * 9875n) / 10000n;
      const recordedHigh = liquidationHigh.get(mintKey) ?? feeAdjustedValue;
      const bestValue = recordedHigh > feeAdjustedValue ? recordedHigh : feeAdjustedValue;
      liquidationHigh.set(mintKey, bestValue);

      const elapsedSlots = currentSlot - (openedAtSlot.get(mintKey) ?? currentSlot);
      const paidForPosition = position.cost_lamports;
      const reachedTarget = feeAdjustedValue >= paidForPosition * (10000n + settings.profitBps) / 10000n;
      const crossedStop = feeAdjustedValue <= paidForPosition * (10000n - settings.stopBps) / 10000n;
      const gaveBackPeak = feeAdjustedValue <= bestValue * (10000n - settings.pullbackBps) / 10000n;
      const overstayed = elapsedSlots >= settings.holdingSlotLimit;

      if (reachedTarget || crossedStop || gaveBackPeak || overstayed) {
        orders.push({ side: 'sell', mint: mintKey, token_amount: tokenCount, max_slippage_bps: 10000 });
        if (orders.length === 16) return orders;
      }
    }

    let openCapacity = state.hello.caps.max_open_positions - state.committedPositionCount();
    let unreservedCash = state.freeCashLamports();
    const candidateMints = Array.from(tapeByMint.keys()).sort();

    for (const mintKey of candidateMints) {
      if (openCapacity <= 0 || orders.length >= 16) break;
      if (alreadyTried.has(mintKey) || closedMints.has(mintKey) || state.positions.has(mintKey) || inFlightMints.has(mintKey)) continue;

      const curve = state.curves.get(mintKey);
      const samples = tapeByMint.get(mintKey)!;
      if (curve === undefined || curve.complete || curve.created_slot === null) continue;
      if (currentSlot - curve.created_slot < settings.ageBeforeBuy) continue;
      if (samples.length < settings.buyCount || currentSlot - samples[samples.length - 1]!.slotSeen > 40) continue;

      const windowSamples = samples.slice(-6);
      let buyEvents = 0;
      let netQuoteFlow = 0n;
      for (const sample of windowSamples) {
        if (sample.wasBuy) {
          buyEvents++;
          netQuoteFlow += sample.quoteMoved;
        } else netQuoteFlow -= sample.quoteMoved;
      }
      if (buyEvents < settings.buyCount || netQuoteFlow < settings.requiredFlow) continue;
      if (settings.latestTradeMustBuy && !windowSamples[windowSamples.length - 1]!.wasBuy) continue;

      if (settings.minimumPriceAdvanceBps > 0n) {
        const firstSample = windowSamples[0]!;
        const newestSample = windowSamples[windowSamples.length - 1]!;
        const missingPrice = firstSample.virtualQuote * newestSample.virtualTokens === 0n;
        const insufficientAdvance =
          newestSample.virtualQuote * firstSample.virtualTokens * 10000n <
          firstSample.virtualQuote * newestSample.virtualTokens * (10000n + settings.minimumPriceAdvanceBps);
        if (missingPrice || insufficientAdvance) continue;
      }

      const quoteReserve = curve.real_quote_reserves;
      if (quoteReserve < settings.reserveFloor || quoteReserve > settings.reserveCeiling) continue;

      const reserveAllowance = state.maxBuyLamports(mintKey);
      const purchaseAmount = reserveAllowance < settings.stakeLimit ? reserveAllowance : settings.stakeLimit;
      const transactionCost = state.txFeeLamports();
      if (purchaseAmount < settings.minimumOrder || unreservedCash < purchaseAmount + transactionCost) continue;

      orders.push({ side: 'buy', mint: mintKey, quote_lamports: purchaseAmount, max_slippage_bps: settings.buySlippage });
      alreadyTried.add(mintKey);
      openedAtSlot.set(mintKey, currentSlot);
      liquidationHigh.set(mintKey, 0n);
      openCapacity--;
      unreservedCash -= purchaseAmount + transactionCost;
    }
    return orders;
  };
}
