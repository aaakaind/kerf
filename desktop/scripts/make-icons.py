# KERF app icons from the block mark (72-unit grid): ink block, kerf slot cut from the top edge, ochre dot.
import sys, os
from PIL import Image, ImageDraw
INK=(28,26,23,255); IVORY=(243,238,228,255); OCHRE=(227,167,47,255)
def mark(d, x0, y0, s, slot_fill):
    k = s/72.0
    d.rectangle([x0, y0, x0+s, y0+s], fill=INK)
    # slot: x 28..44, top above edge to y=46, bottom radius 8
    d.rounded_rectangle([x0+28*k, y0+20*k, x0+44*k, y0+46*k], radius=8*k, fill=slot_fill)
    d.rectangle([x0+28*k, y0, x0+44*k, y0+38*k], fill=slot_fill)
    d.ellipse([x0+(55-8)*k, y0+(55-8)*k, x0+(55+8)*k, y0+(55+8)*k], fill=OCHRE)
def full(size):  # full-bleed block (small sizes): slot is transparent
    S=size*8; im=Image.new('RGBA',(S,S),(0,0,0,0)); d=ImageDraw.Draw(im); mark(d,0,0,S,(0,0,0,0)); return im.resize((size,size),Image.LANCZOS)
def tile(size, inset=0.2, radius=0.22, bg=IVORY):  # ivory tile with the block inset
    S=size*4; im=Image.new('RGBA',(S,S),(0,0,0,0)); d=ImageDraw.Draw(im)
    d.rounded_rectangle([0,0,S-1,S-1], radius=int(S*radius), fill=bg)
    b=S*(1-2*inset); mark(d,(S-b)/2,(S-b)/2,b,bg); return im.resize((size,size),Image.LANCZOS)
def fg(size, frac=0.5, mono=False):  # adaptive-icon foreground: block in the safe zone, slot see-through
    S=size*4; im=Image.new('RGBA',(S,S),(0,0,0,0)); d=ImageDraw.Draw(im); b=S*frac; x0=(S-b)/2
    mark(d,x0,x0,b,(0,0,0,0))
    if mono:  # themed icon: punch the dot out too, so the silhouette reads as the mark
        k=b/72.0; d.ellipse([x0+(55-8)*k, x0+(55-8)*k, x0+(55+8)*k, x0+(55+8)*k], fill=(0,0,0,0))
    return im.resize((size,size),Image.LANCZOS)
out=sys.argv[1]; os.makedirs(out, exist_ok=True)
tile(1024).save(f'{out}/icon.png')
for n in (16,24,32,48,64,128,256,512):
    (full(n) if n<=32 else tile(n)).save(f'{out}/icon-{n}.png')
ico=[(full(n) if n<=32 else tile(n)) for n in (16,24,32,48,64,128,256)]
ico[-1].save(f'{out}/icon.ico', sizes=[(n,n) for n in (16,24,32,48,64,128,256)], append_images=ico[:-1])
# android
for dens,px in {'mdpi':48,'hdpi':72,'xhdpi':96,'xxhdpi':144,'xxxhdpi':192}.items():
    os.makedirs(f'{out}/android/mipmap-{dens}',exist_ok=True)
    tile(px, inset=0.18).save(f'{out}/android/mipmap-{dens}/ic_launcher.png')
    fg(int(px*108/48), 0.42).save(f'{out}/android/mipmap-{dens}/ic_launcher_foreground.png')
    fg(int(px*108/48), 0.42, True).save(f'{out}/android/mipmap-{dens}/ic_launcher_monochrome.png')
print('ok')
