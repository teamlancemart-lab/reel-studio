# Reference Reel Anatomy v1
Frame-level read of the six target reels. Method: ffprobe metadata, scene-cut detection (threshold 0.2), 2 fps contact sheets for structure, 8 to 10 fps sheets for the hooks, librosa beat and loudness tracking on the extracted audio.

## 0. TLDR

1. All six reels are the same listing (16 Foxwood Blvd, Mechanicsburg PA, $789,900, 4,308 sqft) cut from the same 9 stills. This is one vendor's template pack, each template named after its music track. That is the product shape we are targeting: one photo set in, N music-named recipes out.
2. Every shot is a still photo with motion applied. The "drone footage" is drone stills with slow push and pull. There is no real video anywhere in the pack. Interiors are untouched. That matches our zero-AI-interiors rule exactly and removes the need for any drone video.
3. Four of the six hooks map one-to-one to your library: Alright = house drop-in from the sky, Electricity = builds itself, Wildcard = helicopter lifts a black drape, Mochi = sketch tears away to photo. Funkymania and On My Mind have no generative hook, only kinetic address type.
4. The hook is 1.5 to 2.3 seconds, always on the aerial, always resolves on the music drop, and the first hard cut lands on the front exterior with the title card still on screen. Generated hook clips therefore need 2 to 3 usable seconds, not 6.
5. Fixed skeleton across all six: aerial hook, front exterior with title, foyer, dining, living, front exterior again, top-down, wide aerial, wider aerial. It always ends by zooming out to the neighbourhood. No CTA card, no agent card, no disclosure in any of them. We add all three.
6. Three pacing tiers from the same assets: fast (13 to 15s, 1s per shot or 0.2s stutter), medium (18 to 20s, one 4-beat bar per shot, cuts within 150 to 250 ms of the beat), slow (36 to 41s, 2 bars per shot). This is the "three reels that don't look identical" engine, and it is free.

---

## 1. Asset pool (what the vendor started with)

| ID | Asset | Used as |
|---|---|---|
| A1 | Front exterior, eye level, wide | Shot 2 and shot 6 in every reel, hook cut-to target |
| A2 | Three-quarter aerial, 45 degrees | Hook plate for Alright, Electricity, Wildcard, Mochi |
| A3 | Top-down aerial of the lot | Penultimate shot, source of the lot outline and the 3D house cutout |
| A4 | Wide aerial, neighbourhood, mid altitude | Second to last |
| A5 | Wider aerial, horizon visible | Last shot, slow push or pull |
| I1 | Foyer with staircase | Interior 1 |
| I2 | Dining room, orange walls | Interior 2 |
| I3 | Living room, fireplace | Interior 3 |
| D1 | Derived: 3D or 2.5D cutout of the house | Alright hook |
| D2 | Derived: pencil architectural sketch of the exterior | Mochi hook |
| D3 | Derived: lot boundary polygon on A3 | Alright, Electricity hooks |

Note the interior count. Three interiors carried six reels. Our classifier must handle 3 to 12 uploads and the shot-list step must repeat or re-crop when the count is low, exactly as the vendor did (Alright and Electricity reuse the dining room twice from two crops).

---

## 2. Per-reel breakdown

### 2.1 Alright (20.4s, 30 fps, 129 BPM, medium tier)
Cuts: 1.90, 3.73, 5.57, 7.47, 9.30, 11.13, 12.97, 14.87, 16.70, 18.53. Interval 1.83s = one 4-beat bar at 131 BPM. Bar-locked.
Audio: near silent 0 to 2s (RMS 0.018), drop at 2s (RMS 0.112). The hook resolves on the drop.

| Time | Frame content | Technique |
|---|---|---|
| 0.00 | Blue sky, horizon of the town far below, a small 3D model of the actual house floats centre frame. Price stack already on screen | Camera starts high in the sky |
| 0.00 to 1.10 | Camera dives from the sky toward the town, the house model stays centred and grows | 3D camera move over A3 or a zoom into A3 with the cutout pinned |
| 1.10 to 1.75 | Aerial ground plane resolves, a white rectangle marks the lot, the house "lands" inside it | Lot outline polygon fades in, cutout settles |
| 1.90 | Hard cut to A1 front exterior, price stack persists | Cut on the drop |
| 1.90 to 3.73 | Slow push on A1 | Ken Burns in |
| 3.73 to 5.57 | Tighter crop of A1 | Zoom-through cut, title gone by 3.9s |
| 5.57 to 11.13 | I1, I2, I2 (second crop) | Push in, push in, pull out |
| 11.13 to 12.97 | I3 | Slow push |
| 12.97 to 14.87 | A2 three-quarter aerial | Slow push |
| 14.87 to 16.70 | A3 top-down | Slow pull |
| 16.70 to 20.4 | A4 then A5 | Slow pull, ends on the neighbourhood, no card |

