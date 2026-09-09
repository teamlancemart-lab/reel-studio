
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
words="""Coming Soon""".split()
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
centre("""253 Brindle Rd, Mechanicsburg, PA""".upper(),f_small,y+(275 if l2 else 175),track=3)
im.save("v4_title.png"); print("v4_title.png")
