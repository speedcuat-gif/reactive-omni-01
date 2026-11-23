// Local end-to-end demo of the Sentinel stop-loss loop (no live chains needed).
// Spawns a Hardhat node, deploys everything, simulates Reactive delivery by
// impersonating the system contract, and asserts the full loop.
// Usage: node scripts/demo-local.mjs [--keep-node]
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { ethers } from "ethers";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const RPC = "http://127.0.0.1:8545";
const SYSTEM = "0x8888888888888888888888888888888888888888";
const SEPOLIA_CHAIN_ID = 11155111n;
const KEEP_NODE = process.argv.includes("--keep-node");

const art = (name) => JSON.parse(fs.readFileSync(path.join(ROOT, "artifacts", `${name}.json`), "utf8"));
const fmtUSD = (v) => `$${(Number(v) / 1e8).toFixed(2)}`;
const fmtTok = (v) => (Number(ethers.formatEther(v))).toFixed(2);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let failures = 0;
function check(name, cond, extra = "") {
  console.log(`  ${cond ? "PASS" : "FAIL"}  ${name}${extra ? " — " + extra : ""}`);
  if (!cond) failures++;
}

async function waitForRpc(provider, tries = 40) {
  for (let i = 0; i < tries; i++) {
    try {
      await provider.getBlockNumber();
      return true;
    } catch {
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  return false;
}

async function main() {
  console.log("== Sentinel local demo: stop-loss / take-profit loop ==");
  const node = spawn("npx", ["hardhat", "node", "--port", "8545"], {
    cwd: ROOT,
    stdio: "ignore",
  });
  const provider = new ethers.JsonRpcProvider(RPC);
  if (!(await waitForRpc(provider))) {
    console.log("FAIL: hardhat node did not come up");
    node.kill();
    process.exit(1);
  }
  try {
    const [deployer, user] = [await provider.getSigner(0), await provider.getSigner(1)];
    const deployerAddr = await deployer.getAddress();
    const userAddr = await user.getAddress();
    console.log(`deployer ${deployerAddr}\nuser      ${userAddr}`);

    const deploy = async (name, signer, args = [], value = 0n) => {
      const a = art(name);
      const f = new ethers.ContractFactory(a.abi, a.bytecode, signer);
      const c = await f.deploy(...args, { value });
      await c.waitForDeployment();
      const addr = await c.getAddress();
      console.log(`deployed ${name} -> ${addr}`);
      return new ethers.Contract(addr, a.abi, signer);
    };

    // 1. Mock system contract at the real system address (0x8888...).
    const mockSystem = await deploy("MockSystem", deployer);
    const mockSystemAddr = await mockSystem.getAddress();
    const mockCode = await provider.getCode(mockSystemAddr);
    await provider.send("hardhat_setCode", [SYSTEM, mockCode]);
    console.log(`MockSystem code set at ${SYSTEM}`);
    const systemAsContract = new ethers.Contract(SYSTEM, art("MockSystem").abi, provider);

    // 2. Origin-chain contracts (Sepolia in production; local chain here).
    const feed = await deploy("MockPriceFeed", deployer, [2000_00000000n]); // $2,000.00
    const token = await deploy("MockToken", deployer);
    await (await token.mint(userAddr, ethers.parseEther("1000"))).wait();
    console.log(`minted 1000 sUSD to user`);
    const proxy = await deploy("MockCallbackProxy", deployer);

    // 3. Sentinel on "Lasna" (local chain stands in for Lasna here).
    const sentinel = await deploy("StopLossSentinel", deployer, [await feed.getAddress(), SEPOLIA_CHAIN_ID], ethers.parseEther("1"));
    check("sentinel subscribed to feed", (await systemAsContract.subscriptionCount()) === 1n);
    const sub = await systemAsContract.subscriptions(0);
    check("subscription topic is PriceUpdated", sub.topic0 === BigInt(ethers.id("PriceUpdated(uint256,uint256)")));

    // 4. Vault on the destination chain, authorized for this sentinel.
    const vault = await deploy(
      "StopLossVault",
      deployer,
      [await proxy.getAddress(), await sentinel.getAddress(), await token.getAddress()],
      ethers.parseEther("0.1")
    );
    await (await sentinel.setVault(await vault.getAddress())).wait();

    // 5. User deposits + arms: stop-loss $1,800 on 100 sUSD, take-profit $2,200 on 50 sUSD.
    await (await token.connect(user).approve(await vault.getAddress(), ethers.parseEther("1000"))).wait();
    await (await vault.connect(user).deposit(ethers.parseEther("100"), 1800_00000000n, false)).wait();
    await (await vault.connect(user).deposit(ethers.parseEther("50"), 2200_00000000n, true)).wait();
    await (await sentinel.connect(user).armOrder(0, 1800_00000000n, false)).wait();
    await (await sentinel.connect(user).armOrder(1, 2200_00000000n, true)).wait();
    console.log("orders armed: #0 stop-loss $1800 (100 sUSD), #1 take-profit $2200 (50 sUSD)");
    check("vault holds 150 sUSD escrow", (await token.balanceOf(await vault.getAddress())) === ethers.parseEther("150"));

    // Helper: simulate Reactive delivering a PriceUpdated log to the sentinel.
    const deliverPrice = async (price) => {
      const tx = await feed.connect(deployer).setPrice(price);
      const receipt = await tx.wait();
      const log = receipt.logs.find((l) => l.topics[0] === ethers.id("PriceUpdated(uint256,uint256)"));
      const [p, ts] = ethers.AbiCoder.defaultAbiCoder().decode(["uint256", "uint256"], log.data);
      const record = {
        chainId: SEPOLIA_CHAIN_ID,
        contractAddress: await feed.getAddress(),
        topic0: BigInt(log.topics[0]),
        topic1: 0n,
        topic2: 0n,
        topic3: 0n,
        data: log.data,
        blockNumber: BigInt(log.blockNumber),
        opCode: 0n,
        blockHash: BigInt(log.blockHash),
        txHash: BigInt(log.transactionHash),
        logIndex: BigInt(log.index),
      };
      // Fund + impersonate the system contract, then deliver react() as a raw
      // transaction (ethers getSigner rejects impersonated accounts, so use
      // eth_sendTransaction directly — Hardhat accepts it while impersonating).
      await (await deployer.sendTransaction({ to: SYSTEM, value: ethers.parseEther("1") })).wait();
      await provider.send("hardhat_impersonateAccount", [SYSTEM]);
      const data = sentinel.interface.encodeFunctionData("react", [record]);
      const rtxHash = await provider.send("eth_sendTransaction", [
        { from: SYSTEM, to: await sentinel.getAddress(), data, gas: "0x493E0" },
      ]);
      // Manual receipt polling: ethers' waitForTransaction can stall on this
      // slow VM (the tx mines fine, the waiter just never resolves). Nudge the
      // miner if the receipt does not appear promptly.
      let reactReceipt = null;
      const deadline = Date.now() + 300000;
      let nudged = false;
      while (!reactReceipt && Date.now() < deadline) {
        reactReceipt = await provider.getTransactionReceipt(rtxHash);
        if (!reactReceipt) {
          await sleep(2000);
          if (!nudged && Date.now() > deadline - 280000) {
            try {
              await provider.send("hardhat_mine", []);
            } catch {}
            nudged = true;
          }
        }
      }
      if (!reactReceipt) throw new Error(`react tx ${rtxHash} not mined within 300s`);
      await provider.send("hardhat_stopImpersonatingAccount", [SYSTEM]);
      return { price: p, timestamp: ts, callbacks: Number(await systemAsContract.callbackCount()) };
    };

    // Helper: deliver a recorded callback through the proxy, replicating what the
    // real proxy does — the first argument is overwritten with the sentinel's address.
    const deliverCallback = async (index) => {
      const cb = await systemAsContract.callbacks(index);
      const iface = new ethers.Interface(art("StopLossVault").abi);
      const decoded = iface.decodeFunctionData("executeStopLoss", cb.payload);
      const rebuilt = iface.encodeFunctionData("executeStopLoss", [
        await sentinel.getAddress(),
        decoded[1],
        decoded[2],
        decoded[3],
      ]);
      const tx = await proxy.forward(await vault.getAddress(), rebuilt);
      return tx.wait();
    };

    // 6. Price dips to $1,750 — only the stop-loss should fire.
    console.log("\n-- price $2000 -> $1750 (below the $1800 stop) --");
    const d1 = await deliverPrice(1750_00000000n);
    check("one callback requested", d1.callbacks === 1, `got ${d1.callbacks}`);
    const cb0 = await systemAsContract.callbacks(0);
    check("callback targets the vault", cb0.recipient.toLowerCase() === (await vault.getAddress()).toLowerCase());
    check("callback chain is Sepolia", cb0.chainId === SEPOLIA_CHAIN_ID);
    await deliverCallback(0);
    const o0 = await vault.getOrder(0);
    check("order #0 executed, escrow released", o0.executed && !o0.active);
    check("user got 100 sUSD back", (await token.balanceOf(userAddr)) === ethers.parseEther("950"));
    const o1 = await vault.getOrder(1);
    check("order #1 still active (take-profit untouched)", o1.active && !o1.executed);

    // 7. Duplicate delivery of the same price event must not re-fire order #0.
    console.log("\n-- duplicate delivery of the $1750 event --");
    await deliverPrice(1750_00000000n);
    check("no new callback on duplicate", Number(await systemAsContract.callbackCount()) === 1);

    // 8. Price rallies to $2,300 — the take-profit should fire.
    console.log("\n-- price $1750 -> $2300 (above the $2200 target) --");
    const d2 = await deliverPrice(2300_00000000n);
    check("second callback requested", d2.callbacks === 2, `got ${d2.callbacks}`);
    await deliverCallback(1);
    const o1b = await vault.getOrder(1);
    check("order #1 executed, escrow released", o1b.executed && !o1b.active);
    check("user got 50 sUSD back", (await token.balanceOf(userAddr)) === ethers.parseEther("1000"));

    // 9. Negative cases.
    console.log("\n-- negative cases --");
    try {
      await vault.connect(user).executeStopLoss(await sentinel.getAddress(), userAddr, 0, 1750_00000000n);
      check("direct executeStopLoss reverts (not the proxy)", false);
    } catch {
      check("direct executeStopLoss reverts (not the proxy)", true);
    }
    await (await vault.connect(user).deposit(ethers.parseEther("10"), 1900_00000000n, false)).wait();
    await (await vault.connect(user).cancelOrder(2)).wait();
    const o2 = await vault.getOrder(2);
    check("cancelled order refunds escrow", !o2.active && (await token.balanceOf(userAddr)) === ethers.parseEther("1000"));

    console.log(`\n== demo-local: ${failures === 0 ? "ALL GREEN" : failures + " FAILURES"} ==`);
  } finally {
    if (!KEEP_NODE) node.kill();
    else console.log("hardhat node left running on :8545 (--keep-node)");
  }
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