Title system: serif price "$789,900" large, address one line small serif, "Beds | Baths | Sqft" row smaller. White with soft drop shadow, centred, lower third of frame. On screen 0 to 3.9s.

### 2.2 Electricity (17.8s, 103 BPM, medium tier)
Cuts: 2.33, 4.53, 6.80, 9.20, 11.30, 13.67, 14.90, 16.03, 16.63, 17.20. First half at 2.2 to 2.4s per shot, last four cuts accelerate to 0.6s.
Audio: flat, no big drop, builds to the end (RMS 0.041 to 0.075).

| Time | Frame content | Technique |
|---|---|---|
| 0.00 | A2 aerial, the lot is bare dirt where the house should be. "Just Listed" serif already on screen with address and bed/bath/sqft icon row | Plate is A2 with the house removed |
| 0.25 to 0.60 | Foundation slab appears, then framing walls rise floor by floor | Construction time-lapse composited on the plate |
| 0.75 to 1.25 | Walls complete, roof forms | Same |
| 1.30 to 1.60 | Real house fades in over the model | Crossfade to the true A2, the truth lock |
| 1.60 to 2.30 | Slow orbit drift on A2 | Push |
| 2.33 | Whip-blur transition to A1 front exterior, title persists | Motion-blur whip |
| 4.53 | Title changes to "Open House" (italic serif) with date and time line and calendar/clock icons | Second status card |
| 6.80 to 13.67 | I1, I2, I2 second crop, I3 with meme-style kinetic captions | White rounded caption boxes, sans, centred |
| 14.90 to 17.8 | A1, A3, A4 accelerating | 0.6s per shot, ends on neighbourhood |

Captions seen on interiors: "6 bedrooms? I'm already packing my bags." and "When you find the perfect floor plan that pays for itself." Conversational, first-person, one line, no facts. This is the one template with talk-track captions.

### 2.3 Funkymania (40.6s, slow tier)
Cuts: 1.33, 5.20, 9.13, 13.10, 17.03, 20.93, 24.87, 28.80, 32.73, 36.67. Interval 3.93s, two bars. Cut-to-beat error 116 ms mean.

| Time | Frame content | Technique |
|---|---|---|
| 0.00 to 1.30 | A1 front exterior, slow push, a soft diagonal light sweep crosses the frame | Light-leak wipe |
| 1.33 | Zoom-through cut to a tighter crop of A1 | Zoom-through |
| 1.40 to 2.40 | Address "16 Foxwood Blvd / Mechanicsburg, PA" assembles letter by letter from scrambled glyphs | Serif letter-scramble reveal |
| 5.20 to 24.87 | I1, I1 second crop, I2, I2, I3, I3 | 4s each, alternating push and pull |
| 24.87 to 40.6 | A1, A3, A4, A5 | Same slow cadence, ends on the neighbourhood |

No hook effect. This is the luxury-pacing recipe: long holds, letter-scramble type, no captions.

### 2.4 Mochi (15.1s, 136 BPM, fast tier with long hold)
Cuts: 3.10, 6.67, 10.13, then 12.20, 12.60, 12.80, 13.07, 13.27, 13.50, 13.70 (0.2 to 0.4s stutter).

| Time | Frame content | Technique |
|---|---|---|
| 0.00 | Full-frame pencil architectural sketch of the exterior, hand-drawn look with annotations | D2 sketch plate |
| 0.12 | A paper tear starts at the roof ridge, a small search-bar UI appears top centre | Paper-tear mask with curled edges, drop shadow |
| 0.25 to 1.60 | The tear widens diagonally, revealing A2 aerial photo underneath. Search bar types "Homes for Sale in Mechanicsburg, PA" word by word | Tear complete at 1.6s, typing complete at 1.9s |
| 1.60 to 3.10 | Push in on A2 with blurred tree edges in the foreground | 2.5D parallax, foreground layer blurred |
| 3.10 to 10.13 | A1 front exterior, three crops, slow push each | 10 seconds on the exterior, the longest exterior hold in the pack |
| 12.20 to 13.70 | I1, I1, I2, I2, I2, I3, I3, A1, A3, A4 | Beat-stutter montage, 0.2s per frame |
| 13.70 to 15.1 | A5 | Settles on neighbourhood |

Two notable things. The search-bar overlay is an intent hook: it frames the reel as the answer to a Google search. And the interiors are flashes, not a tour. The exterior carries 70 percent of the runtime.

