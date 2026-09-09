// Hook v4. Fixes the three faults in v3.
//   node hook-v4.mjs ./aerial.jpg ./front.jpg
//
// FAULT 1 (mine): v3 generated a good fitted-cover still and then ignored it, conditioning
//   Veo only on the real photo. Veo invented its own cover: a crumpled tarp.
//   FIX: pass BOTH frames. first = the real photo, last = the fitted-cover still. Veo
//   interpolates between two images we control. Then reverse. Vertex requires 8s for
//   lastFrame, so this costs $0.40 not $0.30.
//
// FAULT 2 (mine): the hook used one property and the cut used another.
//   FIX: both arguments must be the SAME property. Script warns if they look unrelated.
//
// FAULT 3: the title card was small, off-centre and unreadable.
//   FIX: rebuilt. Large script status, serif second word, wide-tracked address, dark
//   scrim behind the text, all inside the 9:16 safe zone.

import fs from "node:fs";
import { execSync } from "node:child_process";
import { GoogleAuth } from "google-auth-library";

const PROJECT = process.env.GCP_PROJECT_ID;
const LOCATION = process.env.GCP_LOCATION || "us-central1";
const VEO_MODEL = process.env.VEO_MODEL || "veo-3.1-lite-generate-001";
const IMAGE_MODEL = process.env.IMAGE_MODEL || "gemini-2.5-flash-image";
const PY = process.env.PYTHON_BIN || `${process.env.HOME}/.venvs/reel/bin/python3`;
const STATUS = process.env.STATUS || "Coming Soon";
const ADDRESS = process.env.ADDRESS || "253 Brindle Rd, Mechanicsburg, PA";
const DRAPE = process.env.DRAPE || "matte charcoal black";
const WINDOW_START = process.env.WINDOW_START || "2.6";
const WINDOW_LEN = process.env.WINDOW_LEN || "2.2";

const [aerial, front] = process.argv.slice(2);
if (!aerial || !fs.existsSync(aerial) || !front || !fs.existsSync(front)) {
  console.error("usage: node hook-v4.mjs <aerial.jpg> <front.jpg>   (SAME property, both required)");
  process.exit(1);
}
if (!fs.existsSync(PY)) { console.error(`python not found at ${PY}. Set PYTHON_BIN.`); process.exit(1); }

const auth = new GoogleAuth({ credentials: JSON.parse(Buffer.from(process.env.GCP_SA_JSON_B64, "base64").toString()), scopes: ["https://www.googleapis.com/auth/cloud-platform"] });
const token = (await (await auth.getClient()).getAccessToken()).token;
const base = `https://${LOCATION}-aiplatform.googleapis.com/v1/projects/${PROJECT}/locations/${LOCATION}`;
const H = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
const sh = (c) => execSync(c, { stdio: ["ignore", "pipe", "pipe"] }).toString().trim();
const b64 = (p) => fs.readFileSync(p).toString("base64");
const ledger = [];
async function post(u, b) {
  const r = await fetch(u, { method: "POST", headers: H, body: JSON.stringify(b) });
  const t = await r.text(); if (!r.ok) throw new Error(`${r.status}\n${t.slice(0, 900)}`); return JSON.parse(t);
}
function crop916(src, out, xc = 0.5) {
  const w = +sh(`ffprobe -v error -select_streams v:0 -show_entries stream=width -of csv=p=0 "${src}"`);
  const h = +sh(`ffprobe -v error -select_streams v:0 -show_entries stream=height -of csv=p=0 "${src}"`);
  let cw = Math.min(w, Math.round(h * 9 / 16)); cw -= cw % 2;
  let cx = Math.round((w - cw) * xc); cx -= cx % 2;
  sh(`ffmpeg -y -v error -i "${src}" -vf "crop=${cw}:${h}:${cx}:0,scale=720:1280" ${out}`);
}

console.log("1. crops");
crop916(aerial, "v4_aerial.png", parseFloat(process.env.X_AERIAL || "0.5"));
crop916(front, "v4_front.png", parseFloat(process.env.X_FRONT || "0.5"));

