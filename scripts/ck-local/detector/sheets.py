"""JS vod-timeline.cellOf와 같은 10×10 격자. 시트 해상도는 고정하지 않는다."""
from PIL import Image

FW, FH, PER = 192, 108, 100


def cell_image(sheet, cell):
    w, h = sheet.size
    if w < 10 or h < 10 or w % 10 or h % 10 or not 0 <= cell < PER:
        raise ValueError(f"10x10 sheet and cell 0..99 required: {w}x{h}, cell={cell}")
    cw, ch = w // 10, h // 10
    x, y = cell % 10 * cw, cell // 10 * ch
    image = sheet.crop((x, y, x + cw, y + ch))
    return image if image.size == (FW, FH) else image.resize((FW, FH), Image.Resampling.BILINEAR)
