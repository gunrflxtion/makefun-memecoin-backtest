// Keep protocol handling separate from trade selection.
import { createStrategy as makeOrders, DEFAULT_PARAMS as chosenSettings } from './strategy.ts';
import { runBot as connectReplay } from './vendor/makefun-bot.ts';

const replayAgent = { onBatch: makeOrders(chosenSettings) };
await connectReplay(replayAgent);
