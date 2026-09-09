// Hook v3 - clones the Wildcard reference properly.
//   pip3 install pillow
//   node hook-v3.mjs ./aerial.jpg ./exterior.jpg
//
// What changed from v2, and why:
//  1. SOURCE: an aerial 3/4 shot, not an eye-level shot. In the reference the house is ~15%
//     of the frame. The smaller the building, the less the model can get wrong.
//  2. DRAPE: fitted to the house like a car cover, not a curtain hanging in front of it.
//  3. COLOUR: near-black, matching the reference. Hot pink read as a stage curtain.
//  4. OUTPUT: not a raw clip. A 2.2s hook + title card + hard cut to the front exterior.
//     That is what we are actually comparing against.
//  5. Still uses reverse_conceal: condition on the REAL photo, generate the cover
//     descending, reverse it. Never generate from a still where the house is hidden.

import fs from "node:fs";
import { execSync } from "node:child_process";
import { GoogleAuth } from "google-auth-library";

const PROJECT = process.env.GCP_PROJECT_ID;
const LOCATION = process.env.GCP_LOCATION || "us-central1";
const VEO_MODEL = process.env.VEO_MODEL || "veo-3.1-lite-generate-001";
const IMAGE_MODEL = process.env.IMAGE_MODEL || "gemini-2.5-flash-image";
const STATUS = process.env.STATUS || "Coming Soon";
const ADDRESS = process.env.ADDRESS || "2572 Lexington St, Harrisburg, PA";
const DRAPE = process.env.DRAPE || "charcoal black";
const USD_INR = 84;

const [aerial, exterior] = process.argv.slice(2);
if (!aerial || !fs.existsSync(aerial)) { console.error("usage: node hook-v3.mjs <aerial.jpg> <exterior.jpg>"); process.exit(1); }
const heroExt = exterior && fs.existsSync(exterior) ? exterior : aerial;

const auth = new GoogleAuth({ credentials: JSON.parse(Buffer.from(process.env.GCP_SA_JSON_B64, "base64").toString()), scopes: ["https://www.googleapis.com/auth/cloud-platform"] });
const token = (await (await auth.getClient()).getAccessToken()).token;
const base = `https://${LOCATION}-aiplatform.googleapis.com/v1/projects/${PROJECT}/locations/${LOCATION}`;
const H = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
const sh = (c) => execSync(c, { stdio: ["ignore", "pipe", "pipe"] }).toString().trim();
const b64 = (p) => fs.readFileSync(p).toString("base64");
const ledger = [];
async function post(u, b) {
  const r = await fetch(u, { method: "POST", headers: H, body: JSON.stringify(b) });
  const t = await r.text(); if (!r.ok) throw new Error(`${r.status}\n${t.slice(0, 800)}`); return JSON.parse(t);
}
function crop916(src, out, xc = 0.5) {
  const w = +sh(`ffprobe -v error -select_streams v:0 -show_entries stream=width -of csv=p=0 "${src}"`);
  const h = +sh(`ffprobe -v error -select_streams v:0 -show_entries stream=height -of csv=p=0 "${src}"`);
  let cw = Math.min(w, Math.round(h * 9 / 16)); cw -= cw % 2;
  let cx = Math.round((w - cw) * xc); cx -= cx % 2;
  sh(`ffmpeg -y -v error -i "${src}" -vf "crop=${cw}:${h}:${cx}:0,scale=720:1280" ${out}`);
}

console.log("1. crops");
crop916(aerial, "hero_aerial.png", parseFloat(process.env.X_AERIAL || "0.5"));
crop916(heroExt, "hero_front.png", parseFloat(process.env.X_FRONT || "0.37"));

console.log("2. end-state still: fitted cover, house small in frame");
{
  const p = `Using the reference aerial photograph exactly as it is, add ONE element: a ${DRAPE} fabric cover draped tightly over the single house at the centre of the frame, following the shape of its roof and walls like a fitted car cover. The fabric hugs the building's form. It covers only that one house and does not extend onto the lawn, the driveway or any neighbouring house.
Everything else is identical to the reference: the same neighbouring houses, the same roads, the same trees, the same vehicles, the same sky, the same time of day, the same light and shadow direction, the same camera position and altitude.
Photographic, matching the exposure and colour of the reference. No people. No text. No logos.`;
  const res = await post(`${base}/publishers/google/models/${IMAGE_MODEL}:generateContent`, {
    contents: [{ role: "user", parts: [{ text: p }, { inlineData: { mimeType: "image/png", data: b64("hero_aerial.png") } }] }],
    generationConfig: { responseModalities: ["IMAGE"] },
  });
  const part = res.candidates?.[0]?.content?.parts?.find((x) => x.inlineData);
  if (!part) throw new Error("no image: " + JSON.stringify(res).slice(0, 400));
  fs.writeFileSync("v3_still.png", Buffer.from(part.inlineData.data, "base64"));
  ledger.push({ step: "still", inr: 4 });
  console.log("   -> v3_still.png  (check this: is the cover fitted, or a curtain?)");
}

