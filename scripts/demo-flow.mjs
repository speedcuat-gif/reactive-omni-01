// Testnet end-to-end demo: arm a stop-loss, crash the price, and watch the
// full loop (origin event -> Lasna react -> Sepolia callback) happen on-chain,
// measuring the latency of every leg.
// Prerequisites: node scripts/deploy-all.mjs has been run (deployments.json).
// Usage: node scripts/demo-flow.mjs
import { ethers } from "ethers";
import { CHAINS, artifact, loadDeployer, readDeployments, fmtUSD } from "./common.mjs";

const d = readDeployments();
for (const k of ["feed", "token", "vault", "sentinel"]) {
  if (!d[k]) throw new Error(`deployments.json is missing ${k} — run node scripts/deploy-all.mjs first`);
}

const sepolia = new ethers.JsonRpcProvider(CHAINS.sepolia.rpc);
const lasna = new ethers.JsonRpcProvider(CHAINS.lasna.rpc);
const sepWallet = loadDeployer(sepolia);
const lasnaWallet = loadDeployer(lasna);
const user = await sepWallet.getAddress();

const feed = new ethers.Contract(d.feed, artifact("MockPriceFeed").abi, sepWallet);
const token = new ethers.Contract(d.token, artifact("MockToken").abi, sepWallet);
const vault = new ethers.Contract(d.vault, artifact("StopLossVault").abi, sepWallet);
const sentinel = new ethers.Contract(d.sentinel, artifact("StopLossSentinel").abi, lasnaWallet);
// Lasna rejects type-2 txs with a 0 priority fee ("gas tip cap 0, minimum
// needed 1") — ethers defaults it to 0 from the RPC's fee data, so set it
// explicitly (1 gwei tip, 200 gwei max fee matches the chain's fee market).
const lasnaFees = {
  maxPriorityFeePerGas: 1_000_000_000n,
  maxFeePerGas: 200_000_000_000n,
};

console.log("== Sentinel testnet demo ==");
console.log(`feed     ${d.feed}\ntoken    ${d.token}\nvault    ${d.vault}\nsentinel ${d.sentinel}`);
console.log(`price now ${fmtUSD(await feed.getPrice())}`);

const AMOUNT = ethers.parseEther("100");
const STOP = 1800_00000000n; // $1,800.00
const balBefore = await token.balanceOf(user);

// 1. Deposit + arm.
console.log(`\n-- deposit ${ethers.formatEther(AMOUNT)} sUSD, stop-loss ${fmtUSD(STOP)} --`);
await (await token.approve(d.vault, AMOUNT)).wait();
const depTx = await vault.deposit(AMOUNT, STOP, false);
const depRc = await depTx.wait();
const orderId = BigInt(depRc.logs.find((l) => l.topics[0] === ethers.id("OrderCreated(uint256,address,uint256,uint256,bool)")).topics[1]);
console.log(`order #${orderId} created (tx ${depTx.hash})`);
// Arm on LASNA via the Lasna wallet: the sentinel contract lives on Lasna,
// so arming through the Sepolia provider would send the call to an address
// with no code on Sepolia (a no-op that still mines).
const armTx = await sentinel.armOrder(orderId, STOP, false, lasnaFees);
await armTx.wait();
console.log(`order #${orderId} armed on the sentinel (tx ${armTx.hash})`);

// 2. Crash the price and time the loop.
console.log(`\n-- set price to $1,750 (below the stop) --`);
// Capture the poll windows BEFORE the price event: the sentinel can trigger
// within ~1s of the origin event, so a fromBlock captured after setPrice can
// already be past the trigger block and the poll would miss it forever.
const pollFromLasna = await lasna.getBlockNumber();
const pollFromSepolia = await sepolia.getBlockNumber();
const t0 = Date.now();
const setTx = await feed.setPrice(1750_00000000n);
const setRc = await setTx.wait();
const originBlock = await sepolia.getBlock(setRc.blockNumber);
console.log(`origin event tx ${setTx.hash} (Sepolia block ${setRc.blockNumber}, ${new Date(originBlock.timestamp * 1000).toISOString()})`);

// 3. Poll Lasna for the Triggered event, then Sepolia for the execution.
console.log("waiting for the sentinel to fire (polling Lasna)...");
// Lasna RPC rejects getLogs over >30,000 blocks, and "earliest" spans the
// whole chain (~9M blocks) — poll in a sliding window instead: each call
// covers only the blocks since the previous call, so the range stays tiny.
let lasnaFrom = pollFromLasna;
let triggeredBlock = null;
for (let i = 0; i < 40; i++) {
  const lasnaTo = await lasna.getBlockNumber();
  const events = await sentinel.queryFilter(sentinel.filters.OrderTriggered, lasnaFrom, lasnaTo);
  lasnaFrom = lasnaTo + 1;
  const ev = events.find((e) => e.args.orderId === orderId);
  if (ev) {
    triggeredBlock = await lasna.getBlock(ev.blockNumber);
    console.log(`sentinel triggered in Lasna block ${ev.blockNumber} (${new Date(triggeredBlock.timestamp * 1000).toISOString()})`);
    break;
  }
  await new Promise((r) => setTimeout(r, 15000));
}
if (!triggeredBlock) throw new Error("sentinel did not trigger within 10 minutes — check funding + subscription");

console.log("waiting for the vault callback on Sepolia...");
let sepFrom = pollFromSepolia;
let execBlock = null;
for (let i = 0; i < 40; i++) {
  const sepTo = await sepolia.getBlockNumber();
  const events = await vault.queryFilter(vault.filters.StopLossExecuted, sepFrom, sepTo);
  sepFrom = sepTo + 1;
  const ev = events.find((e) => e.args.orderId === orderId);
  if (ev) {
    execBlock = await sepolia.getBlock(ev.blockNumber);
    console.log(`vault executed in Sepolia block ${ev.blockNumber} (tx ${ev.transactionHash})`);
    break;
  }
  await new Promise((r) => setTimeout(r, 15000));
}
if (!execBlock) throw new Error("callback did not arrive within 10 minutes — check vault funding");

// 4. Verify + report latency.
const order = await vault.getOrder(orderId);
const balAfter = await token.balanceOf(user);
const t1 = Date.now();
console.log("\n== result ==");
console.log(`order executed: ${order.executed} | user sUSD: ${ethers.formatEther(balBefore)} -> ${ethers.formatEther(balAfter)}`);
console.log(`wall-clock loop: ${((t1 - t0) / 1000).toFixed(1)}s`);
console.log(`origin block -> sentinel trigger: ${triggeredBlock.timestamp - originBlock.timestamp}s`);
console.log(`sentinel trigger -> vault callback: ${execBlock.timestamp - triggeredBlock.timestamp}s`);
console.log(`FULL LOOP (origin event -> funds released): ${execBlock.timestamp - originBlock.timestamp}s`);
console.log(`\nEvidence:\n  origin:   ${CHAINS.sepolia.explorer}/tx/${setTx.hash}\n  sentinel: ${CHAINS.lasna.explorer}/address/${d.sentinel}\n  callback: ${CHAINS.sepolia.explorer}/address/${d.vault}`);