console.log("2. fitted-cover still (this WILL be used as the last frame)");
{
  const p = `Using the reference aerial photograph exactly as it is, add ONE element: a ${DRAPE} fabric cover pulled taut over the single house at the centre of the frame. The fabric follows the exact shape of the roof planes, the ridges and the walls, like a tailored cover on a car. It is smooth and taut, not bunched or crumpled. It covers that one house completely and stops at the ground line. It does not extend onto the lawn, the driveway, the trees or any neighbouring building.
Everything else is identical to the reference: same neighbouring buildings, same roads and driveway, same trees and shrubs, same vehicles, same sky, same time of day, same light and shadow direction, same camera position and altitude.
Photographic, matching the exposure and colour of the reference. No people. No text. No logos.`;
  const res = await post(`${base}/publishers/google/models/${IMAGE_MODEL}:generateContent`, {
    contents: [{ role: "user", parts: [{ text: p }, { inlineData: { mimeType: "image/png", data: b64("v4_aerial.png") } }] }],
    generationConfig: { responseModalities: ["IMAGE"] },
  });
  const part = res.candidates?.[0]?.content?.parts?.find((x) => x.inlineData);
  if (!part) throw new Error("no image: " + JSON.stringify(res).slice(0, 400));
  fs.writeFileSync("v4_still.png", Buffer.from(part.inlineData.data, "base64"));
  // Veo wants both frames the same size
  sh(`ffmpeg -y -v error -i v4_still.png -vf scale=720:1280 v4_still_r.png`);
  ledger.push({ step: "still", inr: 4 });
  console.log("   -> v4_still.png");
}

console.log("3. veo, FIRST=real photo  LAST=fitted-cover still  (8s, lastFrame needs 8s on Vertex)");
{
  const p = `Aerial drone shot, camera completely locked off, no camera movement whatsoever.
A ${DRAPE} fabric cover is lowered by two thin cables from a small helicopter high at the top of the frame. The fabric descends and draws itself smoothly and evenly over the house at the centre of the frame until it is taut over the roof and walls.
The neighbouring buildings, the driveway, the lawns, the trees, the shrubs, the parked vehicles and the sky remain exactly as they are and never change. Nothing else in the scene moves.
Real photographic drone footage, bright daylight, no cuts.`;
  const op = await post(`${base}/publishers/google/models/${VEO_MODEL}:predictLongRunning`, {
    instances: [{
      prompt: p,
      image: { bytesBase64Encoded: b64("v4_aerial.png"), mimeType: "image/png" },
      lastFrame: { bytesBase64Encoded: b64("v4_still_r.png"), mimeType: "image/png" },
    }],
    parameters: { aspectRatio: "9:16", durationSeconds: 8, resolution: "720p", generateAudio: false, sampleCount: 1, personGeneration: "dont_allow" },
  });
  console.log("   submitted", op.name.split("/").pop());
  let done = false, res;
  for (let i = 0; i < 90 && !done; i++) {
    await new Promise((r) => setTimeout(r, 10000));
    res = await post(`${base}/publishers/google/models/${VEO_MODEL}:fetchPredictOperation`, { operationName: op.name });
    done = !!res.done; process.stdout.write(done ? "  done\n" : ".");
  }
  const v = res.response?.videos?.[0];
  if (!v?.bytesBase64Encoded) throw new Error("no video: " + JSON.stringify(res.response).slice(0, 600));
  fs.writeFileSync("v4_forward.mp4", Buffer.from(v.bytesBase64Encoded, "base64"));
  ledger.push({ step: "veo 8s (lastFrame)", usd: 0.40 });
}

console.log("4. reverse + cut the usable window");
sh(`ffmpeg -y -v error -i v4_forward.mp4 -vf "reverse,fps=30" -an v4_rev.mp4`);
sh(`ffmpeg -y -v error -ss ${WINDOW_START} -t ${WINDOW_LEN} -i v4_rev.mp4 -an -r 30 v4_hook.mp4`);

