import unittest
from PIL import Image, ImageDraw
from sheets import cell_image

class SheetsTest(unittest.TestCase):
    def test_grid(self):
        for w, h in [(1280, 720), (1920, 1080)]:
            im = Image.new('RGB', (w, h)); draw = ImageDraw.Draw(im)
            for i in range(100):
                x, y = i % 10 * (w // 10), i // 10 * (h // 10)
                draw.rectangle((x, y, x+w//10-1, y+h//10-1), fill=(i, 255-i, 0))
            for i in [0, 9, 10, 57, 99]:
                cell = cell_image(im, i)
                self.assertEqual(cell.size, (192, 108))
                self.assertEqual(cell.getpixel((191, 107)), (i, 255-i, 0))
    def test_bad_grid(self):
        with self.assertRaises(ValueError): cell_image(Image.new('RGB', (1279, 720)), 99)

if __name__ == '__main__': unittest.main()
