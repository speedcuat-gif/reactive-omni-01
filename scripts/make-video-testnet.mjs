// Build the demo video from the LIVE testnet deployment: screenshot the UI at
// three stages reconstructed from the real on-chain history (armed /
// stop-loss fired / take-profit fired), and assemble a captioned slideshow
// into web/demo.mp4 (silent; narration in DEMO_SCRIPT.md).
// The stages are real points in the testnet run (Sepolia + Lasna):
//   stage 1 — just before the 07:04:48Z price set: orders #1/#2 armed (order
//             #1 already executed from the earlier $1,750 event), escrow 200 sUSD
//   stage 2 — after the stop-loss fired: order #2 executed, escrow 100 sUSD
//   stage 3 — live state now: take-profit #3 executed at $2,300, all settled
// Usage: node scripts/make-video-testnet.mjs
// Requires: Chromium at /opt/meta-chromium/chrome, ffmpeg, python3 + PIL.
import { spawn, execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { ethers } from "ethers";
import { fileURLToPath } from "node:url";
import { CHAINS, artifact, loadDeployer, readDeployments } from "./common.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CHROME = "/opt/meta-chromium/chrome";
const SHOTS = path.join(ROOT, "web", "screenshots");
fs.mkdirSync(SHOTS, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fmtUSD = (v) => `$${(Number(v) / 1e8).toFixed(2)}`;
const fmtTok = (v) => Number(ethers.formatEther(v)).toFixed(2);

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
  console.log("== Sentinel testnet video build ==");
  const d = readDeployments();
  const sepolia = new ethers.JsonRpcProvider(CHAINS.sepolia.rpc);
  const lasna = new ethers.JsonRpcProvider(CHAINS.lasna.rpc);
  const wallet = loadDeployer(sepolia);
  const user = await wallet.getAddress();
  const feed = new ethers.Contract(d.feed, artifact("MockPriceFeed").abi, sepolia);
  const token = new ethers.Contract(d.token, artifact("MockToken").abi, sepolia);
  const vault = new ethers.Contract(d.vault, artifact("StopLossVault").abi, sepolia);
  const sentinel = new ethers.Contract(d.sentinel, artifact("StopLossSentinel").abi, lasna);

  const shortTx = (h) => `${h.slice(0, 10)}…${h.slice(-6)}`;
  const orderRow = (id, type, amount, trigger, status) => ({
    id, type, amount, trigger, status,
    statusClass: status === "Executed" ? "executed" : status === "Armed" ? "armed" : "cancelled",
  });

  // Live state (stage 3) + sentinel balance.
  const livePrice = await feed.getPrice();
  const liveEscrow = await token.balanceOf(d.vault);
  const liveBal = await token.balanceOf(user);
  const liveArmed = Number(await sentinel.armedOrderCount());
  const sentinelBal = Number(ethers.formatEther(await lasna.getBalance(d.sentinel))).toFixed(3) + " lREACT";
  console.log(`live: price ${fmtUSD(livePrice)}, escrow ${fmtTok(liveEscrow)}, myBal ${fmtTok(liveBal)}, armed ${liveArmed}, sentinel ${sentinelBal}`);

  const cfg = {
    sepoliaRpc: CHAINS.sepolia.rpc,
    lasnaRpc: CHAINS.lasna.rpc,
    feed: d.feed, token: d.token, vault: d.vault, sentinel: d.sentinel, deployer: user,
  };

  const evCreated0 = { text: "Order #0 created — 100.00 sUSD @ $1,800.00", when: "tx " + shortTx("0xd9d02eb523e6396b8f099e613e9cf075e33e7de1435de2c1f02db7c66e6c2f20") };
  const evCreated1 = { text: "Order #1 created — 100.00 sUSD @ $1,800.00", when: "tx " + shortTx("0x15d4dc2a2fcfedb1cb63acd4c38dee970492f776dd843b6f04aeb0d4fe829b27") };
  const evCreated2 = { text: "Order #2 created — 100.00 sUSD @ $1,800.00", when: "tx " + shortTx("0xc60691c01471d7fa559ffd4950eb82c867a5cd9098d303f5c2ac973e0208f3c2") };
  const evTrig1 = { text: "Sentinel triggered order #1 at $1,750.00", when: "tx " + shortTx("0x847c5bc0b2231c9e1a8d61661a5ef07cdec847822698c8912d607f5b5e3c68dc") };
  const evExec1 = { text: "Vault released 100.00 sUSD for order #1", when: "tx " + shortTx("0xd22de09c7122c99cd5673681e9da04467033433ac51ec9d648dcdfbf2df00099") };
  const evTrig2 = { text: "Sentinel triggered order #2 at $1,750.00", when: "tx " + shortTx("0xd07cf85261d8abfae5eafc2ead56dc697e56664e9212030d573e1cd0348fc42b") };
  const evExec2 = { text: "Vault released 100.00 sUSD for order #2", when: "tx " + shortTx("0x82f6ae87268463b26b30a3b9079e9184144e3c93e14edf2a6df4480d1fd526e2") };
  const evCancel0 = { text: "Order #0 cancelled — 100.00 sUSD refunded", when: "tx " + shortTx("0xe0838ed992277c4bababc0efa22c8e04df7d257bd161416e23736e576cfbe409") };
  const evCreated3 = { text: "Order #3 created — 50.00 sUSD @ $2,200.00 (take-profit)", when: "tx " + shortTx("0x986cfbcf99789d8c51f6a470f5ea5abc1447b7e1b287f8848e2cf1006eb18659") };
  const evTrig3 = { text: "Sentinel triggered order #3 at $2,300.00", when: "tx " + shortTx("0xff671f8574fcfdbc60c6bfcdcceb4a1c61328eb23043aeaa9b6cdaf60f4dfed2") };
  const evExec3 = { text: "Vault released 50.00 sUSD for order #3", when: "tx " + shortTx("0x2dd3606f13335789584760d7fbaa269e82163be2372480e54b8522d36f00ac64") };

  // "armed" below counts orders that can still fire (armed on the sentinel
  // and not yet triggered), not the contract's cumulative armedOrderCount()
  // (which keeps triggered orders in its list). Sentinel lREACT for stages
  // 1–2 is derived from the measured live balance (0.940 after 3 reacts
  // from 1.000 funded ≈ 0.020/react): stage 1 = 1 react done, stage 2 = 2.
  const stages = [
    {
      name: "t1-armed",
      snap: {
        price: "175000000000", escrow: "200.00", myBal: "1900.00", armed: 1,
        sentinelBal: "0.980 lREACT",
        orders: [
          orderRow(0, "Stop-loss", "100.00", "$1,800.00", "Armed"),
          orderRow(1, "Stop-loss", "100.00", "$1,800.00", "Executed"),
          orderRow(2, "Stop-loss", "100.00", "$1,800.00", "Armed"),
        ],
        events: [evCreated0, evCreated1, evCreated2, evTrig1, evExec1],
        note: "testnet — orders armed, price $1,750",
      },
    },
    {
      name: "t2-stoploss",
      snap: {
        price: "175000000000", escrow: "100.00", myBal: "1900.00", armed: 0,
        sentinelBal: "0.960 lREACT",
        orders: [
          orderRow(0, "Stop-loss", "100.00", "$1,800.00", "Armed"),
          orderRow(1, "Stop-loss", "100.00", "$1,800.00", "Executed"),
          orderRow(2, "Stop-loss", "100.00", "$1,800.00", "Executed"),
        ],
        events: [evCreated0, evCreated1, evCreated2, evTrig1, evExec1, evTrig2, evExec2],
        note: "testnet — stop-loss fired at $1,750, escrow released (full loop 12s)",
      },
    },
    {
      name: "t3-takeprofit",
      snap: {
        price: livePrice.toString(), escrow: fmtTok(liveEscrow), myBal: fmtTok(liveBal), armed: 0,
        sentinelBal,
        orders: [
          orderRow(0, "Stop-loss", "100.00", "$1,800.00", "Cancelled"),
          orderRow(1, "Stop-loss", "100.00", "$1,800.00", "Executed"),
          orderRow(2, "Stop-loss", "100.00", "$1,800.00", "Executed"),
          orderRow(3, "Take-profit", "50.00", "$2,200.00", "Executed"),
        ],
        events: [evCreated0, evCreated1, evCreated2, evTrig1, evExec1, evTrig2, evExec2, evCancel0, evCreated3, evTrig3, evExec3],
        note: "testnet — take-profit fired at $2,300, all orders settled",
      },
    },
  ];

  const buildStageHtml = (snap) => {
    let html = fs.readFileSync(path.join(ROOT, "web", "index.html"), "utf8");
    const ethersSrc = fs.readFileSync(path.join(ROOT, "web", "vendor", "ethers.umd.min.js"), "utf8");
    const appSrc = fs.readFileSync(path.join(ROOT, "web", "app.js"), "utf8");
    html = html.replace('<script src="vendor/ethers.umd.min.js"></script>', `<script>${ethersSrc}</script>`);
    html = html.replace('<script src="config.js"></script>', `<script>window.SENTINEL_CONFIG = ${JSON.stringify(cfg)};</script>`);
    html = html.replace('<script src="app.js"></script>', `<script>window.SENTINEL_SNAPSHOT = ${JSON.stringify(snap)};</script><script>${appSrc}</script>`);
    return html;
  };

  // Chromium (headless CDP). This VM's Chromium blocks all local-network
  // navigation, so the stills are rendered from standalone file:// pages.
  const policy = "hatch-webgl-allowed-domains-v1\n";
  fs.writeFileSync("/tmp/hatch-webgl.json", policy);
  const policySha = crypto.createHash("sha256").update(policy).digest("hex");
  const chrome = spawn(CHROME, [
    "--headless=new", "--no-sandbox", "--disable-gpu",
    "--remote-debugging-port=9222", "--window-size=1280,900",
    "--user-data-dir=/tmp/chrome-video-profile",
    `--hatch-webgl-allowed-domains-file=/tmp/hatch-webgl.json`,
    `--hatch-webgl-allowed-domains-sha256=${policySha}`,
    "about:blank",
  ], { stdio: "ignore" });

  try {
    const waitFor = async (url, tries = 40) => {
      for (let i = 0; i < tries; i++) {
        try { const r = await fetch(url); if (r.ok) return true; } catch {}
        await sleep(500);
      }
      return false;
    };
    if (!(await waitFor("http://127.0.0.1:9222/json/version"))) throw new Error("chromium did not come up");
    const put = await fetch(`http://127.0.0.1:9222/json/new?${encodeURIComponent("about:blank")}`, { method: "PUT" });
    const target = await put.json();
    const cdp = new CDP();
    await cdp.connect(target.webSocketDebuggerUrl);
    await cdp.call("Page.enable");
    for (const s of stages) {
      fs.writeFileSync(path.join(SHOTS, `${s.name}.html`), buildStageHtml(s.snap));
      await cdp.screenshot(`file://${path.join(SHOTS, `${s.name}.html`)}`, path.join(SHOTS, `${s.name}.png`));
    }
    cdp.close();
  } finally {
    chrome.kill();
  }

  // Caption cards + slideshow via PIL + ffmpeg.
  const slides = [
    { img: null, caption: "SENTINEL — stop-loss & take-profit, executed by Reactive", sub: "Reactive Omni Buildathon · Set It and Forget It · live on Sepolia + Lasna testnets", dur: 4 },
    { img: "t1-armed.png", caption: "Orders armed on testnet — escrowed sUSD, stop-loss at $1,800.", sub: "", dur: 5 },
    { img: "t2-stoploss.png", caption: "Price crashes to $1,750. The sentinel fires, the vault releases the escrow. Full loop: 12 seconds.", sub: "", dur: 5 },
    { img: "t3-takeprofit.png", caption: "Take-profit at $2,200 fires on the rally to $2,300. All orders settled — no bot, no keeper.", sub: "", dur: 5 },
    { img: null, caption: "Sentinel — set it, and forget it.", sub: "Live deployment + tx hashes in the repo", dur: 3 },
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
  fs.writeFileSync("/tmp/cards-testnet.py", py);
  fs.writeFileSync("/tmp/slides-testnet.json", JSON.stringify(slides));
  await new Promise((res, rej) =>
    execFile("python3", ["/tmp/cards-testnet.py", "/tmp/slides-testnet.json", SHOTS], (e, so, se) => (e ? rej(new Error(se || e.message)) : res(so)))
  );
  const list = slides.map((s, i) => `file '${path.join(SHOTS, `slide-${i}.png`)}'\nduration ${s.dur}`).join("\n");
  fs.writeFileSync("/tmp/slides-testnet.txt", list + `\nfile '${path.join(SHOTS, `slide-${slides.length - 1}.png`)}'`);
  await new Promise((res, rej) =>
    execFile("ffmpeg", ["-y", "-f", "concat", "-safe", "0", "-i", "/tmp/slides-testnet.txt", "-vf", "scale=1280:900,format=yuv420p", "-r", "30", path.join(ROOT, "web", "demo.mp4")], (e, so, se) => (e ? rej(new Error(se)) : res(so)))
  );
  const st = fs.statSync(path.join(ROOT, "web", "demo.mp4"));
  console.log(`video web/demo.mp4 (testnet) — ${st.size} bytes`);
}

main().catch((e) => {
  console.error("VIDEO FAILED:", e.message);
  process.exit(1);
});
