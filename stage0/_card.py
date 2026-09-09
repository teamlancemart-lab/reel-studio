
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
status="""Coming Soon""".split(); line1=status[0]; line2=" ".join(status[1:]) or ""
def centre(txt,font,y,fill=(255,255,255,255)):
    b=d.textbbox((0,0),txt,font=font); x=(W-(b[2]-b[0]))//2-b[0]
    for ox,oy in [(-2,-2),(2,-2),(-2,2),(2,2),(0,3)]:
        d.text((x+ox,y+oy),txt,font=font,fill=(0,0,0,110))
    d.text((x,y),txt,font=font,fill=fill)
# lower third, inside safe zone (top 15%, bottom 12%)
base_y=int(H*0.42)
centre(line1,script,base_y)
if line2: centre(line2,serif,base_y+110)
centre("""2572 Lexington St, Harrisburg, PA""",small,base_y+(190 if line2 else 110))
im.save("title.png")
print("title.png")