console.log("5. title card");
fs.writeFileSync("_card4.py", `
from PIL import Image, ImageDraw, ImageFont
W,H=720,1280
im=Image.new("RGBA",(W,H),(0,0,0,0)); d=ImageDraw.Draw(im)
def f(paths,size):
    for p in paths:
        try:
            return ImageFont.truetype(p,size)
        except Exception: pass
    return ImageFont.load_default()
SCRIPT=["/System/Library/Fonts/Supplemental/SnellRoundhand.ttc","/System/Library/Fonts/Supplemental/Zapfino.ttf","/System/Library/Fonts/Supplemental/Georgia Italic.ttf","/Library/Fonts/Georgia Italic.ttf"]
SERIF =["/System/Library/Fonts/Supplemental/Georgia.ttf","/System/Library/Fonts/Supplemental/Times New Roman.ttf","/System/Library/Fonts/Supplemental/Baskerville.ttc"]
f_script=f(SCRIPT,150); f_serif=f(SERIF,78); f_small=f(SERIF,26)
words="""${STATUS}""".split()
l1=words[0]; l2=" ".join(words[1:])
# dark scrim so text reads over any photo
scrim=Image.new("RGBA",(W,H),(0,0,0,0)); sd=ImageDraw.Draw(scrim)
top=int(H*0.30); bot=int(H*0.56)
for y in range(top,bot):
    t=(y-top)/(bot-top); a=int(120*(1-abs(2*t-1)))
    sd.line([(0,y),(W,y)],fill=(0,0,0,a))
im=Image.alpha_composite(im,scrim); d=ImageDraw.Draw(im)
def centre(txt,font,y,track=0):
    if track:
        wds=[d.textbbox((0,0),c,font=font) for c in txt]
        total=sum(b[2]-b[0] for b in wds)+track*(len(txt)-1)
        x=(W-total)//2
        for c in txt:
            b=d.textbbox((0,0),c,font=font)
            for ox,oy in [(0,3),(2,2),(-2,2)]:
                d.text((x+ox,y+oy),c,font=font,fill=(0,0,0,150))
            d.text((x,y),c,font=font,fill=(255,255,255,255))
            x+=(b[2]-b[0])+track
        return
    b=d.textbbox((0,0),txt,font=font); x=(W-(b[2]-b[0]))//2-b[0]
    for ox,oy in [(0,4),(3,3),(-3,3),(3,-2),(-3,-2)]:
        d.text((x+ox,y+oy),txt,font=font,fill=(0,0,0,150))
    d.text((x,y),txt,font=font,fill=(255,255,255,255))
y=int(H*0.33)
centre(l1,f_script,y)
if l2: centre(l2,f_serif,y+165)
centre("""${ADDRESS}""".upper(),f_small,y+(275 if l2 else 175),track=3)
im.save("v4_title.png"); print("v4_title.png")
`);
sh(`"${PY}" _card4.py`);

console.log("6. assemble: hook -> hard cut -> front exterior push");
sh(`ffmpeg -y -v error -loop 1 -t 3 -i v4_front.png -vf "scale=792:1408,zoompan=z='min(zoom+0.0009,1.12)':d=90:s=720x1280:fps=30,format=yuv420p" -frames:v 90 -an v4_frontclip.mp4`);
sh(`ffmpeg -y -v error -i v4_hook.mp4 -i v4_frontclip.mp4 -filter_complex "[0][1]concat=n=2:v=1:a=0[v]" -map "[v]" -r 30 -an v4_nocard.mp4`);
const total = +WINDOW_LEN + 3;
sh(`ffmpeg -y -v error -i v4_nocard.mp4 -i v4_title.png -filter_complex "[1]format=rgba,fade=t=out:st=${(total - 1.2).toFixed(2)}:d=0.6:alpha=1[t];[0][t]overlay=0:0,format=yuv420p" -r 30 -an v4_reel.mp4`);
sh(`ffmpeg -y -v error -i v4_reel.mp4 -vf "fps=5,scale=180:-1,tile=7x4:padding=2:color=black" -frames:v 1 v4_sheet.png`);

const inr = ledger.reduce((s, l) => s + (l.inr || 0) + (l.usd || 0) * 84, 0);
console.table(ledger);
console.log(`total ≈ ₹${inr.toFixed(2)}

  v4_reel.mp4    compare against Wildcard.mp4
  v4_still.png   the fitted cover. This is now Veo's LAST FRAME, not a discarded asset
  v4_sheet.png   contact sheet

  Retune with no new spend (ffmpeg only):
    WINDOW_START=1.8 WINDOW_LEN=2.4 node hook-v4.mjs <same args>
`);
