// Shared helpers for the Sentinel scripts: env, artifacts, chain configs.
import fs from "node:fs";
import path from "node:path";
import dotenv from "dotenv";
import { ethers } from "ethers";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

dotenv.config({ path: path.join(ROOT, ".env") });

export const CHAINS = {
  sepolia: {
    name: "Ethereum Sepolia",
    chainId: 11155111n,
    rpc: process.env.SEPOLIA_RPC || "https://ethereum-sepolia-rpc.publicnode.com",
    faucet: "0x9b9BB25f1A81078C544C829c5EB7822d747Cf434",
    callbackProxy: "0xAa14d9Cd0f788Ca23d11805986C1d8bd035D23b4",
    explorer: "https://sepolia.etherscan.io",
  },
  lasna: {
    name: "Reactive Lasna",
    chainId: 5318007n,
    rpc: process.env.LASNA_RPC || "https://lasna-rpc.rnk.dev/",
    explorer: "https://lasna.reactscan.net",
  },
  baseSepolia: {
    name: "Base Sepolia",
    chainId: 84532n,
    rpc: process.env.BASE_SEPOLIA_RPC || "https://sepolia.base.org",
    faucet: "0x2afaFD298b23b62760711756088F75B7409f5967",
    callbackProxy: "0x476F44b11F5C942c58f4c8E3d0300E5710743585",
    explorer: "https://sepolia.basescan.org",
  },
};

export function loadDeployer(provider) {
  const key = process.env.DEPLOYER_PRIVATE_KEY;
  if (!key) throw new Error("DEPLOYER_PRIVATE_KEY is not set in .env — see README.md");
  return new ethers.Wallet(key, provider);
}

export function artifact(name) {
  return JSON.parse(fs.readFileSync(path.join(ROOT, "artifacts", `${name}.json`), "utf8"));
}

export async function deploy(name, signer, args = [], value = 0n, overrides = {}) {
  const a = artifact(name);
  const factory = new ethers.ContractFactory(a.abi, a.bytecode, signer);
  const c = await factory.deploy(...args, { value, ...overrides });
  await c.waitForDeployment();
  return new ethers.Contract(await c.getAddress(), a.abi, signer);
}

export function deploymentsPath() {
  return path.join(ROOT, "deployments.json");
}

export function readDeployments() {
  const p = deploymentsPath();
  if (!fs.existsSync(p)) return {};
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

export function writeDeployments(patch) {
  const cur = readDeployments();
  const next = { ...cur, ...patch };
  fs.writeFileSync(deploymentsPath(), JSON.stringify(next, null, 2) + "\n");
  return next;
}

export const fmtUSD = (v) => `$${(Number(v) / 1e8).toFixed(2)}`;
