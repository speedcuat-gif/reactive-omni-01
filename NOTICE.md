# NOTICE

Sentinel is a hackathon demo built for the Reactive Omni Buildathon
(Set It and Forget It track). Testnet only.

- All funds are testnet tokens with no real-world value (Sepolia ETH, lREACT,
  and the demo sUSD token). Nothing here touches mainnet or real money.
- The price feed (`MockPriceFeed`) is a demo stand-in controlled by the deployer.
  In production it would be a Chainlink feed or a Uniswap TWAP oracle.
- The deployer key in `.env` is a fresh throwaway test-only key. It is
  gitignored, never committed, and never printed in logs or reports.
- No admin keys, no upgradeability, no fees. The vault can only release escrow
  to the order's own user, and only on an authenticated callback from the
  authorized sentinel through the destination chain's callback proxy.
- The Reactive library in `lib/` is vendored from
  https://github.com/Reactive-Network/reactive-lib-omni (upstream license
  UNLICENSED as published; see `lib/README.md`).
- This project was built by an AI agent (Mate) for the user cuat for the
  Reactive Omni Buildathon on DoraHacks. All code is original except the
  vendored Reactive library above.