console.log("3. veo forward: cover descends onto the real aerial");
{
  const p = `Aerial drone shot, camera locked off, no camera movement at all.
A small dark helicopter enters high at the top of the frame trailing two thin cables. The cables lower a ${DRAPE} fabric cover down onto the single house at the centre of the frame. The fabric settles over that house, following the shape of its roof, until the house is covered.
The neighbouring houses, the roads, the lawns, the trees, the parked vehicles and the sky remain exactly as they are and never change. Nothing else in the scene moves.
Real photographic drone footage, bright daylight.`;
  const op = await post(`${base}/publishers/google/models/${VEO_MODEL}:predictLongRunning`, {
    instances: [{ prompt: p, image: { bytesBase64Encoded: b64("hero_aerial.png"), mimeType: "image/png" } }],
    parameters: { aspectRatio: "9:16", durationSeconds: 6, resolution: "720p", generateAudio: false, sampleCount: 1, personGeneration: "dont_allow" },
  });
  console.log("   submitted", op.name.split("/").pop());
  let done = false, res;
  for (let i = 0; i < 60 && !done; i++) {
    await new Promise((r) => setTimeout(r, 10000));
    res = await post(`${base}/publishers/google/models/${VEO_MODEL}:fetchPredictOperation`, { operationName: op.name });
    done = !!res.done; process.stdout.write(done ? "  done\n" : ".");
  }
  const v = res.response?.videos?.[0];
  if (!v?.bytesBase64Encoded) throw new Error("no video: " + JSON.stringify(res.response).slice(0, 400));
  fs.writeFileSync("v3_forward.mp4", Buffer.from(v.bytesBase64Encoded, "base64"));
  ledger.push({ step: "veo 6s", usd: 0.30 });
}

console.log("4. reverse, then cut the 2.2s usable window");
sh(`ffmpeg -y -v error -i v3_forward.mp4 -vf "reverse,fps=30" -an v3_rev.mp4`);
const REV_START = process.env.WINDOW_START || "1.3";
sh(`ffmpeg -y -v error -ss ${REV_START} -t 2.2 -i v3_rev.mp4 -an -r 30 v3_hook.mp4`);

console.log("5. title card");
fs.writeFileSync("_card.py", `
from PIL import Image, ImageDraw, ImageFont
W,H=720,1280
im=Image.new("RGBA",(W,H),(0,0,0,0)); d=ImageDraw.Draw(im)
def f(paths,size):
    for p in paths:
        try: return ImageFont.truetype(p,size)
        except: pass
    return ImageFont.load_default()
script=f(["/System/Library/Fonts/Supplemental/SnellRoundhand.ttc","/System/Library/Fonts/Supplemental/Zapfino.ttf","/System/Library/Fonts/Supplemental/Georgia Italic.ttf"],96)
serif =f(["/System/Library/Fonts/Supplemental/Georgia.ttf","/System/Library/Fonts/Times New Roman.ttf"],54)
small =f(["/System/Library/Fonts/Supplemental/Georgia.ttf"],22)
status="""${STATUS}""".split(); line1=status[0]; line2=" ".join(status[1:]) or ""
def centre(txt,font,y,fill=(255,255,255,255)):
    b=d.textbbox((0,0),txt,font=font); x=(W-(b[2]-b[0]))//2-b[0]
    for ox,oy in [(-2,-2),(2,-2),(-2,2),(2,2),(0,3)]:
        d.text((x+ox,y+oy),txt,font=font,fill=(0,0,0,110))
    d.text((x,y),txt,font=font,fill=fill)
# lower third, inside safe zone (top 15%, bottom 12%)
base_y=int(H*0.42)
centre(line1,script,base_y)
if line2: centre(line2,serif,base_y+110)
centre("""${ADDRESS}""",small,base_y+(190 if line2 else 110))
im.save("title.png")
print("title.png")
`);
sh(`python3 _card.py`);

console.log("6. assemble: hook + hard cut to front exterior");
sh(`ffmpeg -y -v error -loop 1 -t 3 -i hero_front.png -vf "scale=792:1408,zoompan=z='min(zoom+0.0008,1.10)':d=90:s=720x1280:fps=30,format=yuv420p" -frames:v 90 -an v3_front.mp4`);
sh(`ffmpeg -y -v error -i v3_hook.mp4 -i v3_front.mp4 -filter_complex "[0][1]concat=n=2:v=1:a=0[v]" -map "[v]" -r 30 -an v3_nocard.mp4`);
sh(`ffmpeg -y -v error -i v3_nocard.mp4 -i title.png -filter_complex "[1]format=rgba,fade=t=out:st=4.0:d=0.6:alpha=1[t];[0][t]overlay=0:0,format=yuv420p" -r 30 -an v3_reel.mp4`);
sh(`ffmpeg -y -v error -i v3_reel.mp4 -vf "fps=5,scale=180:-1,tile=7x4:padding=2:color=black" -frames:v 1 v3_sheet.png`);

const inr = ledger.reduce((s, l) => s + (l.inr || 0) + (l.usd || 0) * USD_INR, 0);
console.table(ledger);
console.log(`total ≈ ₹${inr.toFixed(2)}`);
console.log(`
  v3_reel.mp4    <- compare this against Wildcard.mp4, not the raw clip
  v3_sheet.png   <- contact sheet
  v3_still.png   <- the still. If the cover is a curtain not a fitted cover, the prompt needs work
  v3_hook.mp4    <- the 2.2s hook alone

  Tune without regenerating:
    WINDOW_START=0.9 node hook-v3.mjs ...   (cut earlier or later in the reversed clip)
    DRAPE="deep crimson" STATUS="Just Listed" ADDRESS="..." node hook-v3.mjs ...
`);
