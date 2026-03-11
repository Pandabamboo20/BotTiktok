from PIL import Image, ImageDraw
import base64, os

# Create 32x32 favicon
img = Image.new('RGBA', (64, 64), (0,0,0,0))
draw = ImageDraw.Draw(img)

# Background rounded square - dark
draw.rounded_rectangle([0, 0, 63, 63], radius=14, fill=(15, 16, 20, 255))

# TikTok-style music note gradient simulation
# Pink layer (offset)
draw.ellipse([28, 18, 44, 30], fill=(254, 44, 85, 255))
draw.rectangle([40, 18, 44, 42], fill=(254, 44, 85, 255))
draw.ellipse([28, 38, 44, 50], fill=(254, 44, 85, 255))

# Cyan layer (offset)
draw.ellipse([24, 16, 40, 28], fill=(37, 244, 238, 200))
draw.rectangle([36, 16, 40, 40], fill=(37, 244, 238, 200))
draw.ellipse([24, 36, 40, 48], fill=(37, 244, 238, 200))

# White main note
draw.ellipse([22, 15, 38, 27], fill=(255, 255, 255, 255))
draw.rectangle([34, 15, 38, 39], fill=(255, 255, 255, 255))
draw.ellipse([22, 35, 38, 47], fill=(255, 255, 255, 255))

img = img.resize((32, 32), Image.LANCZOS)
img.save('favicon.png', 'PNG')
print("done")