### 2.5 On My Mind (35.8s, 117 BPM, slow tier)
Cuts: 2.63, 5.07, 7.37, 9.20, 12.80, 16.80, 20.77, 24.67, 27.77, 31.87. Starts at 2.3s per shot, settles at 4s.

| Time | Frame content | Technique |
|---|---|---|
| 0.00 to 4.5 | A1 front exterior, slow push, bold sans "16 Foxwood Blvd" centred with heavy shadow | Bold sans address card, no price, no status |
| 2.63 | Zoom-through to tighter A1 | Zoom-through |
| 5.07 to 20.77 | I1, I1, I2, I2, I2, I3, I3 | Alternating push and pull |
| 20.77 to 35.8 | A1, A3, A4, A5 | Ends on neighbourhood |

The sans variant of Funkymania. Same skeleton, different type voice.

### 2.6 Wildcard (13.1s, 117 BPM, fast tier)
Cuts: 2.17, 2.67, 3.70, 4.77, 5.77, 6.87, 7.90, 9.73, 9.97, 11.03, 12.07. One second per shot after the hook.
Audio: quiet 0 to 2s (RMS 0.039), drop at 2.17 (RMS 0.109). Hook resolves on the drop.

| Time | Frame content | Technique |
|---|---|---|
| 0.00 | A2 aerial. The house is covered by a black drape. A dark helicopter enters top-left. "Coming Soon" in script over serif, address line below | Drape composite on the plate |
| 0.10 to 1.10 | Helicopter crosses the frame left to right, cables pull the drape up and off the house | Drape lifts, house emerges from underneath |
| 1.20 to 1.90 | Drape trails off the bottom-left corner, house fully revealed | Truth lock: the reveal ends on the untouched A2 |
| 2.17 | Hard cut to A1 front exterior on the drop, title persists to 3.2s | Cut on drop |
| 3.70 to 9.73 | I1, I1, I2, I2, I3, I3 | 1s each |
| 9.73 to 13.1 | A1, A3, A4, A5 | Ends on neighbourhood |

This is your helicopter drape, done with a black drape not a red one, and the helicopter is small and high in frame so its geometry never has to be convincing. Copy that: small helicopter, top of frame, the drape does the work.

---

## 3. The skeleton (extracted)

| Slot | Content | Duration by tier (fast / medium / slow) | Motion |
|---|---|---|---|
| 1 Hook | A2 aerial plate plus effect, title on from frame 0 | 2.2 / 1.9 to 2.3 / none (address type instead) | Effect resolves on the music drop |
| 2 Exterior | A1, title persists then exits | 1.5 / 1.8 to 3.7 / 4 to 5 | Push in |
| 3 Exterior tight | A1 tighter crop | 0 / 1.8 / 4 | Zoom-through |
| 4 to 9 Interiors | I1, I2, I3 in that order, each repeated once from a second crop | 1 each / 1.8 to 2.4 each / 4 each | Alternate push and pull, 2.5D where edges allow |
| 10 Exterior return | A1 | 1 / 1.8 / 4 | Slow push |
| 11 Top-down | A3 | 1 / 1.8 / 4 | Slow pull |
| 12 Wide aerial | A4 | 1 / 1.8 / 4 | Slow pull |
| 13 Wider aerial | A5, ends the reel | 1.5 / 2 / 4 | Slow pull, no card |

Order is invariant: exterior, entry, dining, living, exterior, top-down, wide, wider. The reel closes by zooming out to the neighbourhood every single time. The only thing that changes between templates is the hook effect, the title system, the tier and the transition family.

---

## 4. Title systems (five observed)

| System | Reels | Faces | Content | Timing |
|---|---|---|---|---|
| Price stack | Alright | Serif display plus small serif | Price, address, beds/baths/sqft row | Frame 0 to 3.9s |
| Status card | Electricity, Wildcard | Serif (regular, italic, or script over serif) plus small sans plus icon row | "Just Listed", "Open House" with date/time, "Coming Soon", address, icon facts | Frame 0 to about 3.5s, second card at 4.5s in Electricity |
| Address only, serif scramble | Funkymania | Serif | Street, city state | 1.4 to 4.5s |
| Address only, bold sans | On My Mind | Heavy sans | Street only | Frame 0 to 4.5s |
| Search-bar intent | Mochi | UI element, sans | "Homes for Sale in [City, State]" typed word by word | 0.1 to 5s |

Plus one caption system: white rounded boxes, centred, conversational one-liners on interiors (Electricity only).

All type sits in the centre or lower-centre of the 16:9 frame, which is inside the 9:16 safe zone after a centre crop. That makes the 9:16 master feasible without redesigning the type.

