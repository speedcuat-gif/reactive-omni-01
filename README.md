# Sentinel — stop-loss & take-profit, executed by Reactive

**Reactive Omni Buildathon · Track: Set It and Forget It** ($2,000 first place)

Arm an order once and forget it. A reactive contract on Reactive Lasna watches a
price feed on Ethereum Sepolia; when your price is hit it fires a callback to the
vault, which releases your escrowed funds. No bot, no keeper, no off-chain watcher
— the rule lives on-chain.

- **Stop-loss:** price falls to or below your stop → escrow released to you.
- **Take-profit:** price rises to or above your target → escrow released to you.
- **The vault is the source of truth for funds.** A callback for a non-existent,
  cancelled or already-executed order reverts, so a forged or duplicate trigger
  can never move money. The sentinel marks orders as triggered *before* requesting
  the callback, so a duplicate event delivery can never double-fire.

## Why this track

Set It and Forget It is for personal automations on any chain Reactive supports —
and a stop-loss is the canonical "set it and forget it" rule. Speed matters less
here than usefulness, so the design uses Ethereum Sepolia as origin *and*
destination (both supported by Reactive), which keeps the whole demo on one
funding path: Sepolia ETH → lREACT via the Reactive faucet. The same contracts
deploy unchanged to Base/Unichain Sepolia for the Every Second Counts track
(one-line chain change).

## Architecture

```
Ethereum Sepolia (origin + destination)          Reactive Lasna
┌──────────────────────────────┐                  ┌──────────────────────────┐
│ MockPriceFeed                │  PriceUpdated    │ StopLossSentinel         │
│  setPrice() ──emits──►       │ ───────────────► │  react() checks armed    │
│ MockToken (sUSD)             │                  │  orders, requests        │
│ StopLossVault (callback)     │ ◄──callback──────│  callback on trip        │
│  deposit / executeStopLoss / │                  │  (funded in lREACT)      │
│  cancelOrder                 │                  │                          │
└──────────────────────────────┘                  └──────────────────────────┘
```

| Contract | Chain | What it does |
|---|---|---|
| `MockPriceFeed` | Sepolia | Demo price feed, emits `PriceUpdated(price, timestamp)` (USD, 8 decimals). Stands in for a Chainlink/Uniswap source; the sentinel subscribes by topic, so swapping the origin is a one-line change. |
| `MockToken` (sUSD) | Sepolia | Minimal ERC20 escrowed asset. |
| `StopLossVault` | Sepolia | Callback contract (`AbstractCallback`). Holds escrow, releases it on an authenticated callback, refunds on cancel. Funded in Sepolia ETH for callback gas. |
| `StopLossSentinel` | Lasna | Reactive contract (`AbstractReactive`). Subscribes to the feed, evaluates armed orders in `react()`, requests callbacks. Funded in lREACT. |
| `MockSystem`, `MockCallbackProxy` | local only | Test doubles for the local demo. Never deployed to a real chain. |

Key addresses (testnet): Sepolia callback proxy `0xAa14d9Cd0f788Ca23d11805986C1d8bd035D23b4`,
Lasna system contract `0x8888888888888888888888888888888888888888`, Lasna chain 5318007,
Sepolia chain 11155111.

## Verified locally (no live chains needed)

```
npm run demo        # full loop on a local Hardhat node, 16 assertions
```

What it proves: subscription recorded with the right topic; price crash fires
exactly one callback for the stop-loss (take-profit untouched); duplicate delivery
of the same event fires nothing; price rally fires the take-profit; direct calls
to `executeStopLoss` revert (only the proxy can call it); cancel refunds escrow.
See `scripts/demo-local.mjs` — the MockSystem is installed at the real system
address with `hardhat_setCode` and delivery is simulated by impersonating it.

## Deploying to testnet

You need Sepolia ETH in the deployer wallet (a fresh throwaway key in `.env`,
never the user's wallet) and lREACT on Lasna for the same address.

```bash
# 1. Sepolia ETH — PoW faucet, no account: https://sepolia-faucet.pk910.de
#    (mine a little, ~0.1 ETH is plenty)
# 2. Swap some of it for lREACT (1 ETH -> 100 lREACT):
node scripts/fund-lasna.mjs 0.05
# 3. Deploy everything (Sepolia feed+token, Lasna sentinel, Sepolia vault, wiring):
node scripts/deploy-all.mjs
# 4. Run the full loop on testnet and measure latency:
node scripts/demo-flow.mjs
# 5. Serve the UI:
node scripts/serve.mjs 8080   # http://localhost:8080/
```

`deploy-all.mjs` writes `deployments.json` and `web/config.js`. It refuses to
run without enough Sepolia ETH (≥0.02) and lREACT (≥0.5) and tells you exactly
what to do.

Notes from the live deploy (23 Nov 2026): the deployer held only 0.03 Sepolia
ETH (the Google Cloud faucet paid 0.03, not the advertised 0.05), so Lasna was
funded with 0.02 ETH → 2.0 lREACT and the vault was funded with 0.01 ETH
instead of 0.05 (see `deploy-all.mjs` — 0.01 ETH covers callback gas for the
demo at Sepolia prices). Lasna also rejects type-2 txs with a 0 priority fee,
so Lasna txs set an explicit 1 gwei tip (see `lasnaFees` in `deploy-all.mjs`
and `demo-flow.mjs`). `demo-flow.mjs` polls logs in a sliding window and
captures the poll window *before* the price event — the sentinel can trigger
within ~1s, so a window captured after the event can miss it.

## Live testnet deployment (verified 23 Nov 2026)

Deployer (throwaway test key): `0xc8e44773fEb0D03380671e3497Cf8D58fecA7114`

| Contract | Chain | Address |
|---|---|---|
| MockPriceFeed | Sepolia | `0xeB1D6498C3265016cE944CC649044E627e1bB9AE` |
| MockToken (sUSD) | Sepolia | `0x7207fc291CDA14d0C2802c89555B944F6F9Cc3DA` |
| StopLossVault | Sepolia | `0x803B6292f87175eCf5b501F50eCE060DfBB7A6cC` |
| StopLossSentinel | Lasna | `0x7cEeD7F18D4Ac53445976bAd73605e8C9771Eb18` |

Full loop, measured on testnet (origin event → Lasna react → Sepolia callback):
- **Stop-loss #2** — 100 sUSD @ $1,800, price crashed to $1,750: origin
  `0x03935ff1ab375c00401e94528c45761867a70a83a28b6f8044c4de2107fc6d03`
  (Sepolia block 12194119) → sentinel triggered in Lasna block 9037160
  (tx `0xd07cf85261d8abfae5eafc2ead56dc697e56664e9212030d573e1cd0348fc42b`,
  1s) → vault released in Sepolia block 12194120
  (tx `0x82f6ae87268463b26b30a3b9079e9184144e3c93e14edf2a6df4480d1fd526e2`,
  11s). **Full loop: 12s.**
- **Stop-loss #1** fired the same way (Lasna block 9037114, callback tx
  `0xd22de09c7122c99cd5673681e9da04467033433ac51ec9d648dcdfbf2df00099`).
