# Demo script — Sentinel (3 minutes, narrated)

Use for the <3 min DoraHacks demo video. Narration is timed to the captioned
walkthrough in `web/demo.mp4` (live testnet run, 23 Nov 2026 — Sepolia +
Lasna; full loop 12s for both legs, tx hashes in the README).

## 0:00–0:20 — The problem

> "If you hold crypto, you know the fear: the price crashes while you sleep and
> your stop-loss is a bot you have to keep running — or an exchange order you
> have to trust. Sentinel removes the bot. You arm an order once, on-chain, and
> forget it."

[Show: UI header + the three-step diagram.]

## 0:20–0:50 — How it works

> "Three contracts. A price feed on Sepolia publishes prices. A reactive contract
> on Reactive Lasna subscribes to that feed — no polling, no keeper. And a vault
> on Sepolia holds your escrowed stablecoins. When the price hits your stop, the
> sentinel fires a callback and the vault releases your funds."

[Show: architecture — feed → sentinel → vault.]

## 0:50–1:40 — The loop, live

> "Here is the loop running on testnet. I deposit 100 sUSD with a stop at $1,800
> and arm it. Now I crash the feed to $1,750. The sentinel sees the event on
> Lasna, finds the tripped order, and requests a callback. The vault verifies
> the call came through the proxy from the authorized sentinel — and releases
> the 100 sUSD back to me. Origin event to funds released: twelve seconds.
> Then the take-profit: 50 sUSD at $2,200, the price rallies to $2,300, and the
> same loop fires again — twelve seconds, funds back."

[Show: deposit + arm, price crash, trigger event on Lasna, callback tx on
Sepolia, balances before/after.]

## 1:40–2:20 — Why it is safe

> "Two things make this safe. First, the vault is the source of truth: a callback
> for an order that doesn't exist, was cancelled, or already executed reverts —
> a forged or duplicate trigger can never move money. Second, the sentinel marks
> an order as triggered before it requests the callback, so a duplicate event
> delivery fires nothing. We test both: a duplicate delivery and a direct call
> to the vault both fail, exactly as designed."

[Show: duplicate-delivery and direct-call assertions passing.]

## 2:20–2:50 — What it costs, and what's next

> "The full loop is one origin event, one reactive transaction, one callback.
> On testnet the whole thing settles in seconds. The same contracts deploy
> unchanged to Base or Unichain Sepolia — the sentinel subscribes by event topic,
> so pointing it at a real Chainlink feed or a Uniswap pool is a one-line change."

[Show: latency numbers from `demo-flow.mjs`, repo + explorer links.]

## 2:50–3:00 — Close

> "Sentinel: set it, and forget it. Built for the Reactive Omni Buildathon."

[Show: repo URL + contract addresses.]
