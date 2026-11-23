// Build the demo video: deploy Sentinel locally, screenshot the UI at three
// stages (armed / stop-loss fired / take-profit fired), and assemble a
// captioned slideshow into web/demo.mp4 (silent; narration in DEMO_SCRIPT.md).
// Usage: node scripts/make-video.mjs
// Requires: hardhat node (spawned here), Chromium at /opt/meta-chromium/chrome,
// ffmpeg, python3 + PIL (for caption cards).
import { spawn, execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { ethers } from "ethers";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const RPC = "http://127.0.0.1:8545";
const UI = "http://localhost:8080/";
const SYSTEM = "0x8888888888888888888888888888888888888888";
const SEPOLIA_CHAIN_ID = 11155111n;
const CHROME = "/opt/meta-chromium/chrome";
const SHOTS = path.join(ROOT, "web", "screenshots");
fs.mkdirSync(SHOTS, { recursive: true });

const art = (n) => JSON.parse(fs.readFileSync(path.join(ROOT, "artifacts", `${n}.json`), "utf8"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fmtUSD = (v) => `$${(Number(v) / 1e8).toFixed(2)}`;
const fmtTok = (v) => Number(ethers.formatEther(v)).toFixed(2);

async function waitFor(url, tries = 40) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url);
      if (r.ok) return true;
    } catch {}
    await sleep(500);
  }
  return false;
}