- **Take-profit #3** — 50 sUSD @ $2,200, price rallied to $2,300: origin
  `0xde47d7fa73567f980157d5f5d532115ff52ab8e43a2999f41b7bceedf8a1ec08`
  (Sepolia block 12194131) → sentinel triggered in Lasna block 9037294
  (tx `0xff671f8574fcfdbc60c6bfcdcceb4a1c61328eb23043aeaa9b6cdaf60f4dfed2`,
  0s) → vault released in Sepolia block 12194132
  (tx `0x2dd3606f13335789584760d7fbaa269e82163be2372480e54b8522d36f00ac64`,
  12s). **Full loop: 12s.**
- Order #0 was cancelled and refunded
  (tx `0xe0838ed992277c4bababc0efa22c8e04df7d257bd161416e23736e576cfbe409`).
- Final state: all orders settled, vault escrow 0 sUSD, deployer back to
  2,000 sUSD. Funding: 0.05 Sepolia ETH claimed from the Google Cloud Web3
  faucet (tx `0x5fa3717ea74ab83b882f58b3d26549f5a3c09706aedcfa579610bce98a298956`,
  actual payout 0.03 ETH); 0.02 ETH swapped for 2.0 lREACT
  (tx `0x1386b08633721cc7fcf565a2b29b2162dec26f4b40b731a0749e6326b063b913`).

## Demo video

`web/demo.mp4` — 22 s, 1280×900, silent captioned walkthrough of the **live
testnet run** above (stills in `web/screenshots/t1-armed.png`,
`t2-stoploss.png`, `t3-takeprofit.png`; the earlier local-run stills
`1-armed.png` / `2-stoploss.png` / `3-takeprofit.png` are kept for reference).
Rebuild it with `node scripts/make-video-testnet.mjs`.
`DEMO_SCRIPT.md` has the 3-minute narration. Re-record against the live
testnet deployment once funded. Stills in `web/screenshots/`. The UI vendors
ethers locally (`web/vendor/`) so it works offline and from `file://` — this
VM's Chromium blocks all local-network navigation, which is also why the
video stills are rendered from standalone snapshot pages.

## Submission checklist (DoraHacks)

- [x] Public repo (push needed) + open-source (MIT)
- [x] Contract + working demo, docs (this README)
- [x] Draft video (`web/demo.mp4` + script) — re-recorded against the live testnet run
- [x] Live testnet deployment + tx hashes showing the full loop
      (origin event → Lasna react → Sepolia callback) — **verified 23 Nov 2026,
      full loop 12s for both stop-loss and take-profit; see "Live testnet
      deployment" above**
- [ ] Final narrated video (<3 min) + YouTube upload (needs the user's Google account)
- [ ] Submit on DoraHacks (parent handles submission)

## Project layout

```
contracts/            MockPriceFeed, MockToken, StopLossVault, StopLossSentinel
contracts/mocks/      MockSystem, MockCallbackProxy (local tests only)
scripts/              compile.mjs, demo-local.mjs, fund-lasna.mjs,
                      deploy-all.mjs, demo-flow.mjs, serve.mjs, common.mjs
web/                  index.html, app.js, config.js (generated), demo.mp4
lib/                  reactive-lib-omni (vendored, MIT/UNLICENSED upstream)
artifacts/            compiled ABIs + bytecode (generated)
```

## Notes

- The sentinel scans armed orders linearly in `react()`. That is fine for a
  personal-automation demo (a handful of orders); a production version would
  bucket orders by trigger price. Documented as a known limitation, not hidden.
- The price feed is a demo stand-in. The subscription is topic-based, so pointing
  the sentinel at a real Chainlink `AnswerUpdated` feed or a Uniswap pool `Swap`
  event is a redeploy with a different origin address — no sentinel code change.
- Testnet only. No real funds, no mainnet deployment, no admin keys.
