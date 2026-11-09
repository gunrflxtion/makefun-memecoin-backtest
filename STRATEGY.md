# Trading approach

The bot follows buying activity on pump.fun bonding curves. It keeps a brief record of trades and only considers a coin once it is 180 slots old, trading recently, and has at least four buys among the latest six trades. Those trades must show net SOL inflow above 0.25 SOL, and the most recent one must be a buy. The curve's real SOL reserve must be from 19 through 80 SOL. This selects active, deeper curves after their launch activity.

An entry allocates at most 0.5 SOL, subject to the rule limiting each coin's buys in a reply to one percent of its real reserve. The order must be at least 0.03 SOL and fit the available cash after transaction costs. The bot allows no more than five open or pending positions, processes coin addresses in sorted order, and enters each coin once.

For each open position, the bot estimates sale proceeds from current virtual reserves and its token balance, then accounts for curve fees. It closes after an 8% gain, an 18% loss, a 22% fall from the best observed liquidation value, or 900 slots. Sells allow 10,000 bps slippage; entries allow 1,800 bps for replay latency. The replay handles positions on completed curves and anything left at the end.

The hello message, batch events, account state, and slot numbers are the bot's only decision inputs. It runs on Node 22 with the vendored make.fun protocol shim.
