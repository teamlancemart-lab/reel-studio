// Retune. Zero API calls. Rebuilds the reel from an EXISTING v4_forward.mp4.
//   node retune.mjs
//   WINDOW_START=5.6 node retune.mjs
//   WINDOW_START=5.6 WINDOW_LEN=2.4 STATUS="Just Listed" node retune.mjs
//
// The reversed clip ends on the real photo, so the reveal COMPLETES at the end.
// Cut the tail, not the middle. Try 5.2, 5.6, 6.0.

import fs from "node:fs";
import { execSync } from "node:child_process";

const PY = process.env.PYTHON_BIN || `${process.env.HOME}/.venvs/reel/bin/python3`;
const FWD = process.env.FORWARD || "v4_forward.mp4";
const FRONT = process.env.FRONT_PNG || "v4_front.png";
const STATUS = process.env.STATUS || "Coming Soon";
const ADDRESS = process.env.ADDRESS || "253 Brindle Rd, Mechanicsburg, PA";
const LEN = parseFloat(process.env.WINDOW_LEN || "2.2");
const FRONT_S = parseFloat(process.env.FRONT_LEN || "3.0");
const OUT = process.env.OUT || "retune";

const sh = (c) => execSync(c, { stdio: ["ignore", "pipe", "pipe"] }).toString().trim();
for (const f of [FWD, FRONT]) if (!fs.existsSync(f)) { console.error(`missing ${f}`); process.exit(1); }

sh(`ffmpeg -y -v error -i ${FWD} -vf "reverse,fps=30" -an _rev.mp4`);
const revDur = parseFloat(sh(`ffprobe -v error -show_entries format=duration -of csv=p=0 _rev.mp4`));

// default: land the window on the END of the reversed clip, where the reveal completes
const START = process.env.WINDOW_START !== undefined
  ? parseFloat(process.env.WINDOW_START)
  : Math.max(0, revDur - LEN);
console.log(`reversed clip ${revDur.toFixed(2)}s -> cutting ${START.toFixed(2)}s to ${(START + LEN).toFixed(2)}s`);

sh(`ffmpeg -y -v error -ss ${START} -t ${LEN} -i _rev.mp4 -an -r 30 _hook.mp4`);

fs.writeFileSync("_card.py", `
from PIL import Image, ImageDraw, ImageFont
W,H=720,1280
im=Image.new("RGBA",(W,H),(0,0,0,0)); d=ImageDraw.Draw(im)
def f(paths,size):
    for p in paths:
        try: return ImageFont.truetype(p,size)
        except Exception: pass
    return ImageFont.load_default()
SCRIPT=["/System/Library/Fonts/Supplemental/SnellRoundhand.ttc","/System/Library/Fonts/Supplemental/Zapfino.ttf","/System/Library/Fonts/Supplemental/Georgia Italic.ttf"]
SERIF=["/System/Library/Fonts/Supplemental/Georgia.ttf","/System/Library/Fonts/Supplemental/Times New Roman.ttf"]
f_script=f(SCRIPT,150); f_serif=f(SERIF,80); f_small=f(SERIF,30)
words="""${STATUS}""".split(); l1=words[0]; l2=" ".join(words[1:])
scrim=Image.new("RGBA",(W,H),(0,0,0,0)); sd=ImageDraw.Draw(scrim)
top,bot=int(H*0.26),int(H*0.60)
for y in range(top,bot):
    t=(y-top)/(bot-top); sd.line([(0,y),(W,y)],fill=(0,0,0,int(135*(1-abs(2*t-1)))))
im=Image.alpha_composite(im,scrim); d=ImageDraw.Draw(im)
def centre(txt,font,y,track=0):
    if track:
        bs=[d.textbbox((0,0),c,font=font) for c in txt]
        x=(W-(sum(b[2]-b[0] for b in bs)+track*(len(txt)-1)))//2
        for c in txt:
            b=d.textbbox((0,0),c,font=font)
            for ox,oy in [(0,3),(2,2),(-2,2)]: d.text((x+ox,y+oy),c,font=font,fill=(0,0,0,170))
            d.text((x,y),c,font=font,fill=(255,255,255,255)); x+=(b[2]-b[0])+track
        return
    b=d.textbbox((0,0),txt,font=font); x=(W-(b[2]-b[0]))//2-b[0]
    for ox,oy in [(0,4),(3,3),(-3,3),(3,-2),(-3,-2)]: d.text((x+ox,y+oy),txt,font=font,fill=(0,0,0,170))
    d.text((x,y),txt,font=font,fill=(255,255,255,255))
y=int(H*0.30)
centre(l1,f_script,y)
if l2: centre(l2,f_serif,y+170)
centre("""${ADDRESS}""".upper(),f_small,y+(285 if l2 else 180),track=4)
im.save("_title.png")
`);
sh(`"${PY}" _card.py`);

sh(`ffmpeg -y -v error -loop 1 -t ${FRONT_S} -i ${FRONT} -vf "scale=792:1408,zoompan=z='min(zoom+0.0009,1.12)':d=${Math.round(FRONT_S * 30)}:s=720x1280:fps=30,format=yuv420p" -frames:v ${Math.round(FRONT_S * 30)} -an _front.mp4`);
sh(`ffmpeg -y -v error -i _hook.mp4 -i _front.mp4 -filter_complex "[0][1]concat=n=2:v=1:a=0[v]" -map "[v]" -r 30 -an _nocard.mp4`);
const total = LEN + FRONT_S;
sh(`ffmpeg -y -v error -i _nocard.mp4 -i _title.png -filter_complex "[1]format=rgba,fade=t=out:st=${(total - 1.2).toFixed(2)}:d=0.6:alpha=1[t];[0][t]overlay=0:0,format=yuv420p" -r 30 -an ${OUT}.mp4`);
sh(`ffmpeg -y -v error -i ${OUT}.mp4 -vf "fps=5,scale=180:-1,tile=7x4:padding=2:color=black" -frames:v 1 -update 1 ${OUT}_sheet.png`);

console.log(`-> ${OUT}.mp4  ${OUT}_sheet.png   (${total.toFixed(1)}s, cost ₹0)`);