// ---------- CDP screenshot helper (Node built-in WebSocket) ----------
class CDP {
  constructor() {
    this.id = 0;
    this.pending = new Map();
  }
  async connect(wsUrl) {
    this.ws = new WebSocket(wsUrl);
    await new Promise((res, rej) => {
      this.ws.onopen = res;
      this.ws.onerror = rej;
    });
    this.ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { res, rej } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        msg.error ? rej(new Error(JSON.stringify(msg.error))) : res(msg.result);
      }
    };
  }
  call(method, params = {}) {
    const id = ++this.id;
    return new Promise((res, rej) => {
      this.pending.set(id, { res, rej });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  async screenshot(url, outPath) {
    await this.call("Page.navigate", { url });
    await sleep(3500);
    const { data } = await this.call("Page.captureScreenshot", { format: "png" });
    fs.writeFileSync(outPath, Buffer.from(data, "base64"));
    console.log(`shot ${outPath} (${fs.statSync(outPath).size} bytes)`);
  }
  close() {
    try {
      this.ws.close();
    } catch {}
  }
}

async function main() {
  console.log("== Sentinel video build ==");
  const node = spawn("npx", ["hardhat", "node", "--port", "8545"], { cwd: ROOT, stdio: "ignore" });
  // WebGL policy file (empty allow-list; the UI needs no WebGL, but the
  // bundled Chromium requires the flags to start).
  const policy = "hatch-webgl-allowed-domains-v1\n";
  fs.writeFileSync("/tmp/hatch-webgl.json", policy);
  const policySha = crypto.createHash("sha256").update(policy).digest("hex");
  const chrome = spawn(CHROME, [
    "--headless=new",
    "--no-sandbox",
    "--disable-gpu",
    "--remote-debugging-port=9222",
    "--window-size=1280,900",
    "--user-data-dir=/tmp/chrome-video-profile",
    `--hatch-webgl-allowed-domains-file=/tmp/hatch-webgl.json`,
    `--hatch-webgl-allowed-domains-sha256=${policySha}`,
    "about:blank",
  ], { stdio: "ignore" });

  try {
    if (!(await waitFor(RPC))) throw new Error("hardhat node did not come up");
    if (!(await waitFor("http://127.0.0.1:9222/json/version"))) throw new Error("chromium did not come up");
    const provider = new ethers.JsonRpcProvider(RPC);
    const [deployer, user] = [await provider.getSigner(0), await provider.getSigner(1)];
    const userAddr = await user.getAddress();

    const deploy = async (name, signer, args = [], value = 0n) => {
      const a = art(name);
      const f = new ethers.ContractFactory(a.abi, a.bytecode, signer);
      const c = await f.deploy(...args, { value });
      await c.waitForDeployment();
      return new ethers.Contract(await c.getAddress(), a.abi, signer);
    };

    const mockSystem = await deploy("MockSystem", deployer);
    await provider.send("hardhat_setCode", [SYSTEM, await provider.getCode(await mockSystem.getAddress())]);
    const systemAsContract = new ethers.Contract(SYSTEM, art("MockSystem").abi, provider);
    const feed = await deploy("MockPriceFeed", deployer, [2000_00000000n]);
    const token = await deploy("MockToken", deployer);
    await (await token.mint(userAddr, ethers.parseEther("1000"))).wait();
    const proxy = await deploy("MockCallbackProxy", deployer);
    const sentinel = await deploy("StopLossSentinel", deployer, [await feed.getAddress(), SEPOLIA_CHAIN_ID], ethers.parseEther("1"));
    const vault = await deploy("StopLossVault", deployer, [await proxy.getAddress(), await sentinel.getAddress(), await token.getAddress()], ethers.parseEther("0.1"));
    await (await sentinel.setVault(await vault.getAddress())).wait();
    const cfg = {
      sepoliaRpc: RPC,
      lasnaRpc: RPC,
      feed: await feed.getAddress(),
      token: await token.getAddress(),
      vault: await vault.getAddress(),
      sentinel: await sentinel.getAddress(),
      deployer: userAddr,
    };
    fs.writeFileSync(path.join(ROOT, "web", "config.js"), `window.SENTINEL_CONFIG = ${JSON.stringify(cfg, null, 2)};\n`);

    const writeSnapshot = async (note) => {
      const price = await feed.getPrice();
      const escrow = await token.balanceOf(cfg.vault);
      const myBal = await token.balanceOf(userAddr);
      const armed = Number(await sentinel.armedOrderCount());
      const sBal = await provider.getBalance(cfg.sentinel);
      const orders = [];
      for (let i = 0; i < Number(await vault.nextOrderId()); i++) {
        const o = await vault.getOrder(i);
        orders.push({
          id: i,
          type: o.isTakeProfit ? "Take-profit" : "Stop-loss",
          amount: fmtTok(o.amount),
          trigger: fmtUSD(o.stopPrice),
          status: o.executed ? "Executed" : o.active ? "Armed" : "Cancelled",
          statusClass: o.executed ? "executed" : o.active ? "armed" : "cancelled",
        });
      }
      const evs = [];
      for (const e of await vault.queryFilter(vault.filters.OrderCreated, 0, "latest"))
        evs.push({ text: `Order #${e.args.orderId} created — ${fmtTok(e.args.amount)} sUSD @ ${fmtUSD(e.args.stopPrice)}`, when: `block ${e.blockNumber}` });
      for (const e of await sentinel.queryFilter(sentinel.filters.OrderTriggered, 0, "latest"))
        evs.push({ text: `Sentinel triggered order #${e.args.orderId} at ${fmtUSD(e.args.price)}`, when: `block ${e.blockNumber}` });
      for (const e of await vault.queryFilter(vault.filters.StopLossExecuted, 0, "latest"))
        evs.push({ text: `Vault released ${fmtTok(e.args.amount)} sUSD for order #${e.args.orderId}`, when: `block ${e.blockNumber}` });
      const snap = { price: price.toString(), escrow: fmtTok(escrow), myBal: fmtTok(myBal), armed, sentinelBal: Number(ethers.formatEther(sBal)).toFixed(3) + " lREACT", orders, events: evs, note };
      fs.writeFileSync(path.join(ROOT, "web", "snapshot.json"), JSON.stringify(snap, null, 2));
      return snap;
    };

    // Build a standalone, self-contained HTML for one stage (inlined ethers,
    // config, app and snapshot) so Chromium can render it from file:// —
    // this VM's Chromium blocks all local-network navigation/fetch.
    const buildStageHtml = (snap) => {
      let html = fs.readFileSync(path.join(ROOT, "web", "index.html"), "utf8");
      const ethersSrc = fs.readFileSync(path.join(ROOT, "web", "vendor", "ethers.umd.min.js"), "utf8");
      const appSrc = fs.readFileSync(path.join(ROOT, "web", "app.js"), "utf8");
      html = html.replace('<script src="vendor/ethers.umd.min.js"></script>', `<script>${ethersSrc}</script>`);
      html = html.replace('<script src="config.js"></script>', `<script>window.SENTINEL_CONFIG = ${JSON.stringify(cfg)};</script>`);
      html = html.replace('<script src="app.js"></script>', `<script>window.SENTINEL_SNAPSHOT = ${JSON.stringify(snap)};</script><script>${appSrc}</script>`);
      return html;
    };

    const deliverPrice = async (price) => {
      const tx = await feed.connect(deployer).setPrice(price);
      const receipt = await tx.wait();
      const log = receipt.logs.find((l) => l.topics[0] === ethers.id("PriceUpdated(uint256,uint256)"));
      const record = {
        chainId: SEPOLIA_CHAIN_ID, contractAddress: await feed.getAddress(),
        topic0: BigInt(log.topics[0]), topic1: 0n, topic2: 0n, topic3: 0n,
        data: log.data, blockNumber: BigInt(log.blockNumber), opCode: 0n,
        blockHash: BigInt(log.blockHash), txHash: BigInt(log.transactionHash), logIndex: BigInt(log.index),
      };
      await (await deployer.sendTransaction({ to: SYSTEM, value: ethers.parseEther("1") })).wait();
      await provider.send("hardhat_impersonateAccount", [SYSTEM]);
      const data = sentinel.interface.encodeFunctionData("react", [record]);
      const hash = await provider.send("eth_sendTransaction", [{ from: SYSTEM, to: await sentinel.getAddress(), data, gas: "0x493E0" }]);
      // Manual receipt polling: ethers' waitForTransaction can stall on this
      // slow VM (the tx mines fine, the waiter just never resolves). Nudge the
      // miner if the receipt does not appear promptly.
      let reactReceipt = null;
      const deadline = Date.now() + 300000;
      let nudged = false;
      while (!reactReceipt && Date.now() < deadline) {
        reactReceipt = await provider.getTransactionReceipt(hash);
        if (!reactReceipt) {
          await sleep(2000);
          if (!nudged && Date.now() > deadline - 280000) {
            try { await provider.send("hardhat_mine", []); } catch {}
            nudged = true;
          }
        }
      }
      if (!reactReceipt) throw new Error(`react tx ${hash} not mined within 300s`);
      await provider.send("hardhat_stopImpersonatingAccount", [SYSTEM]);
    };
    const deliverCallback = async (index) => {
      const cb = await systemAsContract.callbacks(index);
      const iface = new ethers.Interface(art("StopLossVault").abi);
      const decoded = iface.decodeFunctionData("executeStopLoss", cb.payload);
      const rebuilt = iface.encodeFunctionData("executeStopLoss", [await sentinel.getAddress(), decoded[1], decoded[2], decoded[3]]);
      await (await proxy.forward(await vault.getAddress(), rebuilt)).wait();
    };

    // Arm orders.
    await (await token.connect(user).approve(cfg.vault, ethers.parseEther("1000"))).wait();
    await (await vault.connect(user).deposit(ethers.parseEther("100"), 1800_00000000n, false)).wait();
    await (await vault.connect(user).deposit(ethers.parseEther("50"), 2200_00000000n, true)).wait();
    await (await sentinel.connect(user).armOrder(0, 1800_00000000n, false)).wait();
    await (await sentinel.connect(user).armOrder(1, 2200_00000000n, true)).wait();

    // CDP: open one tab, screenshot a standalone file:// page per stage.
    const put = await fetch(`http://127.0.0.1:9222/json/new?${encodeURIComponent("about:blank")}`, { method: "PUT" });
    const target = await put.json();
    const cdp = new CDP();
    await cdp.connect(target.webSocketDebuggerUrl);
    await cdp.call("Page.enable");

    const snap1 = await writeSnapshot("local demo — orders armed, price $2,000");
    fs.writeFileSync(path.join(SHOTS, "stage-1.html"), buildStageHtml(snap1));
    await cdp.screenshot(`file://${path.join(SHOTS, "stage-1.html")}`, path.join(SHOTS, "1-armed.png"));

    await deliverPrice(1750_00000000n);
    await deliverCallback(0);
    const snap2 = await writeSnapshot("local demo — stop-loss fired at $1,750, escrow released");
    fs.writeFileSync(path.join(SHOTS, "stage-2.html"), buildStageHtml(snap2));
    await cdp.screenshot(`file://${path.join(SHOTS, "stage-2.html")}`, path.join(SHOTS, "2-stoploss.png"));

    await deliverPrice(2300_00000000n);
    await deliverCallback(1);
    const snap3 = await writeSnapshot("local demo — take-profit fired at $2,300, both orders settled");
    fs.writeFileSync(path.join(SHOTS, "stage-3.html"), buildStageHtml(snap3));
    await cdp.screenshot(`file://${path.join(SHOTS, "stage-3.html")}`, path.join(SHOTS, "3-takeprofit.png"));
    cdp.close();

    // Caption cards + slideshow via PIL + ffmpeg.
    const slides = [
      { img: null, caption: "SENTINEL — stop-loss & take-profit, executed by Reactive", sub: "Reactive Omni Buildathon · Set It and Forget It", dur: 4 },
      { img: "1-armed.png", caption: "Arm an order once and forget it — 100 sUSD escrowed, stop-loss at $1,800.", sub: "", dur: 5 },
      { img: "2-stoploss.png", caption: "Price crashes to $1,750. The sentinel fires, the vault releases the escrow.", sub: "", dur: 5 },
      { img: "3-takeprofit.png", caption: "Take-profit at $2,200 fires on the rally. Both orders settled — no bot, no keeper.", sub: "", dur: 5 },
      { img: null, caption: "Sentinel — set it, and forget it.", sub: "Built for the Reactive Omni Buildathon · contracts + docs in the repo", dur: 3 },
    ];
    const py = `
from PIL import Image, ImageDraw, ImageFont
import json, sys
slides = json.load(open(sys.argv[1]))
outdir = sys.argv[2]
title_font = ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf", 44)
cap_font = ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf", 26)
sub_font = ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf", 20)
for i, s in enumerate(slides):
    if s["img"]:
        im = Image.open(f"{outdir}/{s['img']}").convert("RGB").resize((1280, 900))
        d = ImageDraw.Draw(im)
        d.rectangle([0, 800, 1280, 900], fill=(13, 17, 23))
        d.text((32, 816), s["caption"], font=cap_font, fill=(230, 237, 243))
    else:
        im = Image.new("RGB", (1280, 900), (13, 17, 23))
        d = ImageDraw.Draw(im)
        d.text((64, 380), s["caption"], font=title_font, fill=(88, 166, 255))
        if s["sub"]:
            d.text((64, 450), s["sub"], font=sub_font, fill=(139, 148, 158))
    im.save(f"{outdir}/slide-{i}.png")
print("cards done")
`;
    fs.writeFileSync("/tmp/cards.py", py);
    fs.writeFileSync("/tmp/slides.json", JSON.stringify(slides.map((s) => ({ ...s, img: s.img || null }))));
    // slides reference screenshots dir for images
    const slidesForPy = slides.map((s) => ({ ...s }));
    fs.writeFileSync("/tmp/slides.json", JSON.stringify(slidesForPy));
    const run = (cmd) => new Promise((res, rej) => execFile("python3", ["/tmp/cards.py", "/tmp/slides.json", SHOTS], (e, so, se) => (e ? rej(new Error(se || e.message)) : res(so))));
    // cards.py reads images from outdir, so put slide json paths relative to SHOTS
    await run();
    const list = slides.map((s, i) => `file '${path.join(SHOTS, `slide-${i}.png`)}'\nduration ${s.dur}`).join("\n");
    fs.writeFileSync("/tmp/slides.txt", list + `\nfile '${path.join(SHOTS, `slide-${slides.length - 1}.png`)}'`);
    await new Promise((res, rej) =>
      execFile("ffmpeg", ["-y", "-f", "concat", "-safe", "0", "-i", "/tmp/slides.txt", "-vf", "scale=1280:900,format=yuv420p", "-r", "30", path.join(ROOT, "web", "demo.mp4")], (e, so, se) => (e ? rej(new Error(se)) : res(so)))
    );
    const st = fs.statSync(path.join(ROOT, "web", "demo.mp4"));
    console.log(`video web/demo.mp4 — ${st.size} bytes`);
  } finally {
    node.kill();
    chrome.kill();
  }
}

main().catch((e) => {
  console.error("VIDEO FAILED:", e.message);
  process.exit(1);
});
