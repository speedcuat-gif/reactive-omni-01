// Get testnet lREACT for the deployer by sending Sepolia ETH to the Reactive
// faucet contract (1 ETH -> 100 lREACT, max 5 ETH per transaction).
// Usage: node scripts/fund-lasna.mjs [ethAmount]
//   ethAmount defaults to 0.05. Requires Sepolia ETH in the deployer wallet.
import { ethers } from "ethers";
import { CHAINS, loadDeployer } from "./common.mjs";

const amount = process.argv[2] ? ethers.parseEther(process.argv[2]) : ethers.parseEther("0.05");
if (amount > ethers.parseEther("5")) throw new Error("refusing: faucet max is 5 ETH per transaction");

const sepolia = new ethers.JsonRpcProvider(CHAINS.sepolia.rpc);
const lasna = new ethers.JsonRpcProvider(CHAINS.lasna.rpc);
const wallet = loadDeployer(sepolia);
const addr = await wallet.getAddress();

const sepBal = await sepolia.getBalance(addr);
const lBefore = await lasna.getBalance(addr);
console.log(`deployer ${addr}`);
console.log(`Sepolia ETH before: ${ethers.formatEther(sepBal)}`);
console.log(`Lasna lREACT before: ${ethers.formatEther(lBefore)}`);
if (sepBal < amount + ethers.parseEther("0.005")) {
  throw new Error(
    `not enough Sepolia ETH: have ${ethers.formatEther(sepBal)}, need ${ethers.formatEther(amount)} + gas.\n` +
      `Get Sepolia ETH from a faucet (e.g. https://sepolia-faucet.pk910.de — PoW, no account) and retry.`
  );
}

console.log(`sending ${ethers.formatEther(amount)} Sepolia ETH to the Reactive faucet ${CHAINS.sepolia.faucet} ...`);
const tx = await wallet.sendTransaction({ to: CHAINS.sepolia.faucet, value: amount });
console.log(`tx ${tx.hash} — waiting for confirmation...`);
await tx.wait();
console.log("confirmed. Waiting up to 60s for the lREACT to land on Lasna...");
for (let i = 0; i < 12; i++) {
  await new Promise((r) => setTimeout(r, 5000));
  const lAfter = await lasna.getBalance(addr);
  if (lAfter > lBefore) {
    console.log(`Lasna lREACT after: ${ethers.formatEther(lAfter)} (+${ethers.formatEther(lAfter - lBefore)})`);
    console.log("funded. Next: node scripts/deploy-all.mjs");
    process.exit(0);
  }
}
console.log(`lREACT has not arrived yet (still ${ethers.formatEther(await lasna.getBalance(addr))}).`);
console.log("The faucet can take a few minutes — re-run this script's balance check or just proceed; deploy-all.mjs verifies funding.");