---

## 5. Transition and motion vocabulary observed

| Name | Where | ffmpeg feasibility |
|---|---|---|
| Hard cut on drop | Alright, Wildcard | Trivial |
| Whip-blur | Electricity 2.33 | xfade plus directional blur, or a 6-frame motion blur crossfade |
| Zoom-through | Funkymania 1.33, On My Mind 2.63, Alright 3.73 | Scale-up on out-shot into scale-down on in-shot, 8 frames |
| Light-leak sweep | Funkymania 0 to 1.3 | Overlay a white gradient band with screen blend, animated x |
| Letter-scramble type | Funkymania | Canvas or drawtext per frame, not ffmpeg native; render as PNG sequence |
| Search-bar typing | Mochi | PNG sequence or HTML canvas render |
| Paper tear | Mochi | Needs a mask sequence; a generated 2s clip or a pre-made tear alpha overlay |
| Beat-stutter montage | Mochi 12.2 to 13.7 | Trivial, 6-frame shots |
| 2.5D parallax with edge blur | Mochi 1.6 to 3.1 | Depth-mask foreground layer, blur, offset scale. Free with a depth model or a manual mask |
| Push and pull (Ken Burns) | Everywhere | zoompan |

---

## 6. Music behaviour

| Reel | BPM | Intro | Drop | Cut lock |
|---|---|---|---|---|
| Alright | 129 | Quiet 0 to 2s | 2.0s, hook resolves here | One bar per shot |
| Electricity | 103 | Flat | None, builds to end | Loose, then accelerates |
| Funkymania | 161 (double-time read, treat as 81) | Flat | None | Two bars per shot |
| Mochi | 136 | Loud from 0 | Stutter section on a fill at 12.2s | Beat-stutter |
| On My Mind | 117 | Flat | None | Two bars per shot |
| Wildcard | 117 | Quiet 0 to 2s | 2.17s, hook resolves here | One beat per shot |

Rule for the pacing step: if the track has an intro and a drop, the hook length equals the intro length and the first cut is the drop. If the track is flat, the hook is 2.0s fixed and the tier decides the rest.

---

## 7. What is missing from every sample (we add it)

| Gap | Why it matters | Our default |
|---|---|---|
| No CTA card | Reach without an identifiable agent is wasted | 4 to 5s CTA card before or replacing the last aerial |
| No disclosure on the altered-exterior hooks | Alright, Electricity and Wildcard all show a digitally altered exterior. Under AB 723 and NAR 12-5 they need a label and an originals link | Corner label on the hook, originals line on the CTA |
| No RERA band | Mandatory for Indian listings | Fixed lower band on the CTA |
| No Equal Housing line | Standard on US listing ads | On the CTA |
| No price on five of six | The number is the second strongest hook after the reveal | Price stack default on the medium tier |
| 16:9 only | Letterboxed in Reels | 9:16 master, 16:9 derivative |

---

## 8. Mapping to the hook library and the cheap build path

| Sample hook | Your concept | How the vendor did it | Cheapest faithful replica | fal needed |
|---|---|---|---|---|
| Alright | House drops from the sky | Camera dive from horizon to lot with a 3D cutout pinned in a lot outline | 2.5D: cut the house from A3, pin it, zoom into A3 with easing, fade in lot outline. All ffmpeg and a mask | No, unless you want clouds and dust |
| Electricity | Builds itself | Foundation to frame to roof composited on the aerial, then crossfade to real | Generate the mid-build still (₹4), QA it, then a 3s clip from bare lot to that still, crossfade to A2 | Yes, 3s |
| Wildcard | Helicopter lifts drape | Small helicopter top of frame, black drape peels off the house | Generate from a still of A2 with a drape painted over the house (₹4), 4 to 6s clip, use 2.2s, truth lock to A2 | Yes, one clip |
| Mochi | Sketch to photo | Pencil sketch plate, paper-tear mask reveals A2 | Edge-detect A2 for the sketch, tear alpha overlay, crossfade. Optional generated tear | Optional |
| Funkymania, On My Mind | None | Kinetic address type | Type render only | No |

Reference for the sketch: the sample sketch includes annotations and hatching. A plain edge-detect will look thinner. Budget one image call (₹4) for a "pencil architectural rendering" of A2 if the edge-detect looks cheap.

---

## 9. Facts the vendor put on screen (for the listing truth schema)
Address line, city and state, price, beds, baths, sqft, status, open house date and time. Nothing else. No agent name, no brokerage, no locality claims, no school, no HOA. The vendor stayed inside pure listing facts and let the visuals sell. Our truth schema should default to exactly this set plus the compliance band.
